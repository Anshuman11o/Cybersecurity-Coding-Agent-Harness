/**
 * Pricing — what one model call costs, what the spend gate holds for it, and what a
 * scan is estimated to cost before it starts.
 *
 * Every rate and multiplier is registry data (models.json, read through
 * provider.ts). This file holds only the arithmetic, so the live ledger, Stage
 * 1's estimate and the spend gate all price a call the same way:
 *
 *   fresh = prompt_tokens - cached_tokens - cache_write_tokens
 *   cost  = tier x region x [ ctx_in x (fresh x in + cached x cached_in + written x cache_write)
 *                           + ctx_out x completion_tokens x out ] / 1,000,000
 *           + web_searches x web_search_usd_per_call
 *
 * A target that declares none of the optional fields (long_context,
 * service_tiers, regional_*, web_search_usd_per_call) gets 1 for every
 * multiplier and therefore exactly costUsd()'s number — the lab's targets price
 * as they always have.
 *
 * Zero dependencies (node builtins only) so it can be imported across stage
 * package boundaries without its own node_modules.
 */
import {
  pricingFor,
  longContextFor,
  serviceTiersFor,
  regionalEndpointFor,
  webSearchUsdPerCall,
  type Provider,
} from './provider.js'

/**
 * A follow-up turn's input as a multiple of the turn-1 prompt.
 *
 * A conversational follow-up does not re-send the prompt — it continues the
 * transcript, so it pays for the prompt again plus the assistant's answer plus
 * its own instruction. Measured 1.19x on the 40-lane platform. Treating it as a
 * second full prompt would overstate a looped run's input by about 40%.
 *
 * Moved here from Stage 1's budget governor, which imports it, so the plan and
 * the run estimate share one figure.
 */
export const FOLLOW_UP_INPUT_MULTIPLIER = 1.19

/**
 * One call's token counts, in either API's spelling. Completion tokens include
 * reasoning tokens (reasoning is billed as output); `reasoning_tokens` is the
 * breakdown, never added on top. Null is "the response did not say", never 0.
 */
export interface NormalizedUsage {
  prompt_tokens: number | null
  cached_tokens: number | null
  cache_write_tokens: number | null
  completion_tokens: number | null
  reasoning_tokens: number | null
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * Normalize a response's `usage`. Accepts the Chat Completions shape
 * (prompt_tokens, completion_tokens, prompt_tokens_details, completion_tokens_details)
 * and the Responses shape (input_tokens, output_tokens, input_tokens_details,
 * output_tokens_details). Null when there is no usage or it carries no token
 * counts — a call that cannot be priced from its own response.
 */
export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (raw == null || typeof raw !== 'object') return null
  const u = raw as Record<string, any>
  const chat = 'prompt_tokens' in u || 'completion_tokens' in u
  const prompt = count(chat ? u.prompt_tokens : u.input_tokens)
  const completion = count(chat ? u.completion_tokens : u.output_tokens)
  if (prompt === null && completion === null) return null
  const inDetails = (chat ? u.prompt_tokens_details : u.input_tokens_details) ?? {}
  const outDetails = (chat ? u.completion_tokens_details : u.output_tokens_details) ?? {}
  return {
    prompt_tokens: prompt,
    cached_tokens: count(inDetails?.cached_tokens),
    cache_write_tokens: count(inDetails?.cache_write_tokens),
    completion_tokens: completion,
    reasoning_tokens: count(outDetails?.reasoning_tokens),
  }
}

/** The tier a call was served at, its price-list name and its multiplier (null: unpriced). */
export interface TierInfo {
  tier: string | null
  label: string
  multiplier: number | null
}

/** True when the target declares `service_tiers`, so the scanner records and pins the tier. */
export function tiersManaged(provider: Provider): boolean {
  return serviceTiersFor(provider) !== null
}

/**
 * Price a served tier. A target that does not manage tiers is always 1x
 * "Standard" — what it was billed as before tiers were modelled. A response
 * with no `service_tier` is 1x. A tier string the registry does not list is
 * unpriced (multiplier null): billing it at a guess would be quietly wrong, so
 * the caller stops the run instead.
 */
export function tierInfo(provider: Provider, servedTier: string | null | undefined): TierInfo {
  const tiers = serviceTiersFor(provider)
  const tier = servedTier ? servedTier : null
  if (!tiers) return { tier, label: 'Standard', multiplier: 1 }
  if (tier === null) return { tier: null, label: tiers.default?.label ?? 'Standard', multiplier: 1 }
  const t = tiers[tier]
  if (!t) return { tier, label: tier, multiplier: null }
  return { tier, label: t.label, multiplier: t.multiplier }
}

/** `regional_uplift` when the base URL's host matches the target's regional pattern, else 1. */
export function regionMultiplier(provider: Provider, baseURL: string | null | undefined): number {
  const r = regionalEndpointFor(provider)
  if (!r || !baseURL) return 1
  let host: string
  try {
    host = new URL(baseURL).hostname
  } catch {
    return 1
  }
  return r.pattern.test(host) ? r.uplift : 1
}

