/**
 * Launching pipeline stages. The CLI runs each stage as its own Node process,
 * directly: no bash, no npm, no run.sh. run.sh is unchanged and stays the lab's
 * entry point; it simply is not on the CLI's path any more, because neither
 * bash nor `npm run` exists on a stock Windows machine, and an npm package
 * cannot ship a script that assumes them.
 *
 * What this module keeps from run.sh, for the product profile:
 *
 *   - the v2 stage table: which package directory and entry module a stage key
 *     names, and the budget governor's two modes (STAGE_TABLE below)
 *   - the environment run.sh exported: SCANNER_PROVIDER, SCANNER_PROFILE,
 *     the realpath'd SCANNER_TARGET, SCANNER_RUN_ID, SCANNER_RESUME only when
 *     resuming, and NODE_USE_ENV_PROXY only when a proxy is configured
 *   - cwd = the stage's package directory, as `npm run` gave it
 *   - per-stage logs, <runs>/<provider>/<logdir>/logs/<stage>.std{out,err}.log,
 *     beside the stage's artifacts, as well as the CLI's own secscan.log
 *
 * What it drops is the cross-provider lock. That lock protects the lab's shared
 * runs/<provider>/ tree, where two providers' runs could interleave; a product
 * run writes only under its own <reports>/runs/<run-id>/, which no other run
 * shares, so there is nothing for it to protect here.
 *
 * Two ways to run, decided by whether this module is itself a .ts file:
 *
 *   from source  (lab, development) node <tsx cli> <stage>/src/<entry>.ts
 *                tsx, as `npm run` used it, so a stage behaves as it did.
 *   from dist/   (the npm package)  node <stage>/src/<entry>.js
 *                The build keeps the tools/scanner/ layout under dist/, so the
 *                scanner root is two directories up either way.
 *
 * Each stage runs in its own process group (POSIX) or without the user's
 * console (Windows). A terminal's Ctrl-C therefore reaches only the CLI, which
 * decides what it means: for the hunt, a stop request through a file, so one
 * keypress is exactly one request; for any other stage, a signal it sends.
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { closeSync, mkdirSync, openSync, realpathSync, writeSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { PRODUCT_DIRNAME } from '../../shared/run-context.js'
import type { StageResult } from './run-record.js'

const HERE = fileURLToPath(import.meta.url)

/** tools/scanner/ from source; dist/tools/scanner/ in the package. */
export const SCANNER_ROOT = join(dirname(HERE), '../..')

export interface StageSpec {
  /** The stage's package directory under the scanner root; also its cwd. */
  dir: string
  /** Entry module relative to `dir`, without its extension. */
  entry: string
  args: readonly string[]
  /** Directory under <runs>/<provider>/ its logs go to (run.sh's stage_logdir). */
  logdir: string
}

/**
 * Keyed by the stage names the CLI already uses, which are artifact namespaces
 * rather than source directories: the v2 budget governor shares v1's source.
 * reconcile-v2 is a second pass over the v2 governor's own artifacts, so its
 * logs go with them rather than into a stray directory.
 */
export const STAGE_TABLE: Readonly<Record<string, StageSpec>> = Object.freeze({
  'stage0-recon': { dir: 'stage0-recon', entry: 'src/recon', args: [], logdir: 'stage0-recon' },
  'stage-playbook-agent': { dir: 'stage-playbook-agent', entry: 'src/main', args: [], logdir: 'stage-playbook-agent' },
  'stage05-lane-selector-perfile': {
    dir: 'stage05-lane-selector-perfile', entry: 'src/lane-selector-perfile', args: [], logdir: 'stage05-lane-selector-perfile',
  },
  'stage1-budget-governor-perfile': {
    dir: 'stage1-budget-governor', entry: 'src/budget-governor', args: ['--v2', '--mode', 'estimate'], logdir: 'stage1-budget-governor-perfile',
  },
  'stage2-hunt-lanes-perfile': { dir: 'stage2-hunt-lanes-perfile', entry: 'src/hunt-executor', args: [], logdir: 'stage2-hunt-lanes-perfile' },
  'reconcile-v2': {
    dir: 'stage1-budget-governor', entry: 'src/budget-governor', args: ['--v2', '--mode', 'reconcile'], logdir: 'stage1-budget-governor-perfile',
  },
})

