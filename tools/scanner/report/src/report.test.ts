/**
 * The report against synthetic run folders, one per way a run can end.
 * No stage, model or network is involved; every artifact is written here in
 * the shape the scanner writes it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildReport, compareFindings, NO_SELECTED_CLASS_REASON, type StageName } from './build.js'
import { generateReport, rebuildIndex, serializeReport } from './write.js'
import type { CandidateFinding, FindingsReport } from './types.js'

const MODEL = 'luna6'
const T0 = Date.parse('2026-10-14T15:32:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const NOW = new Date('2026-10-14T16:00:00Z')

const FILES = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`)
const LANES = FILES.map((file, i) => ({ lane_id: `L${i}`, target_file: file }))

/** Stage 2 entries for the given finished lanes; f0 and f1 carry same-line and multi-class findings. */
function findingsFor(done: number[]): CandidateFinding[] {
  const out: CandidateFinding[] = []
  let n = 0
  const add = (lane: number, line: number, sev: string, conf: number, classes: string[], codes: string[]) => {
    n++
    out.push({
      finding_id: `FIND-${String(n).padStart(4, '0')}`,
      lane_id: `L${lane}`,
      finding_classes: classes.map((c, i) => ({ class: c, justified_by_step: i === 0 ? 2 : 1 })),
      categories: codes,
      title: `Finding ${n} in f${lane}`,
      description: `Line one of ${n}.\nLine two.`,
      trace: [
        { kind: 'entrypoint', file: FILES[lane], line: 3, description: 'request enters' },
        { kind: 'propagation', file: FILES[lane], line: line - 1, description: 'value flows' },
        { kind: 'sink', file: FILES[lane], line, description: 'reaches the sink' },
      ],
      severity_estimate: sev,
      confidence: conf,
    })
  }
  for (const lane of done) {
    if (lane === 0) {
      add(0, 42, 'high', 0.9, ['injection'], ['A03'])
      add(0, 42, 'critical', 0.7, ['injection', 'crypto-auth'], ['A03', 'A02', 'A07', 'API2'])
      add(0, 80, 'low', 0.3, ['logging-monitoring'], ['A09'])
    } else if (lane === 1) {
      add(1, 10, 'medium', 0.6, ['access-control'], ['A01', 'API1', 'API5'])
      add(1, 20, 'high', 0.95, ['access-control', 'injection'], ['A01', 'API1', 'API5', 'A03'])
    } else {
      add(lane, 5 + lane, lane % 2 ? 'medium' : 'low', 0.5 + lane / 100, ['misconfiguration'], ['A05', 'API8'])
    }
  }
  return out
}

interface Scenario {
  status?: 'COMPLETE' | 'INCOMPLETE'
  reasons?: { reason: string; detail: string }[]
  /** Lanes whose hunt finished (in the checkpoint and the findings). */
  done?: number[]
  failed?: number[]
  /** Lanes cut by --max-files before the run (not admitted). */
  overMax?: number[]
  /** What the run record says; null coverage.completed means Stage 2 left no fresh status. */
  freshStatus?: boolean
  unscanned?: { lane: number; reason: string }[]
  record?: boolean
  huntRan?: boolean
  planned?: boolean
  passes?: number
  limits?: { max_cost_usd?: number | null; timeout_seconds?: number | null }
}