/**
 * The input rate a bound must use: the higher of fresh input and cache write.
 * Cache writes are billed automatically on a prompt's first send, so a bound
 * priced at the fresh rate would undershoot exactly the first call of a chunk.
 */
export function upperInputRatePerMTok(provider: Provider): number | null {
  const p = pricingFor(provider)
  if (!p) return null
  return Math.max(p.input, p.cache_write ?? p.input)
}

export interface CallCost {
  cost_usd: number | null
  reason: null | 'unpriced_model' | 'unpriced_service_tier' | 'no_usage'
  tier: TierInfo
  /** The request passed the long-context threshold and was priced at its multipliers. */
  long_context: boolean
}

function longContextMultipliers(provider: Provider, promptTokens: number): { inM: number; outM: number; long: boolean } {
  const lc = longContextFor(provider)
  if (lc && promptTokens > lc.threshold_tokens) {
    return { inM: lc.input_multiplier, outM: lc.output_multiplier, long: true }
  }
  return { inM: 1, outM: 1, long: false }
}

/** The actual cost of one call, from its own usage and served tier. */
export function callCostUsd(
  provider: Provider,
  usage: NormalizedUsage | null,
  opts: { servedTier?: string | null; baseURL?: string | null; webSearches?: number } = {},
): CallCost {
  const tier = tierInfo(provider, opts.servedTier)
  const p = pricingFor(provider)
  if (!p) return { cost_usd: null, reason: 'unpriced_model', tier, long_context: false }
  if (!usage) return { cost_usd: null, reason: 'no_usage', tier, long_context: false }
  if (tier.multiplier === null) return { cost_usd: null, reason: 'unpriced_service_tier', tier, long_context: false }

  // Clamped as costUsd() clamps, so a target without the new fields prices to
  // exactly the same number, term for term.
  const prompt = usage.prompt_tokens ?? 0
  const cached = Math.min(usage.cached_tokens ?? 0, prompt)
  const written = Math.min(usage.cache_write_tokens ?? 0, prompt - cached)
  const fresh = prompt - cached - written
  const completion = usage.completion_tokens ?? 0
  const cachedRate = p.cached_input ?? p.input
  const writeRate = p.cache_write ?? p.input

  const ctx = longContextMultipliers(provider, prompt)
  const region = regionMultiplier(provider, opts.baseURL)
  const input = (fresh / 1e6) * p.input + (cached / 1e6) * cachedRate + (written / 1e6) * writeRate
  const output = (completion / 1e6) * p.output
  const searches = opts.webSearches ?? 0
  const web = searches > 0 ? searches * (webSearchUsdPerCall(provider) ?? 0) : 0

  return {
    cost_usd: tier.multiplier * region * (ctx.inM * input + ctx.outM * output) + web,
    reason: null,
    tier,
    long_context: ctx.long,
  }
}

/**
 * The reservation unit U: the worst case of one chunk, computed once per run.
 *
 * Kept for the scan plan's `reservation_unit_usd` (older plans and the
 * confirmation screen read it) and for booking an uncapped call that returned
 * no usage. It is no longer the spend gate's unit: the gate holds each call's
 * own worst case (callReservationUsd) only while that call is in flight.
 *
 * Call i (0-based) of a chunk is bounded by `B + i x (2 x cap + T) + 32 x (2i + 1)`
 * input tokens — the largest first-call prompt in bytes (a token is at least a
 * byte), plus each earlier turn's answer and follow-up instruction, plus
 * per-message framing — and `cap` output tokens. Each call is priced at the
 * upper input rate and the output rate, at the long-context multipliers when
 * its own bound passes the threshold. Null when the model or tier is unpriced.
 */
export function reservationUnitUsd(
  provider: Provider,
  opts: {
    callsPerUnit: number
    maxPromptBytes: number
    followUpTemplateBytes: number
    outputCap: number
    servedTier?: string | null
    baseURL?: string | null
  },
): number | null {
  const p = pricingFor(provider)
  const upper = upperInputRatePerMTok(provider)
  const tier = tierInfo(provider, opts.servedTier)
  if (!p || upper === null || tier.multiplier === null) return null
  let sum = 0
  for (let i = 0; i < opts.callsPerUnit; i++) {
    const inputBound = opts.maxPromptBytes + i * (2 * opts.outputCap + opts.followUpTemplateBytes) + 32 * (2 * i + 1)
    const ctx = longContextMultipliers(provider, inputBound)
    sum += (ctx.inM * inputBound * upper + ctx.outM * opts.outputCap * p.output) / 1e6
  }
  return tier.multiplier * regionMultiplier(provider, opts.baseURL) * sum
}

/**
 * Bytes framing each message of a request — the `32 x (2i + 1)` term of the
 * chunk bound above, per message.
 */
export const MESSAGE_FRAMING_BYTES = 32

/**
 * The prompt-size bound of one request, in bytes: every message's text plus
 * per-message framing. A token is at least a byte, so this bounds the prompt
 * tokens the call can be billed for. Non-text parts count nothing, as in
 * promptChars().
 */
