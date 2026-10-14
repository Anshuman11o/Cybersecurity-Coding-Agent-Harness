/**
 * Write a run's report files and rebuild the reports folder's index.
 *
 *   <reports>/runs/<run-id>/findings.json   the data
 *   <reports>/runs/<run-id>/report.html     the page, rendered from that data
 *   <reports>/index.html                    every run with a report, newest first
 *
 * Every write goes to a temporary file and is renamed into place, so a reader
 * (or a crash) never sees half a report. The index is rebuilt from the
 * findings.json files on disk each time rather than appended to, so a deleted
 * run folder drops out on the next rebuild.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { buildReport, type BuildInput } from './build.js'
import { renderReportHtml } from './option1-summary.js'
import { findingLines, serializeReport } from './serialize.js'
import { renderIndexHtml } from './index-page.js'
import {
  FINDINGS_FILE, FINDINGS_SCHEMA, INDEX_FILE, REPORT_FILE,
  type FindingsReport, type IndexEntry,
} from './types.js'

/** Same shape run ids are given (run-context.ts); anything else is not a run folder. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export { serializeReport }

/** Run ids in a reports folder, newest first (ids start with their UTC start time). */
export function listRunIds(reportsRoot: string): string[] {
  const runs = join(reportsRoot, 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs)
    .filter(id => RUN_ID_RE.test(id) && statSync(join(runs, id)).isDirectory())
    .sort()
    .reverse()
}

export function isRunId(id: string): boolean {
  return RUN_ID_RE.test(id)
}

/** Rebuild <reports>/index.html from every run that has a report. Returns its path. */
export function rebuildIndex(reportsRoot: string, now: Date = new Date()): string {
  const entries: IndexEntry[] = []
  for (const id of listRunIds(reportsRoot)) {
    const dir = join(reportsRoot, 'runs', id)
    if (!existsSync(join(dir, REPORT_FILE))) continue
    let r: FindingsReport
    try {
      r = JSON.parse(readFileSync(join(dir, FINDINGS_FILE), 'utf-8'))
    } catch {
      continue
    }
    if (r?.schema !== FINDINGS_SCHEMA) continue
    entries.push({
      run_id: id,
      href: `runs/${encodeURIComponent(id)}/${REPORT_FILE}`,
      status: r.run.status,
      started_at: r.run.started_at,
      target_root: r.run.target.root,
      branch: r.run.target.branch,
      commit: r.run.target.commit,
      findings_total: r.summary.findings_total,
      by_severity: r.summary.by_severity,
      scanned: r.summary.coverage.scanned,
      in_scope: r.summary.coverage.in_scope,
      spent_usd: r.summary.cost.spent_usd,
      budget_usd: r.summary.cost.budget_usd,
    })
  }
  entries.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '') || b.run_id.localeCompare(a.run_id))
  const path = join(reportsRoot, INDEX_FILE)
  atomicWrite(path, renderIndexHtml(entries, now.toISOString()))
  return path
}

export interface GenerateInput extends BuildInput {
  /** The reports folder holding runs/<run-id>/; its index.html is rebuilt. */
  reportsRoot: string
}

export type GenerateResult =
  | { written: true; json: string; html: string; index: string; report: FindingsReport }
  | { written: false; why: string }

/**
 * Build and write one run's report, then rebuild the index. A run the rules
 * give no report writes nothing and leaves any earlier report in place.
 */
export function generateReport(input: GenerateInput): GenerateResult {
  const { report, eligible, why } = buildReport(input)
  if (!eligible) return { written: false, why: why ?? 'not eligible' }
  const json = join(input.runDir, FINDINGS_FILE)
  const html = join(input.runDir, REPORT_FILE)
  const text = serializeReport(report)
  const lines = findingLines(text, report.findings.length)
  atomicWrite(json, text)
  atomicWrite(html, renderReportHtml(report, lines ? { findingsPath: resolve(json), findingLines: lines } : null))
  const index = rebuildIndex(input.reportsRoot, input.now)
  return { written: true, json, html, index, report }
}