function makeRun(root: string, id: string, s: Scenario) {
  const runDir = join(root, 'runs', id)
  const stageDir = (stage: StageName) => join(runDir, MODEL, stage)
  const overMax = new Set(s.overMax ?? [])
  const admitted = LANES.filter((_, i) => !overMax.has(i))
  const done = s.done ?? []
  const failed = s.failed ?? []
  const huntRan = s.huntRan ?? true
  const planned = s.planned ?? true

  mkdirSync(stageDir('stage05-lane-selector-perfile'), { recursive: true })
  writeFileSync(join(stageDir('stage05-lane-selector-perfile'), 'lane-assignments.json'), JSON.stringify({
    coverage_ledger: { total_files_in_inventory: 14, assigned_hunt: 10, assigned_skip: 4, unaccounted: 0 },
    category_universe: [
      { code: 'A01', name: 'Broken Access Control', framework: 'OWASP Top 10 2021' },
      { code: 'A03', name: 'Injection', framework: 'OWASP Top 10 2021' },
      { code: 'A09', name: 'Security Logging and Monitoring Failures', framework: 'OWASP Top 10 2021' },
      { code: 'LLM01', name: 'Prompt Injection', framework: 'OWASP LLM Top 10' },
    ],
    lanes: [
      ...LANES.map(l => ({ ...l, disposition: 'hunt', skip_reason: null })),
      { lane_id: 'S0', target_file: 'logo.png', disposition: 'skip', skip_reason: 'Non-code file' },
      { lane_id: 'S1', target_file: 'README.md', disposition: 'skip', skip_reason: 'Non-code file' },
      { lane_id: 'S2', target_file: 'src/util.ts', disposition: 'skip', skip_reason: NO_SELECTED_CLASS_REASON },
      { lane_id: 'S3', target_file: 'src/fmt.ts', disposition: 'skip', skip_reason: NO_SELECTED_CLASS_REASON },
    ],
  }))
  if (planned) {
    mkdirSync(stageDir('stage1-budget-governor-perfile'), { recursive: true })
    writeFileSync(join(stageDir('stage1-budget-governor-perfile'), 'scan-plan.json'), JSON.stringify({
      admitted,
      excluded: LANES.filter((_, i) => overMax.has(i)).map(l => ({ ...l, reason: 'over-max-files', detail: 'past --max-files' })),
    }))
  }
  let findingsPath = ''
  if (huntRan) {
    mkdirSync(stageDir('stage2-hunt-lanes-perfile'), { recursive: true })
    findingsPath = join(stageDir('stage2-hunt-lanes-perfile'), 'candidate-findings.json')
    writeFileSync(findingsPath, JSON.stringify(findingsFor(done), null, 2) + '\n')
    writeFileSync(join(stageDir('stage2-hunt-lanes-perfile'), 'budget-consumption.json'), JSON.stringify({
      lanes: [],
      legacy_entries: [
        ...done.map(i => ({ lane_id: `L${i}`, tokens_used: 1000, seconds_elapsed: 3, ceiling_hit: false })),
        ...failed.map(i => ({ lane_id: `L${i}`, tokens_used: 0, seconds_elapsed: 3, ceiling_hit: false, failed: true, failure_reason: 'x' })),
      ],
    }))
    // Findings are written during the hunt, before the record.
    utimesSync(findingsPath, new Date(T0 + 60_000), new Date(T0 + 60_000))
  }
  if (s.record ?? true) {
    const fresh = s.freshStatus ?? true
    const unscanned = (s.unscanned ?? []).map(u => ({ lane_id: `L${u.lane}`, target_file: FILES[u.lane], reason: u.reason, detail: `${u.reason} detail` }))
    writeFileSync(join(runDir, 'run-record.json'), JSON.stringify({
      schema: 'secscan.run-record/1',
      run_id: id,
      passes: s.passes ?? 1,
      created_at: iso(T0),
      updated_at: iso(T0 + 120_000),
      status: s.status ?? 'INCOMPLETE',
      incomplete_reasons: s.reasons ?? [],
      target: { root: '/work/app', commit: 'a1b2c3d4e5f6', branch: 'main' },
      model: { key: MODEL, model: 'gpt-6-luna', label: 'GPT-6 Luna', measured: false },
      limits: { max_cost_usd: 5, timeout_seconds: null, ...s.limits },
      stages: [
        { stage: 'stage0-recon', exit_code: 0, signal: null, started_at: iso(T0), ended_at: iso(T0 + 20_000), log: 'secscan.log' },
        ...(huntRan ? [{ stage: 'stage2-hunt-lanes-perfile', exit_code: 0, signal: null, started_at: iso(T0 + 30_000), ended_at: iso(T0 + 90_000), log: 'secscan.log' }] : []),
      ],
      coverage: {
        inventory_files: 14, hunt_lanes: 10,
        admitted: fresh ? admitted.length : (planned ? admitted.length : null),
        completed: fresh ? done.length : null,
        failed: fresh ? failed.length : null, not_started: null,
      },
      unscanned,
      scope_excluded: [],
      spend: { estimate_usd: 4, spent_usd: 4.91, reconciled_usd: null, cap_usd: s.limits?.max_cost_usd ?? 5, input_tokens: 2_100_000, output_tokens: 180_000, calls: 30 },
      findings_total: done.length,
      artifacts: {},
      resume_command: (s.status ?? 'INCOMPLETE') === 'INCOMPLETE' ? `secscan scan . --resume ${id} --budget <higher>` : null,
    }, null, 2))
  }
  return { runDir, stageDir, findingsPath }
}

