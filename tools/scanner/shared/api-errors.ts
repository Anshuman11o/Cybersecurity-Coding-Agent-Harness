/**
 * API error classification — the one place that decides what a failed model
 * call means for the run.
 *
 *   quota       the account is out of credit or over a spend limit. Retrying
 *               cannot help; the run stops cleanly (provider_quota).
 *   rate_limit  a plain 429. Step concurrency down once, wait, retry.
 *   transient   5xx, timeouts, dropped connections. Back off and retry.
 *   schema      the endpoint rejected the structured-output request.
 *   fatal       anything else (401, 403, 404, a malformed request).
 *
 * The distinction between quota and rate_limit matters most: both arrive as a
 * 429, and treating an empty account as a rate limit retries into the same
 * wall for every file of the run.
 *
 * Zero dependencies (node builtins only).
 */
import { headerValue, parseResetMs, type HeaderSource } from './api-profile.js'

export type ApiErrorClass = 'quota' | 'rate_limit' | 'transient' | 'schema' | 'fatal'

/** Error codes that mean the account cannot pay for the call, whatever the status. */
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'project_spend_limit_exceeded',
  'organization_spend_limit_exceeded',
])

/** Network failure codes worth a retry. */
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ECONNABORTED',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

/** The longest any retry waits, whatever the endpoint asks for. */
export const MAX_RETRY_WAIT_MS = 60_000

function statusOf(err: any): number | null {
  const s = err?.status ?? err?.statusCode ?? err?.response?.status
  return typeof s === 'number' ? s : null
}

function strings(...vs: unknown[]): string {
  return vs.filter(v => typeof v === 'string').join(' ')
}

export function classifyApiError(err: unknown): ApiErrorClass {
  const e = err as any
  const status = statusOf(e)
  const code = strings(e?.code, e?.error?.code, e?.error?.error?.code)
  const type = strings(e?.type, e?.error?.type, e?.error?.error?.type)
  const message = strings(e?.message, e?.error?.message, e?.error?.error?.message)

  if (code.split(' ').some(c => QUOTA_CODES.has(c))) return 'quota'
  if (status === 429 && /quota|billing/i.test(`${code} ${type}`)) return 'quota'
  if (status === 429) return 'rate_limit'
  if ((status === 400 || status === 422) && /json_schema|strict|response_format/i.test(message)) return 'schema'
  if (status !== null && (status >= 500 || status === 408 || status === 409)) return 'transient'

  if (status === null) {
    const netCode = strings(e?.code, e?.cause?.code, e?.cause?.cause?.code)
    if (netCode.split(' ').some(c => NETWORK_CODES.has(c))) return 'transient'
    const name = strings(e?.name, e?.constructor?.name)
    if (/APIConnection(Timeout)?Error|AbortError|TimeoutError/.test(name)) return 'transient'
    if (/econnreset|etimedout|socket hang up|fetch failed|timed? ?out|network/i.test(message)) return 'transient'
  }
  return 'fatal'
}

function headersOf(err: any): HeaderSource {
  return err?.headers ?? err?.response?.headers ?? null
}

/**
 * How long the endpoint asked us to wait, in ms, capped at 60,000: from
 * `retry-after-ms`, `retry-after` (seconds or an HTTP date), or the larger of
 * the `x-ratelimit-reset-*` durations. Null when the error says nothing.
 */
export function retryAfterMs(err: unknown): number | null {
  const h = headersOf(err)
  const cap = (ms: number) => Math.min(MAX_RETRY_WAIT_MS, Math.max(0, Math.round(ms)))

  const ms = headerValue(h, 'retry-after-ms')
  if (ms != null && /^\s*\d+(\.\d+)?\s*$/.test(ms)) return cap(Number(ms))

  const ra = headerValue(h, 'retry-after')
  if (ra != null) {
    if (/^\s*\d+(\.\d+)?\s*$/.test(ra)) return cap(Number(ra) * 1000)
    const date = Date.parse(ra)
    if (!Number.isNaN(date)) return cap(date - Date.now())
  }

  const resets = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']
    .map(n => parseResetMs(headerValue(h, n)))
    .filter((v): v is number => v !== null)
  return resets.length ? cap(Math.max(...resets)) : null
}
