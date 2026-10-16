/**
 * The stage launcher (stages.ts): the stage table, what is spawned from source
 * and from dist/, the environment rules, where the logs go, and the signal
 * branches. Most cases launch tiny fake stages from a temporary dist-shaped
 * root, so no model is called and nothing slow runs. The last case launches the
 * real Stage 0.5 and Stage 1 from source on a synthetic Stage 0 output: the
 * launcher end to end, with no API key and no network.
 *
 *   npx tsx --test src/stages.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  STAGE_TABLE, SCANNER_ROOT, DEFAULT_LAYOUT, stageCommand, stageEnv, stageLogDir, launchStage, signalStage,
  type StageLaunch, type RunningStage,
} from './stages.js'

/** Every stage name the CLI launches (secscan.ts PRE_STAGES, the hunt, reconcile). */
const CLI_STAGES = [
  'stage0-recon', 'stage-playbook-agent', 'stage05-lane-selector-perfile', 'stage1-budget-governor-perfile',
  'stage2-hunt-lanes-perfile', 'reconcile-v2',
]

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))

/** A dist-shaped scanner root whose stage entries are the given scripts. */
function fakeRoot(scripts: Record<string, string>): string {
  const root = tmp('secscan-stages-')
  // CommonJS, so the fake stages can be plain scripts whatever the Node version.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\n')
  for (const [rel, body] of Object.entries(scripts)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

/** Prints where and how it ran, one line to each stream, then exits with FAKE_EXIT. */
const REPORTER = `
process.stdout.write('out:' + JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2),
  provider: process.env.SCANNER_PROVIDER, profile: process.env.SCANNER_PROFILE, target: process.env.SCANNER_TARGET,
  runId: process.env.SCANNER_RUN_ID, resume: process.env.SCANNER_RESUME ?? null }) + '\\n')
process.stderr.write('err:stage stderr line\\n')
process.exitCode = Number(process.env.FAKE_EXIT || 0)
`

function launch(over: Partial<StageLaunch> & { target: string; logPath: string }): StageLaunch {
  return {
    stage: 'stage0-recon', provider: 'fake-model', runId: 'run-1', resume: false,
    env: { PATH: process.env.PATH }, ...over,
  }
}

test('the stage table covers every stage the CLI launches, with run.sh\'s mapping', () => {
  for (const stage of CLI_STAGES) assert.ok(Object.hasOwn(STAGE_TABLE, stage), stage)
  assert.deepEqual(Object.keys(STAGE_TABLE).sort(), [...CLI_STAGES].sort())
  assert.deepEqual(STAGE_TABLE['stage1-budget-governor-perfile'], {
    dir: 'stage1-budget-governor', entry: 'src/budget-governor', args: ['--v2', '--mode', 'estimate'], logdir: 'stage1-budget-governor-perfile',
  })
  assert.deepEqual(STAGE_TABLE['reconcile-v2'], {
    dir: 'stage1-budget-governor', entry: 'src/budget-governor', args: ['--v2', '--mode', 'reconcile'], logdir: 'stage1-budget-governor-perfile',
  })
  assert.equal(STAGE_TABLE['stage0-recon'].entry, 'src/recon')
  assert.equal(STAGE_TABLE['stage-playbook-agent'].entry, 'src/main')
  assert.equal(STAGE_TABLE['stage05-lane-selector-perfile'].entry, 'src/lane-selector-perfile')
  assert.equal(STAGE_TABLE['stage2-hunt-lanes-perfile'].entry, 'src/hunt-executor')
  for (const bad of ['stage2-hunt-lanes', 'all-v2', 'constructor', '__proto__', '']) {
    assert.throws(() => stageCommand(bad), /unknown stage/, bad)
  }
  assert.throws(() => launchStage(launch({ stage: 'nope', target: tmpdir(), logPath: join(tmpdir(), 'unused.log') })), /unknown stage/)
})

test('from source: node <tsx cli> <entry>.ts, cwd the stage package, entries that exist', () => {
  // This test file is TypeScript, so the module under test is too.
  assert.equal(DEFAULT_LAYOUT.fromSource, true)
  assert.equal(DEFAULT_LAYOUT.root, SCANNER_ROOT)
  assert.ok(existsSync(join(SCANNER_ROOT, 'shared', 'models.json')), SCANNER_ROOT)
  for (const stage of CLI_STAGES) {
    const cmd = stageCommand(stage)
    const spec = STAGE_TABLE[stage]
    assert.equal(cmd.command, process.execPath)
    assert.match(cmd.args[0], /[\\/]tsx[\\/]dist[\\/]cli\.mjs$/)
    assert.equal(cmd.args[1], realpathSync(join(SCANNER_ROOT, spec.dir, `${spec.entry}.ts`)))
    assert.deepEqual(cmd.args.slice(2), spec.args)
    assert.equal(cmd.cwd, join(SCANNER_ROOT, spec.dir))
  }
})

test('from dist: node <entry>.js, no tsx, the entry passed as a realpath', () => {
  const root = fakeRoot({ 'stage1-budget-governor/src/budget-governor.js': '' })
  try {
    const cmd = stageCommand('reconcile-v2', { root, fromSource: false })
    assert.equal(cmd.command, process.execPath)
    assert.deepEqual(cmd.args, [join(root, 'stage1-budget-governor/src/budget-governor.js'), '--v2', '--mode', 'reconcile'])
    assert.equal(cmd.cwd, join(root, 'stage1-budget-governor'))
    // Reached through a symlinked install prefix, the entry is still the real file.
    const linked = join(tmp('secscan-stages-link-'), 'pkg')
    symlinkSync(root, linked)
    const viaLink = stageCommand('reconcile-v2', { root: linked, fromSource: false })
    assert.equal(viaLink.args[0], join(root, 'stage1-budget-governor/src/budget-governor.js'))
    assert.equal(viaLink.cwd, join(linked, 'stage1-budget-governor'))
    rmSync(join(linked, '..'), { recursive: true, force: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('env: product profile, realpath target, resume only from the flag, proxy only when set', () => {
  const dir = tmp('secscan-stages-env-')
  try {
    mkdirSync(join(dir, 'app'))
    symlinkSync(join(dir, 'app'), join(dir, 'app-link'))
    const base = {
      SCANNER_REPORTS_ROOT: join(dir, 'reports'), SCANNER_RUNS_ROOT: join(dir, 'reports', 'runs', 'run-1'),
      SCANNER_RESUME: '1', SCANNER_PROFILE: 'benchmark', SCANNER_PLAYBOOK_AGENT: '1', KEEP: 'me',
    }
    const env = stageEnv(launch({ target: join(dir, 'app-link'), logPath: '', env: base, provider: 'luna6' }))
    assert.equal(env.SCANNER_PROVIDER, 'luna6')
    assert.equal(env.SCANNER_PROFILE, 'product')
    assert.equal(env.SCANNER_TARGET, join(dir, 'app'))
    assert.equal(env.SCANNER_RUN_ID, 'run-1')
    assert.equal(env.SCANNER_REPORTS_ROOT, base.SCANNER_REPORTS_ROOT)
    assert.equal(env.SCANNER_RUNS_ROOT, base.SCANNER_RUNS_ROOT)
    assert.equal(env.SCANNER_PLAYBOOK_AGENT, '1')
    assert.equal(env.KEEP, 'me')
    assert.ok(!('SCANNER_RESUME' in env), 'an inherited SCANNER_RESUME is not a resume')
    assert.ok(!('NODE_USE_ENV_PROXY' in env), 'no proxy, no flag')
    assert.equal(stageEnv(launch({ target: dir, logPath: '', env: base, resume: true })).SCANNER_RESUME, '1')
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      assert.equal(stageEnv(launch({ target: dir, logPath: '', env: { [k]: 'http://proxy:3128' } })).NODE_USE_ENV_PROXY, '1', k)
    }
    assert.ok(!('NODE_USE_ENV_PROXY' in stageEnv(launch({ target: dir, logPath: '', env: { HTTPS_PROXY: '' } }))), 'empty is unset')
    // A relative root would resolve against the stage's own cwd; it is made absolute here instead.
    const rel = stageEnv(launch({ target: dir, logPath: '', env: { SCANNER_RUNS_ROOT: 'out/runs/run-1' } }))
    assert.equal(rel.SCANNER_RUNS_ROOT, join(process.cwd(), 'out/runs/run-1'))
    assert.deepEqual(base.SCANNER_RESUME, '1', 'the caller\'s env is not mutated')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('logs: secscan.log gets header, both streams and footer; per-stage logs sit beside the artifacts', async () => {
  const root = fakeRoot({
    'stage0-recon/src/recon.js': REPORTER,
    'stage1-budget-governor/src/budget-governor.js': REPORTER,
  })
  const dir = tmp('secscan-stages-logs-')
  try {
    mkdirSync(join(dir, 'app'))
    const runs = join(dir, 'app', '.secscan', 'runs', 'run-1')
    mkdirSync(runs, { recursive: true })
    const logPath = join(runs, 'secscan.log')
    writeFileSync(logPath, 'earlier line\n')
    const env = { PATH: process.env.PATH, SCANNER_RUNS_ROOT: runs, FAKE_EXIT: '3' }
    const r = await launchStage(launch({ target: join(dir, 'app'), logPath, env, resume: true }), { root, fromSource: false }).done
    assert.equal(r.exit_code, 3)
    assert.equal(r.signal, null)
    assert.equal(r.stage, 'stage0-recon')
    assert.equal(r.log, logPath)

    const log = readFileSync(logPath, 'utf8')
    assert.ok(log.startsWith('earlier line\n=== [fake-model] stage0-recon ===\n'), 'appended, header first')
    assert.ok(log.trimEnd().endsWith('=== [fake-model] stage0-recon exited 3 ==='), 'footer last')
    assert.match(log, /err:stage stderr line/)
    const reported = JSON.parse(log.split('\n').find(l => l.startsWith('out:'))!.slice(4))
    assert.equal(reported.cwd, join(root, 'stage0-recon'))
    assert.deepEqual(reported.argv, [])
    assert.equal(reported.provider, 'fake-model')
    assert.equal(reported.profile, 'product')
    assert.equal(reported.target, join(dir, 'app'))
    assert.equal(reported.runId, 'run-1')
    assert.equal(reported.resume, '1')

    const logs = join(runs, 'fake-model', 'stage0-recon', 'logs')
    assert.match(readFileSync(join(logs, 'stage0-recon.stdout.log'), 'utf8'), /^out:\{.*\}\n$/)
    assert.equal(readFileSync(join(logs, 'stage0-recon.stderr.log'), 'utf8'), 'err:stage stderr line\n')

    // reconcile-v2 logs with the v2 governor's own artifacts, under its own name.
    const rec = await launchStage(launch({ stage: 'reconcile-v2', target: join(dir, 'app'), logPath, env: { ...env, FAKE_EXIT: '0' } }),
      { root, fromSource: false }).done
    assert.equal(rec.exit_code, 0)
    const recLogs = join(runs, 'fake-model', 'stage1-budget-governor-perfile', 'logs')
    assert.deepEqual(JSON.parse(readFileSync(join(recLogs, 'reconcile-v2.stdout.log'), 'utf8').slice(4)).argv, ['--v2', '--mode', 'reconcile'])
    assert.ok(!existsSync(join(runs, 'fake-model', 'reconcile-v2')), 'no stray reconcile-v2 directory')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('log directory: SCANNER_RUNS_ROOT, else <reports>/runs/<id>, else <target>/.secscan/runs/<id>', () => {
  const dir = tmp('secscan-stages-logdir-')
  try {
    const l = launch({ stage: 'stage2-hunt-lanes-perfile', target: dir, logPath: '' })
    assert.equal(stageLogDir({ ...l, env: { SCANNER_RUNS_ROOT: join(dir, 'r') } }), join(dir, 'r', 'fake-model', 'stage2-hunt-lanes-perfile', 'logs'))
    assert.equal(stageLogDir({ ...l, env: { SCANNER_REPORTS_ROOT: join(dir, 'out') } }), join(dir, 'out', 'runs', 'run-1', 'fake-model', 'stage2-hunt-lanes-perfile', 'logs'))
    assert.equal(stageLogDir({ ...l, env: {} }), join(dir, '.secscan', 'runs', 'run-1', 'fake-model', 'stage2-hunt-lanes-perfile', 'logs'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stage that cannot start fails with 127 and says why in secscan.log', async () => {
  const dir = tmp('secscan-stages-nostart-')
  try {
    const logPath = join(dir, 'secscan.log')
    const r = await launchStage(launch({ target: dir, logPath, env: { PATH: process.env.PATH, SCANNER_RUNS_ROOT: join(dir, 'runs') } }),
      { root: join(dir, 'no-such-root'), fromSource: false }).done
    assert.equal(r.exit_code, 127)
    assert.match(readFileSync(logPath, 'utf8'), /could not start stage0-recon/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POSIX: SIGKILL reaches the stage\'s whole process group', { skip: process.platform === 'win32' }, async () => {
  // The stage starts a grandchild that holds its stdout. The stage only counts
  // as done once every holder of the pipe is gone, so finishing at all proves
  // the signal reached the group, not just the direct child.
  const root = fakeRoot({
    'stage2-hunt-lanes-perfile/src/hunt-executor.js': `
const { spawn } = require('child_process')
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
process.stdout.write('ready\\n')
setInterval(() => {}, 1000)
`,
  })
  const dir = tmp('secscan-stages-kill-')
  try {
    const logPath = join(dir, 'secscan.log')
    const s = launchStage(launch({ stage: 'stage2-hunt-lanes-perfile', target: dir, logPath, env: { PATH: process.env.PATH, SCANNER_RUNS_ROOT: join(dir, 'runs') } }),
      { root, fromSource: false })
    const deadline = Date.now() + 10_000
    while (!readFileSync(logPath, 'utf8').includes('ready')) {
      assert.ok(Date.now() < deadline, 'fake stage never started')
      await new Promise(r => setTimeout(r, 25))
    }
    signalStage(s, 'SIGKILL', 'linux')
    const r = await Promise.race([s.done, new Promise<null>(r => setTimeout(() => r(null), 10_000))])
    assert.ok(r, 'the stage did not finish: the grandchild survived the signal')
    assert.equal(r.signal, 'SIGKILL')
    assert.match(readFileSync(logPath, 'utf8'), /exited SIGKILL ===\n$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('win32: kill() for an ordinary signal, taskkill /T /F for SIGKILL', () => {
  const kills: string[] = []
  const trees: number[] = []
  const fake = (pid: number | undefined) => ({
    stage: 'stage0-recon', done: Promise.resolve() as unknown as RunningStage['done'],
    child: { pid, kill: (sig: string) => { kills.push(sig); return true } } as unknown as RunningStage['child'],
  })
  signalStage(fake(4242), 'SIGINT', 'win32', pid => trees.push(pid))
  assert.deepEqual(kills, ['SIGINT'])
  assert.equal(trees.length, 0)
  signalStage(fake(4242), 'SIGKILL', 'win32', pid => trees.push(pid))
  assert.deepEqual(kills, ['SIGINT'], 'SIGKILL does not go through kill()')
  assert.deepEqual(trees, [4242])
  signalStage(fake(undefined), 'SIGKILL', 'win32', pid => trees.push(pid))
  signalStage(fake(undefined), 'SIGINT', 'win32', pid => trees.push(pid))
  assert.deepEqual(trees, [4242], 'a stage that never started is not signalled')
  assert.deepEqual(kills, ['SIGINT'])
})

test('end to end from source: Stage 0.5 and Stage 1 plan a synthetic Stage 0 output, no key, no network', async () => {
  const registry = JSON.parse(readFileSync(join(SCANNER_ROOT, 'shared', 'models.json'), 'utf8'))
  const provider: string = registry.product_default_provider
  const dir = tmp('secscan-stages-e2e-')
  try {
    const target = join(dir, 'app')
    const reports = join(target, '.secscan')
    const runs = join(reports, 'runs', 'e2e-1')
    const upstream = join(runs, provider, 'stage0-recon')
    mkdirSync(upstream, { recursive: true })
    writeFileSync(join(target, 'handler.ts'), 'export function handle(q: string) { return db.query("select * from t where id=" + q) }\n')
    const files = [{ path: 'handler.ts', language: 'typescript', bytes: 90, test: false, empty: false, oversize: false }]
    for (const [name, value] of Object.entries({
      'file-inventory.json': { target_dir: target, files, options: { max_file_bytes: 1_000_000 }, totals: {} },
      'file-signals.json': { target_dir: target, files: { 'handler.ts': ['db_query'] } },
      'architecture-summary.json': { file_inventory: { total_source_files: 1 }, route_table: { hand_written_routes: [], auto_crud_routes: [] } },
      'category-applicability.json': [],
    })) writeFileSync(join(upstream, name), JSON.stringify(value))

    // What the CLI hands the launcher: its own environment minus scanner knobs.
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('SCANNER_') || k.startsWith('HUNT_')) delete env[k]
    delete env.NODE_TEST_CONTEXT
    Object.assign(env, { SCANNER_REPORTS_ROOT: reports, SCANNER_RUNS_ROOT: runs, SCANNER_PLAYBOOK_AGENT: '0' })
    const logPath = join(runs, 'secscan.log')
    for (const stage of ['stage05-lane-selector-perfile', 'stage1-budget-governor-perfile']) {
      const r = await launchStage({ stage, provider, target, runId: 'e2e-1', resume: false, env, logPath }).done
      assert.equal(r.exit_code, 0, `${stage} failed:\n${readFileSync(logPath, 'utf8').slice(-2000)}`)
    }
    const lanes = JSON.parse(readFileSync(join(runs, provider, 'stage05-lane-selector-perfile', 'lane-assignments.json'), 'utf8'))
    assert.deepEqual(lanes.lanes.map((l: { target_file: string }) => l.target_file), ['handler.ts'])
    const plan = JSON.parse(readFileSync(join(runs, provider, 'stage1-budget-governor-perfile', 'scan-plan.json'), 'utf8'))
    assert.equal(plan.admitted.length, 1)
    for (const [logdir, stage] of [['stage05-lane-selector-perfile', 'stage05-lane-selector-perfile'], ['stage1-budget-governor-perfile', 'stage1-budget-governor-perfile']]) {
      assert.ok(readFileSync(join(runs, provider, logdir, 'logs', `${stage}.stdout.log`), 'utf8').length > 0, stage)
    }
    const log = readFileSync(logPath, 'utf8')
    assert.match(log, new RegExp(`=== \\[${provider}\\] stage05-lane-selector-perfile exited 0 ===`))
    assert.match(log, new RegExp(`=== \\[${provider}\\] stage1-budget-governor-perfile exited 0 ===`))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