function withRoot(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'secscan-report-'))
  try { fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

const build = (run: ReturnType<typeof makeRun>) =>
  buildReport({ runDir: run.runDir, stageDir: run.stageDir, secscanVersion: '0.1.0', now: NOW })
const gapReasons = (r: FindingsReport) => r.scan_gaps.map(g => g.reason)
const gapText = (r: FindingsReport) => r.scan_gaps.map(g => g.detail).join(' | ')
const ALL = [...LANES.keys()]

// ── Termination table, row by row ─────────────────────────────────────────

test('finished: COMPLETE, every file, no scan gaps', () => withRoot(root => {
  const { report, eligible } = build(makeRun(root, 'r1', { status: 'COMPLETE', done: ALL }))
  assert.equal(eligible, true)
  assert.equal(report.run.status, 'COMPLETE')
  assert.deepEqual(report.scan_gaps, [])
  assert.equal(report.summary.coverage.scanned, 10)
  assert.equal(report.summary.coverage.in_scope, 10)
  assert.equal(report.summary.coverage.not_scanned, 0)
  assert.equal(report.resume_command, null)
}))

test('finished with zero findings: still a report', () => withRoot(root => {
  const run = makeRun(root, 'r1', { status: 'COMPLETE', done: ALL })
  writeFileSync(run.findingsPath, '[]\n')
  utimesSync(run.findingsPath, new Date(T0 + 60_000), new Date(T0 + 60_000))
  const { report, eligible } = build(run)
  assert.equal(eligible, true)
  assert.equal(report.summary.findings_total, 0)
  assert.equal(report.summary.coverage.scanned, 10)
}))

test('budget reached mid-hunt: partial report of exactly the files and findings that finished', () => withRoot(root => {
  const done = [0, 1, 2, 3, 4, 5]
  const { report, eligible } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'max_cost', detail: 'cap' }], done,
    unscanned: [6, 7, 8, 9].map(lane => ({ lane, reason: 'max_cost' })),
  }))
  assert.equal(eligible, true)
  assert.equal(report.run.status, 'INCOMPLETE')
  assert.equal(report.summary.coverage.scanned, 6)
  assert.equal(report.summary.coverage.in_scope, 10)
  assert.equal(report.summary.coverage.not_scanned, 4)
  assert.deepEqual(report.summary.coverage.not_scanned_by_reason, { max_cost: 4 })
  assert.equal(report.findings.length, findingsFor(done).length)
  assert.ok(report.findings.every(f => done.includes(Number(f.lane_id.slice(1)))), 'only findings from finished files')
  assert.deepEqual(report.not_scanned.map(n => n.file), ['src/f6.ts', 'src/f7.ts', 'src/f8.ts', 'src/f9.ts'])
  assert.match(gapText(report), /Stopped early: budget of \$5\.00 reached/)
  assert.match(gapText(report), /4 of 10 files not scanned \(4 budget\); list in findings\.json/)
  assert.match(report.resume_command ?? '', /--budget <higher>/)
}))

test('budget raised at the prompt: one report for the whole run, from its final record', () => withRoot(root => {
  // The CLI continues the same run; the record it finally writes is COMPLETE.
  const { report, eligible } = build(makeRun(root, 'r1', { status: 'COMPLETE', done: ALL, limits: { max_cost_usd: 8 } }))
  assert.equal(eligible, true)
  assert.equal(report.summary.coverage.scanned, 10)
  assert.equal(report.summary.cost.budget_usd, 8)
}))

