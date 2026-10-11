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
 * Zero dependencies apart from limits.ts, and no I/O: the caller passes the
 * lanes, the per-lane projection and the price, and writes the result.
 */
import {
  admitLanes,
  admissionKey,
  deriveConcurrency,
  type ExclusionReason,
  type RunLimits,
} from './limits.js'

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
  concurrency: { value: number; basis: string }
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
  cap: {
    max_cost_usd: number | null
    /** Null when there is no cap or no price to compare against. */
    estimate_exceeds_cap: boolean | null
    /** How many admitted lanes, in order, fit under the cap by projection. */
    lanes_within_cap: number | null
  }
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
  now?: Date
}

export function computeScanPlan(input: PlanInput): ScanPlan {
  const priced: ScanPlanLane[] = input.lanes.map(l => ({
    ...l,
    projected_cost_usd: input.cost(l.projected_input_tokens, l.projected_output_tokens),
  }))
  const { admitted, excluded } = admitLanes(priced, input.limits)
  const concurrency = deriveConcurrency(input.limits.concurrency, input.vendorConcurrencyCeiling, admitted.length)

  const sum = (f: (l: ScanPlanLane) => number) => admitted.reduce((s, l) => s + f(l), 0)
  const calls = sum(l => l.projected_calls)
  const unpriced = admitted.some(l => l.projected_cost_usd == null)
  const cost = unpriced ? null : sum(l => l.projected_cost_usd ?? 0)
  const longestLane = admitted.reduce((m, l) => Math.max(m, l.projected_calls), 0)
  const wall = Math.round(Math.max(
    (calls * SECONDS_PER_CALL_SLOT) / concurrency.value,
    longestLane * SECONDS_PER_CALL_SLOT,
  ))

  const byReason: Partial<Record<ExclusionReason, number>> = {}
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1

  const cap = input.limits.max_cost_usd
  let withinCap: number | null = null
  if (cap != null && cost != null) {
    let running = 0
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
      projected_input_tokens: sum(l => l.projected_input_tokens),
      projected_output_tokens: sum(l => l.projected_output_tokens),
      projected_cost_usd: cost,
      projected_wall_seconds: wall,
      wall_basis: WALL_BASIS,
    },
    cap: {
      max_cost_usd: cap,
      estimate_exceeds_cap: cap != null && cost != null ? cost > cap : null,
      lanes_within_cap: withinCap,
    },
  }
}
