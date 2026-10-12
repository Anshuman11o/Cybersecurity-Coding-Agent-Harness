/**
 * Live progress and end-of-run status for Stage 2 — the contract between the
 * stage that does the work and the parties that report on it.
 *
 *   progress.json    rewritten (atomically) as lanes start and finish. The CLI
 *                    polls it for the live progress line; nothing else should
 *                    treat it as a result.
 *   run-status.json  written once, when Stage 2 ends for any reason — finished,
 *                    a limit, Ctrl-C, or an abort. COMPLETE only when every
 *                    admitted lane ran; otherwise INCOMPLETE with the reasons
 *                    and the list of what was not scanned. The CLI folds it into
 *                    the run record, and the Task 1d report reads that.
 *
 * Both live in Stage 2's own run directory. The types live here, in the budget
 * governor, because the governor's plan is what they are measured against and
 * because the CLI imports them without importing Stage 2.
 *
 * Zero dependencies.
 */
import type { ExclusionReason, RunLimits } from './limits.js'

export const PROGRESS_FILE = 'progress.json'
export const RUN_STATUS_FILE = 'run-status.json'
/** Created by the CLI to ask Stage 2 to stop after its in-flight lanes. */
export const STOP_REQUEST_FILE = 'stop-request'

export type StopReason =
  /** --max-cost: the next lane would have taken projected spend past the cap. */
  | 'max_cost'
  /** --timeout passed. */
  | 'timeout'
  /** Ctrl-C, SIGTERM, or the CLI's stop request. */
  | 'interrupted'
  /** HUNT_MAX_LANES bounded this pass (lab chunking). */
  | 'chunk_bound'
  /** The provider refused for quota or a spend limit; retrying cannot help. */
  | 'provider_quota'
  /** Three files in a row failed every attempt. */
  | 'provider_failing'
  /** A response reported a service tier the registry has no price for. */
  | 'unpriced_service_tier'

/** Why an admitted lane, or a lane the limits cut, was not scanned. */
export type UnscannedReason =
  | StopReason
  /** Started but threw; retried on --resume. */
  | 'failed'
  /** In flight when the run was aborted (a second Ctrl-C). */
  | 'aborted_in_flight'
  /** Cut by --max-files before the run started. */
  | 'over-max-files'

export interface Stage2Progress {
  schema: 'secscan.progress/1'
  updated_at: string
  /** When this Stage 2 invocation started. */
  started_at: string
  status: 'running' | 'stopping' | 'complete' | 'incomplete'
  stop: { reason: StopReason; detail: string } | null
  lanes: {
    /** Admitted lanes for the whole run, those finished in earlier passes included. */
    total: number
    /** Finished successfully, earlier passes included. */
    done: number
    /** Finished in a previous pass and carried forward by --resume. */
    carried: number
    failed: number
    in_flight: number
  }
  spend: {
    /** Measured spend of the whole run so far, earlier passes included. Null when unpriced. */
    spent_usd: number | null
    estimate_usd: number | null
    cap_usd: number | null
    /** The spend ledger's total: recon, earlier passes and this one. Optional for older run artifacts. */
    ledger_spent_usd?: number | null
  }
  /** Lanes allowed in flight now, and at the start (rate-limit step-downs lower it). Optional for older run artifacts. */
  concurrency?: { current: number; initial: number }
  findings: { total: number; by_severity: Record<'critical' | 'high' | 'medium' | 'low', number> }
}

export interface UnscannedLane {
  lane_id: string
  target_file: string
  reason: UnscannedReason
  detail: string
}

export interface ScopeExcludedLane {
  lane_id: string
  target_file: string
  reason: Exclude<ExclusionReason, 'over-max-files'>
  detail: string
}

export interface Stage2RunStatus {
  schema: 'secscan.stage2-status/1'
  generated_at: string
  started_at: string
  ended_at: string
  status: 'COMPLETE' | 'INCOMPLETE'
  /** Every reason the run is incomplete, with a plain-language detail. Empty when COMPLETE. */
  reasons: { reason: StopReason | 'failed_lanes' | 'blocked_reads' | 'over-max-files'; detail: string }[]
  lanes: {
    /** Hunt lanes in Stage 0.5's assignments. */
    hunt: number
    /** Admitted by the scan plan (all of `hunt` when there is none). */
    admitted: number
    completed: number
    failed: number
    not_started: number
  }
  /** Admitted or limit-cut lanes that were not scanned. The run is INCOMPLETE iff this is non-empty (or reads were blocked). */
  unscanned: UnscannedLane[]
  /** Lanes the user's scope left out (--paths, --include/--exclude, --max-file-size). Not incompleteness. */
  scope_excluded: ScopeExcludedLane[]
  spend: {
    spent_usd: number | null
    estimate_usd: number | null
    cap_usd: number | null
    /** Legacy field: always 1 with the fixed reservation unit U. */
    calibration: number
    /** The spend ledger's total at the end. Optional for older run artifacts. */
    ledger_spent_usd?: number | null
  }
  /** Concurrency at the start and end, and how many rate-limit step-downs it took. Optional for older run artifacts. */
  concurrency?: { initial: number; final: number; step_downs: number }
  findings_total: number
  blocked_reads: number
  limits: RunLimits | null
  /** The command that continues this run, when it is resumable. */
  resume_hint: string | null
}

/** A failed attempt can have a provider or budget reason and still have started. */
export function countNotStartedLanes(unscanned: readonly UnscannedLane[], startedIds: ReadonlySet<string>): number {
  return unscanned.filter(l => !startedIds.has(l.lane_id) && l.reason !== 'over-max-files').length
}
