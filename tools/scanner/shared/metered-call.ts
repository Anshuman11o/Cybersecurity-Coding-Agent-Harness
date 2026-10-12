/**
 * Metered chat completion — one model call, returned with what it cost.
 *
 * The single path through which recon and the hunt send a call when they need
 * its price: it pins the service tier, keeps the response headers (rate limits
 * and reset times live there), normalizes the usage and prices the call. It
 * does NOT retry and does NOT book the ledger — the caller owns both, because
 * the caller is the one that knows the attempt number, the label and whether
 * a missing usage must be booked at a reservation.
 *
 * The client is typed structurally rather than as the `openai` package's
 * class, so this module has no runtime dependency on any package and accepts
 * every client the stages build: the OpenAI SDK (whose create() returns an
 * APIPromise with `.withResponse()`) and the lab's claude-cli client (a plain
 * promise, so headers are null).
 */
import { callCostUsd, normalizeUsage, tiersManaged, type CallCost, type NormalizedUsage } from './pricing.js'
import type { Provider } from './models.js'

/** The tier to send. Null sends none, so the project's own setting decides. */
export interface TierPin {
  send: string | null
}

/** What meteredChatCompletion needs of a client. */
export interface ChatCompletionsClient {
  baseURL?: string
  chat: { completions: { create(params: any, options?: any): any } }
}

export interface MeteredResult<R = any> {
  response: R
  headers: Headers | null
  usage: NormalizedUsage | null
  servedTier: string | null
  cost: CallCost
  charsSent: number
}

/** Characters of prompt text in a message list; non-text parts count nothing. */
export function promptChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) {
    const c = (m as any)?.content
    if (typeof c === 'string') n += c.length
    else if (Array.isArray(c)) {
      for (const part of c) if (typeof part?.text === 'string') n += part.text.length
    }
  }
  return n
}

export async function meteredChatCompletion<R = any>(
  client: ChatCompletionsClient,
  provider: Provider,
  params: Record<string, unknown>,
  pin: TierPin,
): Promise<MeteredResult<R>> {
  // Only a target that declares service_tiers ever sends one: the lab's
  // targets keep sending exactly the body they always have.
  const body = tiersManaged(provider) && pin.send ? { ...params, service_tier: pin.send } : params
  const pending = client.chat.completions.create(body)

  let response: any
  let headers: Headers | null = null
  if (pending && typeof pending.withResponse === 'function') {
    const { data, response: raw } = await pending.withResponse()
    response = data
    headers = (raw?.headers as Headers | undefined) ?? null
  } else {
    response = await pending
  }

  const usage = normalizeUsage(response?.usage)
  const servedTier = typeof response?.service_tier === 'string' ? response.service_tier : null
  const cost = callCostUsd(provider, usage, { servedTier, baseURL: client.baseURL ?? null })
  return { response, headers, usage, servedTier, cost, charsSent: promptChars(params.messages) }
}
