/**
 * Build the report data from a finished (or stopped) run's folder.
 *
 * Reads only what the run already wrote (the CLI's run-record.json, Stage 2's
 * candidate-findings.json, run-status.json and checkpoint, Stage 0.5's lane
 * plan, Stage 1's scan plan) and never writes to any of it. No model calls.
 *
 * Findings are copied, never edited: each gets one added field, `location`,
 * taken from its trace's last step. Stage 2 drops any finding whose trace does
 * not end in a sink (normalizeTurnFindings), so that step always exists.
 *
 * Stage directories come from the caller (the CLI resolves them through
 * runPath()), so this module never builds a stage path itself.
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'
import { scanGaps } from './gaps.js'
import {
  FINDINGS_SCHEMA, SEVERITIES,
  type CandidateFinding, type ClassRow, type Coverage, type FileRow, type FindingsReport,
  type ReportFinding, type RunStatus, type Severity, type SeverityCounts,
} from './types.js'

export type StageName =
  | 'stage-playbook-agent'
  | 'stage05-lane-selector-perfile'
  | 'stage1-budget-governor-perfile'
  | 'stage2-hunt-lanes-perfile'

const HUNT: StageName = 'stage2-hunt-lanes-perfile'

/**
 * Stage 0.5's skip reason for a file no reviewed class applies to. Not exported
 * by the selector; report.test.ts asserts the selector still writes this text.
 */
export const NO_SELECTED_CLASS_REASON = 'No selected class applies to this file'

/** Reasons that earn a report even when no file was scanned: the run failed, it was not stopped by choice. */
const FAILURE_REASONS = new Set(['stage_failed', 'provider_quota', 'provider_failing', 'unpriced_service_tier'])

const CLASS_REGISTRY = fileURLToPath(new URL('../../shared/vuln-classes.json', import.meta.url))

/** The parts of the CLI's run record (secscan.run-record/1) the report reads. */
interface RunRecordLike {
  run_id: string
  passes?: number
  created_at?: string
  updated_at?: string
  status: 'COMPLETE' | 'INCOMPLETE'
  incomplete_reasons?: { reason: string; detail: string }[]
  target?: { root?: string | null; commit?: string | null; branch?: string | null }
  model?: { key?: string; model?: string; label?: string }
  limits?: { max_cost_usd?: number | null; timeout_seconds?: number | null }
  stages?: { stage: string; started_at: string; ended_at: string }[]
  coverage?: { inventory_files?: number | null; admitted?: number | null; completed?: number | null }
  unscanned?: { lane_id?: string; target_file: string; reason: string; detail: string }[]
  scope_excluded?: unknown[]
  spend?: { spent_usd?: number | null; cap_usd?: number | null; input_tokens?: number | null; output_tokens?: number | null }
  resume_command?: string | null
}

interface LaneLite { lane_id: string; target_file: string; disposition: 'hunt' | 'skip'; skip_reason?: string | null }
interface LanePlan {
  lanes?: LaneLite[]
  coverage_ledger?: { total_files_in_inventory?: number }
  category_universe?: { code: string; name: string }[]
}
interface ScanPlanLite {
  admitted?: { lane_id: string; target_file: string }[]
  excluded?: { lane_id: string; target_file: string; reason: string }[]
}

export interface BuildInput {
  /** The run's folder: <reports>/runs/<run-id>. */
  runDir: string
  /** Resolves a stage's artifact directory for this run (runPath(provider, stage) in the CLI). */
  stageDir: (stage: StageName) => string
  secscanVersion: string
  /** Fixed in tests so output is reproducible. */
  now?: Date
  /** Model key, when there is no run record to read it from. */
  modelKey?: string
}

export interface BuildResult {
  report: FindingsReport
  /** Whether the agreed rules call for a report on this run. */
  eligible: boolean
  /** Why not, when not eligible. */
  why: string | null
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
const rank = (s: string) => SEVERITY_RANK[s] ?? 4
const zero = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0 })
const isSeverity = (s: string): s is Severity => (SEVERITIES as readonly string[]).includes(s)

