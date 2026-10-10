/**
 * Stage 0 Recon (v3) — main orchestrator.
 *
 * Nine steps, each writing or feeding one artifact in runPath(provider, 'stage0-recon'):
 *
 *   1. File selection (file-selection.ts)        -> file-inventory.json
 *   2. Symbol table, tree-sitter (symbols.ts)    -> symbols.json
 *   3. Framework enrichers, each optional and detected: the Express AST
 *      extractor (route table, auto-CRUD, persistence) and the frontend
 *      escape-hatch grep over the inventory's frontend-capable files
 *   4. Swagger diff, when there are routes and a swagger.yml
 *   5. Per-file signals over every inventory entry -> file-signals.json
 *   6. Repo map (repo-map.ts) -> repo-map.md, then one LLM call -> the
 *      `architecture` block (frameworks, entry points, auth mechanisms by
 *      their real names, data stores, trust boundaries)
 *   7. Auth tagging of the route table from the architecture's verified identifiers
 *   8. Tool-calling probe over the files that look like they define LLM tools
 *   9. architecture-summary.json, then the category probe ->
 *      category-applicability.json, then meta.json
 *
 * TARGET_DIR is the run context's target root (shared/run-context.ts), which
 * honours --target <path>, --target=<path> and SCANNER_TARGET and defaults to
 * target-apps/juice-shop-blind — the benchmark. Recon resolves nothing itself,
 * so every stage of a run agrees on what is being scanned.
 *
 * architecture-summary.json keeps every key it had before recon v3 with the
 * same meaning — Stage 0.5, Stage 2 and the Stage 0 scoring read them — and
 * adds recon_version, architecture, framework_detection.enrichers and
 * llm_ai.files_probed. It never carries `subsystems` or `data_models`: Stage 2
 * reads those two keys into every prompt.
 */
import * as fs from 'fs'
import * as path from 'path'

import { selectFiles, selectionOptionsFromEnv } from './file-selection.js'
import { extractSymbolTable } from './symbols.js'
import { detectExpress, extract, extractDependencies, tagRouteAuth, type RouteEntry } from './ast-extractor.js'
import { diff as swaggerDiff } from './swagger-diff.js'
import { scan as frontendGrep, detectFrontendFrameworks, escapeHatchCandidates, type EscapeHatchFinding } from './frontend-grep.js'
import {
  detectToolCalling,
  probeCategoryApplicability,
  rankToolCallingCandidates,
  summarizeArchitecture,
  TOOL_CALLING_MAX_FILES,
  type ToolCallingResult,
} from './llm-probe.js'
import { detectAllSignalsFromList, collectRouteHandlerNames } from './signal-detector.js'
import { buildRepoMap, corpusGuard, mapEligible, selectEntryPoints, selectManifests } from './repo-map.js'
import {
  FILE_INVENTORY_FILE,
  REPO_MAP_FILE,
  SYMBOLS_FILE,
  type ArchitectureInfo,
  type InventoryEntry,
} from './recon-contract.js'
import { runPath, REPO_ROOT } from '../../shared/run-paths.js'
import { resolveProvider, modelFor } from '../../shared/provider.js'
import { writeMeta, failIfDegraded } from '../../shared/meta.js'
import { getRunContext } from '../../shared/run-context.js'
import { guardStats } from '../../shared/read-guard.js'

// ---------------------------------------------------------------------------
// Target resolution: delegated to the run context (CLI arg > env var > default)
// ---------------------------------------------------------------------------

// Absolute and symlink-resolved. Stage 0.5 reads it back from file-signals.json
// and file-inventory.json, and refuses to proceed if it names a different
// target than its own context.
const TARGET_DIR = getRunContext().targetRoot
const OUTPUT_DIR = runPath(resolveProvider('stage0'), 'stage0-recon')

// Derived paths (relative to TARGET_DIR, not hardcoded absolute)
const SWAGGER_YML = path.join(TARGET_DIR, 'swagger.yml')
const PACKAGE_JSON = path.join(TARGET_DIR, 'package.json')

/** Absolute path inside TARGET_DIR -> target-relative; anything else unchanged. */
function makeRelativePath(absPath: string, targetDir: string): string {
  if (!absPath.startsWith(targetDir)) return absPath
  const rel = absPath.slice(targetDir.length)
  return rel.startsWith('/') ? rel.slice(1) : rel
}

