/** One retry layer for hunt calls; every attempt is metered and booked. */
import { classifyApiError, retryAfterMs } from '../../shared/api-errors.js'
import { stepDown } from '../../shared/api-profile.js'
import { meteredChatCompletion, promptChars, type ChatCompletionsClient, type MeteredResult, type TierPin } from '../../shared/metered-call.js'
import { callCostUsd, normalizeUsage, tierInfo } from '../../shared/pricing.js'
import { modelFor, type Provider } from '../../shared/provider.js'
import type { SpendLedger } from '../../shared/ledger.js'
import type { SpendGate } from '../../stage1-budget-governor/src/spend-gate.js'
import type { Stage2RunStatus, StopReason } from '../../stage1-budget-governor/src/run-status.js'

export const MAX_CALL_ATTEMPTS = 3

export class HuntCallError extends Error {
  constructor(message: string, readonly stopReason: StopReason | null = null) { super(message) }
}

export interface CallPolicyOptions {
  provider: Provider
  ledger: SpendLedger
  gate: SpendGate
  reservationUnitUsd: number | null
  pin: TierPin
  concurrency: number
  initialConcurrency?: number
  stepDowns?: number
  onStop?: (reason: StopReason, detail: string) => void
  onUpdate?: () => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** A budget-only resume keeps the run's rate-limit reductions, even with an explicit original limit. */
export function resumeConcurrency(planned: number, previous: Stage2RunStatus['concurrency']) {
  return {
    concurrency: previous ? Math.min(previous.final, planned) : planned,
    initialConcurrency: previous?.initial ?? planned,
    stepDowns: previous?.step_downs ?? 0,
  }
}

export class HuntCallPolicy {
  readonly initialConcurrency: number
  currentConcurrency: number
  stepDowns: number
  private lastStepAt = -Infinity
  private consecutiveFailures = 0
  private stopped: HuntCallError | null = null

  constructor(private readonly opts: CallPolicyOptions) {
    this.initialConcurrency = opts.initialConcurrency ?? opts.concurrency
    this.currentConcurrency = opts.concurrency
    this.stepDowns = opts.stepDowns ?? 0
  }

  private stop(reason: StopReason, detail: string): HuntCallError {
    if (!this.stopped) {
      this.stopped = new HuntCallError(detail, reason)
      this.opts.onStop?.(reason, detail)
    }
    return this.stopped
  }

  laneFinished(failed: boolean): void {
    this.consecutiveFailures = failed ? this.consecutiveFailures + 1 : 0
    if (this.consecutiveFailures >= 3) this.stop('provider_failing', 'three files failed consecutively in completion order')
  }

  private rateLimited(): void {
    const now = (this.opts.now ?? Date.now)()
    if (now - this.lastStepAt < 60_000) return
    this.lastStepAt = now
    const next = stepDown(this.currentConcurrency)
    if (next < this.currentConcurrency) {
      this.currentConcurrency = next
      this.stepDowns++
      this.opts.onUpdate?.()
    }
  }

  async call(client: ChatCompletionsClient, params: Record<string, any>, laneId: string, label: string): Promise<MeteredResult> {
    let body = params
    const { provider, ledger, gate, pin, reservationUnitUsd } = this.opts
    if (tierInfo(provider, pin.send).multiplier === null) {
      throw this.stop('unpriced_service_tier', `service tier ${pin.send} has no registered price`)
    }
    for (let attempt = 1; attempt <= MAX_CALL_ATTEMPTS; attempt++) {
      if (this.stopped) throw this.stopped
      let result: MeteredResult | null = null
      let error: unknown = null
      try { result = await meteredChatCompletion(client, provider, body, pin) }
      catch (err) { error = err }
      const rawError = error as any
      const usage = result?.usage ?? normalizeUsage(rawError?.usage ?? rawError?.error?.usage)
      const errorTier = rawError?.service_tier ?? rawError?.error?.service_tier
      const servedTier = result ? result.servedTier : typeof errorTier === 'string' ? errorTier : pin.send
      const cost = result?.cost ?? callCostUsd(provider, usage, { servedTier, baseURL: client.baseURL })
      ledger.append({
        source: 'hunt', stage: 'stage2-hunt-lanes-perfile', label, lane_id: laneId,
        attempt, model: modelFor(provider), served_tier: servedTier, usage,
        chars_sent: result?.charsSent ?? promptChars(body.messages),
        cost_usd: cost.cost_usd ?? reservationUnitUsd,
        basis: cost.cost_usd != null ? 'actual' : 'reservation',
        ...(cost.reason ? { note: cost.reason } : {}),
      })
      this.opts.onUpdate?.()
      if (cost.tier.multiplier === null) {
        throw this.stop('unpriced_service_tier', `service tier ${servedTier} has no registered price`)
      }

      let wait = 0
      if (result) {
        const choice = result.response?.choices?.[0]
        if (typeof choice?.message?.content === 'string' && choice.message.content.trim() && choice.finish_reason !== 'length') {
          return result
        }
        error = new HuntCallError(choice?.finish_reason === 'length' ? 'answer was cut off (length)' : 'answer was empty')
      } else {
        const kind = classifyApiError(error)
        if (kind === 'quota') throw this.stop('provider_quota', 'provider quota or spend limit reached')
        if (kind === 'rate_limit') {
          this.rateLimited()
          wait = retryAfterMs(error) ?? Math.min(2000 * 2 ** (attempt - 1), 60_000)
        } else if (kind === 'transient') {
          wait = Math.min(2000 * 2 ** (attempt - 1), 60_000)
        } else if (kind === 'schema' && body.response_format?.type === 'json_schema') {
          body = { ...body, response_format: { type: 'json_object' } }
        } else {
          throw new HuntCallError(String(rawError?.message ?? error))
        }
      }
      if (attempt === MAX_CALL_ATTEMPTS) throw new HuntCallError(`call failed after ${attempt} attempts: ${(error as any)?.message ?? error}`)
      if (!gate.reserveRetry(laneId, reservationUnitUsd)) {
        throw this.stop('max_cost', 'one more reservation unit for a retry would exceed the budget')
      }
      if (wait > 0) await (this.opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(wait)
    }
    throw new HuntCallError('call attempts exhausted')
  }
}
