/**
 * Scan plan — the lanes this run will hunt, under its limits, priced lane by lane.
 *
 * Written by Stage 1 next to budget-plan-v2.json, read by Stage 2 (which lanes
 * to start and what each is projected to cost) and by the CLI (the confirmation
 * screen). One artifact for all three is the point: what the user confirms,
 * what the gate enforces and what the run then does are the same list, never
 * three recomputations of it.
 *
 * budget-plan-v2.json is left exactly as it was — every hunt lane, no limits —
 * because the lab compares it across runs. Limits live here only.
 *
 * Shared pricing and calibration supply the estimate. computeScanPlan itself
 * takes projections and measured inputs and performs no I/O.
 */
import {
  admitLanes,
  admissionKey,
  deriveConcurrency,
  type ExclusionReason,
  type RunLimits,
} from './limits.js'
import { calibratedRatios } from '../../shared/calibration.js'
import { calibrationFor } from '../../shared/provider.js'
import { DEFAULT_SECONDS_PER_CALL, type ApiProfile } from '../../shared/api-profile.js'
import { scanCostUsd, reservationUnitUsd, estimateBandPct, tierInfo, regionMultiplier } from '../../shared/pricing.js'
import type { LoopConfig } from '../../shared/loop-config.js'

export const SCAN_PLAN_FILE = 'scan-plan.json'
export const SCAN_PLAN_SCHEMA = 'secscan.scan-plan/1'

/**
 * Seconds one in-flight slot spends per model call, measured on run 6
 * (luna, 2026-08-01): 13m04s wall clock at concurrency 32 for 1,082 calls,
 * so 784 s × 32 / 1,082 ≈ 23.2 s. Other models differ — gemini36flash ran
 * ~14 s at 8 — so the time estimate is labelled approximate on every surface
 * that shows it. Re-derive when a run disagrees.
 */
export const SECONDS_PER_CALL_SLOT = 23.2
export const WALL_BASIS =
  `${SECONDS_PER_CALL_SLOT} s per call per in-flight slot, measured on luna run 6 (2026-08-01)`

export interface ScanPlanLane {
  lane_id: string
  target_file: string
  file_bytes: number
  projected_calls: number
  projected_input_tokens: number
  projected_output_tokens: number
  /** Null when the model is unpriced. */
  projected_cost_usd: number | null
}

export interface ScanPlanExclusion extends ScanPlanLane {
  reason: ExclusionReason
  detail: string
}

export interface ScanPlan {
  schema: typeof SCAN_PLAN_SCHEMA
  generated_at: string
  provider: string
  model: string
  /** The lane assignments this plan was computed from, so a stale plan is detectable. */
  source_assignments: { path: string; generated_at: string }
  limits: RunLimits
  /** admissionKey(limits). Stage 2 refuses to run under different scope limits. */
  admission_key: string
  concurrency: {
    value: number
    basis: string
    /**
     * Where the value came from: an explicit --concurrency, the account's rate
     * limits recorded by recon, or the default. Older saved plans may omit it.
     */
    source?: 'explicit' | 'rate-limits' | 'default'
    tokens_per_minute?: number | null
    requests_per_minute?: number | null
  }
  price_per_mtok: { input: number; cached_input?: number; cache_write?: number; output: number } | null
  price_asof: string | null
  admitted: ScanPlanLane[]
  excluded: ScanPlanExclusion[]
  totals: {
    hunt_lanes: number
    admitted_lanes: number
    excluded_by_reason: Partial<Record<ExclusionReason, number>>
    projected_calls: number
    projected_input_tokens: number
    projected_output_tokens: number
    projected_cost_usd: number | null
    projected_wall_seconds: number
    wall_basis: string
  }
  /**
   * The run estimate (shared/pricing.ts scanCostUsd plus the ledger's spend so
   * far). Null when unpriced; absent only in older saved plans.
   */
  estimate?: ScanEstimate | null
  /**
   * The reservation unit U: the worst case of one chunk, which the spend gate
   * reserves per chunk before a file starts (shared/pricing.ts
   * reservationUnitUsd). Null when unpriced; absent only in older saved plans.
   */
  reservation_unit_usd?: number | null
  /** Runtime settings priced into U; a resumed hunt must use the same settings. */
  call_config?: ScanCallConfig
  cap: {
    max_cost_usd: number | null
    /** Null when there is no cap or no price to compare against. */
    estimate_exceeds_cap: boolean | null
    /** How many admitted lanes, in order, fit under the cap by projection. */
    lanes_within_cap: number | null
  }
}