/**
 * A path as the enrichers record it -> target-relative. In the benchmark they
 * record 'target-apps/<app>/server.ts' (the form every committed artifact
 * uses); the repo map and the architecture call speak target-relative only.
 */
function toTargetRelative(p: string): string {
  const prefix = path.relative(REPO_ROOT, TARGET_DIR).split(path.sep).join('/') + '/'
  if (p.startsWith(prefix)) return p.slice(prefix.length)
  return path.isAbsolute(p) ? makeRelativePath(p, TARGET_DIR) : p
}

function writeArtifact(file: string, data: unknown): void {
  const p = path.join(OUTPUT_DIR, file)
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  console.log(`  Written: ${p}`)
}

/** One line per framework enricher, recorded in framework_detection.enrichers. */
interface EnricherRecord {
  name: string
  detected: boolean
  reason: string
  [detail: string]: unknown
}

// ---------------------------------------------------------------------------
// file_inventory: the pre-v3 shape, computed from file-inventory.json
// ---------------------------------------------------------------------------

interface FileInventorySummary {
  total_source_files: number
  by_language: Record<string, { count: number; sample_paths: string[] }>
  unclassified_surface: { language: string; count: number; files: string[]; total_bytes: number }[]
  smart_contract_surface_detected: boolean
  smart_contract_files: string[]
}

/**
 * The `file_inventory` block, from the inventory. Every inventoried file is
 * counted — test, oversize and empty included — so total_source_files equals
 * the number of lanes Stage 0.5 assigns.
 *
 * @param alreadyClassified paths claimed by a framework-specific pass; they are
 *                          left out of unclassified_surface
 */