test('timeout: INCOMPLETE with the time limit named', () => withRoot(root => {
  const { report } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'timeout', detail: 't' }], done: [0, 1, 2], limits: { timeout_seconds: 1800 },
    unscanned: [3, 4, 5, 6, 7, 8, 9].map(lane => ({ lane, reason: 'timeout' })),
  }))
  assert.match(gapText(report), /Stopped early: time limit of 30m reached/)
  assert.equal(report.summary.coverage.scanned, 3)
}))

test('--max-files: cut files count as in scope and not scanned', () => withRoot(root => {
  const { report } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'over-max-files', detail: '2 file(s) past --max-files 8' }],
    done: [0, 1, 2, 3, 4, 5, 6, 7], overMax: [8, 9],
    unscanned: [8, 9].map(lane => ({ lane, reason: 'over-max-files' })),
  }))
  assert.equal(report.summary.coverage.in_scope, 10)
  assert.equal(report.summary.coverage.scanned, 8)
  assert.deepEqual(report.summary.coverage.not_scanned_by_reason, { 'over-max-files': 2 })
  assert.match(gapText(report), /--max-files/)
}))

test('Ctrl-C once: interrupted; files in flight finished and are included', () => withRoot(root => {
  const { report, eligible } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'interrupted', detail: 'Ctrl-C' }], done: [0, 1, 2, 3, 4, 5, 6],
    unscanned: [7, 8, 9].map(lane => ({ lane, reason: 'interrupted' })),
  }))
  assert.equal(eligible, true)
  assert.equal(report.summary.coverage.scanned, 7)
  assert.match(gapText(report), /Stopped early: interrupted/)
}))

test('Ctrl-C twice: abandoned files listed as not scanned; finished files kept', () => withRoot(root => {
  const { report } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'interrupted', detail: 'abort' }], done: [0, 1, 2],
    unscanned: [{ lane: 3, reason: 'aborted_in_flight' }, { lane: 4, reason: 'aborted_in_flight' },
      ...[5, 6, 7, 8, 9].map(lane => ({ lane, reason: 'interrupted' }))],
  }))
  assert.deepEqual(report.summary.coverage.not_scanned_by_reason, { aborted_in_flight: 2, interrupted: 5 })
  assert.match(gapText(report), /7 of 10 files not scanned \(5 interrupted, 2 abandoned\)/)
  assert.equal(report.findings.length, findingsFor([0, 1, 2]).length)
}))

test('stage killed with no status: scanned count from the checkpoint, never "unknown" or 0', () => withRoot(root => {
  const { report, eligible } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'stage_failed', detail: 'the hunt stage did not record a status' }],
    done: [0, 1, 2, 3, 4], freshStatus: false,
    // The CLI's fallback marks every admitted file 'interrupted'; the checkpoint knows better.
    unscanned: ALL.map(lane => ({ lane, reason: 'interrupted' })),
  }))
  assert.equal(eligible, true)
  assert.equal(report.summary.coverage.scanned, 5)
  assert.equal(report.summary.coverage.not_scanned, 5)
  assert.deepEqual(report.summary.coverage.not_scanned_by_reason, { unrecorded: 5 })
  assert.ok(gapReasons(report).includes('unrecorded'))
  assert.equal(report.findings.length, findingsFor([0, 1, 2, 3, 4]).length)
}))

test('files that failed three attempts: INCOMPLETE, counted, resumable', () => withRoot(root => {
  const { report } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'failed_lanes', detail: '2 lane(s) failed; a resumed run retries them' }],
    done: [0, 1, 2, 3, 4, 5, 6, 7], failed: [8, 9],
    unscanned: [8, 9].map(lane => ({ lane, reason: 'failed' })),
  }))
  assert.match(gapText(report), /2 files failed after three attempts; a resume retries them/)
  assert.equal(report.summary.coverage.scanned, 8)
}))

