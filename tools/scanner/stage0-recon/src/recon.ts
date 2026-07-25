/**
 * Stage 0 Recon — main orchestrator.
 *
 * Reads the target app, runs deterministic AST extraction, swagger diff,
 * frontend grep, and LLM probes, then writes the two output files:
 * - architecture-summary.json
 * - category-applicability.json
 *
 * Now parameterized: TARGET_DIR comes from CLI arg --target or env var
 * SCANNER_TARGET, defaulting to target-apps/juice-shop-blind for backward
 * compatibility. Framework-specific passes (Express AST, Angular/React/Vue
 * escape-hatch grep) are gated behind auto-detected framework signals so
 * the scanner no longer silently fails against non-Express / non-Angular
 * targets.
 *
 * Additionally performs a full-repository file inventory walk, producing
 * an unclassified_surface list (files never touched by framework-specific
 * extraction) and a smart_contract_surface_detected signal for .sol files.
 */
import * as fs from 'fs'
import * as path from 'path'

import { extract, extractDependencies } from './ast-extractor.js'
import { diff as swaggerDiff } from './swagger-diff.js'
import { scan as frontendGrep, detectFrontendFrameworks, type FrameworkType, type EscapeHatchFinding } from './frontend-grep.js'
import { detectToolCalling, probeCategoryApplicability } from './llm-probe.js'

// ---------------------------------------------------------------------------
// Target resolution: CLI arg > env var > hardcoded default
// ---------------------------------------------------------------------------

function resolveTargetDir(): string {
  // CLI arg: --target=<path>
  const targetArgIdx = process.argv.indexOf('--target')
  if (targetArgIdx >= 0 && targetArgIdx + 1 < process.argv.length) {
    return process.argv[targetArgIdx + 1]
  }
  // Also support --target=<path> (single-arg form)
  for (const arg of process.argv) {
    if (arg.startsWith('--target=')) {
      return arg.slice('--target='.length)
    }
  }
  // Env var
  if (process.env.SCANNER_TARGET) {
    return process.env.SCANNER_TARGET
  }
  // Backward-compatible default
  const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../../../')
  return path.join(PROJECT_ROOT, 'target-apps', 'juice-shop-blind')
}

const TARGET_DIR = resolveTargetDir()
const PROJECT_ROOT = path.resolve(TARGET_DIR, '../../../..')
const OUTPUT_DIR = path.join(import.meta.dirname, '..', 'output')

// Derived paths (relative to TARGET_DIR, not hardcoded absolute)
const SERVER_TS = path.join(TARGET_DIR, 'server.ts')
const SWAGGER_YML = path.join(TARGET_DIR, 'swagger.yml')
const PACKAGE_JSON = path.join(TARGET_DIR, 'package.json')
const CHAT_TS = path.join(TARGET_DIR, 'routes', 'chat.ts')
const FRONTEND_SRC = path.join(TARGET_DIR, 'frontend', 'src', 'app')

// ---------------------------------------------------------------------------
// Framework detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether the target looks like an Express application.
 * Checks: package.json has 'express' dependency + a plausible entry file exists.
 */
function detectExpress(targetDir: string): { isExpress: boolean; entryFile: string | null; reason: string } {
  const pkgPath = path.join(targetDir, 'package.json')
  let hasExpress = false

  try {
    const pkgContent = fs.readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(pkgContent)
    const allDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]
    hasExpress = allDeps.includes('express')
  } catch {
    return { isExpress: false, entryFile: null, reason: 'No package.json found in target directory' }
  }

  if (!hasExpress) {
    return { isExpress: false, entryFile: null, reason: 'No "express" dependency in package.json' }
  }

  // Look for conventional entry files at target root or src/
  const candidateEntryFiles = [
    'server.ts', 'app.ts', 'index.ts', 'main.ts',
    'src/server.ts', 'src/app.ts', 'src/index.ts', 'src/main.ts',
  ]

  for (const candidate of candidateEntryFiles) {
    const candidatePath = path.join(targetDir, candidate)
    if (fs.existsSync(candidatePath)) {
      return { isExpress: true, entryFile: candidatePath, reason: `Express dependency + entry file "${candidate}" found` }
    }
  }

  return { isExpress: false, entryFile: null, reason: 'Express dependency found but no conventional entry file (server.ts/app.ts/index.ts/main.ts) exists' }
}

