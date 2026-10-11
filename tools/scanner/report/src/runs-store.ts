/**
 * The product run store: <target>/.secscan/ (or wherever --out put it).
 *
 *   <store>/.gitignore            "*" (run.sh writes it, with consent)
 *   <store>/index.json            one row per run, rebuilt from disk
 *   <store>/latest                symlink to the newest reported run
 *                                 (latest.txt holding its id where symlinks fail)
 *   <store>/runs/<run-id>/        report.html, report.md, findings.json,
 *                                 findings.sarif, run.json
 *   <store>/runs/<run-id>/work/   stage internals, checkpoints, logs
 *
 * index.json is rebuilt from the run directories every time rather than
 * appended to: a run that died before its report, or a run someone deleted by
 * hand, then shows up correctly instead of leaving the index out of step with
 * the disk.
 *
 * This module touches only paths under the store. It never reads the scanned
 * repository; excerpts come through the read guard in report.ts.
 */
import {
  existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'fs'
import { join, relative, sep } from 'path'

/** Same rule as run-context.ts: a run id is a safe path segment. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const RUN_FILES = ['report.html', 'report.md', 'findings.json', 'findings.sarif', 'run.json'] as const

export interface IndexRow {
  run_id: string
  path: string
  report: string | null
  status: 'COMPLETE' | 'INCOMPLETE' | 'no report'
  generated_at: string | null
  commit: string | null
  branch: string | null
  provider: string | null
  model: string | null
  findings: number | null
  by_severity: Record<string, number> | null
  cost_usd: number | null
  size_bytes: number
  work_bytes: number
  /** False once `work/` is pruned: the run can no longer be resumed or re-reported. */
  has_work: boolean
}

export interface StoreIndex {
  schema_version: '1.0'
  generated_at: string
  latest: string | null
  runs: IndexRow[]
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as T
  } catch {
    return null
  }
}

/** Bytes under a path, never following a symlink out of it. */
export function sizeOf(p: string): number {
  let st
  try { st = lstatSync(p) } catch { return 0 }
  if (st.isSymbolicLink() || !st.isDirectory()) return st.isFile() ? st.size : 0
  let total = 0
  for (const e of readdirSync(p)) total += sizeOf(join(p, e))
  return total
}

/** Run ids in the store, newest first. Symlinked or oddly named entries are ignored. */
export function listRunIds(store: string): string[] {
  const runs = join(store, 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs)
    .filter((id) => RUN_ID_RE.test(id))
    .filter((id) => {
      try { return lstatSync(join(runs, id)).isDirectory() } catch { return false }
    })
    .sort()
    .reverse()
}

export function indexRow(store: string, id: string): IndexRow {
  const dir = join(store, 'runs', id)
  const run = readJson<Record<string, any>>(join(dir, 'run.json'))
  const hasReport = existsSync(join(dir, 'report.html'))
  return {
    run_id: id,
    path: `runs/${id}/`,
    report: hasReport ? `runs/${id}/report.html` : null,
    status: run?.status === 'COMPLETE' || run?.status === 'INCOMPLETE' ? run.status : 'no report',
    generated_at: run?.generated_at ?? null,
    commit: run?.repo?.commit ?? null,
    branch: run?.repo?.branch ?? null,
    provider: run?.provider ?? null,
    model: run?.model ?? null,
    findings: run?.summary?.findings ?? null,
    by_severity: run?.summary?.by_severity ?? null,
    cost_usd: run?.summary?.cost_usd ?? null,
    size_bytes: sizeOf(dir),
    work_bytes: sizeOf(join(dir, 'work')),
    has_work: existsSync(join(dir, 'work')),
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/**
 * Point <store>/latest at the newest run that has a report. A symlink where
 * the filesystem allows one, replaced atomically; latest.txt otherwise. An
 * existing `latest` that is not a symlink is left alone: it is not ours.
 */
function updateLatest(store: string, id: string | null): void {
  const link = join(store, 'latest')
  const txt = join(store, 'latest.txt')
  let isOurs = true
  try { isOurs = lstatSync(link).isSymbolicLink() } catch { /* absent */ }
  if (!isOurs) {
    console.warn(`  [STORE] ${link} exists and is not a symlink; not replacing it`)
    return
  }
  if (id === null) {
    try { unlinkSync(link) } catch { /* absent */ }
    try { unlinkSync(txt) } catch { /* absent */ }
    return
  }
  const target = join('runs', id)
  try {
    if (readlinkSync(link) === target) return
  } catch { /* absent or not a link */ }
  const tmp = `${link}.tmp-${process.pid}`
  try {
    symlinkSync(target, tmp, 'dir')
    renameSync(tmp, link)
    try { unlinkSync(txt) } catch { /* absent */ }
  } catch {
    try { unlinkSync(tmp) } catch { /* never created */ }
    writeAtomic(txt, id + '\n')
  }
}

/** Rebuild index.json and the latest pointer from the run directories on disk. */
export function refreshStore(store: string, generatedAt: string): StoreIndex {
  const runs = listRunIds(store).map((id) => indexRow(store, id))
  const latest = runs.find((r) => r.report !== null)?.run_id ?? null
  const index: StoreIndex = { schema_version: '1.0', generated_at: generatedAt, latest, runs }
  writeAtomic(join(store, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  updateLatest(store, latest)
  return index
}

export interface PrunePlan {
  /** Whole run directories to delete. */
  deleteRuns: string[]
  /** Runs whose work/ goes; their reports stay. */
  dropWork: string[]
  bytes: number
}

/**
 * What a prune would remove. The newest run is never touched, whatever the
 * options: it may still be running, resuming or about to be reported.
 *
 *   keep  delete every run beyond the newest `keep` (at least 1)
 *   work  drop work/ from every kept run except the newest
 */
export function planPrune(store: string, opts: { keep?: number; work?: boolean }): PrunePlan {
  const ids = listRunIds(store)
  const keep = opts.keep === undefined ? ids.length : Math.max(1, Math.floor(opts.keep))
  const deleteRuns = ids.slice(keep)
  const dropWork = opts.work
    ? ids.slice(1, keep).filter((id) => existsSync(join(store, 'runs', id, 'work')))
    : []
  const bytes = deleteRuns.reduce((s, id) => s + sizeOf(join(store, 'runs', id)), 0) +
    dropWork.reduce((s, id) => s + sizeOf(join(store, 'runs', id, 'work')), 0)
  return { deleteRuns, dropWork, bytes }
}

/** Remove a directory only if it is a real directory strictly inside <store>/runs. */
function removeInside(store: string, p: string): void {
  const rel = relative(join(store, 'runs'), p)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error(`refusing to delete outside the store: ${p}`)
  if (!lstatSync(p).isDirectory()) throw new Error(`refusing to delete a non-directory: ${p}`)
  rmSync(p, { recursive: true, force: true })
}

export function applyPrune(store: string, plan: PrunePlan): void {
  for (const id of plan.deleteRuns) removeInside(store, join(store, 'runs', id))
  for (const id of plan.dropWork) removeInside(store, join(store, 'runs', id, 'work'))
}
