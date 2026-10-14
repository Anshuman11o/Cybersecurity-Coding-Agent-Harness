/**
 * findings.json's exact text, and where each finding starts in it, so a report
 * page can link straight to a finding's line.
 *
 * Zero dependencies.
 */
import type { FindingsReport } from './types.js'

export function serializeReport(report: FindingsReport): string {
  return JSON.stringify(report, null, 2) + '\n'
}

/**
 * The 1-based line of each finding's opening brace in `serializeReport` output,
 * in findings order. Null if the text is not shaped as expected, so a page
 * shows no link rather than a wrong one.
 */
export function findingLines(text: string, expected: number): number[] | null {
  const lines = text.split('\n')
  const start = lines.indexOf('  "findings": [')
  if (start < 0) return expected === 0 ? [] : null
  const out: number[] = []
  for (let i = start + 1; i < lines.length; i++) if (lines[i] === '    {') out.push(i + 1)
  return out.length === expected ? out : null
}

/** Where findings.json is and the line each finding starts on, for VS Code links. */
export interface ReportLinks {
  findingsPath: string
  /** 1-based, in findings order. */
  findingLines: number[]
}

/** A link that opens a local file at a line in VS Code. */
export function vscodeHref(path: string, line: number): string {
  const p = path.replace(/\\/g, '/')
  const abs = p.startsWith('/') ? p : '/' + p
  return 'vscode:' + '//file' + encodeURI(abs).replace(/#/g, '%23').replace(/\?/g, '%3F') + ':' + line
}
