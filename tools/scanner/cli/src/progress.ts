/**
 * Live progress and spend (plan §2.7), rendered from the progress.json Stage 2
 * rewrites as lanes start and finish. Stage 2's own figures, never the CLI's
 * reconstruction of them: the spend shown is the spend its gate is enforcing.
 *
 * On a terminal the line is redrawn in place once a second. Elsewhere (CI, a
 * pipe) a line is printed when a lane finishes, at most every 15 seconds, so a
 * log stays readable.
 */
import { readFileSync } from 'fs'
import type { Stage2Progress } from '../../stage1-budget-governor/src/run-status.js'
import { usd, duration } from './display.js'

export function readProgress(path: string): Stage2Progress | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

export function progressLine(p: Stage2Progress, nowMs: number, plannedSeconds: number): string {
  const elapsed = (nowMs - Date.parse(p.started_at)) / 1000
  const finishedThisPass = p.lanes.done - p.lanes.carried + p.lanes.failed
  const remaining = Math.max(0, p.lanes.total - p.lanes.done - p.lanes.failed)
  let eta: string
  if (remaining === 0) eta = '0s'
  else if (finishedThisPass > 0) eta = `~${duration((elapsed / finishedThisPass) * remaining)}`
  else eta = `~${duration(Math.max(0, plannedSeconds - elapsed))} (planned)`
  const sev = p.findings.by_severity
  const spend = [
    p.spend.spent_usd != null ? `${usd(p.spend.spent_usd)} spent` : 'spend unpriced',
    p.spend.estimate_usd != null ? `~${usd(p.spend.estimate_usd)} est` : null,
    p.spend.cap_usd != null ? `${usd(p.spend.cap_usd)} cap` : null,
  ].filter(Boolean).join(' / ')
  const state = p.status === 'stopping' ? ' · STOPPING (finishing in-flight files)' : ''
  return `files ${p.lanes.done}/${p.lanes.total}` +
    (p.lanes.failed ? ` · ${p.lanes.failed} failed` : '') +
    (p.lanes.in_flight ? ` · ${p.lanes.in_flight} in flight` : '') +
    ` · ${spend} · ${duration(elapsed)} elapsed, ETA ${eta}` +
    ` · findings ${p.findings.total} (${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low)` +
    state
}

export interface ProgressHandle {
  stop(): void
}

export function startProgress(
  path: string,
  plannedSeconds: number,
  out: NodeJS.WriteStream = process.stderr,
): ProgressHandle {
  const tty = Boolean(out.isTTY)
  let lastDone = -1
  let lastStatus = ''
  let lastPrint = 0
  let drawn = false
  const tick = () => {
    const p = readProgress(path)
    if (!p) return
    const now = Date.now()
    let line = progressLine(p, now, plannedSeconds)
    if (tty) {
      const cols = out.columns ?? 120
      if (line.length > cols - 1) line = line.slice(0, cols - 2) + '…'
      out.write(`\r\x1b[2K${line}`)
      drawn = true
      return
    }
    const finished = p.lanes.done + p.lanes.failed
    const changed = finished !== lastDone || p.status !== lastStatus
    if (changed && (now - lastPrint >= 15_000 || p.status !== lastStatus)) {
      out.write(line + '\n')
      lastPrint = now
      lastDone = finished
      lastStatus = p.status
    }
  }
  tick()
  const timer = setInterval(tick, 1000)
  return {
    stop() {
      clearInterval(timer)
      tick()
      if (tty && drawn) out.write('\n')
    },
  }
}
