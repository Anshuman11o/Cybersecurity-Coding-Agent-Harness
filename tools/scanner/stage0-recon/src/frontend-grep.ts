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
 *
 * Recon v3: the files scanned are a list the caller provides — the non-test
 * inventory files with a frontend-capable extension — rather than one fixed
 * directory. A frontend that does not live at frontend/src/app (most of them)
 * used to be skipped whole.
 */
import * as fs from 'fs'
import * as path from 'path'
import { getRunContext, isBenchmark } from '../../shared/run-context.js'

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
export function detectFrontendFrameworks(
  targetDir: string,
  selectedPaths?: readonly string[],
  read: (relPath: string) => string | null = rel => fs.readFileSync(path.join(targetDir, rel), 'utf-8'),
): FrameworkType[] {
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

  const selected = selectedPaths === undefined ? null : new Set(selectedPaths)
  if (selected) {
    for (const rel of selected) {
      if (path.basename(rel) !== 'package.json') continue
      try {
        const content = read(rel)
        if (content === null) continue
        const pkg = JSON.parse(content)
        allDeps.push(...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {}))
      } catch {}
    }
  } else {
    findPackageJsons(targetDir)
  }
  const hasConfig = (rel: string) => selected ? selected.has(rel) : fileExists(targetDir, rel)

  // Also look for framework config files
  if (hasConfig('angular.json')) configFiles.push('angular')
  if (hasConfig('frontend/angular.json')) configFiles.push('angular')
  if (hasConfig('vue.config.js')) configFiles.push('vue')
  if (hasConfig('frontend/vue.config.js')) configFiles.push('vue')
  if (hasConfig('vite.config.ts')) configFiles.push('vite')
  if (hasConfig('frontend/vite.config.ts')) configFiles.push('vite')

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

/** Extensions a template, component or script carrying an escape hatch can have. */
export const ESCAPE_HATCH_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html', '.vue']

/**
 * The files worth grepping, from the inventory: not tests, not oversize (whose
 * content Stage 0 never reads), with an ESCAPE_HATCH_EXTENSIONS extension.
 * Returned in inventory order.
 */
export function escapeHatchCandidates(
  entries: readonly { path: string; test: boolean; oversize: boolean }[],
): string[] {
  return entries
    .filter(e => !e.test && !e.oversize && ESCAPE_HATCH_EXTENSIONS.includes(path.extname(e.path).toLowerCase()))
    .map(e => e.path)
}

/**
 * Scan the given target-relative files for escape-hatch API usage across the
 * specified frontend frameworks. Findings are sorted by file, then line;
 * within a line they keep pattern order.
 */
export function scan(
  targetDir: string, relPaths: readonly string[], frameworks?: FrameworkType[],
  read?: (relPath: string) => string | null,
): EscapeHatchFinding[] {
  const findings: EscapeHatchFinding[] = []

  const patternSets = frameworks
    ? getPatternsForFrameworks(frameworks)
    : FRAMEWORK_PATTERNS

  for (const relPath of relPaths) {
    scanFile(path.join(targetDir, relPath), findings, patternSets, read ? () => read(relPath) : undefined)
  }

  // Stable sort, so equal (file, line) keys keep the order they were found in.
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
  return findings
}

/**
 * Legacy single-framework scan (backward-compatible, Angular-only).
 * @deprecated Use `scan(targetDir, files, frameworks)` with explicit framework list.
 */
export function scanLegacy(targetDir: string, relPaths: readonly string[]): EscapeHatchFinding[] {
  return scan(targetDir, relPaths, ['angular'])
}

function scanFile(
  fullPath: string, findings: EscapeHatchFinding[], patternSets: FrameworkPatternSet[],
  read?: () => string | null,
): void {
  const name = path.basename(fullPath)
  // Kept from the directory walk this replaced: the inventory flags *.spec.*
  // as tests already, but not when tests are included on purpose.
  if (name.endsWith('.spec.ts')) return
  if (!ESCAPE_HATCH_EXTENSIONS.includes(path.extname(name).toLowerCase())) return

  let content: string
  try {
    const source = read ? read() : fs.readFileSync(fullPath, 'utf-8')
    if (source === null) return
    content = source
  } catch {
    return
  }
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

/**
 * Benchmark: repo-relative ('target-apps/juice-shop-blind/frontend/...'), as
 * every committed artifact records it. Product: relative to the target root —
 * the target can live anywhere, so there is no repo prefix to anchor on.
 */
function makeRelativePath(absPath: string): string {
  const ctx = getRunContext()
  if (isBenchmark(ctx)) {
    const idx = absPath.indexOf('target-apps/')
    if (idx >= 0) return absPath.substring(idx)
    return absPath
  }
  if (!path.isAbsolute(absPath)) return absPath
  const rel = path.relative(ctx.targetRoot, absPath)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return absPath
  return rel.split(path.sep).join('/')
}
