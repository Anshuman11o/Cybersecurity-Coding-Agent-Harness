/**
 * Stage 0.5 v3 — Per-File Lane Selector (signal-based class narrowing)
 *
 * One lane per file from the Stage 0 file inventory.
 * Deterministic: no LLM calls. Classes derived from per-file signals
 * detected by Stage 0, via a lookup table — no inference.
 *
 * Provider-scoped: reads Stage 0's artifacts for the resolved provider and
 * writes its own under the same provider, so a run under one model can never
 * consume or overwrite another's evidence. This stage makes no LLM call, but it
 * still carries the provider — its input did.
 *
 * Input:
 *   - runs/<provider>/stage0-recon/file-inventory.json  (the file list; also: target_dir)
 *   - runs/<provider>/stage0-recon/architecture-summary.json
 *   - runs/<provider>/stage0-recon/category-applicability.json
 *   - runs/<provider>/stage0-recon/file-signals.json   (also: target_dir)
 *   - tools/scanner/shared/signal-classes.json
 *   - tools/scanner/shared/vuln-classes.json
 *   - runs/<provider>/stage-playbook-agent/class-selection.json  (optional; "agent mode")
 * Output:
 *   - runs/<provider>/stage05-lane-selector-perfile/lane-assignments.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidConfigSignals } from './android-config.js'
import { runPath, REPO_ROOT, type Provider } from '../../shared/run-paths.js'
import { resolveProvider } from '../../shared/provider.js'
import { writeMeta, assertUpstream } from '../../shared/meta.js'
import { activeDenylist, guardStats } from '../../shared/read-guard.js'
import { getRunContext } from '../../shared/run-context.js'
import { mergeClassTables, readClassesOverlay, readClassSelection } from '../../shared/playbook-overlay.js'
// Relative across packages: the contract has no runtime dependencies, so this
// does not pull Stage 0's parsers into Stage 0.5.
import {
  FILE_INVENTORY_FILE, MANIFEST_LANGUAGE, type FileInventoryArtifact,
} from '../../stage0-recon/src/recon-contract.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROVIDER: Provider = resolveProvider('stage05perfile')
const STARTED = new Date().toISOString()

// ---------------------------------------------------------------------------
// Exported constants (not magic numbers)
// ---------------------------------------------------------------------------

/** Maximum lines a file can have and still fit in a single analysis pass. */
export const SINGLE_PASS_LINE_BUDGET = 2000

/** Overlap between consecutive chunks when chunking is required. */
export const CHUNK_OVERLAP = 20

// ---------------------------------------------------------------------------
// Language classification — generic, not repository-specific
// ---------------------------------------------------------------------------

const EXECUTABLE_LANGUAGES = new Set([
  'typescript', 'javascript', 'python', 'ruby', 'java', 'go',
  'rust', 'c', 'cpp', 'csharp', 'php', 'kotlin', 'swift',
  'scala', 'solidity', 'dart', 'r', 'perl', 'lua', 'shell',
  'docker', 'graphql',
  // Declarative infrastructure has security effects; key files can embed secrets.
  // Both are huntable, so neither belongs in NON_EXECUTABLE_LANGUAGES/SKIP_REASONS.
  'terraform', 'key-material',
])

const NON_EXECUTABLE_LANGUAGES = new Set([
  'json', 'yaml', 'html', 'css', 'toml', 'sql',
  'protobuf', 'xml', 'ini', 'properties', MANIFEST_LANGUAGE,
])

const SKIP_REASONS: Record<string, string> = {
  json: 'Pure data/config file — no executable logic or independent entrypoint-to-sink path',
  yaml: 'Declarative config/CI file — no executable logic',
  html: 'Markup template — no independently executable logic without a render context',
  css: 'Styling file — no executable logic',
  toml: 'Declarative config file — no executable logic',
  sql: 'Declarative query/schema file — not an independent executable entrypoint',
  protobuf: 'Schema definition — no executable logic',
  xml: 'XML outside platform manifests and res/xml configuration — requires a consuming execution or render context',
  ini: 'Declarative config file — no executable logic',
  properties: 'Declarative config file — no executable logic',
  [MANIFEST_LANGUAGE]: 'Dependency manifest — declarative; dependency risk is not judged per file',
}