test('provider quota with zero files scanned: a failure, so a report', () => withRoot(root => {
  const { report, eligible } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'provider_quota', detail: 'q' }], done: [],
    unscanned: ALL.map(lane => ({ lane, reason: 'provider_quota' })),
  }))
  assert.equal(eligible, true)
  assert.equal(report.summary.coverage.scanned, 0)
  assert.match(gapText(report), /quota or spending limit/)
}))

test('provider failing and unpriced tier are failures too', () => withRoot(root => {
  for (const reason of ['provider_failing', 'unpriced_service_tier']) {
    const { eligible } = build(makeRun(root, reason, { reasons: [{ reason, detail: 'x' }], done: [] }))
    assert.equal(eligible, true, reason)
  }
}))

test('read guard refusals: INCOMPLETE with the count', () => withRoot(root => {
  const { report, eligible } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'blocked_reads', detail: '3 read(s) refused by the read guard' }], done: ALL,
  }))
  assert.equal(eligible, true)
  assert.equal(report.run.status, 'INCOMPLETE')
  assert.match(gapText(report), /Reads refused by the read guard: 3 read\(s\)/)
}))

test('recon crashed: report says zero files scanned, names the stage and its log', () => withRoot(root => {
  const { report, eligible } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'stage_failed', detail: 'stage0-recon exited 1; see /work/app/.secscan/runs/r1/secscan.log' }],
    huntRan: false, planned: false, freshStatus: false,
  }))
  assert.equal(eligible, true)
  assert.equal(report.summary.coverage.scanned, 0)
  assert.equal(report.summary.findings_total, 0)
  assert.match(gapText(report), /stage0-recon exited 1; see .*secscan\.log/)
}))

test('cancelled at confirmation: no report', () => withRoot(root => {
  const { eligible, why } = build(makeRun(root, 'r1', {
    reasons: [{ reason: 'cancelled', detail: 'the run was not started at the confirmation screen' }],
    huntRan: false, freshStatus: false, unscanned: ALL.map(lane => ({ lane, reason: 'interrupted' })),
  }))
  assert.equal(eligible, false)
  assert.equal(why, 'the run was not started at the confirmation screen')
}))

test('Ctrl-C before any file finished, or budget too small for one file: no report', () => withRoot(root => {
  for (const reason of ['interrupted', 'max_cost', 'timeout']) {
    const { eligible, why } = build(makeRun(root, reason, {
      reasons: [{ reason, detail: 'x' }], done: [], unscanned: ALL.map(lane => ({ lane, reason })),
    }))
    assert.equal(eligible, false, reason)
    assert.equal(why, 'no files were scanned')
  }
}))

test('resumed run finishes: its report replaces the partial one and covers every pass', () => withRoot(root => {
  const first = makeRun(root, 'r1', {
    reasons: [{ reason: 'max_cost', detail: 'cap' }], done: [0, 1, 2],
    unscanned: [3, 4, 5, 6, 7, 8, 9].map(lane => ({ lane, reason: 'max_cost' })),
  })
  const a = generateReport({ ...first, reportsRoot: root, secscanVersion: '0.1.0', now: NOW })
  assert.equal(a.written && a.report.run.status, 'INCOMPLETE')
  const second = makeRun(root, 'r1', { status: 'COMPLETE', done: ALL, passes: 2 })
  const b = generateReport({ ...second, reportsRoot: root, secscanVersion: '0.1.0', now: NOW })
  assert.ok(b.written)
  const onDisk: FindingsReport = JSON.parse(readFileSync(join(second.runDir, 'findings.json'), 'utf-8'))
  assert.equal(onDisk.run.status, 'COMPLETE')
  assert.equal(onDisk.run.passes, 2)
  assert.equal(onDisk.findings.length, findingsFor(ALL).length)
  assert.match(readFileSync(join(second.runDir, 'report.html'), 'utf-8'), /COMPLETE/)
}))

