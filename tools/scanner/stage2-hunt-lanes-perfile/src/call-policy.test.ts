import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HuntCallPolicy, HuntCallError, resumeConcurrency, type CallPolicyOptions } from './call-policy.js'
import { createClient } from './llm-client.js'
import { waitForLaneAdmission, scanPlanCallMismatch, fullLedgerEstimate } from './hunt-executor.js'
import { countNotStartedLanes, type UnscannedLane } from '../../stage1-budget-governor/src/run-status.js'
import { SpendGate } from '../../stage1-budget-governor/src/spend-gate.js'
import { SpendLedger } from '../../shared/ledger.js'
import { apiKeyEnvFor, defaultProvider, modelFor, productDefaultProvider } from '../../shared/provider.js'
import { callCostUsd, normalizeUsage } from '../../shared/pricing.js'

const provider = productDefaultProvider()
const params = { model: modelFor(provider), messages: [{ role: 'user', content: 'tiny fake prompt' }], response_format: { type: 'json_schema' } }
const ok = (extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20 }, ...extra,
})

function fixture(t: TestContext, extra: Partial<CallPolicyOptions> = {}, cap: number | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'hunt-policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'))
  const gate = new SpendGate({ capUsd: cap, deadlineMs: null, ledgerTotal: () => ledger.total() })
  gate.begin('lane', 0.1)
  const stops: string[] = []
  const waits: number[] = []
  const policy = new HuntCallPolicy({
    provider, ledger, gate, reservationUnitUsd: 0.1, pin: { send: 'flex' }, concurrency: 8,
    onStop: reason => { stops.push(reason) }, sleep: async ms => { waits.push(ms) }, ...extra,
  })
  return { ledger, gate, policy, stops, waits }
}

function fake(results: any[]) {
  const sent: any[] = []
  const client = { chat: { completions: { create: async (body: any) => {
    sent.push(body)
    const r = results.shift()
    if (r instanceof Error) throw r
    assert.ok(r, 'unexpected extra model attempt')
    return r
  } } } }
  return { client, sent }
}
const apiError = (status: number, details: Record<string, unknown> = {}) => Object.assign(new Error('fake provider error'), { status, ...details })

test('each successful call pins recon tier, books actual served-tier cost and appends on resume', async t => {
  const { policy, ledger } = fixture(t)
  const response = ok({ service_tier: 'flex' })
  const { client, sent } = fake([response])
  await policy.call(client, params, 'lane', 'chunk 0 pass 0')
  assert.equal(sent[0].service_tier, 'flex')
  assert.equal(ledger.list()[0].basis, 'actual')
  assert.equal(ledger.total(), callCostUsd(provider, normalizeUsage(response.usage), { servedTier: 'flex' }).cost_usd)
  assert.equal(new SpendLedger(ledger.path).total(), ledger.total())
  assert.equal(ledger.list()[0].chars_sent, params.messages[0].content.length)
})

test('targets without tier management omit service_tier', async t => {
  const { policy } = fixture(t, { provider: defaultProvider() })
  const { client, sent } = fake([ok()])
  await policy.call(client, params, 'lane', 'chunk')
  assert.equal('service_tier' in sent[0], false)
})

test('no usage is booked at the fixed U, including a failed network attempt', async t => {
  const { policy, ledger, gate } = fixture(t)
  const { client, sent } = fake([apiError(503), ok({ usage: undefined })])
  await policy.call(client, params, 'lane', 'chunk')
  assert.equal(sent.length, 2)
  assert.equal(ledger.total(), 0.2)
  assert.deepEqual(ledger.list().map(e => [e.attempt, e.basis]), [[1, 'reservation'], [2, 'reservation']])
  assert.equal(gate.snapshot().in_flight_projected_usd, 0.2)
  gate.finish('lane')
  assert.equal(gate.spentUsd(), 0.2)
})

for (const [name, choice] of [
  ['empty', { message: { content: '' }, finish_reason: 'stop' }],
  ['cut-off', { message: { content: '{' }, finish_reason: 'length' }],
] as const) {
  test(`${name} answers consume three attempts and fail the file`, async t => {
    const { policy, ledger } = fixture(t)
    const { client, sent } = fake(Array.from({ length: 3 }, () => ok({ choices: [choice] })))
    await assert.rejects(policy.call(client, params, 'lane', 'chunk'), /failed after 3 attempts/)
    assert.equal(sent.length, 3)
    assert.equal(ledger.list().length, 3)
    assert.deepEqual(ledger.list().map(e => e.attempt), [1, 2, 3])
  })
}

test('schema fallback shares the three-attempt limit and ledger', async t => {
  const { policy, ledger } = fixture(t)
  const { client, sent } = fake([
    apiError(400, { message: 'json_schema unsupported' }), apiError(502), ok(),
  ])
  await policy.call(client, params, 'lane', 'chunk')
  assert.deepEqual(sent.map(p => p.response_format.type), ['json_schema', 'json_object', 'json_object'])
  assert.equal(ledger.list().length, 3)
})