// ---------------------------------------------------------------------------
// Full-repository file inventory walk
// ---------------------------------------------------------------------------

/**
 * Directories to exclude from the inventory walk (build artifacts, deps, VCS).
 */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.output', '.angular', '.cache',
  'out', '.turbo', '.vercel',
])

/**
 * Source file extensions we care about for inventory classification.
 */
const SOURCE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.php': 'php',
  '.cs': 'csharp',
  '.sol': 'solidity',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.proto': 'protobuf',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.json': 'json',
  '.sh': 'shell',
  '.bash': 'shell',
  '.dockerfile': 'docker',
}

interface FileInventoryEntry {
  path: string    // target-relative path
  extension: string
  language: string
}

interface FileInventoryResult {
  total_source_files: number
  by_language: Record<string, { count: number; sample_paths: string[] }>
  unclassified_surface: {
    language: string
    count: number
    files: string[]
    total_bytes: number
  }[]
  smart_contract_surface_detected: boolean
  smart_contract_files: string[]
}

/**
 * Walk the target directory, cataloging every source file by extension/language.
 *
 * @param targetDir         Root of the target codebase
 * @param alreadyClassified Set of paths already claimed by framework-specific extraction
 */
function walkFileInventory(
  targetDir: string,
  alreadyClassified: Set<string>,
): FileInventoryResult {
  const allFiles: FileInventoryEntry[] = []
  const smartContractFiles: string[] = []

  function walkDir(dir: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walkDir(fullPath)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        // Also check for extensionless but named files like Dockerfile
        const basename = entry.name.toLowerCase()
        const lang = SOURCE_EXTENSIONS[ext] || (basename === 'dockerfile' ? 'docker' : null)
        if (!lang) continue

        const relPath = makeRelativePath(fullPath, targetDir)
        allFiles.push({ path: relPath, extension: ext, language: lang })

        if (ext === '.sol') {
          smartContractFiles.push(relPath)
        }
      }
    }
  }

  walkDir(targetDir)

  // Group by language
  const byLanguage: Record<string, FileInventoryEntry[]> = {}
  for (const f of allFiles) {
    if (!byLanguage[f.language]) byLanguage[f.language] = []
    byLanguage[f.language].push(f)
  }

  // Unclassified = files not in the alreadyClassified set
  const unclassifiedByLanguage: Record<string, FileInventoryEntry[]> = {}
  for (const f of allFiles) {
    if (alreadyClassified.has(f.path)) continue
    if (!unclassifiedByLanguage[f.language]) unclassifiedByLanguage[f.language] = []
    unclassifiedByLanguage[f.language].push(f)
  }

  // Build output structure
  const byLangOutput: Record<string, { count: number; sample_paths: string[] }> = {}
  for (const [lang, files] of Object.entries(byLanguage)) {
    byLangOutput[lang] = {
      count: files.length,
      sample_paths: files.slice(0, 5).map(f => f.path),
    }
  }

  const unclassifiedOutput: { language: string; count: number; files: string[]; total_bytes: number }[] = []
  for (const [lang, files] of Object.entries(unclassifiedByLanguage)) {
    const relPaths = files.map(f => f.path).sort()
    let totalBytes = 0
    for (const f of files) {
      try { totalBytes += fs.statSync(path.join(targetDir, f.path)).size } catch { /* skip if unreadable */ }
    }
    unclassifiedOutput.push({
      language: lang,
      count: files.length,
      files: relPaths,
      total_bytes: totalBytes,
    })
  }

  return {
    total_source_files: allFiles.length,
    by_language: byLangOutput,
    unclassified_surface: unclassifiedOutput.sort((a, b) => b.count - a.count),
    smart_contract_surface_detected: smartContractFiles.length > 0,
    smart_contract_files: smartContractFiles.sort(),
  }
}

