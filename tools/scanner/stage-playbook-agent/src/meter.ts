/** Use the same run ledger, tier pin and pricing as recon and the hunt. No retries. */
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { SpendLedger, ledgerPathFor, readLedgerTotals } from '../../shared/ledger.js'
import { callCostUsd, normalizeUsage, tiersManaged, tierInfo, worstCaseCallUsd } from '../../shared/pricing.js'
import { modelFor, webSearchUsdPerCall, type Provider } from '../../shared/provider.js'
import type { RunContext } from '../../shared/run-context.js'
import { PLAYBOOK_STAGE } from '../../shared/playbook-overlay.js'
import { searchTrace, type AgentOptions } from './agent.js'

export class PlaybookMeter {
  readonly ledger: SpendLedger

  constructor(
    private readonly provider: Provider,
    ctx: RunContext,
    private readonly baseURL: string | null,
    private readonly servedTier: string | null,
    private readonly create: AgentOptions['create'],
  ) {
    // Do not reset: recon and earlier resumed passes have already spent money.
    this.ledger = new SpendLedger(ledgerPathFor(ctx.runsRoot, provider))
  }

  /** Same body and pricing used by the call, including its bounded web-tool allowance. */
  reservation(request: ResponseCreateParamsNonStreaming): number | null {
    const body = this.body(request)
    const usd = worstCaseCallUsd(this.provider, {
      promptBytes: Buffer.byteLength(JSON.stringify(body)), outputCap: body.max_output_tokens ?? 0,
      servedTier: this.servedTier, baseURL: this.baseURL,
    })
    const webCalls = body.tools?.some(t => t.type === 'web_search') ? body.max_tool_calls ?? 0 : 0
    const web = webSearchUsdPerCall(this.provider)
    return usd === null || (webCalls > 0 && web === null) ? null : usd + webCalls * (web ?? 0)
  }

  private body(request: ResponseCreateParamsNonStreaming): ResponseCreateParamsNonStreaming {
    return { ...request, model: request.model ?? modelFor(this.provider),
      ...(tiersManaged(this.provider) && this.servedTier
        ? { service_tier: this.servedTier as ResponseCreateParamsNonStreaming['service_tier'] } : {}) }
  }

  /** `purpose` is the agent's name for the call (coverage, turn1, research:<id>, ...) and the ledger label. */
  async call(request: ResponseCreateParamsNonStreaming, purpose: string, options: { attempt?: number; budgetUsd?: number | null; signal?: AbortSignal } = {}): Promise<Response> {
    if (tierInfo(this.provider, this.servedTier).multiplier === null) {
      throw new Error(`unpriced_service_tier: ${this.servedTier}`)
    }
    const body = this.body(request)
    options.signal?.throwIfAborted()
    if (options.budgetUsd != null) {
      const reserved = this.reservation(request)
      if (reserved === null || readLedgerTotals(this.ledger.path).total_usd + reserved > options.budgetUsd) {
        throw new Error('Review call exceeds the budget; raise the budget first')
      }
    }
    const chars = (typeof body.instructions === 'string' ? body.instructions.length : 0) +
      (typeof body.input === 'string' ? body.input.length : JSON.stringify(body.input ?? '').length)
    const promptBytes = Buffer.byteLength(JSON.stringify(body))

    const book = (response: any, failed: boolean) => {
      const usage = normalizeUsage(response?.usage)
      const servedTier = typeof response?.service_tier === 'string' ? response.service_tier : this.servedTier
      const searches = searchTrace({ output: response?.output ?? [] } as Response).web_search_calls
      const cost = callCostUsd(this.provider, usage, { servedTier, baseURL: this.baseURL, webSearches: searches })
      const reservation = worstCaseCallUsd(this.provider, {
        promptBytes, outputCap: body.max_output_tokens ?? 0, servedTier, baseURL: this.baseURL,
      })
      this.ledger.append({
        source: 'playbook', stage: PLAYBOOK_STAGE, label: purpose, lane_id: null, attempt: options.attempt ?? 1,
        model: body.model, served_tier: servedTier, usage, chars_sent: chars,
        cost_usd: usage ? cost.cost_usd
          : reservation === null ? null : reservation + Math.max(searches, purpose.startsWith('review:') && body.tools?.some(t => t.type === 'web_search') ? body.max_tool_calls ?? 0 : 0) * (webSearchUsdPerCall(this.provider) ?? 0),
        basis: usage ? 'actual' : 'reservation',
        ...(!usage || failed ? { note: `${failed ? 'request failed' : 'response'} ${usage ? 'with usage' : 'without usage'}` } : {}),
      })
      if (cost.tier.multiplier === null) {
        throw Object.assign(new Error(`unpriced_service_tier: ${servedTier}`), {
          usage: response?.usage, service_tier: servedTier,
        })
      }
    }

    let response: Response
    try { response = await this.create(body, purpose) } catch (error: any) {
      book(error?.usage ? error : error?.error, true)
      throw error
    }
    book(response, false) // Book before the agent validates status, JSON or sources.
    return response
  }
}
