/**
 * Grep-based detection of frontend escape-hatch APIs across multiple frameworks.
 *
 * Supported frameworks:
 * - Angular: bypassSecurityTrustHtml, bypassSecurityTrust*, [innerHTML]
 * - React:   dangerouslySetInnerHTML
 * - Vue:     v-html, v-text (template) / v-html (JSX)
 *
 * Auto-detects framework from package.json dependencies / config files,
 * or can be called directly with a framework type.
 */
import * as fs from 'fs'
import * as path from 'path'

export type FrameworkType = 'angular' | 'react' | 'vue'

export interface EscapeHatchFinding {
  file: string
  line: number
  type: string
  snippet: string
  framework: FrameworkType
}

export interface FrameworkPatternSet {
  framework: FrameworkType
  patterns: { regex: RegExp, type: string }[]
}

/**
 * Pattern sets for each supported framework.
 */
const FRAMEWORK_PATTERNS: FrameworkPatternSet[] = [
  {
    framework: 'angular',
    patterns: [
      { regex: /\.bypassSecurityTrustHtml\s*\(/, type: 'bypassSecurityTrustHtml' },
      { regex: /\.bypassSecurityTrust\w+\s*\(/, type: 'bypassSecurityTrust*' },
      { regex: /\[innerHTML\]/, type: 'innerHTML' },
      { regex: /\[innerHtml\]/, type: 'innerHTML' },
    ],
  },
  {
    framework: 'react',
    patterns: [
      { regex: /dangerouslySetInnerHTML\s*[=:]\s*\{/, type: 'dangerouslySetInnerHTML' },
    ],
  },
  {
    framework: 'vue',
    patterns: [
      { regex: /v-html\s*=/, type: 'v-html' },
      { regex: /v-text\s*=/, type: 'v-text' },
      { regex: /\bdangerouslySetInnerHTML\b/, type: 'dangerouslySetInnerHTML' },
    ],
  },
]

/**
 * Auto-detect which frontend frameworks are present in the target.
 * Checks package.json dependencies and config files.
 */
export function detectFrontendFrameworks(targetDir: string): FrameworkType[] {
  const detected: FrameworkType[] = []

  // Collect dependencies from ALL package.json files in the target tree
  // (frontends often have their own package.json in a subdirectory like frontend/)
  const allDeps: string[] = []
  const configFiles: string[] = []

  function findPackageJsons(dir: string, depth: number = 0) {
    if (depth > 3) return // Don't recurse too deep
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        findPackageJsons(fullPath, depth + 1)
      } else if (entry.isFile() && entry.name === 'package.json') {
        try {
          const pkgContent = fs.readFileSync(fullPath, 'utf-8')
          const pkg = JSON.parse(pkgContent)
          allDeps.push(...Object.keys(pkg.dependencies || {}))
          allDeps.push(...Object.keys(pkg.devDependencies || {}))
        } catch {}
      }
    }
  }

  findPackageJsons(targetDir)

  // Also look for framework config files
  if (fileExists(targetDir, 'angular.json')) configFiles.push('angular')
  if (fileExists(targetDir, 'frontend/angular.json')) configFiles.push('angular')
  if (fileExists(targetDir, 'vue.config.js')) configFiles.push('vue')
  if (fileExists(targetDir, 'frontend/vue.config.js')) configFiles.push('vue')
  if (fileExists(targetDir, 'vite.config.ts')) configFiles.push('vite')
  if (fileExists(targetDir, 'frontend/vite.config.ts')) configFiles.push('vite')

  const uniqueDeps = [...new Set(allDeps)]

  if (uniqueDeps.some(d => d.startsWith('@angular/')) || configFiles.includes('angular')) {
    detected.push('angular')
  }

  if (uniqueDeps.includes('react') || uniqueDeps.includes('react-dom')) {
    detected.push('react')
  }

  if (uniqueDeps.some(d => d === 'vue' || d === 'vue-template-compiler' || d === '@vue/compiler-sfc')) {
    detected.push('vue')
  }

  return detected
}

function fileExists(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name))
}

function getPatternsForFrameworks(frameworks: FrameworkType[]): FrameworkPatternSet[] {
  return FRAMEWORK_PATTERNS.filter(ps => frameworks.includes(ps.framework))
}

/**
 * Recursively scan a directory for escape-hatch API usage across
 * the specified frontend frameworks.
 */
export function scan(frontendSrcDir: string, frameworks?: FrameworkType[]): EscapeHatchFinding[] {
  const findings: EscapeHatchFinding[] = []

  const patternSets = frameworks
    ? getPatternsForFrameworks(frameworks)
    : FRAMEWORK_PATTERNS

  scanDirRecursive(frontendSrcDir, findings, patternSets)
  return findings
}

/**
 * Legacy single-framework scan (backward-compatible, Angular-only).
 * @deprecated Use `scan(dir, frameworks)` with explicit framework list.
 */
export function scanLegacy(frontendSrcDir: string): EscapeHatchFinding[] {
  return scan(frontendSrcDir, ['angular'])
}

function scanDirRecursive(dir: string, findings: EscapeHatchFinding[], patternSets: FrameworkPatternSet[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDirRecursive(fullPath, findings, patternSets)
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.spec.ts')) continue
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.html') && !entry.name.endsWith('.tsx') && !entry.name.endsWith('.vue')) continue

      const content = fs.readFileSync(fullPath, 'utf-8')
      const lines = content.split('\n')
      const relPath = makeRelativePath(fullPath)

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const ps of patternSets) {
          for (const pattern of ps.patterns) {
            if (pattern.regex.test(line)) {
              if (pattern.type === 'bypassSecurityTrust*' && line.includes('.bypassSecurityTrustHtml(')) {
                continue
              }
              findings.push({
                file: relPath,
                line: i + 1,
                type: pattern.type,
                snippet: line.trim().substring(0, 200),
                framework: ps.framework,
              })
            }
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