for (const code of ['insufficient_quota', 'project_spend_limit_exceeded', 'organization_spend_limit_exceeded', 'billing_limit']) {
  test(`quota ${code} stops immediately and subsequent files make no calls`, async t => {
    const { policy, ledger, stops } = fixture(t)
    const { client, sent } = fake([apiError(429, { code })])
    await assert.rejects(policy.call(client, params, 'lane', 'chunk'), (e: HuntCallError) => e.stopReason === 'provider_quota')
    await assert.rejects(policy.call(client, params, 'other', 'chunk'), (e: HuntCallError) => e.stopReason === 'provider_quota')
    assert.equal(sent.length, 1)
    assert.equal(ledger.list().length, 1)
    assert.deepEqual(stops, ['provider_quota'])
    assert.equal(policy.currentConcurrency, 8)
  })
}

test('429 steps concurrency down once per minute and waits the capped reset header', async t => {
  let now = 0
  const { policy, waits } = fixture(t, { now: () => now })
  const { client } = fake([
    apiError(429, { headers: { 'retry-after': '120' } }),
    apiError(429, { headers: { 'x-ratelimit-reset-tokens': '3s' } }), ok(),
    apiError(429, { headers: { 'retry-after': '0' } }), ok(),
  ])
  await policy.call(client, params, 'lane', 'chunk')
  assert.equal(policy.currentConcurrency, 6)
  assert.equal(policy.stepDowns, 1)
  assert.deepEqual(waits, [60_000, 3000])
  now = 60_000
  await policy.call(client, params, 'lane', 'chunk 2')
  assert.equal(policy.currentConcurrency, 4)
  assert.equal(policy.stepDowns, 2)
  assert.equal(policy.initialConcurrency, 8)
})

test('retry reservation refusal stops at max_cost without making another attempt', async t => {
  const { policy, ledger, stops, gate } = fixture(t, {}, 0.25)
  const { client, sent } = fake([apiError(503)])
  await assert.rejects(policy.call(client, params, 'lane', 'chunk'), (e: HuntCallError) => e.stopReason === 'max_cost')
  assert.equal(sent.length, 1)
  assert.equal(ledger.total(), 0.1)
  assert.equal(gate.snapshot().in_flight_projected_usd, 0.1)
  assert.deepEqual(stops, ['max_cost'])
})

test('three consecutive failed files stop in completion order; success resets the streak', t => {
  const { policy, stops } = fixture(t)
  policy.laneFinished(true)
  policy.laneFinished(true)
  policy.laneFinished(false)
  policy.laneFinished(true)
  policy.laneFinished(true)
  assert.deepEqual(stops, [])
  policy.laneFinished(true)
  assert.deepEqual(stops, ['provider_failing'])
})

for (const usage of [{ prompt_tokens: 100, completion_tokens: 20 }, undefined]) {
  test(`an unpriced served tier stops even ${usage ? 'with' : 'without'} usage`, async t => {
    const { policy, ledger, stops } = fixture(t)
    const { client, sent } = fake([ok({ service_tier: 'unlisted-tier', usage })])
    await assert.rejects(policy.call(client, params, 'lane', 'chunk'), (e: HuntCallError) => e.stopReason === 'unpriced_service_tier')
    assert.equal(sent.length, 1)
    assert.equal(ledger.list().length, 1)
    assert.deepEqual(stops, ['unpriced_service_tier'])
  })
}

test('the SDK has no retry layer', () => {
  const keyName = apiKeyEnvFor(provider)
  const previous = process.env[keyName]
  try {
    process.env[keyName] = 'fake-test-credential'
    assert.equal(createClient(provider).maxRetries, 0)
  } finally {
    if (previous === undefined) delete process.env[keyName]
    else process.env[keyName] = previous
  }
})