/** Report order: severity, then confidence (highest first), then file, line and id. */
export function compareFindings(a: ReportFinding, b: ReportFinding): number {
  return rank(a.severity_estimate) - rank(b.severity_estimate) ||
    b.confidence - a.confidence ||
    (a.location.file < b.location.file ? -1 : a.location.file > b.location.file ? 1 : 0) ||
    (a.location.line ?? Infinity) - (b.location.line ?? Infinity) ||
    (a.finding_id < b.finding_id ? -1 : a.finding_id > b.finding_id ? 1 : 0)
}

/** The finding's primary location: its trace's last step (the sink). */
export function locate(f: CandidateFinding, laneFile: (laneId: string) => string | undefined): ReportFinding['location'] {
  const last = Array.isArray(f.trace) && f.trace.length ? f.trace[f.trace.length - 1] : null
  if (last && typeof last.file === 'string') return { file: last.file, line: typeof last.line === 'number' ? last.line : null }
  // Defensive only: Stage 2 never emits a finding without a sink step.
  return { file: laneFile(f.lane_id) ?? '', line: null }
}

/** A shallow copy with `location` appended. Every Stage 2 field, the trace included, is the same object. */
function withLocation(f: CandidateFinding, location: ReportFinding['location']): ReportFinding {
  return { ...f, location }
}

function checkpointEntries(huntDir: string): { lane_id: string; failed?: boolean }[] | null {
  const raw = readJson<any>(join(huntDir, 'budget-consumption.json'))
  if (raw == null) return null
  return Array.isArray(raw) ? raw : Array.isArray(raw.legacy_entries) ? raw.legacy_entries : []
}

function classCodes(stageDir: BuildInput['stageDir']): Map<string, string[]> {
  const codes = new Map<string, string[]>()
  const builtins = readJson<Record<string, { codes?: string[] }>>(CLASS_REGISTRY) ?? {}
  const overlay = readJson<Record<string, { codes?: string[] }>>(join(stageDir('stage-playbook-agent'), 'classes-overlay.json')) ?? {}
  for (const table of [builtins, overlay]) {
    for (const [id, entry] of Object.entries(table)) if (Array.isArray(entry?.codes)) codes.set(id, entry.codes)
  }
  return codes
}

