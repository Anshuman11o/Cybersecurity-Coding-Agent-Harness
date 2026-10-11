/**
 * Report stage types: what the report reads, and the model every output is
 * rendered from (findings.json is this model, serialized).
 *
 * The input types are deliberately loose. The report reads artifacts written
 * by every Stage 2 run there has been, including ones made before the
 * explanation fields (plan §2.9) existed, so nothing beyond the fields every
 * run has always written may be assumed present.
 */

// ── Inputs (as written by Stages 0 to 2) ────────────────────────────────────

export interface InTraceStep {
  kind: string
  file?: string
  line: number
  description?: string
}

export interface InConfidenceReason {
  validation?: string
  assumptions?: string[]
  summary?: string
}

export interface InFinding {
  finding_id: string
  lane_id: string
  finding_classes?: { class: string; justified_by_step?: number }[]
  categories?: string[]
  title: string
  description?: string
  trace: InTraceStep[]
  severity_estimate?: string
  confidence?: number
  cwe?: string[]
  severity_reason?: string
  confidence_reason?: InConfidenceReason
  attack_scenario?: string
  remediation?: string
}

export interface InLane {
  lane_id: string
  target_file: string
  disposition: 'hunt' | 'skip'
  skip_reason: string | null
  classes?: string[]
  categories?: { code: string; name: string; framework?: string }[]
  signals?: string[]
  file_bytes: number
  file_lines: number
}

export interface InAssignments {
  generated_at?: string
  target_dir: string
  coverage_ledger: {
    total_files_in_inventory: number
    assigned_hunt: number
    assigned_skip: number
    unaccounted: number
  }
  category_universe?: { code: string; name: string; framework?: string }[]
  lanes: InLane[]
}

export interface InLegacyEntry {
  lane_id: string
  tokens_used: number
  seconds_elapsed?: number
  failed?: boolean
  failure_reason?: string
}

export interface InMeasured {
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  cached_prompt_tokens?: number | null
  cache_write_prompt_tokens?: number | null
}

export interface InLaneRecord {
  lane_id: string
  target_file: string
  chunks: { measured: InMeasured }[]
  lane_totals?: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null }
}

export interface InConsumption {
  generated_at?: string
  provider?: string
  model?: string | null
  lanes?: InLaneRecord[]
  rollup?: unknown
  legacy_entries?: InLegacyEntry[]
}

export interface InUsage {
  generated_at?: string
  provider?: string
  model?: string
  calls?: number | null
  input_tokens?: number | null
  cached_input_tokens?: number | null
  cache_write_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
  cost_usd?: number | null
  price_asof?: string | null
}

export interface InPlan {
  total_projected_cost_usd?: number | null
  total_projected_input_tokens?: number
  total_projected_output_tokens?: number
}

export interface InMeta {
  provider?: string
  model?: string
  stage?: string
  git_sha?: string
  started?: string
  ended?: string
  exit_code?: number
  blocked_reads?: number
  degraded?: boolean
  sampling?: Record<string, unknown>
  max_output_tokens?: number
  loop_mode?: string
  loop_passes?: number
  sweep_group_size?: number
  run_context?: Record<string, unknown>
}

export interface InRoute {
  method?: string
  path?: string
  handler?: string
  auth?: string | null
  file?: string
  line?: number
}

export interface InArchitecture {
  route_table?: { hand_written_routes?: InRoute[] }
  client_side?: { escape_hatch_findings?: { file: string; line: number; type: string }[] }
}

export interface InFileSignals {
  target_dir?: string
  files?: Record<string, string[]>
}

// ── Task 1c's hand-off (stage1-budget-governor/src/run-status.ts, scan-plan.ts,
//    cli/src/run-record.ts). Only the fields the report reads. ─────────────────

export interface InReason { reason: string; detail: string }
export interface InUnscanned { lane_id: string; target_file: string; reason: string; detail: string }

/** Stage 2's own end-of-run verdict: run-status.json. */
export interface InRunStatus {
  generated_at?: string
  ended_at?: string
  status?: 'COMPLETE' | 'INCOMPLETE'
  reasons?: InReason[]
  unscanned?: InUnscanned[]
  scope_excluded?: InUnscanned[]
  spend?: { spent_usd?: number | null; estimate_usd?: number | null; cap_usd?: number | null }
}

