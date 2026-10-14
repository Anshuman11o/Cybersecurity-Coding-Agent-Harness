/**
 * The report's data contract: `findings.json` (schema secscan.findings/1).
 *
 * `report.html` is rendered from exactly this object, so the page and the file
 * can never disagree. Every finding is Stage 2's own entry, unchanged, plus one
 * added field, `location`, copied from the trace's last step (Stage 2 drops any
 * finding whose trace does not end in a sink, so that step always exists).
 *
 * Zero dependencies.
 */

export const FINDINGS_SCHEMA = 'secscan.findings/1'
export const FINDINGS_FILE = 'findings.json'
export const REPORT_FILE = 'report.html'
export const INDEX_FILE = 'index.html'

/** Every severity Stage 2 may write, most severe first. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type Severity = (typeof SEVERITIES)[number]
/**
 * Findings per severity. `critical` is present only when the run has a critical
 * finding; otherwise the report carries and shows High, Medium and Low alone.
 */
export type SeverityCounts = { critical?: number; high: number; medium: number; low: number }

/** The severities to show for these counts: Critical only when there is one. */
export function shownSeverities(counts: Partial<Record<Severity, number>> | null | undefined): Severity[] {
  return (counts?.critical ?? 0) > 0 ? [...SEVERITIES] : SEVERITIES.filter(s => s !== 'critical')
}

/** Confidence bands, for display next to a finding's confidence. Never written into a finding. */
export type ConfidenceBand = 'High' | 'Medium' | 'Low'
export function confidenceBand(confidence: number): ConfidenceBand {
  return confidence >= 0.8 ? 'High' : confidence >= 0.5 ? 'Medium' : 'Low'
}

/** Stage 2's trace step, as written. */
export interface TraceStep {
  kind: 'entrypoint' | 'propagation' | 'sink'
  file: string
  line: number
  description: string
}

/** Stage 2's finding, as written (candidate-findings.json). */
export interface CandidateFinding {
  finding_id: string
  lane_id: string
  finding_classes: { class: string; justified_by_step: number }[]
  categories: string[]
  title: string
  description: string
  trace: TraceStep[]
  severity_estimate: string
  confidence: number
}

/** A finding in findings.json: the Stage 2 entry plus `location`. */
export interface ReportFinding extends CandidateFinding {
  location: { file: string; line: number | null }
}

export type RunStatus = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN'

export interface ScanGap {
  /** Machine reason (the run record's reason code, or one of the report's own: not_scanned, unrecorded, stale_record, no_record). */
  reason: string
  /** Plain-language sentence shown in the Scan gaps box. */
  detail: string
}

export interface ClassRow {
  class: string
  /** Codes the class maps to (registry or the run's added-class overlay). */
  codes: string[]
  /** Findings carrying this class. A finding counts under every class it carries. */
  count: number
  by_severity: SeverityCounts
}

export interface FileRow {
  file: string
  count: number
  by_severity: SeverityCounts
}

export interface Coverage {
  /** Every file recon inventoried. */
  files_in_repo: number | null
  /** Files the lane selector skipped (non-code, tests, empty, too large, denylisted). */
  skipped_by_selector: number | null
  /** Files left with no selected class after class review. */
  skipped_no_selected_class: number | null
  /** Files the user's scope left out (--paths, --include/--exclude, --max-file-size). */
  scope_excluded: number | null
  /** Files this scope covers: admitted plus those --max-files cut. */
  in_scope: number | null
  /** Files whose hunt finished. Null only when it cannot be known. */
  scanned: number | null
  not_scanned: number | null
  not_scanned_by_reason: Record<string, number>
}

export interface FindingsReport {
  schema: typeof FINDINGS_SCHEMA
  generated_at: string
  secscan_version: string
  run: {
    id: string
    passes: number | null
    status: RunStatus
    started_at: string | null
    ended_at: string | null
    target: { root: string | null; branch: string | null; commit: string | null }
    model: { key: string; name: string | null; label: string | null }
  }
  /** Facts about this run's gaps. Empty on a complete run. */
  scan_gaps: ScanGap[]
  summary: {
    findings_total: number
    /** Distinct file:line locations among the findings. */
    distinct_locations: number
    files_with_findings: number
    by_severity: SeverityCounts
    /** Every class carried by at least one finding, most findings first. */
    by_class: ClassRow[]
    /** Up to ten files with the most findings. */
    top_files: FileRow[]
    /** Up to ten finding ids, in report order (severity, then confidence). */
    review_first: string[]
    /** OWASP code to display name, from the run's lane plan. Display only. */
    category_names: Record<string, string>
    coverage: Coverage
    cost: { spent_usd: number | null; budget_usd: number | null }
    usage: { input_tokens: number | null; output_tokens: number | null; wall_clock_seconds: number | null }
  }
  /** Every in-scope file that was not scanned, with its reason. */
  not_scanned: { file: string; reason: string; detail: string }[]
  resume_command: string | null
  /** Report order: severity, then confidence (highest first), then file, line and id. */
  findings: ReportFinding[]
}

/** One row of the reports folder's index.html. */
export interface IndexEntry {
  run_id: string
  /** Path to the run's report.html, relative to the reports folder. */
  href: string
  status: RunStatus
  started_at: string | null
  target_root: string | null
  branch: string | null
  commit: string | null
  findings_total: number
  by_severity: SeverityCounts
  scanned: number | null
  in_scope: number | null
  spent_usd: number | null
  budget_usd: number | null
}
