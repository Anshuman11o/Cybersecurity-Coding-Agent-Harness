/**
 * Unit tests for the Task 2a foundation: call pricing, the reservation unit,
 * the scan estimate, the spend ledger, the API profile and error
 * classification, the metered call, calibration and the reports root. No stage
 * runs, no model calls — every client here is a fake.
 *
 *   npx tsx --test foundation.test.ts
 *
 * Expected numbers are worked by hand in the comment beside each assertion, so
 * a change to the arithmetic fails here rather than in a bill.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { costUsd } from './provider.js'
import { loadRegistry } from './models.js'
import {
  normalizeUsage, callCostUsd, tierInfo, tiersManaged, regionMultiplier, upperInputRatePerMTok,
  reservationUnitUsd, worstCaseCallUsd, callReservationUsd, callPromptBytes, planCallReservationsUsd, scanCostUsd, estimateBandPct, FOLLOW_UP_INPUT_MULTIPLIER,
  type NormalizedUsage,
} from './pricing.js'
import { SpendLedger, readLedgerTotals, ledgerPathFor, LEDGER_FILE, type LedgerEntry } from './ledger.js'
import {
  parseRateLimitHeaders, parseResetMs, concurrencyFromRateLimits, stepDown,
  readApiProfile, writeApiProfile, API_PROFILE_SCHEMA,
} from './api-profile.js'
import { classifyApiError, retryAfterMs } from './api-errors.js'
import { meteredChatCompletion, promptChars } from './metered-call.js'
import { recordCalibration, calibratedRatios, readCalibration, type CalibrationRun } from './calibration.js'
import { resolveRunContext, BENCHMARK_RUNS_ROOT, PRODUCT_DIRNAME } from './run-context.js'

const near = (a: number | null | undefined, b: number, eps = 1e-12) =>
  assert.ok(a != null && Math.abs(a - b) < eps, `expected ${b}, got ${a}`)

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))

// 10,000 prompt tokens of which 4,000 cached and 2,000 written, 3,000 completion.
const CHAT_USAGE = {
  prompt_tokens: 10000,
  completion_tokens: 3000,
  total_tokens: 13000,
  prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 2000 },
  completion_tokens_details: { reasoning_tokens: 2500 },
}

test('callCostUsd prices tiers, long context, regions and web search from registry data', () => {
  const u = normalizeUsage(CHAT_USAGE)!
  // luna6 Standard: fresh 4,000 x $0.10 + cached 4,000 x $0.01 + written 2,000 x $0.125
  //   = 400 + 40 + 250 = 690 per 1M -> $0.000690; output 3,000 x $0.50 = 1,500 -> $0.001500.
  //   Total $0.002190.
  const std = callCostUsd('luna6', u, { servedTier: 'default' })
  near(std.cost_usd, 0.00219)
  assert.equal(std.reason, null)
  assert.equal(std.tier.label, 'Standard')
  assert.equal(std.long_context, false)
  // A response with no service_tier is 1x.
  near(callCostUsd('luna6', u).cost_usd, 0.00219)
  // Flex is 0.5x: $0.001095. Priority and Fast are 2x: $0.004380.
  near(callCostUsd('luna6', u, { servedTier: 'flex' }).cost_usd, 0.00219 / 2)
  near(callCostUsd('luna6', u, { servedTier: 'priority' }).cost_usd, 0.00219 * 2)
  near(callCostUsd('luna6', u, { servedTier: 'fast' }).cost_usd, 0.00219 * 2)
  assert.equal(callCostUsd('luna6', u, { servedTier: 'fast' }).tier.label, 'Fast')
  // Ultrafast has no published price: unpriced, never a guess.
  const ultra = callCostUsd('luna6', u, { servedTier: 'ultrafast' })
  assert.equal(ultra.cost_usd, null)
  assert.equal(ultra.reason, 'unpriced_service_tier')
  assert.equal(ultra.tier.multiplier, null)

  // Long context: 300,000 fresh prompt tokens (> 272,000) and 1,000 completion.
  //   input 300,000 x $0.10 x 2 = 60,000 per 1M -> $0.06; output 1,000 x $0.50 x 1.5 = 750 -> $0.00075.
  //   Total $0.06075 (it would be $0.0305 without the long-context tier).
  const long = callCostUsd('luna6', normalizeUsage({ prompt_tokens: 300000, completion_tokens: 1000 }))
  near(long.cost_usd, 0.06075)
  assert.equal(long.long_context, true)
  // Exactly at the threshold is still short context: 272,000 x $0.10 = $0.0272.
  near(callCostUsd('luna6', normalizeUsage({ prompt_tokens: 272000, completion_tokens: 0 })).cost_usd, 0.0272)

  // A regional host is +10%: $0.00219 x 1.1 = $0.002409. api.openai.com itself is not regional.
  near(callCostUsd('luna6', u, { baseURL: 'https://eu.api.openai.com/v1' }).cost_usd, 0.002409)
  near(callCostUsd('luna6', u, { baseURL: 'https://api.openai.com/v1' }).cost_usd, 0.00219)
  assert.equal(regionMultiplier('luna6', 'https://eu.api.openai.com/v1'), 1.1)
  assert.equal(regionMultiplier('luna6', 'https://api.openai.com/v1'), 1)
  assert.equal(regionMultiplier('luna6', 'not a url'), 1)

  // Three web searches at $0.01: $0.00219 + $0.03 = $0.03219.
  near(callCostUsd('luna6', u, { webSearches: 3 }).cost_usd, 0.03219)

  // No usage, and an unpriced model, are reasons, not zeros.
  assert.equal(callCostUsd('luna6', null).reason, 'no_usage')
  assert.equal(callCostUsd('qwen', u).reason, 'unpriced_model')
})

test('a target without the new fields prices exactly as costUsd() does', () => {
  const u = normalizeUsage(CHAT_USAGE)!
  const expected = costUsd('luna', 10000, 3000, 4000, 2000)
  assert.equal(callCostUsd('luna', u).cost_usd, expected)
  // Not tier-managed: any reported tier is 1x Standard, and no regional or long-context multiplier applies.
  assert.equal(tiersManaged('luna'), false)
  assert.equal(callCostUsd('luna', u, { servedTier: 'ultrafast' }).cost_usd, expected)
  assert.deepEqual(tierInfo('luna', 'flex'), { tier: 'flex', label: 'Standard', multiplier: 1 })
  assert.equal(callCostUsd('luna', u, { baseURL: 'https://eu.api.openai.com/v1' }).cost_usd, expected)
  const big = normalizeUsage({ prompt_tokens: 300000, completion_tokens: 1000 })!
  assert.equal(callCostUsd('luna', big).cost_usd, costUsd('luna', 300000, 1000))
  assert.equal(callCostUsd('luna', big).long_context, false)
})

test('normalizeUsage reads both API shapes and returns null for missing usage', () => {
  assert.deepEqual(normalizeUsage(CHAT_USAGE), {
    prompt_tokens: 10000, cached_tokens: 4000, cache_write_tokens: 2000, completion_tokens: 3000, reasoning_tokens: 2500,
  })
  assert.deepEqual(normalizeUsage({
    input_tokens: 8000, output_tokens: 1200, total_tokens: 9200,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 8000 },
    output_tokens_details: { reasoning_tokens: 900 },
  }), { prompt_tokens: 8000, cached_tokens: 0, cache_write_tokens: 8000, completion_tokens: 1200, reasoning_tokens: 900 })
  // Details absent: null, never 0.
  assert.deepEqual(normalizeUsage({ prompt_tokens: 5, completion_tokens: 1 }), {
    prompt_tokens: 5, cached_tokens: null, cache_write_tokens: null, completion_tokens: 1, reasoning_tokens: null,
  })
  assert.equal(normalizeUsage(undefined), null)
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage({}), null)
  assert.equal(normalizeUsage({ total_tokens: 7 }), null)
})

test('reservationUnitUsd is the hand-computed worst case of one chunk, and pure', () => {
  // luna6, k = 2, B = 100,000, T = 1,500, cap = 64,000; upper input rate max($0.10, $0.125) = $0.125.
  //   call 0: input 100,000 + 0 + 32 x 1 = 100,032 -> x $0.125 = $0.012504; output 64,000 x $0.50 = $0.032.
  //   call 1: input 100,000 + (2 x 64,000 + 1,500) + 32 x 3 = 229,596 (< 272K) -> $0.0286995; output $0.032.
  //   U = 0.044504 + 0.0606995 = $0.1052035.
  assert.equal(upperInputRatePerMTok('luna6'), 0.125)
  const opts = { callsPerUnit: 2, maxPromptBytes: 100000, followUpTemplateBytes: 1500, outputCap: 64000 }
  const u = reservationUnitUsd('luna6', opts)
  near(u, 0.1052035)
  assert.equal(reservationUnitUsd('luna6', opts), u)
  assert.equal(reservationUnitUsd('luna6', opts), u)
  // Tier and region scale it: Flex is half.
  near(reservationUnitUsd('luna6', { ...opts, servedTier: 'flex' }), 0.1052035 / 2)
  assert.equal(reservationUnitUsd('luna6', { ...opts, servedTier: 'ultrafast' }), null)
  // One call's bound: (100,032 x $0.125 + 64,000 x $0.50) / 1M = $0.044504.
  near(worstCaseCallUsd('luna6', { promptBytes: 100000, outputCap: 64000 }), 0.044504)
})

test('per-call holds: one call\'s own worst case, from its own prompt bytes', () => {
  // Two messages: 10 + 4 bytes of text, 32 bytes framing each -> 78.
  assert.equal(callPromptBytes([{ role: 'user', content: 'a'.repeat(10) }, { role: 'assistant', content: 'ü'.repeat(2) }]), 78)
  assert.equal(callPromptBytes(undefined), 0)
  // luna6, 20,032 bytes, cap 64,000: (20,032 x $0.125 + 64,000 x $0.50) / 1M = $0.034504.
  near(callReservationUsd('luna6', { promptBytes: 20032, outputCap: 64000 }), 0.034504)
  near(callReservationUsd('luna6', { promptBytes: 20032, outputCap: 64000, servedTier: 'flex' }), 0.034504 / 2)
  assert.equal(callReservationUsd('luna6', { promptBytes: 1, outputCap: 1, servedTier: 'ultrafast' }), null)
  assert.equal(callReservationUsd('qwen', { promptBytes: 1, outputCap: 1 }), null)
  // Past 272K the long-context multipliers apply: (300,000 x 0.125 x 2 + 64,000 x 0.5 x 1.5) / 1M.
  near(callReservationUsd('luna6', { promptBytes: 300000, outputCap: 64000 }), 0.075 + 0.048)
  // Agrees with the one-call bound already booked for unmeasured calls (which adds one framing).
  near(callReservationUsd('luna6', { promptBytes: 100032, outputCap: 64000 }), worstCaseCallUsd('luna6', { promptBytes: 100000, outputCap: 64000 })!)
  // The plan's figures: the same call-i bounds as U, one call at a time; they sum to U.
  const opts = { callsPerUnit: 2, maxPromptBytes: 100000, followUpTemplateBytes: 1500, outputCap: 64000 }
  const per = planCallReservationsUsd('luna6', opts)!
  near(per.first_usd, 0.044504)
  near(per.max_usd, 0.0606995)
  near(per.first_usd + per.max_usd, reservationUnitUsd('luna6', opts)!)
  assert.equal(planCallReservationsUsd('luna6', { ...opts, servedTier: 'ultrafast' }), null)
})

test('scanCostUsd matches the hand-computed run-6-sized estimate on luna6', () => {
  // I = 7,174,088, R = 0.341.
  //   C_in  = 7,174,088 x $0.125 / 1M = $0.896761
  //   out   = round(7,174,088 x 0.341) = round(2,446,364.008) = 2,446,364 tokens
  //   C_out = 2,446,364 x $0.50 / 1M = $1.223182
  //   scan  = $2.119943
  const s = scanCostUsd('luna6', { inputTokens: 7174088, ratioR: 0.341 })!
  near(s.input_usd, 0.896761, 1e-9)
  assert.equal(s.output_tokens, 2446364)
  near(s.output_usd, 1.223182, 1e-9)
  near(s.scan_usd, 2.119943, 1e-9)
  assert.equal(scanCostUsd('qwen', { inputTokens: 1, ratioR: 1 }), null)
  assert.equal(FOLLOW_UP_INPUT_MULTIPLIER, 1.19)
})

test('estimateBandPct follows the resampled boundaries', () => {
  assert.equal(estimateBandPct(9), null)
  assert.equal(estimateBandPct(10), 78)
  assert.equal(estimateBandPct(39), 78)
  assert.equal(estimateBandPct(40), 27)
  assert.equal(estimateBandPct(100), 15)
  assert.equal(estimateBandPct(299), 15)
  assert.equal(estimateBandPct(300), 7)
})

function entry(source: 'recon' | 'hunt', cost: number, extra: Partial<LedgerEntry> = {}): Omit<LedgerEntry, 'schema' | 'at'> {
  const usage: NormalizedUsage = { prompt_tokens: 1000, cached_tokens: 0, cache_write_tokens: 1000, completion_tokens: 200, reasoning_tokens: 100 }
  return {
    source, stage: source === 'recon' ? 'stage0-recon' : 'stage2-hunt-lanes-perfile', label: 'call',
    lane_id: source === 'hunt' ? 'file-0001' : null, attempt: 1, model: 'm', served_tier: 'default',
    usage, chars_sent: 4200, cost_usd: cost, basis: 'actual', ...extra,
  }
}

test('SpendLedger appends, reloads, ignores a torn line, resets, and splits by source', () => {
  const dir = tmp('secscan-ledger-')
  try {
    const path = ledgerPathFor(dir, 'luna6')
    assert.equal(path, join(dir, 'luna6', LEDGER_FILE))
    // A missing file is zeros.
    assert.equal(readLedgerTotals(path).total_usd, 0)
    assert.equal(readLedgerTotals(path).calls, 0)

    const a = new SpendLedger(path)
    a.append(entry('recon', 0.01))
    a.append(entry('hunt', 0.25))
    a.append(entry('hunt', 0.5, { usage: null, basis: 'reservation', chars_sent: 9000 }))
    // 0.01 + 0.25 + 0.5 = 0.76
    near(a.total(), 0.76)

    // Resume: a new ledger on the same file continues the same total.
    const b = new SpendLedger(path)
    near(b.total(), 0.76)
    const t = b.totals()
    near(t.by_source.recon, 0.01)
    near(t.by_source.hunt, 0.75)
    assert.equal(t.calls, 3)
    assert.equal(t.reserved_calls, 1)
    assert.equal(t.prompt_tokens, 2000)
    assert.equal(t.completion_tokens, 400)
    // chars over the calls that also have prompt tokens: 4,200 x 2 = 8,400 for 2,000 tokens.
    assert.equal(t.chars_sent, 4200 + 4200 + 9000)
    assert.equal(t.prompt_tokens_with_chars, 2000)
    assert.equal(t.chars_with_prompt_tokens, 8400)

    // A crash mid-append leaves a torn last line: ignored on read.
    appendFileSync(path, '{"schema":"secscan.ledger/1","at":"x","source":"hunt","cost_us')
    near(readLedgerTotals(path).total_usd, 0.76)
    // ...and the next append still lands as a line of its own.
    const c = new SpendLedger(path)
    near(c.total(), 0.76)
    c.append(entry('hunt', 0.04))
    near(readLedgerTotals(path).total_usd, 0.8)
    near(new SpendLedger(path).total(), 0.8)

    c.reset()
    assert.equal(c.total(), 0)
    assert.equal(readLedgerTotals(path).calls, 0)
    assert.equal(readFileSync(path, 'utf8'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rate-limit headers and reset durations parse', () => {
  assert.deepEqual(
    parseRateLimitHeaders(new Headers({ 'x-ratelimit-limit-tokens': '2000000', 'x-ratelimit-limit-requests': '5000' })),
    { requests_per_minute: 5000, tokens_per_minute: 2000000 })
  assert.deepEqual(
    parseRateLimitHeaders({ 'X-RateLimit-Limit-Tokens': '30000', 'x-ratelimit-limit-requests': ['500'] }),
    { requests_per_minute: 500, tokens_per_minute: 30000 })
  assert.deepEqual(parseRateLimitHeaders(null), { requests_per_minute: null, tokens_per_minute: null })
  assert.deepEqual(parseRateLimitHeaders({ 'x-ratelimit-limit-tokens': 'lots' }), { requests_per_minute: null, tokens_per_minute: null })

  assert.equal(parseResetMs('12ms'), 12)
  assert.equal(parseResetMs('1s'), 1000)
  assert.equal(parseResetMs('6m0s'), 360000)
  // 1 h + 2 min + 3.5 s = 3,600,000 + 120,000 + 3,500
  assert.equal(parseResetMs('1h2m3.5s'), 3723500)
  assert.equal(parseResetMs('garbage'), null)
  assert.equal(parseResetMs(''), null)
  assert.equal(parseResetMs('5'), null)
  assert.equal(parseResetMs(null), null)
})

test('API profile round-trips', () => {
  const dir = tmp('secscan-profile-')
  try {
    const path = join(dir, 'stage0-recon', 'api-profile.json')
    assert.equal(readApiProfile(path), null)
    const p = {
      schema: API_PROFILE_SCHEMA, observed_at: '2026-10-12T00:00:00.000Z', provider: 'luna6', model: 'm',
      served_tier: 'default', tier_label: 'Standard', tier_multiplier: 1,
      rate_limits: { requests_per_minute: 5000, tokens_per_minute: 2000000 }, recon_calls: 3, chars_per_token: 3.9,
    } as const
    writeApiProfile(path, p)
    assert.deepEqual(readApiProfile(path), p)
    writeFileSync(path, '{"schema":"other"}')
    assert.equal(readApiProfile(path), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrency follows the rate limits, and steps down by a quarter', () => {
  const base = { promptTokensPerCall: 6630, outputTokensPerCall: 2260, secondsPerCall: 23.2 }
  // Build tier: per slot (6,630 + 2,260) x 60 / 23.2 = 22,991 TPM.
  //   by tokens 0.7 x 2,000,000 / 22,991 = 60.9 -> 60; by requests 0.7 x 5,000 x 23.2 / 60 = 1,353.
  //   min(32, 60, 1,353) = 32: the ceiling binds.
  assert.equal(concurrencyFromRateLimits({ ...base, tokensPerMinute: 2000000, requestsPerMinute: 5000 })?.value, 32)
  // 30,000 TPM: 0.7 x 30,000 / 22,991 = 0.91 -> 0, held at 1.
  assert.equal(concurrencyFromRateLimits({ ...base, tokensPerMinute: 30000, requestsPerMinute: null })?.value, 1)
  // 200,000 TPM: 0.7 x 200,000 / 22,991 = 6.09 -> 6.
  assert.equal(concurrencyFromRateLimits({ ...base, tokensPerMinute: 200000, requestsPerMinute: null })?.value, 6)
  assert.equal(concurrencyFromRateLimits({ ...base, tokensPerMinute: null, requestsPerMinute: null }), null)
  assert.equal(stepDown(32), 24)
  assert.equal(stepDown(8), 6)
  assert.equal(stepDown(1), 1)
})

test('API errors classify, and Retry-After is read and capped', () => {
  assert.equal(classifyApiError({ status: 429, code: 'insufficient_quota' }), 'quota')
  assert.equal(classifyApiError({ status: 429, error: { code: 'project_spend_limit_exceeded' } }), 'quota')
  assert.equal(classifyApiError({ status: 429, error: { type: 'billing_hard_limit_reached' } }), 'quota')
  assert.equal(classifyApiError({ status: 429, code: 'rate_limit_exceeded', type: 'tokens' }), 'rate_limit')
  assert.equal(classifyApiError({ status: 503 }), 'transient')
  assert.equal(classifyApiError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), 'transient')
  assert.equal(classifyApiError({ status: 400, message: "Invalid schema for response_format 'hunt_output': json_schema strict mode" }), 'schema')
  assert.equal(classifyApiError({ status: 400, message: 'Unrecognized request argument' }), 'fatal')
  assert.equal(classifyApiError({ status: 401 }), 'fatal')

  assert.equal(retryAfterMs({ headers: { 'retry-after': '5' } }), 5000)
  assert.equal(retryAfterMs({ headers: { 'retry-after': '120' } }), 60000)
  assert.equal(retryAfterMs({ headers: new Headers({ 'retry-after-ms': '250' }) }), 250)
  assert.equal(retryAfterMs({ headers: new Headers({ 'x-ratelimit-reset-tokens': '1s', 'x-ratelimit-reset-requests': '12ms' }) }), 1000)
  assert.equal(retryAfterMs({ headers: { 'x-ratelimit-reset-tokens': '6m0s' } }), 60000)
  assert.equal(retryAfterMs({ status: 429 }), null)
})

function fakeClient(response: unknown, opts: { withResponse: boolean; headers?: Record<string, string>; baseURL?: string }) {
  const sent: any[] = []
  const client = {
    baseURL: opts.baseURL,
    chat: {
      completions: {
        create(params: any) {
          sent.push(params)
          const p: any = Promise.resolve(response)
          if (opts.withResponse) {
            p.withResponse = async () => ({ data: response, response: { headers: new Headers(opts.headers ?? {}) } })
          }
          return p
        },
      },
    },
  }
  return { client, sent }
}

test('meteredChatCompletion pins the tier only where it is managed, and keeps the headers', async () => {
  const response = { choices: [{ message: { content: '{}' } }], usage: CHAT_USAGE, service_tier: 'default' }
  const params = { model: 'm', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] }

  // No pin: no service_tier sent, even on a managed target.
  const a = fakeClient(response, { withResponse: true, headers: { 'x-ratelimit-limit-tokens': '2000000' } })
  const ra = await meteredChatCompletion(a.client, 'luna6', params, { send: null })
  assert.equal('service_tier' in a.sent[0], false)
  assert.equal(ra.servedTier, 'default')
  assert.equal(ra.headers?.get('x-ratelimit-limit-tokens'), '2000000')
  near(ra.cost.cost_usd, 0.00219)
  assert.equal(ra.charsSent, 7)
  assert.deepEqual(ra.usage, normalizeUsage(CHAT_USAGE))

  // Pinned on a managed target: sent, and the caller's params are not mutated.
  const b = fakeClient(response, { withResponse: true })
  await meteredChatCompletion(b.client, 'luna6', params, { send: 'flex' })
  assert.equal(b.sent[0].service_tier, 'flex')
  assert.equal('service_tier' in params, false)

  // A target without service_tiers never sends one.
  const c = fakeClient(response, { withResponse: true })
  await meteredChatCompletion(c.client, 'luna', params, { send: 'flex' })
  assert.equal('service_tier' in c.sent[0], false)

  // A client whose promise has no withResponse (the claude-cli client): headers null.
  const d = fakeClient({ ...response, service_tier: undefined }, { withResponse: false })
  const rd = await meteredChatCompletion(d.client, 'luna6', params, { send: null })
  assert.equal(rd.headers, null)
  assert.equal(rd.servedTier, null)
  near(rd.cost.cost_usd, 0.00219)

  // The client's base URL prices the region.
  const e = fakeClient(response, { withResponse: false, baseURL: 'https://eu.api.openai.com/v1' })
  near((await meteredChatCompletion(e.client, 'luna6', params, { send: null })).cost.cost_usd, 0.002409)

  assert.equal(promptChars([{ role: 'user', content: [{ type: 'text', text: 'abc' }, { type: 'image_url' }] }]), 3)
})

function run(id: string, model: string, effort: string, input: number, output: number, chars: number, forChars: number): CalibrationRun {
  return {
    run_id: id, at: '2026-10-12T00:00:00.000Z', model, effort, files: 1, calls: 2, input_tokens: input,
    output_tokens: output, chars_sent: chars, prompt_tokens_for_chars: forChars,
    ratio_R: output / input, chars_per_token: chars / forChars,
  }
}

test('calibration is token-weighted, keeps the last 20, and never mixes models or efforts', () => {
  const dir = tmp('secscan-cal-')
  try {
    assert.deepEqual(calibratedRatios(dir, 'm', 'high'), { ratio_R: null, chars_per_token: null, runs: 0 })
    recordCalibration(dir, run('a', 'm', 'high', 1000, 300, 4000, 1000))
    recordCalibration(dir, run('b', 'm', 'high', 3000, 1500, 9000, 3000))
    // Token-weighted R: (300 + 1,500) / (1,000 + 3,000) = 0.45, not the mean of 0.3 and 0.5 (0.4).
    // Chars per token: (4,000 + 9,000) / (1,000 + 3,000) = 3.25.
    const r = calibratedRatios(dir, 'm', 'high')
    near(r.ratio_R, 0.45)
    near(r.chars_per_token, 3.25)
    assert.equal(r.runs, 2)
    // Another model, or another effort, is not mixed in.
    recordCalibration(dir, run('c', 'other', 'high', 1000, 900, 1000, 1000))
    recordCalibration(dir, run('d', 'm', 'low', 1000, 100, 1000, 1000))
    near(calibratedRatios(dir, 'm', 'high').ratio_R, 0.45)
    near(calibratedRatios(dir, 'other', 'high').ratio_R, 0.9)
    // Re-recording a run id replaces it rather than counting it twice.
    recordCalibration(dir, run('b', 'm', 'high', 3000, 1500, 9000, 3000))
    assert.equal(calibratedRatios(dir, 'm', 'high').runs, 2)
    // Only the last 20 runs are kept.
    for (let i = 0; i < 25; i++) recordCalibration(dir, run(`x${i}`, 'm', 'high', 1000, 100, 1000, 1000))
    const kept = readCalibration(dir)
    assert.equal(kept.length, 20)
    assert.equal(kept[0].run_id, 'x5')
    assert.equal(kept[19].run_id, 'x24')
    near(calibratedRatios(dir, 'm', 'high').ratio_R, 0.1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run context: reportsRoot defaults into the target, can be overridden, and is null in the lab', () => {
  const dir = tmp('secscan-ctx-')
  try {
    const target = join(dir, 'repo')
    mkdirSync(target)
    const ctx = resolveRunContext({ SCANNER_TARGET: target, SCANNER_RUN_ID: 'r1' }, [], dir)
    assert.equal(ctx.profile, 'product')
    assert.equal(ctx.reportsRoot, join(ctx.targetRoot, PRODUCT_DIRNAME))
    // Unchanged from before reportsRoot existed: <target>/.secscan/runs/<run-id>.
    assert.equal(ctx.runsRoot, join(ctx.targetRoot, PRODUCT_DIRNAME, 'runs', 'r1'))

    const reports = join(dir, 'reports')
    const o = resolveRunContext({ SCANNER_TARGET: target, SCANNER_RUN_ID: 'r1', SCANNER_REPORTS_ROOT: reports }, [], dir)
    assert.equal(o.reportsRoot, reports)
    assert.equal(o.runsRoot, join(reports, 'runs', 'r1'))
    // An explicit runs root still wins over both.
    const runs = join(dir, 'elsewhere')
    const e = resolveRunContext({ SCANNER_TARGET: target, SCANNER_RUNS_ROOT: runs, SCANNER_REPORTS_ROOT: reports }, [], dir)
    assert.equal(e.runsRoot, runs)
    assert.equal(e.reportsRoot, reports)

    const lab = resolveRunContext({}, [], dir)
    assert.equal(lab.profile, 'benchmark')
    assert.equal(lab.reportsRoot, null)
    assert.equal(lab.runsRoot, BENCHMARK_RUNS_ROOT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the registry validates the new fields loudly, and an overlay may declare them', () => {
  const dir = tmp('secscan-reg-')
  const overlay = (t: Record<string, unknown>) => {
    const p = join(dir, `o${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(p, JSON.stringify({ targets: { mine: t } }))
    return { SCANNER_MODELS_FILE: p }
  }
  const base = {
    label: 'Mine', model: 'my-model', model_env: 'MY_MODEL', api_key_env: 'MY_KEY',
    base_url: null, base_url_env: 'MY_BASE', token_limit_param: 'max_tokens', sampling: {},
  }
  try {
    const ok = loadRegistry(overlay({
      ...base,
      long_context: { threshold_tokens: 1000, input_multiplier: 2, output_multiplier: 1.5 },
      service_tiers: { default: { multiplier: 1, label: 'Standard' } },
      regional_endpoint_pattern: '^eu\\.', regional_uplift: 1.1,
      web_search_usd_per_call: 0, calibration: { output_per_input: 0.3, chars_per_token: 4, seconds_per_call: 20, source: 'mine' },
    }))
    assert.equal(ok.targets.mine.service_tiers?.default.label, 'Standard')
    for (const bad of [
      { long_context: { threshold_tokens: 0, input_multiplier: 2, output_multiplier: 1 } },
      { long_context: { threshold_tokens: 1000, input_multiplier: '2', output_multiplier: 1 } },
      { service_tiers: {} },
      { service_tiers: { flex: { multiplier: -1, label: 'Flex' } } },
      { service_tiers: { flex: { multiplier: 0.5 } } },
      { regional_endpoint_pattern: '(', regional_uplift: 1.1 },
      { regional_endpoint_pattern: '^eu\\.' },
      { regional_uplift: 1.1 },
      { web_search_usd_per_call: -0.01 },
      { calibration: { output_per_input: 0.3, chars_per_token: 4, seconds_per_call: 20 } },
    ]) {
      assert.throws(() => loadRegistry(overlay({ ...base, ...bad })), undefined, JSON.stringify(bad))
    }
    // The shipped file names a product default that is a shipped target.
    const shipped = loadRegistry({})
    assert.equal(shipped.product_default_provider, 'luna6')
    assert.equal(shipped.default_provider, 'luna')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
