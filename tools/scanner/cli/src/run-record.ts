/**
 * The run record — one file per run, `<run dir>/run-record.json`, written by
 * the CLI whenever a run ends, however it ends.
 *
 * It is the hand-off to the Task 1d report stage: what the user confirmed, what
 * ran, whether it is COMPLETE or INCOMPLETE and why, every file that was not
 * scanned and the reason, and what it cost. The report reads this rather than
 * re-deriving any of it, so a partial run can never be presented as a whole
 * one.
 *
 * COMPLETE means every file the scope admitted was scanned. Files the user's
 * scope left out (--paths, --include/--exclude, --max-file-size) are listed in
 * `scope_excluded` and do not make a run incomplete; a limit that cut the run
 * short (--max-cost, --timeout, --max-files), Ctrl-C, a failed file or a stage
 * that did not finish does.
 */
import { writeFileSync, renameSync } from 'fs'
import type { RunLimits } from '../../stage1-budget-governor/src/limits.js'
import type { Stage2RunStatus, UnscannedLane, ScopeExcludedLane } from '../../stage1-budget-governor/src/run-status.js'
import type { ConfirmationSummary } from './confirm.js'

export const RUN_RECORD_FILE = 'run-record.json'
export const RUN_RECORD_SCHEMA = 'secscan.run-record/1'

export interface StageResult {
  stage: string
  exit_code: number | null
  signal: string | null
  started_at: string
  ended_at: string
  /** Where the stage's full output went. */
  log: string
}

export type IncompleteReason =
  | Stage2RunStatus['reasons'][number]['reason']
  | 'cancelled'
  | 'stage_failed'

export interface RunRecord {
  schema: typeof RUN_RECORD_SCHEMA
  run_id: string
  /** Bumped each time the run is resumed. */
  passes: number
  created_at: string
  updated_at: string
  status: 'COMPLETE' | 'INCOMPLETE'
  incomplete_reasons: { reason: IncompleteReason; detail: string }[]
  target: { root: string; commit: string | null; branch: string | null }
  model: {
    key: string
    model: string
    label: string
    origin: string
    measured: boolean
    benchmark: unknown
    api_key_env: string
    /** Only for a custom endpoint or overlay; shipped models use the vendor default. */
    base_url: string | null
    price_per_mtok: unknown
    price_asof: string | null
  }
  config_file: { path: string; sha256: string } | null
  limits: RunLimits
  confirmation: {
    by: 'prompt' | '--yes'
    at: string
    summary: ConfirmationSummary
  } | null
  stages: StageResult[]
  coverage: {
    inventory_files: number | null
    hunt_lanes: number | null
    admitted: number | null
    completed: number | null
    failed: number | null
    not_started: number | null
  }
  unscanned: UnscannedLane[]
  scope_excluded: ScopeExcludedLane[]
  spend: {
    estimate_usd: number | null
    /** The ledger total: recon, hunt, failed attempts and earlier passes. */
    spent_usd: number | null
    /** Stage 1's post-run reconciliation (usage-v2.json), when it ran. */
    reconciled_usd: number | null
    cap_usd: number | null
    input_tokens: number | null
    output_tokens: number | null
    calls: number | null
  }
  findings_total: number | null
  artifacts: Record<string, string>
  /** The command that continues this run; null when there is nothing left to do. */
  resume_command: string | null
}

export function writeRunRecord(path: string, record: RunRecord): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n')
  renameSync(tmp, path)
}

/**
 * The verdict, from what actually happened. Stage 2's own status is the
 * authority on lanes; the CLI adds what only it can see — a cancelled
 * confirmation, a stage that never ran or exited non-zero.
 */
export function decideStatus(
  stage2: Stage2RunStatus | null,
  stages: StageResult[],
  cancelled: boolean,
): { status: 'COMPLETE' | 'INCOMPLETE'; reasons: RunRecord['incomplete_reasons'] } {
  const reasons: RunRecord['incomplete_reasons'] = []
  if (cancelled) reasons.push({ reason: 'cancelled', detail: 'the run was not started at the confirmation screen' })
  for (const s of stages) {
    // Stage 2 exits 130 after a clean interrupt; its status already says so.
    if (s.stage === 'stage2-hunt-lanes-perfile' && s.exit_code === 130 && stage2) continue
    if (s.exit_code !== 0) {
      reasons.push({
        reason: 'stage_failed',
        detail: `${s.stage} ${s.signal ? `was killed by ${s.signal}` : `exited ${s.exit_code}`}; see ${s.log}`,
      })
    }
  }
  if (stage2) reasons.push(...stage2.reasons)
  else if (!cancelled && !reasons.length) {
    reasons.push({ reason: 'stage_failed', detail: 'the hunt stage did not record a status' })
  }
  const complete = !cancelled && stage2?.status === 'COMPLETE' && reasons.length === 0
  return { status: complete ? 'COMPLETE' : 'INCOMPLETE', reasons }
}
