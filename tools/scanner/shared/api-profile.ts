/**
 * API profile — what recon learned about the endpoint from its own first
 * responses, so the hunt can be configured to the account it is running on.
 *
 *   <runPath(provider, 'stage0-recon')>/api-profile.json
 *
 * Two things are recorded:
 *
 *   tier         the `service_tier` the first response reports. Recon's first
 *                call sends none, so the project's own setting decides; recon
 *                then pins that tier on its later calls and the hunt pins it on
 *                every call, so the whole run bills at the tier its estimate
 *                was priced at.
 *   rate limits  `x-ratelimit-limit-tokens` and `x-ratelimit-limit-requests`
 *                from the first response. Stage 1 sizes concurrency from them
 *                (concurrencyFromRateLimits) instead of a fixed default.
 *
 * Zero dependencies (node builtins only) so it can be imported across stage
 * package boundaries without its own node_modules.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const API_PROFILE_FILE = 'api-profile.json'
export const API_PROFILE_SCHEMA = 'secscan.api-profile/1'

export interface ApiProfile {
  schema: typeof API_PROFILE_SCHEMA
  observed_at: string
  provider: string
  model: string
  served_tier: string | null
  tier_label: string
  /** Null when the served tier is unpriced. */
  tier_multiplier: number | null
  rate_limits: { requests_per_minute: number | null; tokens_per_minute: number | null }
  /** Model calls recon made, failed attempts included. */
  recon_calls: number
  /** Recon's own chars sent / prompt tokens, or null when it measured none. */
  chars_per_token: number | null
}

/** In-flight ceiling for the derived concurrency, whatever the limits allow. */
export const CONCURRENCY_CEILING = 32
/** Share of a published rate limit the run plans to use. */
export const RATE_LIMIT_MARGIN = 0.7
/** Concurrency after a rate-limit 429: x0.75, floored, at least 1. */
export const STEP_DOWN_FACTOR = 0.75
/**
 * Seconds one in-flight slot spends per call when the registry has no
 * calibration: run 6 (2026-08-01), 784 s x 32 / 1,082 calls.
 */
export const DEFAULT_SECONDS_PER_CALL = 23.2

/** The profile on disk, or null when it is missing or not a profile. */
export function readApiProfile(path: string): ApiProfile | null {
  if (!existsSync(path)) return null
  try {
    const p = JSON.parse(readFileSync(path, 'utf8'))
    return p && p.schema === API_PROFILE_SCHEMA ? (p as ApiProfile) : null
  } catch {
    return null
  }
}

/** Write atomically, so a reader never sees half a profile. */
export function writeApiProfile(path: string, p: ApiProfile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n')
  renameSync(tmp, path)
}

/** Anything header-shaped: a fetch Headers, a plain object, or nothing. */
export type HeaderSource =
  | { get(name: string): string | null }
  | Record<string, unknown>
  | null
  | undefined

/** One header's value, case-insensitively, from any HeaderSource. */
export function headerValue(headers: HeaderSource, name: string): string | null {
  if (headers == null || typeof headers !== 'object') return null
  if (typeof (headers as any).get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name)
    return v == null ? null : String(v)
  }
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== want || v == null) continue
    return Array.isArray(v) ? (v.length ? String(v[0]) : null) : String(v)
  }
  return null
}

function positiveInt(v: string | null): number | null {
  if (v == null || !/^\s*\d+\s*$/.test(v)) return null
  const n = Number(v.trim())
  return n > 0 ? n : null
}

/** The account's published per-minute limits from a response's headers; null where absent. */
export function parseRateLimitHeaders(headers: HeaderSource): {
  requests_per_minute: number | null
  tokens_per_minute: number | null
} {
  return {
    requests_per_minute: positiveInt(headerValue(headers, 'x-ratelimit-limit-requests')),
    tokens_per_minute: positiveInt(headerValue(headers, 'x-ratelimit-limit-tokens')),
  }
}

/**
 * A rate-limit reset duration in milliseconds: "12ms", "1s", "6m0s",
 * "1h2m3.5s". Null for anything else, a bare number included — its unit is
 * not knowable.
 */
export function parseResetMs(v: string | null | undefined): number | null {
  if (typeof v !== 'string') return null
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(v.trim())
  if (!m || (m[1] ?? m[2] ?? m[3] ?? m[4]) === undefined) return null
  const n = (x: string | undefined) => (x ? Number(x) : 0)
  return Math.round(n(m[1]) * 3_600_000 + n(m[2]) * 60_000 + n(m[3]) * 1000 + n(m[4]))
}

/**
 * Concurrency the account's rate limits support:
 *
 *   per-slot TPM = (prompt + output tokens per call) x 60 / seconds per call
 *   value        = min(ceiling, floor(margin x TPM / per-slot),
 *                      floor(margin x RPM x seconds per call / 60)), at least 1
 *
 * Either limit may be unknown and is then not a constraint; null when neither
 * is known, so the caller falls back to its default. The output term is the
 * expected output, not the cap: the cap does not count toward the TPM limit at
 * admission (verified 2026-10-12; see the registry entry's notes).
 */
export function concurrencyFromRateLimits(opts: {
  tokensPerMinute: number | null
  requestsPerMinute: number | null
  promptTokensPerCall: number
  outputTokensPerCall: number
  secondsPerCall: number
  ceiling?: number
  margin?: number
}): { value: number; basis: string } | null {
  const ceiling = opts.ceiling ?? CONCURRENCY_CEILING
  const margin = opts.margin ?? RATE_LIMIT_MARGIN
  if (opts.tokensPerMinute == null && opts.requestsPerMinute == null) return null
  const bounds: number[] = [ceiling]
  const parts: string[] = [`ceiling ${ceiling}`]
  if (opts.tokensPerMinute != null) {
    const perSlot = ((opts.promptTokensPerCall + opts.outputTokensPerCall) * 60) / opts.secondsPerCall
    const byTokens = perSlot > 0 ? Math.floor((margin * opts.tokensPerMinute) / perSlot) : ceiling
    bounds.push(byTokens)
    parts.push(`${opts.tokensPerMinute.toLocaleString('en-US')} TPM x ${margin} / ${Math.round(perSlot).toLocaleString('en-US')} per slot = ${byTokens}`)
  }
  if (opts.requestsPerMinute != null) {
    const byRequests = Math.floor((margin * opts.requestsPerMinute * opts.secondsPerCall) / 60)
    bounds.push(byRequests)
    parts.push(`${opts.requestsPerMinute.toLocaleString('en-US')} RPM x ${margin} x ${opts.secondsPerCall} s / 60 = ${byRequests}`)
  }
  const value = Math.max(1, Math.min(...bounds))
  return { value, basis: `from the account's rate limits: ${parts.join('; ')}` }
}

/** One step down after a rate-limit 429: x0.75, floored, never below 1. */
export function stepDown(n: number): number {
  return Math.max(1, Math.floor(n * STEP_DOWN_FACTOR))
}
