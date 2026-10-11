/** Number and label formatting shared by the Markdown, HTML and terminal outputs. */
import type { ExcerptLine, Report, ReportFinding, ScannerSignal } from './types.js'

export const fmtInt = (n: number | null | undefined) => (n == null ? 'not recorded' : n.toLocaleString('en-US'))
export const fmtUsd = (n: number | null | undefined) => (n == null ? 'not available' : `$${n.toFixed(2)}`)

export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return 'not recorded'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const SIGNAL_LABEL: Record<ScannerSignal['signal'], string> = {
  trace_complete: 'Trace complete, entry point to sink',
  entry_exposed: 'Entry point exposed per recon',
  known_sink: 'Sink in a known dangerous API',
  playbook_coverage: 'File reached by playbooks',
}

export const VALIDATION_LABEL: Record<string, string> = {
  looked_for_absent: 'looked for, none found',
  looked_for_insufficient: 'looked for, present but insufficient',
  not_looked_for: 'not looked for',
  not_applicable: 'not applicable (the defect is not about input)',
}

export const signalMark = (v: boolean | null) => (v === true ? 'yes' : v === false ? 'no' : 'n/a')

/** Excerpt as plain text with line numbers, the cited line marked with '>'. */
export function excerptText(lines: ExcerptLine[]): string {
  const w = String(lines[lines.length - 1]?.n ?? 0).length
  return lines.map((l) => `${l.cited ? '>' : ' '} ${String(l.n).padStart(w)} | ${l.text}`).join('\n')
}

export function findingById(report: Report): Map<string, ReportFinding> {
  return new Map(report.findings.map((f) => [f.id, f]))
}

export function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'
}
