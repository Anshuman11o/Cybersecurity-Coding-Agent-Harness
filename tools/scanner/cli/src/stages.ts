/**
 * Launching pipeline stages. The CLI drives run.sh one stage at a time, so the
 * stage table, the run-context resolution, the provider lock and the per-stage
 * log tees stay in the one place the lab already relies on. (Task 1e replaces
 * this with an in-process orchestrator for the npm package.)
 *
 * Each stage runs in its own process group. A terminal's Ctrl-C therefore
 * reaches only the CLI, which decides what it means — for the hunt, a stop
 * request through a file, so one keypress is exactly one request no matter how
 * many wrappers (bash, npm, tsx) sit between the CLI and the stage.
 */
import { spawn, type ChildProcess } from 'child_process'
import { openSync, closeSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { StageResult } from './run-record.js'

export const RUN_SH = join(dirname(fileURLToPath(import.meta.url)), '../../run.sh')

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

export function launchStage(l: StageLaunch): RunningStage {
  const fd = openSync(l.logPath, 'a')
  const started = new Date().toISOString()
  const child = spawn(
    'bash',
    [RUN_SH, '--target', l.target, '--profile', 'product', '--run-id', l.runId,
      ...(l.resume ? ['--resume'] : []), l.provider, l.stage],
    { env: l.env, detached: true, stdio: ['ignore', fd, fd] },
  )
  const done = new Promise<StageResult>(resolveDone => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      try { closeSync(fd) } catch { /* already closed */ }
      resolveDone({
        stage: l.stage,
        exit_code: code,
        signal: signal ?? null,
        started_at: started,
        ended_at: new Date().toISOString(),
        log: l.logPath,
      })
    }
    child.on('exit', finish)
    child.on('error', () => finish(127, null))
  })
  return { child, stage: l.stage, done }
}

/** Signal a stage's whole process group (bash, npm, tsx, node). */
export function signalStage(s: RunningStage, sig: NodeJS.Signals): void {
  if (s.child.pid == null) return
  try {
    process.kill(-s.child.pid, sig)
  } catch {
    // The group is already gone.
  }
}