test('resume cancelled at confirmation: a rewritten record without a hunt keeps the earlier coverage and is not stale', () => withRoot(root => {
  const run = makeRun(root, 'r1', {
    reasons: [{ reason: 'max_cost', detail: 'cap' }], done: [0, 1, 2],
    unscanned: [3, 4, 5, 6, 7, 8, 9].map(lane => ({ lane, reason: 'max_cost' })),
  })
  // The CLI's frozen-resume path rewrites the record (review edits, budget) and writes no report.
  const rec = JSON.parse(readFileSync(join(run.runDir, 'run-record.json'), 'utf-8'))
  rec.updated_at = iso(T0 + 3_600_000)
  rec.limits.max_cost_usd = 9
  writeFileSync(join(run.runDir, 'run-record.json'), JSON.stringify(rec))
  const { report } = build(run)
  assert.equal(report.run.status, 'INCOMPLETE')
  assert.ok(!gapReasons(report).includes('stale_record'))
  assert.equal(report.summary.coverage.scanned, 3)
}))

test('CLI killed before recording: status UNKNOWN, findings and scanned count from saved progress', () => withRoot(root => {
  const run = makeRun(root, 'r1', { record: false, done: [0, 1, 2, 3] })
  const { report, eligible } = buildReport({ runDir: run.runDir, stageDir: run.stageDir, secscanVersion: '0.1.0', now: NOW, modelKey: MODEL })
  assert.equal(eligible, true)
  assert.equal(report.run.status, 'UNKNOWN')
  assert.equal(report.run.model.key, MODEL)
  assert.equal(report.summary.coverage.scanned, 4)
  assert.ok(gapReasons(report).includes('no_record'))
}))

test('findings newer than the run record: INCOMPLETE, a later pass did not finish', () => withRoot(root => {
  const run = makeRun(root, 'r1', { status: 'COMPLETE', done: ALL })
  utimesSync(run.findingsPath, new Date(T0 + 7_200_000), new Date(T0 + 7_200_000))
  const { report } = build(run)
  assert.equal(report.run.status, 'INCOMPLETE')
  assert.ok(gapReasons(report).includes('stale_record'))
}))

// ── Counts, location, trace, determinism ──────────────────────────────────

test('counts reconcile: severity, types (multi-type counted under each), locations, files, coverage', () => withRoot(root => {
  const { report } = build(makeRun(root, 'r1', { status: 'COMPLETE', done: ALL }))
  const s = report.summary
  const sev = s.by_severity
  assert.equal(sev.critical, 1)
  assert.equal(sev.critical + sev.high + sev.medium + sev.low, s.findings_total)
  assert.equal(s.findings_total, findingsFor(ALL).length)
  for (const row of s.by_class) {
    assert.equal(row.count, report.findings.filter(f => f.finding_classes.some(c => c.class === row.class)).length, row.class)
    assert.equal(row.by_severity.critical! + row.by_severity.high + row.by_severity.medium + row.by_severity.low, row.count)
  }
  const injection = s.by_class.find(r => r.class === 'injection')!
  assert.equal(injection.count, 3, 'f0:42 twice (one also crypto-auth) and f1:20 (also access-control)')
  assert.deepEqual(injection.codes, ['A03'])
  assert.equal(s.distinct_locations, new Set(report.findings.map(f => `${f.location.file}:${f.location.line}`)).size)
  assert.equal(s.distinct_locations, s.findings_total - 1, 'two findings share src/f0.ts:42')
  assert.equal(s.files_with_findings, 10)
  assert.ok(s.top_files.length <= 10)
  assert.equal(s.top_files[0].file, 'src/f0.ts')
  assert.equal(s.top_files[0].count, 3)
  assert.equal(s.coverage.files_in_repo, 14)
  assert.equal(s.coverage.skipped_by_selector, 2)
  assert.equal(s.coverage.skipped_no_selected_class, 2)
  assert.equal(s.category_names.A03, 'Injection')
  assert.ok(!('LLM01' in s.category_names), 'only codes the findings use')
  assert.deepEqual(s.cost, { spent_usd: 4.91, budget_usd: 5 })
  assert.deepEqual(s.usage, { input_tokens: 2_100_000, output_tokens: 180_000, wall_clock_seconds: 80 })
  assert.ok(!('by_confidence_band' in s))
}))

