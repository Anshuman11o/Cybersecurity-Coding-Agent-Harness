/** One retry layer for hunt calls; every attempt is metered and booked. */
import { classifyApiError, retryAfterMs } from '../../shared/api-errors.js'
import { stepDown } from '../../shared/api-profile.js'
import { meteredChatCompletion, promptChars, type ChatCompletionsClient, type MeteredResult, type TierPin } from '../../shared/metered-call.js'
import { callCostUsd, callPromptBytes, callReservationUsd, normalizeUsage, tierInfo } from '../../shared/pricing.js'
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
  /**
   * The chunk unit U. Books a call that returned no usage when the run has no
   * cap, exactly as before per-call holds; under a cap such a call is booked
   * at its own hold, so the ledger never passes what the gate held.
   */
  reservationUnitUsd: number | null
  /**
   * The output-token cap every hunt call sends; prices each call's hold. When
   * omitted, a call holds U — the old chunk-wide bound, never less.
   */
  outputCap?: number
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

  /** This call's own worst case: its actual prompt bound and the output cap. */
  holdFor(client: ChatCompletionsClient, body: Record<string, any>): number | null {
    const { provider, pin, outputCap, reservationUnitUsd } = this.opts
    if (outputCap == null) return reservationUnitUsd
    return callReservationUsd(provider, {
      promptBytes: callPromptBytes(body.messages), outputCap, servedTier: pin.send, baseURL: client.baseURL ?? null,
    })
  }

  async call(client: ChatCompletionsClient, params: Record<string, any>, laneId: string, label: string): Promise<MeteredResult> {
    let body = params
    const { provider, ledger, gate, pin, reservationUnitUsd } = this.opts
    if (tierInfo(provider, pin.send).multiplier === null) {
      throw this.stop('unpriced_service_tier', `service tier ${pin.send} has no registered price`)
    }
    for (let attempt = 1; attempt <= MAX_CALL_ATTEMPTS; attempt++) {
      if (this.stopped) throw this.stopped
      // Every attempt — first call, follow-up turn or retry — holds its own
      // worst case first, waiting for releases while other calls are in flight.
      const held = await gate.acquire(laneId, this.holdFor(client, body))
      if (!held.ok) throw this.stop('max_cost', held.detail)
      const hold = held.hold
      if (this.stopped) { gate.release(hold, 0); throw this.stopped }
      let result: MeteredResult | null = null
      let error: unknown = null
      try { result = await meteredChatCompletion(client, provider, body, pin) }
      catch (err) { error = err }
      const rawError = error as any
      const usage = result?.usage ?? normalizeUsage(rawError?.usage ?? rawError?.error?.usage)
      const errorTier = rawError?.service_tier ?? rawError?.error?.service_tier
      const servedTier = result ? result.servedTier : typeof errorTier === 'string' ? errorTier : pin.send
      const cost = result?.cost ?? callCostUsd(provider, usage, { servedTier, baseURL: client.baseURL })
      const booked = cost.cost_usd ?? (gate.capped ? hold.usd : reservationUnitUsd)
      // Release and book in one synchronous step: the hold is freed exactly as
      // the call's real cost lands in the ledger.
      gate.release(hold, booked, () => ledger.append({
        source: 'hunt', stage: 'stage2-hunt-lanes-perfile', label, lane_id: laneId,
        attempt, model: modelFor(provider), served_tier: servedTier, usage,
        chars_sent: result?.charsSent ?? promptChars(body.messages),
        cost_usd: booked,
        basis: cost.cost_usd != null ? 'actual' : 'reservation',
        ...(cost.reason ? { note: cost.reason } : {}),
      }))
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
      // The retry holds nothing while it backs off; it acquires at the top of the loop.
      if (wait > 0) await (this.opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(wait)
    }
    throw new HuntCallError('call attempts exhausted')
  }
}
