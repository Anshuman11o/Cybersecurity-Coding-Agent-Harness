/**
 * Unit tests for the secscan CLI: flags, the config file's rules, the
 * confirmation summary, the progress line and the run verdict. No stage runs,
 * no model calls.
 *
 *   npx tsx --test src/cli.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs, UsageError } from './args.js'
import { validateConfig, loadConfig, configFromRun, writeConfig } from './config.js'
import { buildSummary, renderSummary } from './confirm.js'
import { progressLine } from './progress.js'
import { decideStatus, type StageResult } from './run-record.js'
import { languageShares, topDirs } from './display.js'
import { NO_LIMITS } from '../../stage1-budget-governor/src/limits.js'
import { computeScanPlan } from '../../stage1-budget-governor/src/scan-plan.js'
import type { Stage2RunStatus, Stage2Progress } from '../../stage1-budget-governor/src/run-status.js'
import type { ModelInfo } from './registry.js'

test('flags parse into limits and model choices', () => {
  const a = parseArgs(['scan', 'app', '--max-cost', '5', '--max-files=100', '--max-file-size', '200k',
    '--timeout', '30m', '--concurrency', '4', '--paths', 'src,api', '--paths', 'lib',
    '--include', '*.ts', '--exclude', 'vendor', '--exclude', '**/*.test.ts', '--yes'])
  assert.equal(a.command, 'scan')
  if (a.command !== 'scan') return
  assert.equal(a.target, 'app')
  assert.equal(a.yes, true)
  assert.deepEqual(a.limits, {
    max_cost_usd: 5, max_files: 100, max_file_size: 204800, timeout_seconds: 1800, concurrency: 4,
    paths: ['src', 'api', 'lib'], include: ['*.ts'], exclude: ['vendor', '**/*.test.ts'],
  })
  const g = parseArgs(['scan', '--base-url', 'http://localhost:1/v1', '--model', 'm', '--api-key-env', 'MY_KEY', '--price', '1/2'])
  assert.equal(g.command === 'scan' && g.baseUrl, 'http://localhost:1/v1')
  assert.equal(g.command === 'scan' && g.target, '.')
  assert.equal(parseArgs(['models', '--all']).command, 'models')
  assert.equal(parseArgs([]).command, 'scan')
})

test('bad flags are usage errors', () => {
  const bad = [
    ['scan', '--max-cost', 'lots'],
    ['scan', '--max-files', '1e5'],
    ['scan', '--paths', '../x'],
    ['scan', '--base-url', 'http://x'],              // no --model
    ['scan', '--api-key-env', 'K'],                  // needs --base-url
    ['scan', '--base-url', 'u', '--model', 'm', '--api-key-env', 'not a var'],
    ['scan', 'a', 'b'],
    ['scan', '--frobnicate'],
    ['scan', '--max-cost'],
    ['scan', '--config', 'x', '--no-config'],
    ['nope'],
  ]
  for (const argv of bad) assert.throws(() => parseArgs(argv), UsageError, argv.join(' '))
})

test('config: limits parse to canonical units; unknown fields are refused', () => {
  const c = validateConfig({
    model: 'luna', paths: ['./src/'], exclude: ['vendor'],
    limits: { max_cost: '$5', max_files: 10, max_file_size: '1m', timeout: '1h', concurrency: 2 },
  })
  assert.equal(c.model, 'luna')
  assert.deepEqual(c.limits, {
    paths: ['src'], exclude: ['vendor'], max_cost_usd: 5, max_files: 10,
    max_file_size: 1024 * 1024, timeout_seconds: 3600, concurrency: 2,
  })
  assert.throws(() => validateConfig({ modle: 'luna' }), /unknown field/)
  assert.throws(() => validateConfig({ limits: { max_cents: 1 } }), /unknown limit/)
  assert.throws(() => validateConfig({ paths: 'src' }), /array of strings/)
  assert.throws(() => validateConfig([]), /object/)
})

test('config: a committed file can never name an endpoint, a credential variable or an overlay', () => {
  // On a pull request the file is attacker-controlled; any of these would let
  // it redirect the scan, and the key, to a host of its choosing.
  for (const k of ['base_url', 'base-url', 'api_key_env', 'api-key-env', 'api_key', 'models_file', 'models-file']) {
    assert.throws(() => validateConfig({ [k]: 'x' }), /not allowed/, k)
  }
})

