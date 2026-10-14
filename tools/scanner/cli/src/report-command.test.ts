/**
 * `secscan report [run-id]` and the report flags. The rebuild runs the real
 * CLI in a child process against a synthetic run folder; no stage or model runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, UsageError } from './args.js'

const require = createRequire(import.meta.url)
const CLI = fileURLToPath(new URL('./secscan.ts', import.meta.url))
const registry = JSON.parse(readFileSync(new URL('../../shared/models.json', import.meta.url), 'utf8'))
const MODEL: string = registry.product_default_provider

test('report command and --no-open parse', () => {
  assert.deepEqual(parseArgs(['report']), { command: 'report', noOpen: false })
  assert.deepEqual(parseArgs(['report', '20261014-153200', '--out', 'r', '--no-open']),
    { command: 'report', runId: '20261014-153200', out: 'r', noOpen: true })
  const scan = parseArgs(['scan', '.', '--no-open'])
  assert.equal(scan.command === 'scan' && scan.noOpen, true)
  assert.equal((parseArgs(['scan']) as { noOpen: boolean }).noOpen, false)
  assert.throws(() => parseArgs(['report', '--budget', '5']), UsageError)
  assert.throws(() => parseArgs(['report', 'a', 'b']), UsageError)
})

function seedRun(root: string, id: string, opts: { record?: boolean; running?: boolean } = {}) {
  const target = join(root, 'app')
  mkdirSync(target, { recursive: true })
  const reports = join(target, '.secscan')
  const runDir = join(reports, 'runs', id)
  const hunt = join(runDir, MODEL, 'stage2-hunt-lanes-perfile')
  mkdirSync(hunt, { recursive: true })
  const findings = [{
    finding_id: 'FIND-0001', lane_id: 'L0', finding_classes: [{ class: 'injection', justified_by_step: 1 }],
    categories: ['A03'], title: 'Query built from request input', description: 'The id parameter reaches the query.',
    trace: [
      { kind: 'entrypoint', file: 'api.ts', line: 4, description: 'route reads req.query.id' },
      { kind: 'sink', file: 'api.ts', line: 9, description: 'interpolated into SQL' },
    ],
    severity_estimate: 'high', confidence: 0.9,
  }]
  writeFileSync(join(hunt, 'candidate-findings.json'), JSON.stringify(findings, null, 2) + '\n')
  writeFileSync(join(hunt, 'budget-consumption.json'), JSON.stringify({ lanes: [], legacy_entries: [{ lane_id: 'L0', tokens_used: 1, seconds_elapsed: 1, ceiling_hit: false }] }))
  mkdirSync(join(runDir, MODEL, 'stage1-budget-governor-perfile'), { recursive: true })
  writeFileSync(join(runDir, MODEL, 'stage1-budget-governor-perfile', 'scan-plan.json'),
    JSON.stringify({ admitted: [{ lane_id: 'L0', target_file: 'api.ts' }, { lane_id: 'L1', target_file: 'db.ts' }], excluded: [] }))
  writeFileSync(join(runDir, 'read-allowlist.json'), JSON.stringify({ schema: 'secscan.read-allowlist/1', target_root: target, files: [] }))
  if (opts.running) {
    writeFileSync(join(hunt, 'progress.json'), JSON.stringify({ schema: 'secscan.progress/1', updated_at: new Date().toISOString(), status: 'running' }))
  }
  if (opts.record ?? true) {
    const at = new Date(Date.now() + 60_000).toISOString()
    writeFileSync(join(runDir, 'run-record.json'), JSON.stringify({
      schema: 'secscan.run-record/1', run_id: id, passes: 1, created_at: at, updated_at: at,
      status: 'INCOMPLETE', incomplete_reasons: [{ reason: 'max_cost', detail: 'cap' }],
      target: { root: target, commit: 'a1b2c3d', branch: 'main' },
      model: { key: MODEL, model: registry.targets[MODEL].model, label: 'Model', origin: 'registry', measured: false },
      limits: { max_cost_usd: 1 }, stages: [],
      coverage: { inventory_files: 2, hunt_lanes: 2, admitted: 2, completed: 1, failed: 0, not_started: 1 },
      unscanned: [{ lane_id: 'L1', target_file: 'db.ts', reason: 'max_cost', detail: 'cap' }], scope_excluded: [],
      spend: { spent_usd: 0.9, cap_usd: 1, input_tokens: 10, output_tokens: 2, calls: 1 },
      findings_total: 1, artifacts: {}, resume_command: `secscan scan . --resume ${id} --budget <higher>`,
    }))
  }
  return { reports, runDir }
}

function runCli(args: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('SCANNER_')) delete env[key]
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, ['--import', require.resolve('tsx'), CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 })
}

test('secscan report rebuilds a run\'s report and the index from disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'secscan-report-cmd-'))
  try {
    const { reports, runDir } = seedRun(root, '20261014-153200')
    const r = runCli(['report', '--out', reports, '--no-open'], root)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Report: {3}.*report\.html/)
    assert.match(r.stdout, /Findings: .*findings\.json/)
    const findings = JSON.parse(readFileSync(join(runDir, 'findings.json'), 'utf8'))
    assert.equal(findings.run.status, 'INCOMPLETE')
    assert.equal(findings.summary.coverage.scanned, 1)
    assert.equal(findings.summary.coverage.in_scope, 2)
    assert.deepEqual(findings.findings[0].location, { file: 'api.ts', line: 9 })
    assert.ok(existsSync(join(runDir, 'report.html')))
    assert.match(readFileSync(join(reports, 'index.html'), 'utf8'), /runs\/20261014-153200\/report\.html/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('secscan report without a run record: UNKNOWN, rebuilt from the allowlist and saved progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'secscan-report-cmd-'))
  try {
    const { reports, runDir } = seedRun(root, '20261014-153200', { record: false })
    const r = runCli(['report', '20261014-153200', '--out', reports, '--no-open'], root)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const findings = JSON.parse(readFileSync(join(runDir, 'findings.json'), 'utf8'))
    assert.equal(findings.run.status, 'UNKNOWN')
    assert.equal(findings.summary.coverage.scanned, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('secscan report refuses a run that is still scanning, and an unknown run', () => {
  const root = mkdtempSync(join(tmpdir(), 'secscan-report-cmd-'))
  try {
    const { reports, runDir } = seedRun(root, '20261014-153200', { running: true })
    const busy = runCli(['report', '--out', reports, '--no-open'], root)
    assert.equal(busy.status, 2, busy.stdout + busy.stderr)
    assert.match(busy.stderr, /still scanning/)
    assert.ok(!existsSync(join(runDir, 'report.html')))
    const missing = runCli(['report', '20991231-000000', '--out', reports, '--no-open'], root)
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /no run 20991231-000000/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