test('a run with no critical finding carries no critical count anywhere', () => withRoot(root => {
  const done = ALL.filter(i => i !== 0)
  const { report } = build(makeRun(root, 'r1', { status: 'COMPLETE', done }))
  assert.ok(!report.findings.some(f => f.severity_estimate === 'critical'))
  const s = report.summary
  for (const counts of [s.by_severity, ...s.by_class.map(r => r.by_severity), ...s.top_files.map(r => r.by_severity)]) {
    assert.deepEqual(Object.keys(counts), ['high', 'medium', 'low'])
  }
  assert.equal(s.by_severity.high + s.by_severity.medium + s.by_severity.low, s.findings_total)
  assert.ok(!serializeReport(report).includes('"critical"'))
}))

test('order: severity, then confidence; review first is the top ten in that order', () => withRoot(root => {
  const { report } = build(makeRun(root, 'r1', { status: 'COMPLETE', done: ALL }))
  for (let i = 1; i < report.findings.length; i++) assert.ok(compareFindings(report.findings[i - 1], report.findings[i]) <= 0)
  assert.equal(report.findings[0].severity_estimate, 'critical')
  assert.equal(report.findings[1].confidence, 0.95)
  assert.deepEqual(report.summary.review_first, report.findings.slice(0, 10).map(f => f.finding_id))
}))

test('location is the trace\'s last step for every finding', () => withRoot(root => {
  const { report } = build(makeRun(root, 'r1', { status: 'COMPLETE', done: ALL }))
  for (const f of report.findings) {
    const last = f.trace[f.trace.length - 1]
    assert.deepEqual(f.location, { file: last.file, line: last.line })
  }
}))

test('trace untouched: removing location gives Stage 2\'s entry exactly; its file is unchanged', () => withRoot(root => {
  const run = makeRun(root, 'r1', { status: 'COMPLETE', done: ALL })
  const before = readFileSync(run.findingsPath)
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const result = generateReport({ ...run, reportsRoot: root, secscanVersion: '0.1.0', now: NOW })
  assert.ok(result.written)
  assert.equal(sha(readFileSync(run.findingsPath)), sha(before), 'candidate-findings.json is never written')
  const stage2: CandidateFinding[] = JSON.parse(before.toString())
  const written: FindingsReport = JSON.parse(readFileSync(result.json, 'utf-8'))
  assert.equal(written.findings.length, stage2.length)
  const byId = new Map(stage2.map(f => [f.finding_id, f]))
  for (const f of written.findings) {
    const { location, ...rest } = f
    assert.ok(location)
    assert.deepEqual(rest, byId.get(f.finding_id))
    assert.deepEqual(Object.keys(rest), Object.keys(byId.get(f.finding_id)!), 'same fields, same order')
  }
}))

test('byte-identical output for the same inputs, apart from generated_at', () => withRoot(root => {
  const run = makeRun(root, 'r1', { reasons: [{ reason: 'max_cost', detail: 'cap' }], done: [0, 1, 2], unscanned: [3, 4].map(lane => ({ lane, reason: 'max_cost' })) })
  const gen = (now: Date) => {
    const r = generateReport({ ...run, reportsRoot: root, secscanVersion: '0.1.0', now })
    assert.ok(r.written)
    return { json: readFileSync(r.json, 'utf-8'), html: readFileSync(r.html, 'utf-8') }
  }
  const a = gen(NOW)
  const b = gen(NOW)
  assert.equal(a.json, b.json)
  assert.equal(a.html, b.html)
  const later = new Date(NOW.getTime() + 5000)
  const c = gen(later)
  const strip = (s: string, d: Date) => s.split(d.toISOString()).join('<generated>')
  assert.equal(strip(c.json, later), strip(a.json, NOW))
  assert.equal(strip(c.html, later), strip(a.html, NOW))
}))