export function buildReport(input: BuildInput): BuildResult {
  const { runDir, stageDir } = input
  const huntDir = stageDir(HUNT)
  const findingsPath = join(huntDir, 'candidate-findings.json')
  const record = readJson<RunRecordLike>(join(runDir, 'run-record.json'))
  const candidates = readJson<CandidateFinding[]>(findingsPath) ?? []
  const lanePlan = readJson<LanePlan>(join(stageDir('stage05-lane-selector-perfile'), 'lane-assignments.json'))
  const scanPlan = readJson<ScanPlanLite>(join(stageDir('stage1-budget-governor-perfile'), 'scan-plan.json'))
  const checkpoint = checkpointEntries(huntDir)

  const laneFiles = new Map((lanePlan?.lanes ?? []).map(l => [l.lane_id, l.target_file]))
  const findings = candidates
    .map(f => withLocation(f, locate(f, id => laneFiles.get(id))))
    .sort(compareFindings)

  // ── Status ──────────────────────────────────────────────────────────────
  // The run record is the verdict. Findings written after it mean a later
  // pass started and never recorded how it ended.
  const recordAt = record?.updated_at ? Date.parse(record.updated_at) : NaN
  const findingsAt = existsSync(findingsPath) ? statSync(findingsPath).mtimeMs : NaN
  const staleRecord = Boolean(record) && Number.isFinite(recordAt) && Number.isFinite(findingsAt) && findingsAt > recordAt + 1000
  let status: RunStatus = record ? record.status : 'UNKNOWN'
  if (staleRecord) status = 'INCOMPLETE'
  const reasons = record?.incomplete_reasons ?? []

  // ── Coverage ────────────────────────────────────────────────────────────
  // A record whose coverage.completed is set was written from a fresh Stage 2
  // status. Without one (the hunt was killed, or no record at all), count from
  // Stage 2's checkpoint, which it rewrites after every finished file.
  const huntRan = checkpoint !== null || (record?.stages ?? []).some(s => s.stage === HUNT)
  const fresh = !staleRecord && record?.coverage?.completed != null
  const overMax = (scanPlan?.excluded ?? []).filter(e => e.reason === 'over-max-files')
  let scanned: number | null
  let inScope: number | null
  let notScannedList: FindingsReport['not_scanned']
  let unrecorded = false
  if (fresh) {
    scanned = record!.coverage!.completed!
    const unscanned = record!.unscanned ?? []
    inScope = record!.coverage!.admitted != null
      ? record!.coverage!.admitted + unscanned.filter(u => u.reason === 'over-max-files').length
      : null
    notScannedList = unscanned.map(u => ({ file: u.target_file, reason: u.reason, detail: u.detail }))
  } else if (huntRan && scanPlan?.admitted) {
    const done = new Set((checkpoint ?? []).filter(e => !e.failed).map(e => e.lane_id))
    const failed = new Set((checkpoint ?? []).filter(e => e.failed && !done.has(e.lane_id)).map(e => e.lane_id))
    scanned = scanPlan.admitted.filter(l => done.has(l.lane_id)).length
    inScope = scanPlan.admitted.length + overMax.length
    notScannedList = [
      ...scanPlan.admitted.filter(l => !done.has(l.lane_id)).map(l => failed.has(l.lane_id)
        ? { file: l.target_file, reason: 'failed', detail: 'failed every attempt' }
        : { file: l.target_file, reason: 'unrecorded', detail: 'not finished when the hunt stopped' }),
      ...overMax.map(l => ({ file: l.target_file, reason: 'over-max-files', detail: 'past --max-files' })),
    ]
    unrecorded = true
  } else {
    // The hunt never wrote a checkpoint, so no file finished.
    scanned = huntRan ? null : 0
    inScope = record?.coverage?.admitted != null
      ? record.coverage.admitted + overMax.length
      : scanPlan?.admitted ? scanPlan.admitted.length + overMax.length : null
    notScannedList = (record?.unscanned ?? []).map(u => ({ file: u.target_file, reason: u.reason, detail: u.detail }))
  }
  const notScannedByReason: Record<string, number> = {}
  for (const u of notScannedList) notScannedByReason[u.reason] = (notScannedByReason[u.reason] ?? 0) + 1

  const lanes = lanePlan?.lanes ?? null
  const coverage: Coverage = {
    files_in_repo: lanePlan?.coverage_ledger?.total_files_in_inventory ?? record?.coverage?.inventory_files ?? null,
    skipped_by_selector: lanes ? lanes.filter(l => l.disposition === 'skip' && l.skip_reason !== NO_SELECTED_CLASS_REASON).length : null,
    skipped_no_selected_class: lanes ? lanes.filter(l => l.disposition === 'skip' && l.skip_reason === NO_SELECTED_CLASS_REASON).length : null,
    scope_excluded: fresh
      ? (record!.scope_excluded ?? []).length
      : scanPlan?.excluded ? scanPlan.excluded.filter(e => e.reason !== 'over-max-files').length : (record?.scope_excluded?.length ?? null),
    in_scope: inScope,
    scanned,
    not_scanned: scanned === null && inScope === null ? null : notScannedList.length,
    not_scanned_by_reason: notScannedByReason,
  }

  // ── Summary counts ──────────────────────────────────────────────────────
  const bySeverity = zero()
  const locations = new Set<string>()
  const files = new Map<string, FileRow>()
  const classes = new Map<string, ClassRow>()
  const codesFor = classCodes(stageDir)
  const usedCodes = new Set<string>()
  for (const f of findings) {
    const sev = f.severity_estimate
    if (isSeverity(sev)) bySeverity[sev] = (bySeverity[sev] ?? 0) + 1
    locations.add(`${f.location.file}\u0000${f.location.line}`)
    const row = files.get(f.location.file) ?? { file: f.location.file, count: 0, by_severity: zero() }
    row.count++
    if (isSeverity(sev)) row.by_severity[sev] = (row.by_severity[sev] ?? 0) + 1
    files.set(f.location.file, row)
    for (const c of f.categories ?? []) usedCodes.add(c)
    // A finding counts once under each distinct class it carries.
    for (const id of new Set((f.finding_classes ?? []).map(c => c.class))) {
      const cls = classes.get(id) ?? { class: id, codes: codesFor.get(id) ?? [], count: 0, by_severity: zero() }
      cls.count++
      if (isSeverity(sev)) cls.by_severity[sev] = (cls.by_severity[sev] ?? 0) + 1
      classes.set(id, cls)
    }
  }
  for (const c of classes.values()) for (const code of c.codes) usedCodes.add(code)
  // Critical stays only in a run that has a critical finding.
  if (!bySeverity.critical) {
    for (const counts of [bySeverity, ...[...files.values(), ...classes.values()].map(r => r.by_severity)]) delete counts.critical
  }
  const bySeverityDesc = (a: SeverityCounts, b: SeverityCounts) =>
    (b.critical ?? 0) - (a.critical ?? 0) || b.high - a.high || b.medium - a.medium || b.low - a.low
  const categoryNames: Record<string, string> = {}
  for (const entry of [...(lanePlan?.category_universe ?? [])].sort((a, b) => a.code.localeCompare(b.code))) {
    if (usedCodes.has(entry.code) && entry.name && !(entry.code in categoryNames)) categoryNames[entry.code] = entry.name
  }

  const wallClock = record?.stages?.length
    ? Math.round(record.stages.reduce((s, st) => {
        const d = Date.parse(st.ended_at) - Date.parse(st.started_at)
        return s + (Number.isFinite(d) && d > 0 ? d : 0)
      }, 0) / 1000)
    : null

  const gaps = scanGaps({
    reasons,
    capUsd: record?.spend?.cap_usd ?? record?.limits?.max_cost_usd ?? null,
    timeoutSeconds: record?.limits?.timeout_seconds ?? null,
    failedFiles: notScannedByReason.failed ?? 0,
    notScanned: coverage.not_scanned,
    inScope,
    notScannedByReason,
    noRecord: !record,
    staleRecord,
    unrecorded: unrecorded && Boolean(record) && !staleRecord,
  })

  const report: FindingsReport = {
    schema: FINDINGS_SCHEMA,
    generated_at: (input.now ?? new Date()).toISOString(),
    secscan_version: input.secscanVersion,
    run: {
      id: record?.run_id ?? basename(runDir),
      passes: record?.passes ?? null,
      status,
      started_at: record?.created_at ?? null,
      ended_at: record?.updated_at ?? null,
      target: { root: record?.target?.root ?? null, branch: record?.target?.branch ?? null, commit: record?.target?.commit ?? null },
      model: { key: record?.model?.key ?? input.modelKey ?? '', name: record?.model?.model ?? null, label: record?.model?.label ?? null },
    },
    scan_gaps: status === 'COMPLETE' ? [] : gaps,
    summary: {
      findings_total: findings.length,
      distinct_locations: locations.size,
      files_with_findings: files.size,
      by_severity: bySeverity,
      by_class: [...classes.values()].sort((a, b) => b.count - a.count || bySeverityDesc(a.by_severity, b.by_severity) || a.class.localeCompare(b.class)),
      top_files: [...files.values()]
        .sort((a, b) => b.count - a.count || bySeverityDesc(a.by_severity, b.by_severity) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
        .slice(0, 10),
      review_first: findings.slice(0, 10).map(f => f.finding_id),
      category_names: categoryNames,
      coverage,
      cost: { spent_usd: record?.spend?.spent_usd ?? null, budget_usd: record?.spend?.cap_usd ?? null },
      usage: { input_tokens: record?.spend?.input_tokens ?? null, output_tokens: record?.spend?.output_tokens ?? null, wall_clock_seconds: wallClock },
    },
    not_scanned: notScannedList,
    resume_command: record?.resume_command ?? null,
    findings,
  }

  // ── Eligibility ─────────────────────────────────────────────────────────
  // Any run that scanned a file, and every COMPLETE run, gets a report. One
  // that scanned none gets one only when it failed; a run the user stopped
  // before anything finished, or whose budget could not cover one file, does not.
  const failed = reasons.some(r => FAILURE_REASONS.has(r.reason))
  let why: string | null = null
  if (status !== 'COMPLETE' && !((scanned ?? 0) > 0) && !(scanned === null && findings.length > 0) && !failed) {
    why = reasons.some(r => r.reason === 'cancelled')
      ? 'the run was not started at the confirmation screen'
      : 'no files were scanned'
  }
  return { report, eligible: why === null, why }
}