/** Stage 1's admission: scan-plan.json. */
export interface InScanPlan {
  limits?: Record<string, unknown>
  excluded?: { lane_id: string; target_file: string; reason: string; detail: string }[]
  totals?: { projected_cost_usd?: number | null }
  cap?: { max_cost_usd?: number | null }
}

/** The CLI's manifest of the whole run: run-record.json. Authoritative on status when present. */
export interface InRunRecord {
  updated_at?: string
  status?: 'COMPLETE' | 'INCOMPLETE'
  incomplete_reasons?: InReason[]
  unscanned?: InUnscanned[]
  scope_excluded?: InUnscanned[]
  limits?: Record<string, unknown>
  config_file?: { path: string; sha256: string } | null
  confirmation?: { by: string; at: string; summary?: { scan?: { dirs?: string[] }; skip?: { dirs?: string[] } } } | null
  spend?: { estimate_usd?: number | null; spent_usd?: number | null; reconciled_usd?: number | null; cap_usd?: number | null }
}

/** Everything the report reads, already parsed. Only the first two are required. */
export interface ReportInputs {
  findings: InFinding[]
  assignments: InAssignments
  consumption: InConsumption | null
  usage: InUsage | null
  plan: InPlan | null
  stage2Meta: InMeta | null
  stage0Meta: InMeta | null
  architecture: InArchitecture | null
  fileSignals: InFileSignals | null
  /** vuln-classes.json: class id -> { playbook, codes } */
  classRegistry: Record<string, { playbook: string; codes: string[] }>
  /** signal-classes.json */
  signalClasses: { floor?: string[]; signals?: Record<string, string[]> } | null
  /** Count of `[RETRY]` lines in Stage 2's stdout log; null when the log is absent. */
  retries: number | null
  /** Whether usage-v2.json was older than the Stage 2 consumption it should describe. */
  usageStale: boolean
  runStatus: InRunStatus | null
  scanPlan: InScanPlan | null
  runRecord: InRunRecord | null
}

// ── Environment the report is built in ──────────────────────────────────────

export interface RepoInfo {
  /** Absolute target root the lanes are relative to. */
  root: string
  name: string
  branch: string | null
  commit: string | null
  /** owner/repo when the origin (or GITHUB_REPOSITORY) is GitHub. */
  github: { server: string; owner: string; repo: string } | null
  /** Path of the target root inside its git work tree ("" at the top), with a trailing slash. */
  prefix: string
  /** Target-relative paths whose working copy differs from HEAD (modified or untracked). */
  dirty: Set<string>
  /** False when the target is not in a git work tree at all. */
  isGit: boolean
  /** False when `git status` could not be read; then no file is known to match HEAD. */
  statusKnown: boolean
}

/**
 * The chosen model's lab result: the registry's `benchmark` block (models.json,
 * pinned to docs/benchmarking-results.md by guard.test.ts), plus the precision
 * proxy from this package's benchmark-reference.json, which the registry does
 * not carry. Null for an unmeasured model.
 */
export interface ModelBenchmark {
  run: string
  corpus: string
  recall: string
  localization: string
  precision_proxy: string | null
  /** Languages measured on this model, as the registry names them (lower case). */
  languages: string[]
  source: string
}

export interface BuildEnv {
  provider: string
  modelLabel: string
  repo: RepoInfo
  /** Read a target-relative file through the read guard; null when refused or missing. */
  readTargetFile: (relPath: string) => string | null
  /** Cost in USD for a token split under this provider's registry price; null when unpriced. */
  costUsd: (input: number, output: number, cached: number, written: number) => number | null
  priceAsOf: string | null
  benchmark: ModelBenchmark | null
  tool: { name: string; version: string; scannerGitSha: string | null }
  profile: string
  runId: string | null
  generatedAt: string
}

// ── The report model (findings.json) ────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type ConfidenceBand = 'High' | 'Medium' | 'Low'

export interface ExcerptLine { n: number; text: string; cited: boolean }