// Inventory flags (file-inventory.json). Checked before language, after the
// denylist: the file is in the inventory, so it gets a lane and a stated reason.
const EMPTY_SKIP_REASON = 'Empty file — nothing to scan'
const TEST_SKIP_REASON = 'Test file — skipped by default'
function oversizeSkipReason(bytes: number, cap: number): string {
  return 'Exceeds the per-file byte cap (' + bytes + ' > ' + cap + ' bytes)'
}

function getSkipReason(language: string): string {
  return SKIP_REASONS[language.toLowerCase()] ??
    'Declarative file in language "' + language + '" — no executable logic'
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface CategoryVerdict {
  name: string
  framework: string
  verdict: 'present' | 'absent' | 'uncertain'
  evidence: string
  confidence: number
}

interface CategoryEntry {
  code: string
  name: string
  framework: string
}

interface FileInventory {
  total_source_files: number
  by_language: Record<string, { count: number; sample_paths: string[] }>
  unclassified_surface: {
    language: string
    count: number
    files: string[]
    total_bytes?: number
  }[]
  smart_contract_surface_detected: boolean
  smart_contract_files: string[]
}

interface ArchitectureSummary {
  route_table: {
    hand_written_routes: { method: string; path: string; handler?: string | null; auth?: string | null; middleware?: string[]; file?: string; line?: number }[]
    middleware_routes: { method: string; path: string; handler?: string | null; auth?: string | null; middleware?: string[]; file?: string; line?: number }[]
    auto_crud_routes: { pathPattern: string; model: string }[]
  }
  persistence_layer: {
    orm: string
    raw_queries: boolean
    raw_query_files: string[]
    mongodb_detected: boolean
    models?: string[]
  }
  client_side: {
    escape_hatch_findings: { file: string; line: number; type: string }[]
  }
  file_inventory: FileInventory
  [key: string]: unknown
}

interface FileSignals {
  generated_at: string
  target_dir?: string
  files: Record<string, string[]>
}

interface SignalClassMap {
  floor: string[]
  signals: Record<string, string[]>
}

interface Lane {
  lane_id: string
  target_file: string
  disposition: 'hunt' | 'skip'
  skip_reason: string | null
  signals: string[]        // NEW: per-file signals from Stage 0
  classes: string[]        // NEW: narrowed class ids (union of signal classes + floor)
  class_basis: Record<string, string[]>  // NEW: which signal contributed which classes
  categories: CategoryEntry[]  // ALL 26, unchanged
  file_bytes: number
  file_lines: number
  estimated_prompt_tokens: number
  chunk_plan: {
    required: boolean
    total_chunks: number
    chunks: { index: number; start_line: number; end_line: number }[]
  }
}

interface CoverageLedger {
  total_files_in_inventory: number
  assigned_hunt: number
  assigned_skip: number
  unaccounted: number
}

interface LaneAssignments {
  generated_at: string
  target_dir: string
  source_stage0_run: string
  coverage_ledger: CoverageLedger
  category_universe: CategoryEntry[]
  signal_class_map: string
  floor_classes: string[]
  /** Present only when the playbook agent selected the run's classes. */
  class_selection?: { source: 'playbook-agent'; classes: string[]; unrouted: string[] }
  lanes: Lane[]
}

const NO_SELECTED_CLASS_REASON = 'No selected class applies to this file'

// ---------------------------------------------------------------------------
// Framework name expansion
// ---------------------------------------------------------------------------

function expandFramework(fw: string): string {
  switch (fw.toLowerCase().trim()) {
    case 'owasp': return 'OWASP Top 10 2021'
    case 'api security': return 'API Security Top 10'
    case 'llm': return 'LLM Top 10'
    default: return fw
  }
}

// ---------------------------------------------------------------------------
// Build the category universe from recon verdicts
// ---------------------------------------------------------------------------

function buildCategoryUniverse(verdicts: CategoryVerdict[]): CategoryEntry[] {
  const universe: CategoryEntry[] = []
  for (const v of verdicts) {
    if (v.verdict === 'present' || v.verdict === 'uncertain') {
      universe.push({
        code: extractCategoryCode(v.name),
        name: v.name,
        framework: expandFramework(v.framework),
      })
    }
  }
  return universe
}

function extractCategoryCode(categoryName: string): string {
  const m = categoryName.match(/^([A-Za-z0-9]+):/)
  return m ? m[1] : categoryName.trim()
}

// ---------------------------------------------------------------------------
// Build a lookup: category code -> CategoryEntry
// ---------------------------------------------------------------------------

function buildCategoryLookup(universe: CategoryEntry[]): Map<string, CategoryEntry> {
  const map = new Map<string, CategoryEntry>()
  for (const entry of universe) {
    map.set(entry.code, entry)
  }
  return map
}

// ---------------------------------------------------------------------------
// File metric measurement
// ---------------------------------------------------------------------------

interface FileMetrics {
  bytes: number
  lines: number
}

function measureFile(absolutePath: string): FileMetrics {
  try {
    const content = fs.readFileSync(absolutePath, 'utf-8')
    const bytes = Buffer.byteLength(content, 'utf-8')
    const lines = content.split('\n').length
    return { bytes, lines }
  } catch {
    return { bytes: 0, lines: 0 }
  }
}

function estimatePromptTokens(fileBytes: number): number {
  return Math.ceil(fileBytes / 4)
}

/** Symlink-resolved absolute path; a path that does not exist is just resolved. */
function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

// ---------------------------------------------------------------------------
// Chunk plan generation with tiling assertions
// ---------------------------------------------------------------------------

interface ChunkPlanResult {
  required: boolean
  total_chunks: number
  chunks: { index: number; start_line: number; end_line: number }[]
}

function generateChunkPlan(fileLines: number): ChunkPlanResult {
  if (fileLines <= 0) {
    return {
      required: false,
      total_chunks: 1,
      chunks: [{ index: 1, start_line: 0, end_line: 0 }],
    }
  }

  if (fileLines <= SINGLE_PASS_LINE_BUDGET) {
    return {
      required: false,
      total_chunks: 1,
      chunks: [{ index: 1, start_line: 1, end_line: fileLines }],
    }
  }

  const chunks: { index: number; start_line: number; end_line: number }[] = []
  let currentStart = 1
  let chunkIndex = 1

  while (currentStart <= fileLines) {
    let endLine = Math.min(currentStart + SINGLE_PASS_LINE_BUDGET - 1, fileLines)

    if (endLine < fileLines) {
      endLine = Math.min(currentStart + SINGLE_PASS_LINE_BUDGET - 1, fileLines)
    }

    chunks.push({ index: chunkIndex, start_line: currentStart, end_line: endLine })

    if (endLine >= fileLines) break

    currentStart = endLine - CHUNK_OVERLAP + 1
    chunkIndex++

    if (chunkIndex > fileLines * 2) {
      throw new Error('Chunk generation safety limit exceeded for file with ' + fileLines + ' lines')
    }
  }

  if (chunks.length === 0) {
    throw new Error('Tiling assertion failed: no chunks generated')
  }
  if (fileLines > 0) {
    if (chunks[0].start_line !== 1) {
      throw new Error('Tiling assertion failed: first chunk start_line=' + chunks[0].start_line + ', expected 1')
    }
    if (chunks[chunks.length - 1].end_line !== fileLines) {
      throw new Error('Tiling assertion failed: last chunk end_line=' + chunks[chunks.length - 1].end_line + ', expected ' + fileLines)
    }
  }
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = chunks[i - 1].end_line
    const currStart = chunks[i].start_line
    if (currStart > prevEnd + 1) {
      throw new Error('Tiling assertion failed: gap between chunk ' + i + ' (ends ' + prevEnd + ') and chunk ' + (i + 1) + ' (starts ' + currStart + ')')
    }
    const overlap = prevEnd - currStart + 1
    if (overlap < 1) {
      throw new Error('Tiling assertion failed: no overlap between consecutive chunks')
    }
  }

  return {
    required: true,
    total_chunks: chunks.length,
    chunks,
  }
}