test('scheduler rechecks concurrency when a budget wait wakes after a 429 step-down', async () => {
  const gate = new SpendGate({ capUsd: 1, deadlineMs: null })
  const running = new Set<Promise<void>>()
  const finish: (() => void)[] = []
  for (let i = 0; i < 4; i++) {
    const id = `lane-${i}`
    gate.begin(id, 0.2)
    let resolve!: () => void
    const pending = new Promise<void>(r => { resolve = r })
    const tracked = pending.finally(() => { gate.finish(id, 0); running.delete(tracked) })
    running.add(tracked)
    finish.push(resolve)
  }
  let current = 5
  let admitted = false
  const decision = waitForLaneAdmission(gate, 0.4, running, () => current, () => false, () => { admitted = true })
  current = 3
  finish[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(gate.decide(0.4).action, 'start', 'budget permits the file now')
  assert.equal(running.size, 3)
  assert.equal(admitted, false, 'the lowered slot limit still prevents admission')
  finish[1]()
  assert.deepEqual(await decision, { action: 'start' })
  finish[2]()
  finish[3]()
  await Promise.all(running)
})

for (const reason of ['provider_quota', 'max_cost', 'unpriced_service_tier'] as const) {
  test(`status does not also count a file attempted before ${reason} as not started`, () => {
    const started = new Set(['attempted'])
    const unscanned: UnscannedLane[] = [
      { lane_id: 'attempted', target_file: 'a.ts', reason, detail: 'call stopped' },
      { lane_id: 'pending', target_file: 'b.ts', reason, detail: 'not launched' },
      { lane_id: 'excluded', target_file: 'c.ts', reason: 'over-max-files', detail: 'not admitted' },
    ]
    assert.equal(countNotStartedLanes(unscanned, started), 1)
    assert.equal(countNotStartedLanes(unscanned.slice(0, 1), started), 0)
  })
}

test("a quota stop during another lane's retry wait prevents its next attempt", async t => {
  let release!: () => void
  let waiting!: () => void
  const sleeping = new Promise<void>(resolve => { waiting = resolve })
  const { policy, ledger } = fixture(t, {
    sleep: () => { waiting(); return new Promise(resolve => { release = resolve }) },
  })
  const retry = fake([apiError(503)])
  const pending = policy.call(retry.client, params, 'lane', 'chunk')
  await sleeping
  const quota = fake([apiError(429, { code: 'insufficient_quota' })])
  await assert.rejects(policy.call(quota.client, params, 'other', 'chunk'), (e: HuntCallError) => e.stopReason === 'provider_quota')
  release()
  await assert.rejects(pending, (e: HuntCallError) => e.stopReason === 'provider_quota')
  assert.equal(retry.sent.length, 1)
  assert.equal(ledger.list().length, 2)
})

test('usage-bearing failed HTTP attempts are booked at actual cost', async t => {
  const { policy, ledger } = fixture(t)
  const usage = { prompt_tokens: 100, completion_tokens: 10 }
  const { client } = fake([apiError(502, { usage, service_tier: 'priority' }), ok()])
  await policy.call(client, params, 'lane', 'chunk')
  const first = ledger.list()[0]
  assert.equal(first.basis, 'actual')
  assert.equal(first.served_tier, 'priority')
  assert.equal(first.cost_usd, callCostUsd(provider, normalizeUsage(usage), { servedTier: 'priority' }).cost_usd)
})

test('a resume preserves lowered concurrency and its original initial value', t => {
  const previous = { initial: 8, final: 6, step_downs: 1 }
  const state = resumeConcurrency(8, previous)
  assert.deepEqual(state, { concurrency: 6, initialConcurrency: 8, stepDowns: 1 })
  const { policy } = fixture(t, state)
  assert.equal(policy.currentConcurrency, 6)
  assert.equal(policy.initialConcurrency, 8)
  assert.equal(policy.stepDowns, 1)
  assert.equal(resumeConcurrency(12, previous).concurrency, 6, 'never climb back in this run')
  assert.equal(resumeConcurrency(4, previous).concurrency, 4)
})

test('fixed-U plans refuse changed model, cap, sampling, loop or endpoint before calls', () => {
  const current = {
    model: modelFor(provider), max_output_tokens: 100,
    sampling: { reasoning_effort: 'high' },
    loop: { mode: 'trace' as const, passes: 1, sweepGroupSize: 3, strictTrace: false },
    base_url: null,
  }
  const plan = { model: current.model, call_config: current }
  assert.equal(scanPlanCallMismatch(plan, current), null)
  assert.equal(scanPlanCallMismatch({ model: current.model }, current), null, 'old lab plans remain supported')
  for (const change of [
    { model: 'changed-model' }, { max_output_tokens: 101 },
    { sampling: { reasoning_effort: 'medium' } },
    { loop: { ...current.loop, passes: 2 } }, { base_url: 'changed-endpoint' },
  ]) {
    assert.notEqual(scanPlanCallMismatch(plan, { ...current, ...change }), null)
  }
})


test('an error response with an unpriced tier stops before retrying', async t => {
  const { policy, ledger, stops } = fixture(t)
  const { client, sent } = fake([apiError(502, { service_tier: 'unlisted-tier' }), ok()])
  await assert.rejects(policy.call(client, params, 'lane', 'chunk'),
    (e: HuntCallError) => e.stopReason === 'unpriced_service_tier')
  assert.equal(sent.length, 1)
  assert.equal(ledger.list()[0].served_tier, 'unlisted-tier')
  assert.deepEqual(stops, ['unpriced_service_tier'])
})


test('progress estimate includes the full ledger and only remaining projected work on resume', () => {
  const plan = { admitted: [
    { lane_id: 'done', projected_cost_usd: 2 }, { lane_id: 'next', projected_cost_usd: 3 },
  ] } as Parameters<typeof fullLedgerEstimate>[0]
  assert.equal(fullLedgerEstimate(plan, 0.7), 5.7)
  assert.equal(fullLedgerEstimate(plan, 2.1, new Set(['done'])), 5.1)
  assert.equal(fullLedgerEstimate(plan, 5.1, new Set(['done', 'next'])), 5.1)
  assert.equal(fullLedgerEstimate(null, 0.7), null)
  assert.equal(fullLedgerEstimate({ admitted: [{ projected_cost_usd: null }] } as any, 0.7), null)
})
