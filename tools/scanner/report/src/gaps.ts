/**
 * Scan gaps: the run's own reasons for being incomplete, in plain words.
 *
 * Only facts about this run appear here (why it stopped, what was not
 * scanned, what failed). The run record's reason codes stay in `reason`, so a
 * script can still branch on them; `detail` is the sentence the page shows.
 *
 * Zero dependencies.
 */
import type { ScanGap } from './types.js'

/** Short words for not-scanned reasons, used in counts like "35 budget, 3 failed". */
export const NOT_SCANNED_WORDS: Record<string, string> = {
  max_cost: 'budget',
  timeout: 'time limit',
  interrupted: 'interrupted',
  failed: 'failed',
  aborted_in_flight: 'abandoned',
  'over-max-files': 'file limit',
  provider_quota: 'provider quota',
  provider_failing: 'provider failing',
  unpriced_service_tier: 'unpriced tier',
  chunk_bound: 'bounded pass',
  unrecorded: 'stopped before recording',
}

export interface GapContext {
  /** The run record's incomplete reasons, in its order. */
  reasons: { reason: string; detail: string }[]
  capUsd: number | null
  timeoutSeconds: number | null
  /** Files that failed every attempt. */
  failedFiles: number
  notScanned: number | null
  inScope: number | null
  notScannedByReason: Record<string, number>
  /** The report's own observations about the record itself. */
  noRecord: boolean
  staleRecord: boolean
  unrecorded: boolean
}

const usd = (n: number) => `$${n.toFixed(2)}`

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export function breakdown(byReason: Record<string, number>): string {
  return Object.entries(byReason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${n} ${NOT_SCANNED_WORDS[reason] ?? reason}`)
    .join(', ')
}

function sentence(r: { reason: string; detail: string }, c: GapContext): string | null {
  switch (r.reason) {
    case 'cancelled': return null
    case 'max_cost': return c.capUsd != null ? `Stopped early: budget of ${usd(c.capUsd)} reached` : 'Stopped early: budget reached'
    case 'timeout': return c.timeoutSeconds != null ? `Stopped early: time limit of ${duration(c.timeoutSeconds)} reached` : 'Stopped early: time limit reached'
    case 'interrupted': return 'Stopped early: interrupted'
    case 'chunk_bound': return 'Stopped after a bounded pass'
    case 'provider_quota': return 'Stopped: the model provider refused because of a quota or spending limit'
    case 'provider_failing': return 'Stopped: three files in a row failed every attempt, so the provider appears to be failing'
    case 'unpriced_service_tier': return 'Stopped: the provider served a service tier that has no registered price'
    case 'over-max-files': return `Files past the --max-files limit were not scanned (${r.detail})`
    case 'failed_lanes': return `${c.failedFiles || 'Some'} file${c.failedFiles === 1 ? '' : 's'} failed after three attempts; a resume retries them`
    case 'blocked_reads': return `Reads refused by the read guard: ${r.detail}`
    // stage_failed already names the stage and its log in plain words.
    default: return r.detail || r.reason
  }
}

export function scanGaps(c: GapContext): ScanGap[] {
  const gaps: ScanGap[] = []
  if (c.noRecord) gaps.push({ reason: 'no_record', detail: 'The scan was cut off before it recorded its result' })
  if (c.staleRecord) gaps.push({ reason: 'stale_record', detail: 'A later pass did not finish; its findings are included but it recorded no result' })
  for (const r of c.reasons) {
    const detail = sentence(r, c)
    if (detail) gaps.push({ reason: r.reason, detail })
  }
  if (c.unrecorded) {
    gaps.push({ reason: 'unrecorded', detail: 'The hunt stopped before it recorded its status; scanned files are counted from its saved progress' })
  }
  if (c.notScanned) {
    const by = breakdown(c.notScannedByReason)
    gaps.push({
      reason: 'not_scanned',
      detail: `${c.notScanned} of ${c.inScope ?? 'unknown'} files not scanned${by ? ` (${by})` : ''}; list in findings.json`,
    })
  }
  return gaps
}
