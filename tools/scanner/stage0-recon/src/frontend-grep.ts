/**
 * Grep-based detection of Angular escape-hatch APIs in frontend source.
 * Scans for bypassSecurityTrustHtml, bypassSecurityTrust*, innerHTML patterns.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface EscapeHatchFinding {
  file: string
  line: number
  type: 'bypassSecurityTrustHtml' | 'bypassSecurityTrust*' | 'innerHTML'
  snippet: string
}

/**
 * Recursively scan a directory for Angular escape-hatch API usage.
 * Only scans .ts and .html files (not .spec.ts test files).
 */
export function scan(frontendSrcDir: string): EscapeHatchFinding[] {
  const findings: EscapeHatchFinding[] = []
  const escapeHatchPatterns = [
    { regex: /\.bypassSecurityTrustHtml\s*\(/, type: 'bypassSecurityTrustHtml' as const },
    { regex: /\.bypassSecurityTrust\w+\s*\(/, type: 'bypassSecurityTrust*' as const },
    { regex: /\[innerHTML\]/, type: 'innerHTML' as const },
    { regex: /\[innerHtml\]/, type: 'innerHTML' as const },
  ]

  scanDirRecursive(frontendSrcDir, findings, escapeHatchPatterns)
  return findings
}

function scanDirRecursive(dir: string, findings: EscapeHatchFinding[], patterns: { regex: RegExp, type: EscapeHatchFinding['type'] }[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDirRecursive(fullPath, findings, patterns)
    } else if (entry.isFile()) {
      // Skip test files
      if (entry.name.endsWith('.spec.ts')) continue
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.html')) continue

      const content = fs.readFileSync(fullPath, 'utf-8')
      const lines = content.split('\n')
      const relPath = makeRelativePath(fullPath)

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const pattern of patterns) {
          if (pattern.regex.test(line)) {
            // For bypassSecurityTrust*, avoid duplicating bypassSecurityTrustHtml
            if (pattern.type === 'bypassSecurityTrust*' && line.includes('.bypassSecurityTrustHtml(')) {
              continue // Already captured by the specific pattern
            }
            findings.push({
              file: relPath,
              line: i + 1,
              type: pattern.type,
              snippet: line.trim().substring(0, 200),
            })
          }
        }
      }
    }
  }
}

function makeRelativePath(absPath: string): string {
  const idx = absPath.indexOf('target-apps/')
  if (idx >= 0) return absPath.substring(idx)
  return absPath
}
