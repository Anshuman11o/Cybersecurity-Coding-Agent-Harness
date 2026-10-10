/**
 * The terminal summary (plan §4.4, Option A). Locations print as
 * `relative/path.ts:42`, which VS Code's terminal and most others make
 * clickable when the shell is at the target root.
 */
import { cap, findingById, fmtUsd } from './format.js'
import type { Report } from './types.js'

export function renderTerminal(report: Report, outputs: Record<string, string>): string {
  const s = report.summary, c = report.coverage, r = report.run_stats
  const lines: string[] = []
  const bar = '─'.repeat(72)
  lines.push(bar)
  lines.push(`  ${report.status.state}  ${report.header.repo}${report.header.commit ? ` @ ${report.header.commit.slice(0, 7)}` : ''}  ·  ${report.header.model}`)
  for (const reason of report.status.reasons) lines.push(`    ! ${reason}`)
  lines.push(bar)
  lines.push(`  ${s.total} potential vulnerabilit${s.total === 1 ? 'y' : 'ies'}:  ` +
    `${s.by_severity.critical} critical, ${s.by_severity.high} high, ${s.by_severity.medium} medium, ${s.by_severity.low} low`)
  lines.push(`  confidence: ${s.by_confidence_band.High} high, ${s.by_confidence_band.Medium} medium, ${s.by_confidence_band.Low} low`)
  lines.push(`  coverage:   ${c.files_scanned}/${c.files_total} files scanned, ${c.files_skipped} skipped, ${c.files_failed} failed` +
    (c.files_not_run ? `, ${c.files_not_run} never ran` : '') +
    (c.code_lines_pct != null ? `; ${c.code_lines_pct}% of code lines` : ''))
  lines.push(`  cost:       ${fmtUsd(r.cost_usd)}${r.estimate_usd != null ? ` (estimate ${fmtUsd(r.estimate_usd)})` : ''}`)
  const unmeasured = c.languages.filter((l) => l.code && l.scanned > 0 && !l.measured).map((l) => l.language)
  if (unmeasured.length) lines.push(`  unmeasured: ${unmeasured.join(', ')}`)

  if (s.review_first.length) {
    const byId = findingById(report)
    lines.push('')
    lines.push('  Review first:')
    for (const id of s.review_first) {
      const f = byId.get(id)!
      lines.push(`    ${cap(f.severity).padEnd(8)} ${f.confidence.toFixed(2)}  ${f.location.display}`)
      lines.push(`                   ${f.title}`)
    }
  }
  lines.push('')
  lines.push('  Reports:')
  for (const [name, path] of Object.entries(outputs)) lines.push(`    ${name.padEnd(14)} ${path}`)
  lines.push('')
  lines.push('  Static reasoning only: every finding is a candidate to review, not a confirmed bug.')
  lines.push(bar)
  return lines.join('\n')
}