function makeRelativePath(absPath: string, targetDir: string): string {
  if (!absPath.startsWith(targetDir)) return absPath
  const rel = absPath.slice(targetDir.length)
  return rel.startsWith('/') ? rel.slice(1) : rel
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Stage 0: Recon ===')
  console.log(`Target: ${TARGET_DIR}`)
  console.log()

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Validate target directory exists
  if (!fs.existsSync(TARGET_DIR)) {
    console.error(`ERROR: Target directory does not exist: ${TARGET_DIR}`)
    console.error('Use --target=<path> or set SCANNER_TARGET env var.')
    process.exit(1)
  }

  // Track which files have been claimed by framework-specific extraction
  // so the file inventory can produce an accurate unclassified_surface list.
  const classifiedFiles = new Set<string>()

  // ---- Step 0: Framework detection ----
  console.log('[0/6] Detecting target frameworks...')
  const expressResult = detectExpress(TARGET_DIR)
  const frontendFrameworks = detectFrontendFrameworks(TARGET_DIR)
  console.log(`  Express: ${expressResult.isExpress} (${expressResult.reason})`)
  console.log(`  Frontend frameworks: ${frontendFrameworks.length > 0 ? frontendFrameworks.join(', ') : 'none detected'}`)
  console.log()

  // ---- Step 1: Deterministic AST extraction (gated on Express) ----
  let astResult: ReturnType<typeof extract> | null = null
  let dependencies: ReturnType<typeof extractDependencies> = []

  if (expressResult.isExpress && expressResult.entryFile) {
    console.log('[1/6] AST extraction from Express entry point...')
    astResult = extract(expressResult.entryFile)
    dependencies = extractDependencies(PACKAGE_JSON)
    astResult.dependencies = dependencies
    console.log(`  Found ${astResult.routes.length} route registrations`)
    console.log(`  Found ${astResult.autoCrudRoutes.length} auto-CRUD resources`)
    console.log(`  Persistence: ${astResult.persistence.orm} / ${astResult.persistence.database}`)
    console.log(`  Models: ${astResult.persistence.models.join(', ')}`)

    // Track classified files
    classifiedFiles.add(makeRelativePath(expressResult.entryFile, TARGET_DIR))
    for (const route of astResult.routes) {
      if (route.file) classifiedFiles.add(route.file)
    }
    for (const rawFile of astResult.persistence.rawQueryFiles) {
      classifiedFiles.add(rawFile)
    }
  } else {
    console.log('[1/6] SKIPPED: AST extraction (not an Express app)')
    console.log(`  Reason: ${expressResult.reason}`)
    // Try to get dependencies anyway for the architecture summary
    try {
      dependencies = extractDependencies(PACKAGE_JSON)
    } catch {
      console.log('  (Could not read package.json either)')
    }
  }
  console.log()

  // ---- Step 2: Swagger diff (only meaningful with AST routes) ----
  let swaggerResult: ReturnType<typeof swaggerDiff> | null = null
  if (astResult && fs.existsSync(SWAGGER_YML)) {
    console.log('[2/6] Diffing routes against swagger.yml...')
    swaggerResult = swaggerDiff(SWAGGER_YML, astResult.routes, astResult.autoCrudRoutes)
    console.log(`  Documented paths: ${swaggerResult.documentedPaths.length}`)
    console.log(`  Undocumented surfaces: ${swaggerResult.undocumentedSurfaces.length}`)
    console.log(`  Coverage: ${swaggerResult.coverageNote}`)
  } else {
    console.log('[2/6] SKIPPED: Swagger diff (no AST routes or no swagger.yml)')
    swaggerResult = { documentedPaths: [], undocumentedSurfaces: [], coverageNote: 'No routes extracted or swagger.yml not found' }
  }
  console.log()

  // ---- Step 3: Frontend escape-hatch grep (gated on detected frameworks) ----
  let escapeHatchFindings: EscapeHatchFinding[] = []
  if (frontendFrameworks.length > 0 && fs.existsSync(FRONTEND_SRC)) {
    console.log(`[3/6] Scanning frontend for escape-hatch APIs (${frontendFrameworks.join(', ')})...`)
    escapeHatchFindings = frontendGrep(FRONTEND_SRC, frontendFrameworks)
    console.log(`  Found ${escapeHatchFindings.length} escape-hatch occurrences`)
    if (escapeHatchFindings.length > 0) {
      const byFile = new Map<string, number>()
      for (const f of escapeHatchFindings) {
        byFile.set(f.file, (byFile.get(f.file) || 0) + 1)
      }
      for (const [file, count] of byFile) {
        console.log(`    ${file}: ${count} occurrence(s)`)
        classifiedFiles.add(file)
      }
    }
  } else if (!fs.existsSync(FRONTEND_SRC)) {
    console.log('[3/6] SKIPPED: Frontend grep (frontend source directory not found)')
  } else {
    console.log('[3/6] SKIPPED: Frontend grep (no frontend frameworks detected)')
  }
  console.log()

  // ---- Step 4: LLM tool-calling detection (chat.ts, if it exists) ----
  let toolCallingVerdict: Awaited<ReturnType<typeof detectToolCalling>> | null = null
  if (fs.existsSync(CHAT_TS)) {
    console.log('[4/6] Analyzing chat.ts for tool-calling capabilities...')
    toolCallingVerdict = await detectToolCalling(CHAT_TS)
    console.log(`  Genuine tool-calling: ${toolCallingVerdict.hasGenuineToolCalling}`)
    console.log(`  Tools detected: ${toolCallingVerdict.toolsDetected.join(', ') || 'none'}`)
    console.log(`  Confidence: ${toolCallingVerdict.confidence}`)
    console.log(`  Evidence: ${toolCallingVerdict.evidence}`)
    classifiedFiles.add(makeRelativePath(CHAT_TS, TARGET_DIR))
  } else {
    console.log('[4/6] SKIPPED: Tool-calling detection (no chat.ts found)')
    toolCallingVerdict = { hasGenuineToolCalling: false, evidence: 'No chat.ts found in target', toolsDetected: [], confidence: 0 }
  }
  console.log()

  // ---- Step 5: Full-repository file inventory ----
  console.log('[5/6] Walking target directory for full file inventory...')
  const fileInventory = walkFileInventory(TARGET_DIR, classifiedFiles)
  console.log(`  Total source files: ${fileInventory.total_source_files}`)
  for (const [lang, info] of Object.entries(fileInventory.by_language).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${lang}: ${info.count} file(s)`)
  }
  console.log(`  Unclassified surface: ${fileInventory.unclassified_surface.reduce((sum, u) => sum + u.count, 0)} file(s) across ${fileInventory.unclassified_surface.length} language(s)`)
  if (fileInventory.smart_contract_surface_detected) {
    console.log(`  Smart contract surface: YES (${fileInventory.smart_contract_files.length} .sol file(s))`)
    for (const f of fileInventory.smart_contract_files) {
      console.log(`    ${f}`)
    }
  }
  console.log()

  // ---- Step 6: Build architecture summary and run category probe ----
  console.log('[6/6] Building architecture summary and running category applicability probe...')

  const archSummary = buildArchitectureSummary(
    astResult,
    swaggerResult,
    escapeHatchFindings,
    toolCallingVerdict,
    dependencies,
    fileInventory,
  )

  const categoryVerdicts = await probeCategoryApplicability(
    archSummary,
    toolCallingVerdict,
    escapeHatchFindings,
    swaggerResult.coverageNote,
  )

  console.log(`  Category verdicts: ${categoryVerdicts.length}`)
  const presentCount = categoryVerdicts.filter(c => c.verdict === 'present').length
  const absentCount = categoryVerdicts.filter(c => c.verdict === 'absent').length
  const uncertainCount = categoryVerdicts.filter(c => c.verdict === 'uncertain').length
  console.log(`  Present: ${presentCount}, Absent: ${absentCount}, Uncertain: ${uncertainCount}`)
  console.log()

  // ---- Write output files ----
  const archSummaryPath = path.join(OUTPUT_DIR, 'architecture-summary.json')
  const catApplicPath = path.join(OUTPUT_DIR, 'category-applicability.json')

  fs.writeFileSync(archSummaryPath, JSON.stringify(archSummary, null, 2))
  console.log(`Written: ${archSummaryPath}`)

  fs.writeFileSync(catApplicPath, JSON.stringify(categoryVerdicts, null, 2))
  console.log(`Written: ${catApplicPath}`)

  console.log()
  console.log('=== Stage 0 Recon complete ===')
}

// ---------------------------------------------------------------------------
// Architecture summary builder
// ---------------------------------------------------------------------------

function buildArchitectureSummary(
  ast: ReturnType<typeof extract> | null,
  swagger: ReturnType<typeof swaggerDiff> | null,
  escapeHatch: EscapeHatchFinding[],
  toolCalling: Awaited<ReturnType<typeof detectToolCalling>> | null,
  dependencies: ReturnType<typeof extractDependencies>,
  fileInventory: FileInventoryResult,
): any {
  // Safe defaults when AST extraction was skipped
  const routes = ast?.routes ?? []
  const autoCrud = ast?.autoCrudRoutes ?? []
  const persistence = ast?.persistence ?? { orm: 'unknown', database: 'unknown', models: [], rawQueries: false, rawQueryFiles: [] }

  const handWrittenRoutes = routes
    .filter(r => r.method !== 'USE' && r.routePath !== '*')
    .map(r => ({
      method: r.method,
      path: r.routePath,
      handler: r.handler,
      auth: r.auth,
      middleware: r.middleware,
      file: r.file,
      line: r.line,
    }))

  const middlewareRoutes = routes
    .filter(r => r.method === 'USE' && r.routePath !== '*')
    .map(r => ({
      method: r.method,
      path: r.routePath,
      middleware: r.middleware,
      auth: r.auth,
      file: r.file,
      line: r.line,
    }))

  const autoCrudEntries = autoCrud.map(ac => ({
    pathPattern: ac.pathPattern,
    model: ac.model,
    excludeAttributes: ac.excludeAttributes,
    hasPagination: ac.hasPagination,
    hasCustomHooks: ac.hasCustomHooks,
  }))

  const summary = {
    route_table: {
      hand_written_routes: handWrittenRoutes,
      middleware_routes: middlewareRoutes,
      auto_crud_routes: autoCrudEntries,
      total_routes: handWrittenRoutes.length + middlewareRoutes.length,
      total_auto_crud: autoCrudEntries.length,
    },
    persistence_layer: {
      orm: persistence.orm,
      database: persistence.database,
      models: persistence.models,
      raw_queries: persistence.rawQueries,
      raw_query_files: persistence.rawQueryFiles,
      mongodb_detected: persistence.database === 'mongodb',
    },
    dependencies: {
      total: dependencies.length,
      security_relevant: dependencies
        .filter(d => isSecurityRelevantDependency(d.name))
        .map(d => ({ name: d.name, version: d.version })),
    },
    api_documentation: {
      swagger_paths: swagger?.documentedPaths ?? [],
      undocumented_surfaces: (swagger?.undocumentedSurfaces ?? []).map(u => ({
        type: u.type,
        method: u.method,
        path: u.routePath,
      })),
      coverage_note: swagger?.coverageNote ?? 'No swagger diff performed',
    },
    client_side: {
      escape_hatch_findings: escapeHatch.map(f => ({
        file: f.file,
        line: f.line,
        type: f.type,
        framework: f.framework,
      })),
      total_escape_hatch_count: escapeHatch.length,
    },
    llm_ai: {
      has_genuine_tool_calling: toolCalling?.hasGenuineToolCalling ?? false,
      tools_detected: toolCalling?.toolsDetected ?? [],
      evidence: toolCalling?.evidence ?? 'No LLM surface analyzed',
      confidence: toolCalling?.confidence ?? 0,
    },
    // NEW: File inventory signals
    file_inventory: {
      total_source_files: fileInventory.total_source_files,
      by_language: fileInventory.by_language,
      unclassified_surface: fileInventory.unclassified_surface,
      smart_contract_surface_detected: fileInventory.smart_contract_surface_detected,
      smart_contract_files: fileInventory.smart_contract_files,
    },
    // NEW: Framework detection metadata
    framework_detection: {
      express_detected: ast !== null,
      frontend_frameworks: [...new Set(escapeHatch.map(f => f.framework))],
    },
  }

  return summary
}

function isSecurityRelevantDependency(name: string): boolean {
  const securityKeywords = [
    'helmet', 'cors', 'jsonwebtoken', 'jwt', 'bcrypt', 'argon2', 'passport',
    'express-rate-limit', 'csurf', 'crypto', 'validator', 'sanitize',
    'xml', 'yaml', 'js-yaml', 'multer', 'compression',
    'sequelize', 'mongoose', 'mongo',
    'ai-sdk', 'openai', 'ai', 'langchain',
    'express-ipfilter', 'feature-policy',
  ]
  const lower = name.toLowerCase()
  return securityKeywords.some(kw => lower.includes(kw))
}

main().catch(err => {
  console.error('Stage 0 Recon failed:', err)
  process.exit(1)
})