export interface EvidenceStep {
  index: number
  kind: string
  path: string
  line: number
  /** True when the cited line exists in the file on disk. */
  resolves: boolean
  description: string
  excerpt: ExcerptLine[] | null
  /** Set only when the model named a different file than the lane's; the lane wins. */
  model_cited_file?: string
}

export interface ScannerSignal {
  signal: 'trace_complete' | 'entry_exposed' | 'known_sink' | 'playbook_coverage'
  value: boolean | null
  detail: string
}

export interface ReportFinding {
  /** Stable fingerprint: same issue, same id, across runs. */
  id: string
  /** Full sha256 behind `id`, as SARIF partialFingerprints carries it. */
  fingerprint: string
  source_finding_id: string
  lane_id: string
  title: string
  description: string
  classes: string[]
  owasp: { code: string; name: string }[]
  cwe: string[]
  /** "other (recon-guided)" when no class is in the built-in registry. */
  category_label: string
  severity: Severity
  severity_reason: string | null
  confidence: number
  confidence_band: ConfidenceBand
  confidence_explanation: {
    text: string
    scanner_signals: ScannerSignal[]
    model_reasoning: { validation: string | null; assumptions: string[]; summary: string | null } | null
  }
  location: {
    path: string
    line: number
    resolves: boolean
    display: string
    permalink: string | null
  }
  evidence: EvidenceStep[]
  attack_scenario: string | null
  remediation: string | null
  /** Explanation fields this finding's Stage 2 output did not carry. */
  fields_missing: string[]
  /** True when the file's line count on disk differs from the one Stage 0.5 recorded. */
  file_changed_since_scan: boolean
  rank_score: number
}

export interface SkippedFile { path: string; category: string; reason: string }
export interface FailedLane { lane_id: string; path: string; reason: string }

export interface Report {
  schema_version: '1.0'
  generated_at: string
  tool: { name: string; version: string; scanner_git_sha: string | null }
  header: {
    repo: string
    root: string
    branch: string | null
    commit: string | null
    github: string | null
    date: string
    model: string
    provider: string
    scope: { mode: 'full' | 'diff' | 'paths'; detail: string }
    config_hash: string
    profile: string
    run_id: string | null
  }
  status: { state: 'COMPLETE' | 'INCOMPLETE'; reasons: string[] }
  summary: {
    total: number
    by_severity: Record<Severity, number>
    by_confidence_band: Record<ConfidenceBand, number>
    by_owasp: { code: string; name: string; count: number }[]
    by_cwe: { cwe: string; count: number }[]
    other_recon_guided: number
    review_first: string[]
    hotspots: { path: string; count: number }[]
  }
  coverage: {
    files_total: number
    files_scanned: number
    files_skipped: number
    skipped_by_reason: Record<string, number>
    files_failed: number
    files_not_run: number
    code_lines_scanned: number
    code_lines_total: number
    code_lines_pct: number | null
    languages: { language: string; files: number; scanned: number; code: boolean; measured: boolean }[]
    directories_included: string[]
    directories_excluded: string[]
    /** `confirmed`: from the CLI's confirmation screen; `derived`: from which files were scanned. */
    directories_basis: 'confirmed' | 'derived'
    /** Hunt files the user's scope left out (--paths, --include/--exclude, --max-file-size). */
    files_scope_excluded: number
    classes_hunted: { class: string; source: 'built-in' | 'recon-guided'; playbook: string; owasp: string[]; lanes: number }[]
    guidance_sources: string[]
  }
  limitations: string[]
  run_stats: {
    model: string
    provider: string
    input_tokens: number | null
    cached_input_tokens: number | null
    output_tokens: number | null
    total_tokens: number | null
    calls: number | null
    cost_usd: number | null
    cost_source: string
    estimate_usd: number | null
    cap_usd: number | null
    price_asof: string | null
    wall_clock_seconds: number | null
    stage2_seconds: number | null
    retries: number | null
    loop_mode: string | null
    reasoning_effort: string | null
  }
  benchmark_reference: (ModelBenchmark & { provider: string }) | null
  findings: ReportFinding[]
  appendix: {
    skipped_files: SkippedFile[]
    failed_lanes: FailedLane[]
    guidance_sources: string[]
    config: Record<string, unknown>
  }
}