function summarizeInventory(entries: readonly InventoryEntry[], alreadyClassified: Set<string>): FileInventorySummary {
  const byLanguage: Record<string, InventoryEntry[]> = {}
  const unclassifiedByLanguage: Record<string, InventoryEntry[]> = {}
  for (const f of entries) {
    ;(byLanguage[f.language] ??= []).push(f)
    if (!alreadyClassified.has(f.path)) (unclassifiedByLanguage[f.language] ??= []).push(f)
  }

  const byLangOutput: Record<string, { count: number; sample_paths: string[] }> = {}
  for (const [lang, files] of Object.entries(byLanguage)) {
    byLangOutput[lang] = { count: files.length, sample_paths: files.slice(0, 5).map(f => f.path) }
  }

  const unclassifiedOutput = Object.entries(unclassifiedByLanguage).map(([language, files]) => ({
    language,
    count: files.length,
    files: files.map(f => f.path).sort(),
    total_bytes: files.reduce((sum, f) => sum + f.bytes, 0),
  }))

  const smartContractFiles = entries.filter(f => f.language === 'solidity').map(f => f.path).sort()
  return {
    total_source_files: entries.length,
    by_language: byLangOutput,
    unclassified_surface: unclassifiedOutput.sort((a, b) => b.count - a.count),
    smart_contract_surface_detected: smartContractFiles.length > 0,
    smart_contract_files: smartContractFiles,
  }
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

type AstResult = ReturnType<typeof extract>

/**
 * The route_table block. '*' registrations (global middleware) are left out
 * and USE registrations are kept apart from handlers, exactly as before recon
 * v3: route handler names for signals and Stage 2's route context both come
 * from this table, and both must see the routes they saw before.
 */
function buildRouteTable(routes: readonly RouteEntry[], ast: AstResult | null) {
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

  const autoCrudEntries = (ast?.autoCrudRoutes ?? []).map(ac => ({
    pathPattern: ac.pathPattern,
    model: ac.model,
    excludeAttributes: ac.excludeAttributes,
    hasPagination: ac.hasPagination,
    hasCustomHooks: ac.hasCustomHooks,
  }))

  return {
    hand_written_routes: handWrittenRoutes,
    middleware_routes: middlewareRoutes,
    auto_crud_routes: autoCrudEntries,
    total_routes: handWrittenRoutes.length + middlewareRoutes.length,
    total_auto_crud: autoCrudEntries.length,
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Stage 0: Recon (v3) ===')
  console.log(`Target: ${TARGET_DIR}`)
  console.log()

  const provider = resolveProvider('stage0')
  const started = new Date().toISOString()

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Validate target directory exists
  if (!fs.existsSync(TARGET_DIR)) {
    console.error(`ERROR: Target directory does not exist: ${TARGET_DIR}`)
    console.error('Use --target=<path> or set SCANNER_TARGET env var.')
    process.exit(1)
  }

  const guard = corpusGuard(TARGET_DIR)

  // Files claimed by a framework-specific pass, left out of
  // file_inventory.unclassified_surface. Each pass adds paths in the form it
  // records them, as before recon v3 — so in the benchmark the route-table and
  // escape-hatch paths are repo-relative and claim nothing, and the block keeps
  // the content it has always had.
  const classifiedFiles = new Set<string>()

  // ---- Step 1: File selection ----
  console.log('[1/9] Selecting files...')
  const inventory = selectFiles(TARGET_DIR, selectionOptionsFromEnv())
  const t = inventory.totals
  console.log(`  Inventoried: ${t.inventoried} (test: ${t.test}, oversize: ${t.oversize}, empty: ${t.empty})`)
  console.log(`  Excluded: ${t.excluded_files} file(s), ${t.excluded_dirs} director(ies)` +
    (inventory.excluded.length > 0
      ? ` — ${inventory.excluded.map(g => `${g.reason}: ${g.files.length + g.dirs.length}`).join(', ')}`
      : ''))
  console.log(`  Unsupported (no language): ${inventory.unsupported.count}`)
  if (inventory.ignore_files.length > 0) console.log(`  Ignore files honoured: ${inventory.ignore_files.join(', ')}`)
  writeArtifact(FILE_INVENTORY_FILE, inventory)
  console.log()

  const files = inventory.files
  const byPath = new Map(files.map(f => [f.path, f]))

  // ---- Step 2: Symbol table ----
  console.log('[2/9] Extracting symbols (tree-sitter)...')
  const symbols = await extractSymbolTable(TARGET_DIR, files)
  const parsedCount = Object.keys(symbols.files).length
  console.log(`  Parsed: ${parsedCount} file(s) — ${Object.entries(symbols.languages).map(([l, n]) => `${l} ${n}`).join(', ') || 'none'}`)
  if (Object.keys(symbols.skipped).length > 0) {
    console.log(`  Not parsed: ${Object.entries(symbols.skipped).map(([r, n]) => `${r} ${n}`).join(', ')}`)
  }
  writeArtifact(SYMBOLS_FILE, symbols)
  console.log()

  // ---- Step 3: Framework enrichers ----
  console.log('[3/9] Framework enrichers...')
  const enrichers: EnricherRecord[] = []

  // Express: an entry file the inventory selected (not ignored, not a test).
  const expressResult = detectExpress(TARGET_DIR, rel => byPath.get(rel)?.test === false)
  let astResult: AstResult | null = null
  let dependencies: ReturnType<typeof extractDependencies> = []

  console.log(`  Express: ${expressResult.isExpress} (${expressResult.reason})`)
  if (expressResult.isExpress && expressResult.entryFile) {
    astResult = extract(expressResult.entryFile)
    dependencies = extractDependencies(PACKAGE_JSON)
    astResult.dependencies = dependencies
    const entryRel = makeRelativePath(expressResult.entryFile, TARGET_DIR)
    console.log(`    Route receivers: ${astResult.receivers.join(', ')}`)
    console.log(`    Found ${astResult.routes.length} route registrations`)
    console.log(`    Found ${astResult.autoCrudRoutes.length} auto-CRUD resources`)
    console.log(`    Persistence: ${astResult.persistence.orm} / ${astResult.persistence.database}`)
    console.log(`    Models: ${astResult.persistence.models.join(', ')}`)
    enrichers.push({
      name: 'express',
      detected: true,
      reason: expressResult.reason,
      entry_file: entryRel,
      receivers: astResult.receivers,
      routes: astResult.routes.length,
      auto_crud_routes: astResult.autoCrudRoutes.length,
    })

    classifiedFiles.add(entryRel)
    for (const route of astResult.routes) {
      if (route.file) classifiedFiles.add(route.file)
    }
    for (const rawFile of astResult.persistence.rawQueryFiles) {
      classifiedFiles.add(rawFile)
    }
  } else {
    enrichers.push({ name: 'express', detected: false, reason: expressResult.reason })
    // Try to get dependencies anyway for the architecture summary
    try {
      dependencies = extractDependencies(PACKAGE_JSON)
    } catch {
      console.log('    (Could not read package.json either)')
    }
  }

  // Frontend escape hatches: every non-test inventory file with a
  // frontend-capable extension that the read guard allows — its lines and
  // line numbers reach the category prompt.
  const frontendFrameworks = detectFrontendFrameworks(TARGET_DIR)
  const grepFiles = escapeHatchCandidates(files).filter(p => guard.isReadable(p))
  let escapeHatchFindings: EscapeHatchFinding[] = []
  console.log(`  Frontend frameworks: ${frontendFrameworks.length > 0 ? frontendFrameworks.join(', ') : 'none detected'}`)
  if (frontendFrameworks.length > 0 && grepFiles.length > 0) {
    escapeHatchFindings = frontendGrep(TARGET_DIR, grepFiles, frontendFrameworks)
    console.log(`    Scanned ${grepFiles.length} file(s) for escape-hatch APIs: ${escapeHatchFindings.length} occurrence(s)`)
    const byFile = new Map<string, number>()
    for (const f of escapeHatchFindings) byFile.set(f.file, (byFile.get(f.file) || 0) + 1)
    for (const [file, count] of byFile) {
      console.log(`      ${file}: ${count} occurrence(s)`)
      classifiedFiles.add(file)
    }
    enrichers.push({
      name: 'frontend-escape-hatch',
      detected: true,
      reason: `frameworks detected: ${frontendFrameworks.join(', ')}`,
      frameworks: frontendFrameworks,
      files_scanned: grepFiles.length,
      findings: escapeHatchFindings.length,
    })
  } else {
    const reason = frontendFrameworks.length === 0
      ? 'no frontend frameworks detected'
      : 'no non-test .ts/.tsx/.js/.jsx/.mjs/.html/.vue files in the inventory'
    console.log(`    SKIPPED: escape-hatch grep (${reason})`)
    enrichers.push({ name: 'frontend-escape-hatch', detected: false, reason, frameworks: frontendFrameworks })
  }
  console.log()

  // ---- Step 4: Swagger diff (only meaningful with AST routes) ----
  let swaggerResult: ReturnType<typeof swaggerDiff>
  if (astResult && fs.existsSync(SWAGGER_YML)) {
    console.log('[4/9] Diffing routes against swagger.yml...')
    swaggerResult = swaggerDiff(SWAGGER_YML, astResult.routes, astResult.autoCrudRoutes)
    console.log(`  Documented paths: ${swaggerResult.documentedPaths.length}`)
    console.log(`  Undocumented surfaces: ${swaggerResult.undocumentedSurfaces.length}`)
    console.log(`  Coverage: ${swaggerResult.coverageNote}`)
  } else {
    console.log('[4/9] SKIPPED: Swagger diff (no AST routes or no swagger.yml)')
    swaggerResult = { documentedPaths: [], undocumentedSurfaces: [], coverageNote: 'No routes extracted or swagger.yml not found' }
  }
  console.log()

  // ---- Step 5: Per-file signals (deterministic, no LLM) ----
  console.log('[5/9] Extracting per-file signals...')
  // Auth is still null here; route handler names depend only on handler and
  // middleware text, so they are the names the tagged table would give too.
  const untaggedTable = buildRouteTable(astResult?.routes ?? [], astResult)
  const rhNames = collectRouteHandlerNames(untaggedTable)
  console.log(`  Route handler names from route table: ${rhNames.size}`)
  const fileSignals = detectAllSignalsFromList(TARGET_DIR, files, rhNames, symbols)
  const signalCounts = Object.values(fileSignals.files).map(s => s.length)
  const signalDist: Record<number, number> = {}
  for (const n of signalCounts) signalDist[n] = (signalDist[n] || 0) + 1
  console.log(`  ${Object.keys(fileSignals.files).length} files scanned (inventory total: ${files.length})`)
  console.log(`  Signal distribution (signals-per-file): ${JSON.stringify(signalDist)}`)
  writeArtifact('file-signals.json', fileSignals)
  console.log()

  // ---- Step 6: Repo map and architecture call ----
  console.log('[6/9] Building repo map and summarizing architecture...')
  const expressEntryRel = astResult && expressResult.entryFile ? makeRelativePath(expressResult.entryFile, TARGET_DIR) : null
  const entryPoints = selectEntryPoints(files, symbols, expressEntryRel, guard)
  const mapRoutes = (astResult?.routes ?? [])
    .filter(r => r.routePath !== '*')
    .map(r => ({ method: r.method, path: r.routePath, middleware: r.middleware, file: toTargetRelative(r.file) }))
  const mapAutoCrud = (astResult?.autoCrudRoutes ?? [])
    .map(a => ({ pathPattern: a.pathPattern, model: a.model, file: toTargetRelative(a.file) }))
  const repoMap = buildRepoMap({
    targetDir: TARGET_DIR,
    inventory: files,
    symbols,
    signals: fileSignals.files,
    routes: mapRoutes,
    autoCrud: mapAutoCrud,
    routeSource: astResult ? 'Express enricher' : undefined,
    entryPoints,
    guard,
  })
  console.log(`  Repo map: ${repoMap.text.length} chars — ${repoMap.sections.map(s => `${s.name} ${s.chars}${s.omitted ? ` (${s.omitted} omitted)` : ''}`).join(', ')}`)
  console.log(`  Entry points: ${entryPoints.map(e => e.path).join(', ') || 'none'}`)
  writeArtifact(REPO_MAP_FILE, repoMap.text)

  const eligible = mapEligible(files, guard)
  const symbolNames = new Set<string>()
  for (const f of Object.values(symbols.files)) for (const s of f.symbols) symbolNames.add(s.name)
  const routeText = [...untaggedTable.hand_written_routes, ...untaggedTable.middleware_routes]
    .flatMap(r => [('handler' in r ? r.handler : null) ?? '', ...r.middleware])
    .join('\n')
  const languageCounts: Record<string, number> = {}
  for (const f of eligible) languageCounts[f.language] = (languageCounts[f.language] ?? 0) + 1
  const manifests = selectManifests(files, guard)
    .map(p => ({ path: p, content: guard.read(p) }))
    .filter((m): m is { path: string; content: string } => m.content !== null)

  const architecture: ArchitectureInfo = await summarizeArchitecture(
    repoMap.text,
    { inventoryPaths: new Set(files.map(f => f.path)), symbolNames, routeText, targetDir: TARGET_DIR },
    {
      manifests,
      symbols,
      eligiblePaths: new Set(eligible.map(f => f.path)),
      entryPoints,
      languages: languageCounts,
      fileCount: eligible.length,
      routeCount: untaggedTable.total_routes,
      routeSource: astResult ? 'Express enricher' : null,
    },
  )
  console.log(`  Architecture (${architecture.source}): ${architecture.frameworks.length} framework(s), ` +
    `${architecture.entry_points.length} entry point(s), ${architecture.auth_mechanisms.length} auth mechanism(s), ` +
    `${architecture.data_stores.length} data store(s), ${architecture.trust_boundaries.length} trust boundar(ies)`)
  if (architecture.dropped.length > 0) console.log(`  Dropped by validation: ${architecture.dropped.length} value(s)`)
  console.log()

  // ---- Step 7: Auth tagging ----
  console.log('[7/9] Tagging route auth from verified auth identifiers...')
  const authIdentifiers = [...new Set(architecture.auth_mechanisms.flatMap(m => m.verified_identifiers))]
  const taggedRoutes = tagRouteAuth(astResult?.routes ?? [], authIdentifiers)
  const routeTable = buildRouteTable(taggedRoutes, astResult)
  const tableRoutes = [...routeTable.hand_written_routes, ...routeTable.middleware_routes]
  console.log(`  Identifiers: ${authIdentifiers.join(', ') || 'none'}`)
  console.log(`  ${tableRoutes.filter(r => r.auth).length} of ${tableRoutes.length} route-table entries carry auth middleware`)
  console.log()

  // ---- Step 8: Tool-calling probe ----
  console.log('[8/9] Tool-calling probe...')
  const candidates = rankToolCallingCandidates(files, fileSignals.files, rel => (guard.isReadable(rel) ? guard.read(rel) : null))
  for (const c of candidates.slice(0, TOOL_CALLING_MAX_FILES)) {
    console.log(`  Candidate: ${c.path} (score ${c.score}: ${c.indicators.join(', ')})`)
  }
  if (candidates.length > TOOL_CALLING_MAX_FILES) console.log(`  (${candidates.length - TOOL_CALLING_MAX_FILES} lower-ranked candidate(s) not probed)`)
  const toolCallingVerdict: ToolCallingResult = await detectToolCalling(TARGET_DIR, candidates)
  console.log(`  Files probed: ${toolCallingVerdict.filesProbed.join(', ') || 'none'}`)
  console.log(`  Genuine tool-calling: ${toolCallingVerdict.hasGenuineToolCalling}`)
  console.log(`  Tools detected: ${toolCallingVerdict.toolsDetected.join(', ') || 'none'}`)
  console.log(`  Confidence: ${toolCallingVerdict.confidence}`)
  console.log(`  Evidence: ${toolCallingVerdict.evidence}`)
  for (const f of toolCallingVerdict.filesWithToolCalling) classifiedFiles.add(f)
  console.log()

  // ---- Step 9: Architecture summary and category probe ----
  console.log('[9/9] Building architecture summary and running category applicability probe...')
  const fileInventory = summarizeInventory(files, classifiedFiles)
  console.log(`  Total source files: ${fileInventory.total_source_files}`)
  for (const [lang, info] of Object.entries(fileInventory.by_language).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${lang}: ${info.count} file(s)`)
  }
  console.log(`  Unclassified surface: ${fileInventory.unclassified_surface.reduce((sum, u) => sum + u.count, 0)} file(s) across ${fileInventory.unclassified_surface.length} language(s)`)
  if (fileInventory.smart_contract_surface_detected) {
    console.log(`  Smart contract surface: YES (${fileInventory.smart_contract_files.length} .sol file(s))`)
    for (const f of fileInventory.smart_contract_files) console.log(`    ${f}`)
  }

  const archSummary = buildArchitectureSummary(
    routeTable,
    astResult,
    swaggerResult,
    escapeHatchFindings,
    toolCallingVerdict,
    dependencies,
    fileInventory,
    enrichers,
    architecture,
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

  writeArtifact('architecture-summary.json', archSummary)
  writeArtifact('category-applicability.json', categoryVerdicts)
  writeMeta(provider, 'stage0-recon', modelFor(provider), started, 0, guardStats().blocked)
  failIfDegraded('stage0', 'stage0-recon')

  console.log()
  console.log('=== Stage 0 Recon complete ===')
}

// ---------------------------------------------------------------------------
// Architecture summary builder
// ---------------------------------------------------------------------------

function buildArchitectureSummary(
  routeTable: ReturnType<typeof buildRouteTable>,
  ast: AstResult | null,
  swagger: ReturnType<typeof swaggerDiff> | null,
  escapeHatch: EscapeHatchFinding[],
  toolCalling: ToolCallingResult,
  dependencies: ReturnType<typeof extractDependencies>,
  fileInventory: FileInventorySummary,
  enrichers: EnricherRecord[],
  architecture: ArchitectureInfo,
): Record<string, any> {
  // Safe default when the Express enricher did not run
  const persistence = ast?.persistence ?? { orm: 'unknown', database: 'unknown', models: [], rawQueries: false, rawQueryFiles: [] }

  return {
    recon_version: 3,
    route_table: routeTable,
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
      has_genuine_tool_calling: toolCalling.hasGenuineToolCalling,
      tools_detected: toolCalling.toolsDetected,
      evidence: toolCalling.evidence,
      confidence: toolCalling.confidence,
      files_probed: toolCalling.filesProbed,
    },
    file_inventory: fileInventory,
    framework_detection: {
      express_detected: ast !== null,
      frontend_frameworks: [...new Set(escapeHatch.map(f => f.framework))],
      enrichers,
    },
    architecture,
  }
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