test('the page links each review row to its finding\'s line in findings.json, and embeds no data', () => withRoot(root => {
  const run = makeRun(root, 'r1', { status: 'COMPLETE', done: ALL })
  const r = generateReport({ ...run, reportsRoot: root, secscanVersion: '0.1.0', now: NOW })
  assert.ok(r.written)
  const text = readFileSync(r.json, 'utf-8')
  assert.equal(text, serializeReport(r.report))
  const lines = text.split('\n')
  const html = readFileSync(r.html, 'utf-8')
  assert.ok(!html.includes('report-data'))
  const rows = [...html.matchAll(/<a class="row-link" href="vscode&#58;\/\/file([^"]+):(\d+)">/g)]
  assert.equal(rows.length, r.report.summary.review_first.length)
  rows.forEach((m, i) => {
    assert.equal(decodeURI(m[1]), resolve(r.json))
    const line = Number(m[2])
    assert.equal(lines[line - 1], '    {', 'the link lands on the finding\'s opening brace')
    assert.equal(lines[line], `      "finding_id": "${r.report.summary.review_first[i]}",`)
  })
}))

// ── Index ─────────────────────────────────────────────────────────────────

test('index.html: runs with a report, newest first; a deleted run drops out on the next rebuild', () => withRoot(root => {
  const older = makeRun(root, '20261013-091500', { status: 'COMPLETE', done: ALL })
  const newer = makeRun(root, '20261014-153200', { reasons: [{ reason: 'max_cost', detail: 'cap' }], done: [0, 1], unscanned: [2, 3].map(lane => ({ lane, reason: 'max_cost' })) })
  const rec = JSON.parse(readFileSync(join(older.runDir, 'run-record.json'), 'utf-8'))
  rec.created_at = iso(T0 - 86_400_000)
  writeFileSync(join(older.runDir, 'run-record.json'), JSON.stringify(rec))
  makeRun(root, '20261014-170000', { reasons: [{ reason: 'cancelled', detail: 'quit' }], huntRan: false, freshStatus: false })
  for (const run of [older, newer]) assert.ok(generateReport({ ...run, reportsRoot: root, secscanVersion: '0.1.0', now: NOW }).written)
  const cancelled = generateReport({ ...makeRun(root, '20261014-170000', { reasons: [{ reason: 'cancelled', detail: 'quit' }], huntRan: false, freshStatus: false }), reportsRoot: root, secscanVersion: '0.1.0', now: NOW })
  assert.equal(cancelled.written, false)
  const index = readFileSync(join(root, 'index.html'), 'utf-8')
  assert.ok(index.includes('runs/20261014-153200/report.html'))
  assert.ok(index.includes('runs/20261013-091500/report.html'))
  assert.ok(!index.includes('20261014-170000'), 'a run without a report is not listed')
  assert.ok(index.indexOf('20261014-153200') < index.indexOf('20261013-091500'), 'newest first')
  rmSync(older.runDir, { recursive: true })
  rebuildIndex(root, NOW)
  const after = readFileSync(join(root, 'index.html'), 'utf-8')
  assert.ok(!after.includes('20261013-091500'))
  assert.ok(after.includes('20261014-153200'))
}))

test('the no-selected-class skip reason matches what Stage 0.5 writes', () => {
  const selector = readFileSync(new URL('../../stage05-lane-selector-perfile/src/lane-selector-perfile.ts', import.meta.url), 'utf-8')
  assert.ok(selector.includes(`'${NO_SELECTED_CLASS_REASON}'`), 'update NO_SELECTED_CLASS_REASON in build.ts to match Stage 0.5')
})

test('a run with no report leaves no files behind', () => withRoot(root => {
  const run = makeRun(root, 'r1', { reasons: [{ reason: 'interrupted', detail: 'x' }], done: [] })
  const r = generateReport({ ...run, reportsRoot: root, secscanVersion: '0.1.0', now: NOW })
  assert.equal(r.written, false)
  assert.ok(!existsSync(join(run.runDir, 'findings.json')))
  assert.ok(!existsSync(join(run.runDir, 'report.html')))
}))