test('config: [s] writes a file the next run accepts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secscan-cfg-'))
  try {
    const path = join(dir, 'secscan.config.json')
    const limits = { ...NO_LIMITS, max_cost_usd: 2, paths: ['src'], exclude: ['*.min.js'], timeout_seconds: 90 }
    writeConfig(path, configFromRun('luna', limits))
    const loaded = loadConfig(path)!
    assert.equal(loaded.config.model, 'luna')
    assert.deepEqual(loaded.config.limits, { paths: ['src'], exclude: ['*.min.js'], max_cost_usd: 2, timeout_seconds: 90 })
    assert.match(loaded.sha256, /^[0-9a-f]{64}$/)
    writeFileSync(path, '{ not json')
    assert.throws(() => loadConfig(path), /not valid JSON/)
    assert.equal(loadConfig(join(dir, 'absent.json')), null)
    assert.ok(readFileSync(path, 'utf-8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const model: ModelInfo = {
  key: 'm', label: 'Model M', model: 'm-1', origin: 'registry', transport: 'openai',
  apiKeyEnv: 'M_KEY', keyPresent: true, baseUrl: null, price: { input: 1, output: 1 }, priceAsOf: 'd',
  measured: true,
  benchmark: { corpus: 'c', languages: ['typescript'], recall: '1/2', localization: '1/2', cost_usd: 1, run: 'r', source: 's' },
  maxConcurrency: null, isDefault: true,
}

function planFor(limits = NO_LIMITS) {
  const files = ['src/a.ts', 'src/b.ts', 'api/c.py', 'vendor/d.js']
  return computeScanPlan({
    provider: 'm', model: 'm-1', assignmentsPath: '/x', assignmentsGeneratedAt: 't',
    lanes: files.map((f, i) => ({
      lane_id: `l${i}`, target_file: f, file_bytes: 100,
      projected_calls: 2, projected_input_tokens: 500_000, projected_output_tokens: 0,
    })),
    limits, vendorConcurrencyCeiling: null, price: model.price, priceAsOf: 'd',
    cost: (i, o) => (i + o) / 1e6,
  })
}

const assignmentLanes = [
  { lane_id: 'l0', target_file: 'src/a.ts', disposition: 'hunt' as const, skip_reason: null },
  { lane_id: 'l1', target_file: 'src/b.ts', disposition: 'hunt' as const, skip_reason: null },
  { lane_id: 'l2', target_file: 'api/c.py', disposition: 'hunt' as const, skip_reason: null },
  { lane_id: 'l3', target_file: 'vendor/d.js', disposition: 'hunt' as const, skip_reason: null },
  { lane_id: 'l4', target_file: 'assets/x.css', disposition: 'skip' as const, skip_reason: 'Styling file — no executable logic' },
]

test('confirmation summary reflects the plan it was built from', () => {
  const plan = planFor({ ...NO_LIMITS, exclude: ['vendor'], max_cost_usd: 1.2 })
  const s = buildSummary({
    targetDisplay: './app', targetRoot: '/app', commit: 'abc1234', branch: 'main',
    lanes: assignmentLanes, inventoryFiles: 5,
    byLanguage: { typescript: { count: 2 }, python: { count: 1 }, javascript: { count: 1 }, css: { count: 1 } },
    plan, model, resume: null,
  })
  assert.equal(s.scan.files, 3)
  assert.deepEqual(s.scan.dirs, ['src/', 'api/'])
  assert.equal(s.skip.files, 2)
  assert.deepEqual(s.skip.by_reason, { 'not code': 1, 'user-excluded': 1 })
  assert.equal(s.estimate.usd, 1.5)
  assert.equal(s.estimate.exceeds_cap, true)
  assert.equal(s.estimate.lanes_within_cap, 2)
  assert.deepEqual(s.languages.map(l => [l.name, l.measured]), [['TypeScript', true], ['JavaScript', false], ['Python', false]])
  const text = renderSummary(s)
  assert.match(text, /^Target: \.\/app \(commit abc1234, 5 files\)/)
  assert.match(text, /Languages: TypeScript 50%, JavaScript 25%, Python 25% \(JavaScript, Python: unmeasured\)/)
  assert.match(text, /Scan 3 files in: src\/ api\//)
  assert.match(text, /Model: m-1 \(M_KEY found\), measured/)
  assert.match(text, /Estimate: ~\$1\.50, ~\d+ min {4}Cap: \$1\.20/)
  assert.match(text, /about 2 of 3 files fit/)
})

test('confirmation on resume estimates only what is left', () => {
  const s = buildSummary({
    targetDisplay: '.', targetRoot: '/app', commit: null, branch: null,
    lanes: assignmentLanes, inventoryFiles: 5, byLanguage: undefined,
    plan: planFor(), model: { ...model, measured: false, benchmark: null },
    resume: { runId: 'r1', doneLaneIds: new Set(['l0', 'l1']), spentUsd: 1 },
  })
  assert.equal(s.scan.files, 2)
  assert.equal(s.estimate.usd, 1)
  assert.deepEqual(s.resume, { run_id: 'r1', done: 2, spent_usd: 1 })
  assert.match(renderSummary(s), /not a git checkout/)
  assert.match(renderSummary(s), /Resuming run r1: 2 file\(s\) already scanned/)
})

test('language shares leave out markup and data', () => {
  const l = languageShares({ json: { count: 100 }, yaml: { count: 5 }, go: { count: 1 } }, [])
  assert.deepEqual(l.map(x => [x.key, x.share]), [['go', 1]])
  assert.deepEqual(topDirs(['a/x', 'a/y', 'b/z', 'root.ts']), ['a/', '(root files)', 'b/'])
})

test('progress line shows lanes, spend against estimate and cap, ETA and severities', () => {
  const p: Stage2Progress = {
    schema: 'secscan.progress/1', updated_at: '', started_at: new Date(0).toISOString(), status: 'running', stop: null,
    lanes: { total: 10, done: 4, carried: 0, failed: 1, in_flight: 2 },
    spend: { spent_usd: 1.5, estimate_usd: 4, cap_usd: 5 },
    findings: { total: 3, by_severity: { critical: 1, high: 1, medium: 1, low: 0 } },
  }
  const line = progressLine(p, 50_000, 600)
  assert.match(line, /^files 4\/10 · 1 failed · 2 in flight · \$1\.50 spent \/ ~\$4\.00 est \/ \$5\.00 cap/)
  assert.match(line, /50s elapsed, ETA ~50s/)
  assert.match(line, /findings 3 \(1 critical, 1 high, 1 medium, 0 low\)/)
  const idle = progressLine({ ...p, lanes: { ...p.lanes, done: 0, failed: 0 } }, 10_000, 600)
  assert.match(idle, /ETA ~9m50s \(planned\)/)
})

const ok = (stage: string, code = 0): StageResult => ({ stage, exit_code: code, signal: null, started_at: '', ended_at: '', log: 'l' })
const status = (s: 'COMPLETE' | 'INCOMPLETE', reasons: Stage2RunStatus['reasons'] = []): Stage2RunStatus => ({
  schema: 'secscan.stage2-status/1', generated_at: '', started_at: '', ended_at: '', status: s, reasons,
  lanes: { hunt: 1, admitted: 1, completed: 1, failed: 0, not_started: 0 }, unscanned: [], scope_excluded: [],
  spend: { spent_usd: 0, estimate_usd: 0, cap_usd: null, calibration: 1 }, findings_total: 0, blocked_reads: 0,
  limits: null, resume_hint: null,
})

test('run verdict: complete only when the hunt says so and every stage exited 0', () => {
  assert.equal(decideStatus(status('COMPLETE'), [ok('stage2-hunt-lanes-perfile'), ok('reconcile-v2')], false).status, 'COMPLETE')
  const capped = decideStatus(status('INCOMPLETE', [{ reason: 'max_cost', detail: 'd' }]), [ok('stage2-hunt-lanes-perfile')], false)
  assert.equal(capped.status, 'INCOMPLETE')
  assert.deepEqual(capped.reasons.map(r => r.reason), ['max_cost'])
  // A clean interrupt exits 130 and is already in the hunt's own status.
  const intr = decideStatus(status('INCOMPLETE', [{ reason: 'interrupted', detail: 'd' }]), [ok('stage2-hunt-lanes-perfile', 130)], false)
  assert.deepEqual(intr.reasons.map(r => r.reason), ['interrupted'])
  const failed = decideStatus(status('COMPLETE'), [ok('stage2-hunt-lanes-perfile'), ok('reconcile-v2', 1)], false)
  assert.equal(failed.status, 'INCOMPLETE')
  assert.deepEqual(failed.reasons.map(r => r.reason), ['stage_failed'])
  assert.equal(decideStatus(null, [ok('stage0-recon', 1)], false).status, 'INCOMPLETE')
  assert.deepEqual(decideStatus(null, [], true).reasons.map(r => r.reason), ['cancelled'])
})