export interface ScanCallConfig {
  model: string
  max_output_tokens: number
  sampling: Record<string, number | string>
  loop: LoopConfig
  base_url: string | null
}

/** The scan's cost estimate and every input it was computed from. */
export interface ScanEstimate {
  input_tokens: number
  output_tokens: number
  input_usd: number
  output_usd: number
  scan_usd: number
  /** Ledger total before the hunt: recon and earlier passes. */
  spent_before_usd: number
  /** spent_before_usd + scan_usd. */
  total_usd: number
  /** ± percent; null under 10 files ("can vary widely"). */
  band_pct: number | null
  files: number
  ratio_R: number
  ratio_source: string
  chars_per_token: number
  chars_per_token_source: string
  served_tier: string | null
  tier_label: string
  tier_multiplier: number
  region_multiplier: number
}

export interface PlanInput {
  provider: string
  model: string
  assignmentsPath: string
  assignmentsGeneratedAt: string
  /** Every hunt lane, in assignment order, with its Stage 1 projection. */
  lanes: Omit<ScanPlanLane, 'projected_cost_usd'>[]
  limits: RunLimits
  vendorConcurrencyCeiling: number | null
  price: ScanPlan['price_per_mtok']
  priceAsOf: string | null
  /** costUsd() for this provider; null when unpriced. */
  cost: (inputTokens: number, outputTokens: number) => number | null
  /** Exact prompt projection inputs. Omitted by older callers. */
  estimation?: EstimateInput
  callConfig?: ScanCallConfig
  now?: Date
}

export interface EstimateRatios {
  ratio_R: number
  ratio_source: string
  chars_per_token: number
  chars_per_token_source: string
}

/** Recon measures this run's tokenization; completed runs calibrate output at the same effort. */
export function resolveEstimateRatios(
  provider: string,
  profile: ApiProfile | null,
  reportsRoot: string | null,
  model: string,
  effort: string,
): EstimateRatios {
  const prior = reportsRoot ? calibratedRatios(reportsRoot, model, effort) : null
  const seed = calibrationFor(provider)
  const reconChars = profile?.chars_per_token
  const hasRecon = reconChars != null && Number.isFinite(reconChars) && reconChars > 0
  return {
    ratio_R: prior?.ratio_R ?? seed?.output_per_input ?? 0.341,
    ratio_source: prior?.ratio_R != null ? 'calibration' : seed ? 'registry' : 'default',
    chars_per_token: hasRecon ? reconChars : prior?.chars_per_token ?? seed?.chars_per_token ?? 4,
    chars_per_token_source: hasRecon ? 'recon' : prior?.chars_per_token != null ? 'calibration' : seed ? 'registry' : 'default',
  }
}

export interface PromptBound {
  maxPromptBytes: number
  followUpTemplateBytes: number
  callsPerChunk: number
}

export interface EstimateInput {
  ratios: EstimateRatios
  profile: ApiProfile | null
  baseURL?: string
  spentBeforeUsd: number
  /** Bounds keyed by lane, so excluded files cannot inflate the run's U. */
  promptBounds: Map<string, PromptBound>
  outputCap: number
  secondsPerCall?: number
}