// ---------------------------------------------------------------------------
// Class narrowing via signal lookup
// ---------------------------------------------------------------------------

function computeClasses(
  signals: string[],
  signalClassMap: SignalClassMap,
  allClassIds: Set<string>,
): { classes: string[]; class_basis: Record<string, string[]> } {
  const classBasis: Record<string, string[]> = {}

  // Floor classes apply to every lane
  classBasis['floor'] = [...signalClassMap.floor]

  // Union of classes from each signal
  const classSet = new Set<string>(signalClassMap.floor)
  for (const signal of signals) {
    const classes = signalClassMap.signals[signal]
    if (classes) {
      classBasis[signal] = [...classes]
      for (const c of classes) classSet.add(c)
    }
  }

  // Validate: every referenced class must exist in vuln-classes.json
  for (const c of classSet) {
    if (!allClassIds.has(c)) {
      throw new Error(`Class "${c}" referenced by signal lookup not found in vuln-classes.json`)
    }
  }

  const classes = [...classSet].sort()
  return { classes, class_basis: classBasis }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectRoot = REPO_ROOT
  const stage0OutputDir = runPath(PROVIDER, 'stage0-recon')
  const outputDir = runPath(PROVIDER, 'stage05-lane-selector-perfile')
  const sharedDir = path.join(projectRoot, 'tools/scanner/shared')

  // -----------------------------------------------------------------------
  // Load Stage 0 outputs
  // -----------------------------------------------------------------------
  console.log(`[Stage 0.5 v3] [PROVIDER] ${PROVIDER}`)
  assertUpstream(PROVIDER, 'stage0-recon')
  console.log('[Stage 0.5 v3] Loading Stage 0 outputs...')

  const archPath = path.join(stage0OutputDir, 'architecture-summary.json')
  const arch: ArchitectureSummary = JSON.parse(fs.readFileSync(archPath, 'utf-8'))
  console.log('[Stage 0.5 v3] Loaded architecture summary')

  const catPath = path.join(stage0OutputDir, 'category-applicability.json')
  const verdicts: CategoryVerdict[] = JSON.parse(fs.readFileSync(catPath, 'utf-8'))
  console.log('[Stage 0.5 v3] Loaded category applicability')

  const signalsPath = path.join(stage0OutputDir, 'file-signals.json')
  const fileSignals: FileSignals = JSON.parse(fs.readFileSync(signalsPath, 'utf-8'))
  console.log('[Stage 0.5 v3] Loaded file signals: ' + Object.keys(fileSignals.files).length + ' files')

  // The only file list this stage reads. It used to rebuild one from
  // architecture-summary.json plus a directory walk of its own, with its own
  // exclusion list and extension table, which had drifted from Stage 0's.
  const inventoryPath = path.join(stage0OutputDir, FILE_INVENTORY_FILE)
  if (!fs.existsSync(inventoryPath)) {
    console.error('[FATAL] ' + inventoryPath + ' not found.')
    console.error('  This Stage 0 output predates recon v3, which writes the file inventory. Re-run Stage 0.')
    process.exit(1)
  }
  const inventory: FileInventoryArtifact = JSON.parse(fs.readFileSync(inventoryPath, 'utf-8'))
  console.log('[Stage 0.5 v3] Loaded file inventory: ' + inventory.files.length + ' files (' +
    inventory.totals.test + ' test, ' + inventory.totals.oversize + ' oversize, ' + inventory.totals.empty + ' empty; ' +
    inventory.totals.excluded_files + ' files and ' + inventory.totals.excluded_dirs + ' directories excluded)')

  // -----------------------------------------------------------------------
  // Load signal→class mapping and validate
  // -----------------------------------------------------------------------
  const signalClassMapPath = path.join(sharedDir, 'signal-classes.json')
  let signalClassMap: SignalClassMap = JSON.parse(fs.readFileSync(signalClassMapPath, 'utf-8'))
  console.log('[Stage 0.5 v3] Loaded signal→class map: ' + Object.keys(signalClassMap.signals).length + ' signals, ' + signalClassMap.floor.length + ' floor classes')

  const vulnClassesPath = path.join(sharedDir, 'vuln-classes.json')
  const vulnClassesRaw = fs.readFileSync(vulnClassesPath, 'utf-8')
  const merged = mergeClassTables(JSON.parse(vulnClassesRaw), signalClassMap, readClassesOverlay(PROVIDER))
  const vulnClasses = merged.registry
  signalClassMap = merged.signalMap
  const allClassIds = new Set<string>(Object.keys(vulnClasses))

  // Agent mode: the playbook agent chose the complete class set. No floor, and
  // signals route only selected classes. Without a selection nothing changes.
  const selection = readClassSelection(PROVIDER)
  if (selection) {
    const selected = new Set(selection.classes)
    signalClassMap = {
      ...signalClassMap, floor: [],
      signals: Object.fromEntries(Object.entries(signalClassMap.signals).map(([s, ids]) => [s, ids.filter(c => selected.has(c))])),
    }
    console.log('[Stage 0.5 v3] Agent class selection: ' + selection.classes.length + ' classes (' +
      selection.builtin.length + ' built-in, ' + selection.added.length + ' additional); no floor')
  }

  // Validate: every class in signal-classes.json must exist in vuln-classes.json
  const allReferencedClasses = new Set<string>(signalClassMap.floor)
  for (const [, classes] of Object.entries(signalClassMap.signals)) {
    for (const c of classes) allReferencedClasses.add(c)
  }
  for (const c of allReferencedClasses) {
    if (!allClassIds.has(c)) {
      console.error(`[FATAL] Class "${c}" in signal-classes.json not found in vuln-classes.json`)
      process.exit(1)
    }
  }
  console.log('[Stage 0.5 v3] All ' + allReferencedClasses.size + ' referenced classes validated against vuln-classes.json')

  // -----------------------------------------------------------------------
  // Determine target directory
  // -----------------------------------------------------------------------
  // Stage 0 records the target it inventoried, and every path in its artifacts
  // is relative to that. Inferring it from a route file (as this stage once
  // did) only worked for a target under the repo, and fell back to
  // juice-shop-blind otherwise — silently measuring a different codebase.
  // file-inventory.json always records it; both artifacts must agree with this
  // run's context.
  const contextTarget = getRunContext().targetRoot
  function assertSameTarget(artifact: string, recorded: string): void {
    if (canonicalPath(recorded) !== canonicalPath(contextTarget)) {
      console.error('[FATAL] Stage 0 artifacts were produced for a different target.')
      console.error('  ' + artifact + ' target_dir: ' + recorded)
      console.error('  this run\'s target: ' + contextTarget)
      console.error('  Re-run Stage 0 for this target, or point SCANNER_TARGET at the one Stage 0 scanned.')
      process.exit(1)
    }
  }
  assertSameTarget(FILE_INVENTORY_FILE, inventory.target_dir)
  const targetDir = inventory.target_dir
  if (fileSignals.target_dir) {
    assertSameTarget('file-signals.json', fileSignals.target_dir)
  } else {
    console.warn('[Stage 0.5 v3] file-signals.json has no target_dir — trusting file-inventory.json\'s')
  }
  console.log('[Stage 0.5 v3] Target directory: ' + targetDir)

  // -----------------------------------------------------------------------
  // Build category universe (ALL 26 codes — unchanged)
  // -----------------------------------------------------------------------
  const categoryUniverse = buildCategoryUniverse(verdicts)
  const categoryLookup = buildCategoryLookup(categoryUniverse)
  const allCodes = categoryUniverse.map(e => e.code)

  const presentCount = verdicts.filter(v => v.verdict === 'present').length
  const uncertainCount = verdicts.filter(v => v.verdict === 'uncertain').length
  const absentCount = verdicts.filter(v => v.verdict === 'absent').length
  console.log('[Stage 0.5 v3] Category universe: ' + categoryUniverse.length + ' categories (' + presentCount + ' present, ' + uncertainCount + ' uncertain, ' + absentCount + ' absent)')

  // -----------------------------------------------------------------------
  // File list: Stage 0's inventory, one lane per entry, in its order (by path)
  // -----------------------------------------------------------------------
  const totalFiles = inventory.files.length
  console.log('[Stage 0.5 v3] Total files in inventory: ' + totalFiles)

  // architecture-summary.json's file_inventory is computed from the same
  // selection. If the two disagree, Stage 0 wrote them from different walks and
  // the ledger below would balance against the wrong number.
  const summaryTotal = arch.file_inventory?.total_source_files
  if (summaryTotal !== totalFiles) {
    console.error('[FATAL] ' + FILE_INVENTORY_FILE + ' lists ' + totalFiles + ' files but architecture-summary.json ' +
      'file_inventory.total_source_files is ' + summaryTotal + '. Re-run Stage 0.')
    process.exit(1)
  }

  // -----------------------------------------------------------------------
  // Generate lanes — one per file, with signal-based class narrowing
  // -----------------------------------------------------------------------
  console.log('[Stage 0.5 v3] Generating lanes...')

  const lanes: Lane[] = []
  let laneCounter = 0
  const denylistedSkips: string[] = []
  // Repo-relative paths. The benchmark's seed denylist; empty for a product
  // run, which has no answer key to protect, so both checks below are no-ops.
  const denylist = activeDenylist()

  for (const fileInfo of inventory.files) {
    laneCounter++
    const laneId = 'file-' + String(laneCounter).padStart(4, '0')
    const targetFile = fileInfo.path
    const language = fileInfo.language

    // Disposition: hunt vs skip
    const isExecutable = EXECUTABLE_LANGUAGES.has(language.toLowerCase())
    const isNonExecutable = NON_EXECUTABLE_LANGUAGES.has(language.toLowerCase())

    let disposition: 'hunt' | 'skip'
    let skipReason: string | null = null

    // Blind-development boundary, checked FIRST so no later branch can undo it.
    // These files reference real challenge names for legitimate structural
    // reasons; models/challenge.ts is a literal array of every challenge key.
    // One lane per file means a hunt disposition would paste the answer set
    // straight into the prompt. v1's selector has always applied this list;
    // v2 was forked before it moved into shared/ and never picked it up.
    const repoRelative = path.relative(projectRoot, path.join(targetDir, targetFile))
    if (denylist.includes(repoRelative)) {
      disposition = 'skip'
      skipReason = 'Denylisted: references challenge identifiers — must never reach a hunting lane'
      denylistedSkips.push(targetFile)
    } else if (fileInfo.empty) {
      disposition = 'skip'
      skipReason = EMPTY_SKIP_REASON
    } else if (fileInfo.test) {
      disposition = 'skip'
      skipReason = TEST_SKIP_REASON
    } else if (fileInfo.oversize) {
      disposition = 'skip'
      skipReason = oversizeSkipReason(fileInfo.bytes, inventory.options.max_file_bytes)
    } else if (androidConfigSignals(targetFile, language).length) {
      disposition = 'hunt'
    } else if (isNonExecutable) {
      disposition = 'skip'
      skipReason = getSkipReason(language)
    } else if (isExecutable) {
      disposition = 'hunt'
    } else {
      disposition = 'hunt'
      console.warn('[Stage 0.5 v3] Unknown language "' + language + '" for ' + targetFile + ' — defaulting to hunt')
    }

    // Signal lookup from Stage 0
    const signals = [...new Set([...(fileSignals.files[targetFile] ?? []), ...androidConfigSignals(targetFile, language)])]

    // Class narrowing via signal→class table
    const { classes, class_basis } = computeClasses(signals, signalClassMap, allClassIds)

    // Categories: ALL 26, unchanged
    const categories = allCodes.map(code => categoryLookup.get(code)!).filter(Boolean)

    // File metrics
    const absolutePath = path.join(targetDir, targetFile)
    // An oversize file is never opened (the cap is what makes it oversize); its size comes from the inventory.
    const metrics = fileInfo.oversize ? { bytes: fileInfo.bytes, lines: 0 } : measureFile(absolutePath)

    // Chunk plan
    const chunkPlan = generateChunkPlan(metrics.lines)

    lanes.push({
      lane_id: laneId,
      target_file: targetFile,
      disposition,
      skip_reason: skipReason,
      signals: disposition === 'hunt' ? signals : [],
      classes: disposition === 'hunt' ? classes : [],
      class_basis: disposition === 'hunt' ? class_basis : {},
      categories,
      file_bytes: metrics.bytes,
      file_lines: metrics.lines,
      estimated_prompt_tokens: estimatePromptTokens(metrics.bytes),
      chunk_plan: chunkPlan,
    })
  }

  console.log('[Stage 0.5 v3] Generated ' + lanes.length + ' lanes')

  // Agent mode: route selected classes no file's signals reach onto every hunt
  // lane, then skip lanes left empty — Stage 2 would otherwise fall back to
  // category-derived classes and reintroduce defaults.
  let unrouted: string[] = []
  if (selection) {
    const huntLanes = lanes.filter(l => l.disposition === 'hunt')
    for (const lane of huntLanes) {
      for (const [key, ids] of Object.entries(lane.class_basis)) if (!ids.length) delete lane.class_basis[key]
    }
    const reached = new Set(huntLanes.flatMap(l => l.classes))
    unrouted = selection.classes.filter(c => !reached.has(c))
    for (const lane of huntLanes) {
      if (unrouted.length) {
        lane.classes = [...new Set([...lane.classes, ...unrouted])].sort()
        lane.class_basis['selection-unrouted'] = [...unrouted]
      }
      if (!lane.classes.length) {
        lane.disposition = 'skip'
        lane.skip_reason = NO_SELECTED_CLASS_REASON
        lane.signals = []
        lane.classes = []
        lane.class_basis = {}
      }
    }
    const hunted = lanes.filter(l => l.disposition === 'hunt')
    const union = [...new Set(hunted.flatMap(l => l.classes))].sort()
    if (hunted.length && JSON.stringify(union) !== JSON.stringify([...selection.classes].sort())) {
      throw new Error('Hunt-lane classes ' + JSON.stringify(union) + ' differ from the agent selection ' + JSON.stringify(selection.classes))
    }
    console.log('[Stage 0.5 v3] Unrouted selected classes (on every hunt lane): ' + unrouted.length +
      (unrouted.length ? ' — ' + unrouted.join(', ') : '') + '; ' +
      (huntLanes.length - hunted.length) + ' lane(s) skipped with no selected class')
  }

  // -----------------------------------------------------------------------
  // Coverage ledger
  // -----------------------------------------------------------------------
  const assignedHunt = lanes.filter(l => l.disposition === 'hunt').length
  const assignedSkip = lanes.filter(l => l.disposition === 'skip').length
  const unaccounted = totalFiles - assignedHunt - assignedSkip

  const ledger: CoverageLedger = {
    total_files_in_inventory: totalFiles,
    assigned_hunt: assignedHunt,
    assigned_skip: assignedSkip,
    unaccounted,
  }

  if (unaccounted !== 0) {
    console.error('[FATAL] Ledger does not balance: ' + assignedHunt + ' + ' + assignedSkip + ' = ' + (assignedHunt + assignedSkip) + ' != ' + totalFiles + ' (unaccounted: ' + unaccounted + ')')
    process.exit(1)
  }
  console.log('[Stage 0.5 v3] Ledger balanced: ' + assignedHunt + ' hunt + ' + assignedSkip + ' skip = ' + totalFiles + ' total, unaccounted = 0')

  // Loud, because it is a deliberate coverage gap that every downstream recall
  // number has to be read against.
  console.log('[Stage 0.5 v3] Denylisted (never hunted): ' + denylistedSkips.length +
    (denylistedSkips.length ? ' — ' + denylistedSkips.join(', ') : ''))
  const missedDenylist = denylist
    .map(p => path.relative(targetDir, path.join(projectRoot, p)))
    .filter(rel => !rel.startsWith('..'))
    .filter(rel => {
      const lane = lanes.find(l => l.target_file === rel)
      return lane && lane.disposition !== 'skip'
    })
  if (missedDenylist.length > 0) {
    console.error('[FATAL] Denylisted files assigned to hunt lanes: ' + missedDenylist.join(', '))
    process.exit(1)
  }

  // Assertions
  if (lanes.length !== totalFiles) {
    console.error('[FATAL] Lane count (' + lanes.length + ') != inventory total (' + totalFiles + ')')
    process.exit(1)
  }
  console.log('[Stage 0.5 v3] Lane count matches inventory: ' + lanes.length + ' == ' + totalFiles)

  // Category family coverage
  const codeFamilies = new Set<string>()
  for (const entry of categoryUniverse) {
    codeFamilies.add(entry.code.replace(/[0-9]+$/, ''))
  }
  const laneCategoryCodes = new Set<string>()
  for (const lane of lanes) {
    for (const cat of lane.categories) {
      laneCategoryCodes.add(cat.code)
    }
  }
  const missingFamilies: string[] = []
  for (const family of [...codeFamilies].sort()) {
    const familyMembers = categoryUniverse.filter(e => e.code.startsWith(family)).map(e => e.code)
    const familyPresentInLanes = familyMembers.some(code => laneCategoryCodes.has(code))
    if (!familyPresentInLanes) {
      missingFamilies.push(family)
    }
  }
  if (missingFamilies.length > 0) {
    console.error('[FATAL] Category families missing from all lanes: ' + missingFamilies.join(', '))
    process.exit(1)
  }
  console.log('[Stage 0.5 v3] All category families present across lanes: ' + [...codeFamilies].sort().join(', '))

  // Classes-per-lane distribution
  const classDist: Record<number, number> = {}
  for (const lane of lanes) {
    if (lane.disposition === 'hunt') {
      const n = lane.classes.length
      classDist[n] = (classDist[n] || 0) + 1
    }
  }
  console.log('[Stage 0.5 v3] Classes per hunt lane: ' + JSON.stringify(classDist))

  // Signal distribution
  const signalDist: Record<number, number> = {}
  for (const lane of lanes) {
    if (lane.disposition === 'hunt') {
      const n = lane.signals.length
      signalDist[n] = (signalDist[n] || 0) + 1
    }
  }
  console.log('[Stage 0.5 v3] Signals per hunt lane: ' + JSON.stringify(signalDist))

  // -----------------------------------------------------------------------
  // Write output
  // -----------------------------------------------------------------------
  fs.mkdirSync(outputDir, { recursive: true })

  const output: LaneAssignments = {
    generated_at: new Date().toISOString(),
    target_dir: targetDir,
    // Repo-relative: the artifact is read back on other machines and by
    // archive tooling, and an absolute path would pin it to this checkout.
    source_stage0_run: path.relative(projectRoot, archPath),
    coverage_ledger: ledger,
    category_universe: categoryUniverse,
    signal_class_map: 'tools/scanner/shared/signal-classes.json',
    floor_classes: signalClassMap.floor,
    ...(selection ? { class_selection: { source: 'playbook-agent' as const, classes: selection.classes, unrouted } } : {}),
    lanes,
  }

  const outputPath = path.join(outputDir, 'lane-assignments.json')
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n')
  console.log('[Stage 0.5 v3] Output written to ' + outputPath)

  // Provenance. Deterministic stage — no model ran, so the model field says so
  // rather than naming one that was never called.
  writeMeta(PROVIDER, 'stage05-lane-selector-perfile', 'deterministic', STARTED, 0, guardStats().blocked)
  console.log('[Stage 0.5 v3] Done.')
}

main().catch((err) => {
  console.error('[Stage 0.5 v3] Fatal error:', err)
  process.exit(1)
})