/** Where the stage sources are, and whether they are TypeScript. */
export interface LaunchLayout {
  root: string
  fromSource: boolean
}

export const DEFAULT_LAYOUT: LaunchLayout = { root: SCANNER_ROOT, fromSource: HERE.endsWith('.ts') }

/** Proxy variables that make Node route fetch through a proxy (see stageEnv). */
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const

export interface StageLaunch {
  stage: string
  provider: string
  target: string
  runId: string
  resume: boolean
  env: NodeJS.ProcessEnv
  logPath: string
}

export interface RunningStage {
  child: ChildProcess
  stage: string
  done: Promise<StageResult>
}

export interface StageCommand {
  command: string
  args: string[]
  cwd: string
  spec: StageSpec
}

/** Symlinks resolved when the path exists; otherwise just made absolute. */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

function specFor(stage: string): StageSpec {
  if (!Object.prototype.hasOwnProperty.call(STAGE_TABLE, stage)) throw new Error(`unknown stage "${stage}"`)
  return STAGE_TABLE[stage]
}

/** tsx's CLI, from this package's own dependencies. Only needed from source. */
function tsxCli(): string {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli')
  } catch {
    throw new Error('running from source needs tsx; run tools/scanner/install.sh first')
  }
}

/**
 * The process to spawn for a stage. The entry is passed as a realpath, which
 * is also what each stage's entry guard (shared/entry.ts) compares against.
 * A missing entry is passed through as is: Node then says which file is
 * missing, in the stage log, and the stage fails like any other.
 */
export function stageCommand(stage: string, layout: LaunchLayout = DEFAULT_LAYOUT): StageCommand {
  const spec = specFor(stage)
  const cwd = join(layout.root, spec.dir)
  const entry = realOrResolved(join(cwd, `${spec.entry}.${layout.fromSource ? 'ts' : 'js'}`))
  return {
    command: process.execPath,
    args: layout.fromSource ? [tsxCli(), entry, ...spec.args] : [entry, ...spec.args],
    cwd,
    spec,
  }
}

/**
 * The stage's environment: the caller's (which the CLI has already reduced to
 * exactly what was confirmed, and which carries SCANNER_REPORTS_ROOT and
 * SCANNER_RUNS_ROOT), plus what run.sh exported.
 *
 * Only the flag grants a resume: a SCANNER_RESUME left in the caller's shell
 * would be exactly the implicit resume the product profile exists to stop.
 *
 * NODE_USE_ENV_PROXY: the openai SDK's fetch ignores HTTPS_PROXY on its own,
 * so behind an intercepting proxy every request is refused. Node is told to
 * honour the proxy variables only when one is set; with none, the flag has
 * nothing to do and is not added. An inherited value is left as it was, as
 * run.sh left it.
 */
export function stageEnv(l: StageLaunch): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...l.env,
    SCANNER_PROVIDER: l.provider,
    SCANNER_PROFILE: 'product',
    SCANNER_TARGET: realOrResolved(l.target),
    SCANNER_RUN_ID: l.runId,
  }
  if (l.resume) env.SCANNER_RESUME = '1'
  else delete env.SCANNER_RESUME
  // Absolute, as run.sh exported them: the stage resolves a relative root
  // against its own cwd, which is its package directory, not the caller's.
  for (const k of ['SCANNER_REPORTS_ROOT', 'SCANNER_RUNS_ROOT'] as const) {
    const v = env[k]
    if (v) env[k] = resolve(v)
  }
  if (PROXY_VARS.some(k => env[k])) env.NODE_USE_ENV_PROXY = '1'
  return env
}

/**
 * <runs>/<provider>/<logdir>/logs. The runs root is the one the stage itself
 * resolves (shared/run-context.ts): SCANNER_RUNS_ROOT, else
 * <reports>/runs/<run-id> under SCANNER_REPORTS_ROOT or <target>/.secscan.
 */
export function stageLogDir(l: StageLaunch, env: NodeJS.ProcessEnv = stageEnv(l)): string {
  const target = env.SCANNER_TARGET ?? resolve(l.target)
  const runsRoot = env.SCANNER_RUNS_ROOT ||
    join(env.SCANNER_REPORTS_ROOT || join(target, PRODUCT_DIRNAME), 'runs', l.runId)
  return join(runsRoot, l.provider, specFor(l.stage).logdir, 'logs')
}