export function computeScanPlan(input: PlanInput): ScanPlan {
  const estimation = input.estimation
  const servedTier = estimation?.profile?.served_tier ?? null
  const priceTokens = (inputTokens: number) => estimation ? scanCostUsd(input.provider, {
    inputTokens, ratioR: estimation.ratios.ratio_R, servedTier, baseURL: estimation.baseURL,
  }) : null
  const priced: ScanPlanLane[] = input.lanes.map(l => ({
    ...l,
    projected_cost_usd: estimation
      ? priceTokens(l.projected_input_tokens)?.scan_usd ?? null
      : input.cost(l.projected_input_tokens, l.projected_output_tokens),
  }))
  const { admitted, excluded } = admitLanes(priced, input.limits)

  const sum = (f: (l: ScanPlanLane) => number) => admitted.reduce((s, l) => s + f(l), 0)
  const calls = sum(l => l.projected_calls)
  const inputTokens = sum(l => l.projected_input_tokens)
  const secondsPerCall = estimation?.secondsPerCall ?? DEFAULT_SECONDS_PER_CALL
  const avgPrompt = calls > 0 ? inputTokens / calls : 0
  const concurrency = deriveConcurrency(input.limits.concurrency, input.vendorConcurrencyCeiling, admitted.length,
    estimation ? {
      tokensPerMinute: estimation.profile?.rate_limits.tokens_per_minute ?? null,
      requestsPerMinute: estimation.profile?.rate_limits.requests_per_minute ?? null,
      promptTokensPerCall: avgPrompt,
      outputTokensPerCall: avgPrompt * estimation.ratios.ratio_R,
      secondsPerCall,
    } : undefined)
  const unpriced = admitted.some(l => l.projected_cost_usd == null)
  const scanCost = priceTokens(inputTokens)
  const cost = estimation ? scanCost?.scan_usd ?? null : unpriced ? null : sum(l => l.projected_cost_usd ?? 0)
  const spentBefore = estimation?.spentBeforeUsd ?? 0
  const longestLane = admitted.reduce((m, l) => Math.max(m, l.projected_calls), 0)
  const wall = Math.round(Math.max(
    (calls * secondsPerCall) / concurrency.value,
    longestLane * secondsPerCall,
  ))

  const tier = estimation ? tierInfo(input.provider, servedTier) : { tier: null, label: 'Standard', multiplier: 1 }
  const files = new Set(admitted.map(l => l.target_file)).size
  const estimate: ScanEstimate | null = estimation && scanCost && tier.multiplier !== null ? {
    input_tokens: inputTokens,
    ...scanCost,
    spent_before_usd: spentBefore,
    total_usd: spentBefore + scanCost.scan_usd,
    band_pct: estimateBandPct(files),
    files,
    ...estimation.ratios,
    served_tier: servedTier,
    tier_label: tier.label,
    tier_multiplier: tier.multiplier,
    region_multiplier: regionMultiplier(input.provider, estimation.baseURL),
  } : null
  let reservation: number | null = null
  if (estimation) {
    const bounds = admitted.map(l => estimation.promptBounds.get(l.lane_id))
    if (bounds.some(b => !b)) throw new Error('an admitted lane has no prompt reservation bound')
    const maximum = (f: (b: PromptBound) => number) => bounds.reduce((m, b) => Math.max(m, f(b!)), 0)
    reservation = reservationUnitUsd(input.provider, {
      callsPerUnit: maximum(b => b.callsPerChunk),
      maxPromptBytes: maximum(b => b.maxPromptBytes),
      followUpTemplateBytes: maximum(b => b.followUpTemplateBytes),
      outputCap: estimation.outputCap,
      servedTier,
      baseURL: estimation.baseURL,
    })
  }

  const byReason: Partial<Record<ExclusionReason, number>> = {}
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1

  const cap = input.limits.max_cost_usd
  let withinCap: number | null = null
  if (cap != null && cost != null) {
    let running = spentBefore
    withinCap = 0
    for (const l of admitted) {
      running += l.projected_cost_usd ?? 0
      if (running > cap) break
      withinCap++
    }
  }

  return {
    schema: SCAN_PLAN_SCHEMA,
    generated_at: (input.now ?? new Date()).toISOString(),
    provider: input.provider,
    model: input.model,
    source_assignments: { path: input.assignmentsPath, generated_at: input.assignmentsGeneratedAt },
    limits: input.limits,
    admission_key: admissionKey(input.limits),
    concurrency,
    price_per_mtok: input.price,
    price_asof: input.priceAsOf,
    admitted,
    excluded: excluded.map(e => ({ ...e.lane, reason: e.reason, detail: e.detail })),
    totals: {
      hunt_lanes: input.lanes.length,
      admitted_lanes: admitted.length,
      excluded_by_reason: byReason,
      projected_calls: calls,
      projected_input_tokens: inputTokens,
      projected_output_tokens: scanCost?.output_tokens ?? sum(l => l.projected_output_tokens),
      projected_cost_usd: cost,
      projected_wall_seconds: wall,
      wall_basis: estimation ? `${secondsPerCall} s per call per in-flight slot (registry calibration or default)` : WALL_BASIS,
    },
    estimate,
    reservation_unit_usd: reservation,
    ...(input.callConfig ? { call_config: input.callConfig } : {}),
    cap: {
      max_cost_usd: cap,
      estimate_exceeds_cap: cap != null && cost != null ? spentBefore + cost > cap : null,
      lanes_within_cap: withinCap,
    },
  }
}