export function callPromptBytes(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) {
    n += MESSAGE_FRAMING_BYTES
    const c = (m as any)?.content
    if (typeof c === 'string') n += Buffer.byteLength(c, 'utf8')
    else if (Array.isArray(c)) {
      for (const part of c) if (typeof part?.text === 'string') n += Buffer.byteLength(part.text, 'utf8')
    }
  }
  return n
}

/**
 * The per-call hold: one call's own worst case, which the spend gate holds
 * while that call is in flight and releases the moment it returns.
 *
 *   hold = tier x region x (ctx_in x promptBytes x upper_input + ctx_out x outputCap x out) / 1M
 *
 * `promptBytes` is the call's actual prompt bound including framing
 * (callPromptBytes), so a follow-up turn holds for its real transcript rather
 * than a chunk-wide guess. Long-context multipliers apply when the bound
 * passes the threshold. Null when the model or tier is unpriced.
 */
export function callReservationUsd(
  provider: Provider,
  opts: { promptBytes: number; outputCap: number; servedTier?: string | null; baseURL?: string | null },
): number | null {
  const p = pricingFor(provider)
  const upper = upperInputRatePerMTok(provider)
  const tier = tierInfo(provider, opts.servedTier)
  if (!p || upper === null || tier.multiplier === null) return null
  const ctx = longContextMultipliers(provider, opts.promptBytes)
  return tier.multiplier * regionMultiplier(provider, opts.baseURL) *
    (ctx.inM * opts.promptBytes * upper + ctx.outM * opts.outputCap * p.output) / 1e6
}

/**
 * The per-call holds a run's plan can promise before any prompt is sent:
 * `first_usd` bounds any file's first call (the largest first-turn prompt),
 * `max_usd` bounds any single call of a chunk (its last follow-up turn, whose
 * input carries every earlier turn). Same call-i bound as reservationUnitUsd.
 * The gate admits a file against `first_usd` and fits concurrency to `max_usd`.
 */
export function planCallReservationsUsd(
  provider: Provider,
  opts: {
    callsPerUnit: number
    maxPromptBytes: number
    followUpTemplateBytes: number
    outputCap: number
    servedTier?: string | null
    baseURL?: string | null
  },
): { first_usd: number; max_usd: number } | null {
  const bound = (i: number) =>
    opts.maxPromptBytes + i * (2 * opts.outputCap + opts.followUpTemplateBytes) + MESSAGE_FRAMING_BYTES * (2 * i + 1)
  const price = (i: number) => callReservationUsd(provider, {
    promptBytes: bound(i), outputCap: opts.outputCap, servedTier: opts.servedTier, baseURL: opts.baseURL,
  })
  const first = price(0)
  if (first === null) return null
  let max = first
  for (let i = 1; i < Math.max(1, opts.callsPerUnit); i++) max = Math.max(max, price(i)!)
  return { first_usd: first, max_usd: max }
}

/** One call's bound — booked for a call that returned no usage. */
export function worstCaseCallUsd(
  provider: Provider,
  opts: { promptBytes: number; outputCap: number; servedTier?: string | null; baseURL?: string | null },
): number | null {
  return reservationUnitUsd(provider, {
    callsPerUnit: 1,
    maxPromptBytes: opts.promptBytes,
    followUpTemplateBytes: 0,
    outputCap: opts.outputCap,
    servedTier: opts.servedTier,
    baseURL: opts.baseURL,
  })
}

/**
 * The scan's estimated cost from its total input I and the output ratio R:
 *
 *   C_in  = I x upper_input_rate / 1M
 *   C_out = I x R x out / 1M
 *   scan  = (C_in + C_out) x tier x region
 *
 * The tier and region multipliers are applied to each leg, so input_usd and
 * output_usd add up to scan_usd. Null when the model or tier is unpriced.
 */
export function scanCostUsd(
  provider: Provider,
  opts: { inputTokens: number; ratioR: number; servedTier?: string | null; baseURL?: string | null },
): { input_usd: number; output_tokens: number; output_usd: number; scan_usd: number } | null {
  const p = pricingFor(provider)
  const upper = upperInputRatePerMTok(provider)
  const tier = tierInfo(provider, opts.servedTier)
  if (!p || upper === null || tier.multiplier === null) return null
  const m = tier.multiplier * regionMultiplier(provider, opts.baseURL)
  const outputTokens = Math.round(opts.inputTokens * opts.ratioR)
  const input_usd = (opts.inputTokens * upper / 1e6) * m
  const output_usd = (outputTokens * p.output / 1e6) * m
  return { input_usd, output_tokens: outputTokens, output_usd, scan_usd: input_usd + output_usd }
}

/**
 * The estimate's accuracy band, ± percent, by admitted file count: the 90%
 * interval from resampling run 6's per-file costs. Under 10 files there is no
 * meaningful band and the caller says the cost "can vary widely".
 */
export function estimateBandPct(files: number): number | null {
  if (files >= 300) return 7
  if (files >= 100) return 15
  if (files >= 40) return 27
  if (files >= 10) return 78
  return null
}