/** Open a per-stage log for writing. Not fatal: secscan.log still has every line. */
function openStageLog(path: string): number | null {
  try {
    return openSync(path, 'w')
  } catch {
    return null
  }
}

function writeAll(fds: readonly (number | null)[], chunk: Buffer | string): void {
  const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
  for (const fd of fds) {
    if (fd === null) continue
    try {
      for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off)
    } catch {
      // A full disk or a removed log must not take the CLI down with it.
    }
  }
}

export function launchStage(l: StageLaunch, layout: LaunchLayout = DEFAULT_LAYOUT): RunningStage {
  const cmd = stageCommand(l.stage, layout)
  const env = stageEnv(l)
  const logDir = stageLogDir(l, env)
  try { mkdirSync(logDir, { recursive: true }) } catch { /* the per-stage logs are skipped; secscan.log has every line */ }

  const cliLog = openSync(l.logPath, 'a')
  const outLog = openStageLog(join(logDir, `${l.stage}.stdout.log`))
  const errLog = openStageLog(join(logDir, `${l.stage}.stderr.log`))
  const closeLogs = () => {
    for (const fd of [cliLog, outLog, errLog]) {
      if (fd === null) continue
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
  writeAll([cliLog], `=== [${l.provider}] ${l.stage} ===\n`)

  const started = new Date().toISOString()
  // detached: a new process group on POSIX, so group signals reach the stage
  // and everything under it and a terminal's Ctrl-C does not. On Windows the
  // child is started without the user's console, which is what keeps that
  // console's Ctrl-C away from it; windowsHide keeps it from opening a window.
  let child: ChildProcess
  try {
    child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    closeLogs()
    throw e
  }
  // The CLI is the tee: it outlives every stage it starts, and handles Ctrl-C
  // itself rather than dying of it, so the stage's last lines always land.
  child.stdout?.on('data', (chunk: Buffer) => writeAll([cliLog, outLog], chunk))
  child.stderr?.on('data', (chunk: Buffer) => writeAll([cliLog, errLog], chunk))

  const done = new Promise<StageResult>(resolveDone => {
    let settled = false
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      writeAll([cliLog], `=== [${l.provider}] ${l.stage} exited ${code ?? signal ?? 'unknown'} ===\n`)
      closeLogs()
      resolveDone({
        stage: l.stage,
        exit_code: code,
        signal: signal ?? null,
        started_at: started,
        ended_at: new Date().toISOString(),
        log: l.logPath,
      })
    }
    // 'close', not 'exit': it waits for the pipes to drain, so the footer and
    // the result follow the stage's last line instead of racing it.
    child.on('close', finish)
    child.on('error', (e: Error) => {
      // After a successful spawn, 'error' means a kill failed; the stage is
      // still running and 'close' will report it. Before, nothing will.
      if (child.pid !== undefined) return
      writeAll([cliLog], `secscan: could not start ${l.stage}: ${e.message}\n`)
      finish(127, null)
    })
  })
  return { child, stage: l.stage, done }
}

/** Force-kill a Windows process tree. Best effort: the tree may already be gone. */
function taskkillTree(pid: number): void {
  try {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* ignored */ })
  } catch {
    // No taskkill on PATH; nothing more can be done from here.
  }
}

/**
 * Signal a stage. POSIX: the whole process group (tsx and node from source,
 * node alone from dist). Windows has no signals to deliver: kill() terminates
 * the child itself, and SIGKILL, the CLI's last resort, takes the whole tree
 * with taskkill. `platform` and `forceTree` are parameters so the Windows
 * branch can be tested anywhere.
 */
export function signalStage(
  s: RunningStage,
  sig: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  forceTree: (pid: number) => void = taskkillTree,
): void {
  const pid = s.child.pid
  if (pid == null) return
  if (platform === 'win32') {
    if (sig === 'SIGKILL') {
      forceTree(pid)
      return
    }
    try {
      s.child.kill(sig)
    } catch {
      // Already exited.
    }
    return
  }
  try {
    process.kill(-pid, sig)
  } catch {
    // The group is already gone.
  }
}
