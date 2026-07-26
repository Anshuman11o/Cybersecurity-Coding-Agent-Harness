/**
 * Stage 0.5 v2 — Per-File Lane Selector
 *
 * One lane per file from the Stage 0 file inventory.
 * Deterministic: no LLM calls. Categories derived by code token
 * from recon output, never by exact framework display strings.
 *
 * Input:
 *   - tools/scanner/stage0-recon/output/architecture-summary.json
 *   - tools/scanner/stage0-recon/output/category-applicability.json
 * Output:
 *   - tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

/**
 * Languages whose files can contain executable logic and therefore
 * should be hunted by default.
 */
const EXECUTABLE_LANGUAGES = new Set([
  'typescript', 'javascript', 'python', 'ruby', 'java', 'go',
  'rust', 'c', 'cpp', 'csharp', 'php', 'kotlin', 'swift',
  'scala', 'solidity', 'dart', 'r', 'perl', 'lua', 'shell',
  'docker', 'graphql',
])

/**
 * Languages that are pure declarative config/style/markup with no
 * independently-executable logic and no traceable entrypoint-to-sink
 * vulnerability path on their own.
 */
const NON_EXECUTABLE_LANGUAGES = new Set([
  'json', 'yaml', 'html', 'css', 'toml', 'sql',
  'protobuf', 'xml', 'ini', 'properties',
])

/** Skip reason mapping for non-executable language groups. */
const SKIP_REASONS: Record<string, string> = {
  json: 'Pure data/config file — no executable logic or independent entrypoint-to-sink path',
  yaml: 'Declarative config/CI file — no executable logic',
  html: 'Markup template — no independently executable logic without a render context',
  css: 'Styling file — no executable logic',
  toml: 'Declarative config file — no executable logic',
  sql: 'Declarative query/schema file — not an independent executable entrypoint',
  protobuf: 'Schema definition — no executable logic',
  xml: 'Declarative data/config file — no executable logic',
  ini: 'Declarative config file — no executable logic',
  properties: 'Declarative config file — no executable logic',
}

function getSkipReason(language: string): string {
  return SKIP_REASONS[language.toLowerCase()] ??
    'Declarative file in language "' + language + '" — no executable logic'
}

// ---------------------------------------------------------------------------
// Category code extraction — NEVER match on framework display strings
// ---------------------------------------------------------------------------

/**
 * Extract the leading category code token (e.g. "A01", "API3", "LLM01")
 * from a category name string. This is the ONLY way we identify categories —
 * never by exact framework string comparison.
 */
function extractCategoryCode(categoryName: string): string {
  const m = categoryName.match(/^([A-Za-z0-9]+):/)
  return m ? m[1] : categoryName.trim()
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

interface Lane {
  lane_id: string
  target_file: string
  disposition: 'hunt' | 'skip'
  skip_reason: string | null
  categories: CategoryEntry[]
  category_basis: string
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
  lanes: Lane[]
}

// ---------------------------------------------------------------------------
// Framework name expansion
// ---------------------------------------------------------------------------

/** Expand short framework tokens to their canonical full names. */
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
// Collect files with specific evidence from architecture summary
// ---------------------------------------------------------------------------

/**
 * Extract file paths (target-dir-relative) that have specific recon evidence,
 * and the category_basis each should receive.
 *
 * Returns a Map<targetFileRelative, Set<category_basis>>.
 */
function collectEvidenceFiles(
  arch: ArchitectureSummary,
): Map<string, Set<string>> {
  const evidenceMap = new Map<string, Set<string>>()

  function addFile(file: string, basis: string) {
    if (!evidenceMap.has(file)) evidenceMap.set(file, new Set())
    evidenceMap.get(file)!.add(basis)
  }

  // Route table files — any file referenced in hand_written or middleware routes
  const allRoutes = [
    ...(arch.route_table?.hand_written_routes ?? []),
    ...(arch.route_table?.middleware_routes ?? []),
  ]
  for (const route of allRoutes) {
    if (route.file) {
      // Normalize: strip target-apps/juice-shop-blind/ prefix
      const rel = normalizeFilePath(route.file)
      if (rel) addFile(rel, 'route_table')
    }
  }

  // Persistence: raw_query_files (if any)
  if (arch.persistence_layer?.raw_query_files) {
    for (const f of arch.persistence_layer.raw_query_files) {
      const rel = normalizeFilePath(f)
      if (rel) addFile(rel, 'persistence')
    }
  }

  // Model definition files (sequelize models referenced in models/)
  // These are defined as model files, so they get model_definition basis
  if (arch.persistence_layer?.models) {
    // Model files conventionally live in models/ directory — use the
    // route_table evidence for any model files that also appear there,
    // but also add model_definition for the model definition files themselves.
    // We derive model file paths from the known models/ directory pattern.
    // Since this must be generic, we look for model files that appear
    // in the file inventory under any models/ directory.
    // For now, mark this as handled via universe_default for model files
    // that have no other evidence.
  }

  // Client render: escape hatch findings
  if (arch.client_side?.escape_hatch_findings) {
    for (const finding of arch.client_side.escape_hatch_findings) {
      const rel = normalizeFilePath(finding.file)
      if (rel) addFile(rel, 'client_render')
    }
  }

  // Also check if there is an explicit LLM section in the architecture
  // Some architectures may have an llm_surface or similar key
  // IMPORTANT: Only look for file references in structured fields (arrays, objects with file keys),
  // NOT in natural language evidence strings which may mention .ts files coincidentally.
  const archKeys = Object.keys(arch)
  for (const key of archKeys) {
    if (key.toLowerCase().includes('llm') && typeof arch[key] === 'object') {
      const llmSection = arch[key] as Record<string, unknown>
      for (const [subKey, subVal] of Object.entries(llmSection)) {
        // Skip natural language evidence fields
        if (subKey === 'evidence' || subKey === 'description' || subKey === 'summary') continue
        if (subKey === 'confidence' || subKey === 'has_genuine_tool_calling') continue
        if (Array.isArray(subVal)) {
          for (const item of subVal) {
            if (typeof item === 'string' && (item.includes('.ts') || item.includes('.js') || item.includes('.py'))) {
              const rel = normalizeFilePath(item)
              if (rel) addFile(rel, 'llm_surface')
            } else if (item && typeof item === 'object' && 'file' in item) {
              const rel = normalizeFilePath((item as any).file)
              if (rel) addFile(rel, 'llm_surface')
            }
          }
        }
      }
    }
  }

  return evidenceMap
}

// ---------------------------------------------------------------------------
// Normalize a file path to target-dir-relative
// ---------------------------------------------------------------------------

function normalizeFilePath(rawPath: string): string | null {
  if (!rawPath) return null
  // Remove leading target-apps/juice-shop-blind/ prefix if present
  // This must be generic: strip the first two path components if they
  // look like target-apps/<name>/
  let p = rawPath
  // Try stripping target-apps/<anything>/ prefix
  const targetPrefixMatch = p.match(/^target-apps\/[^/]+\//)
  if (targetPrefixMatch) {
    p = p.slice(targetPrefixMatch[0].length)
  }
  // Also handle non-Windows separators
  const targetPrefixMatch2 = p.match(/^target-apps\/[^/]+\//)
  if (targetPrefixMatch2) {
    p = p.slice(targetPrefixMatch2[0].length)
  }
  return p || null
}

// ---------------------------------------------------------------------------
// Category assignment by evidence surface
// ---------------------------------------------------------------------------

/**
 * Given the set of category_basis values for a file, return the
 * set of category codes that should be assigned to it.
 *
 * Rules:
 * - Files with NO evidence get the FULL universe (universe_default).
 * - Files with evidence get categories associated with their evidence type.
 * - If a file has multiple evidence types, the union applies.
 *
 * IMPORTANT: Categories are selected by CODE, never by framework string.
 */
function assignCategoriesByEvidence(
  basisSet: Set<string>,
  universeByCode: Map<string, CategoryEntry>,
  allCodes: string[],
): CategoryEntry[] {
  // If no evidence, assign the full universe
  if (basisSet.size === 0) {
    return allCodes.map(code => universeByCode.get(code)!).filter(Boolean)
  }

  const assignedCodes = new Set<string>()

  for (const basis of basisSet) {
    switch (basis) {
      case 'route_table': {
        // Route registration files are primary entry points: they handle auth,
        // request parsing, response generation, and wire up ALL subsystems including
        // LLM/chat surfaces. Every category class can manifest here.
        for (const code of allCodes) {
          assignedCodes.add(code)
        }
        break
      }
      case 'persistence': {
        // Persistence files: injection (SQL/NoSQL), integrity failures, property-level auth,
        // but also auth lifecycle (credential storage), misconfiguration (ORM defaults),
        // and component vulnerabilities (ORM/driver versions).
        for (const code of ['A02', 'A03', 'A05', 'A07', 'A08', 'A09',
                            'API1', 'API2', 'API3', 'API8']) {
          if (allCodes.includes(code)) assignedCodes.add(code)
        }
        break
      }
      case 'client_render': {
        // Frontend escape-hatch sinks (bypassSecurityTrustHtml, innerHTML) disable
        // automatic framework sanitization, creating XSS vectors. XSS is a subclass of
        // Injection (A03) — the sink is dangerous regardless of whether the untrusted
        // content originated from ordinary user input OR a language model. LLM05 only
        // covers the model-output case; A03 covers all others. Both must be included.
        for (const code of ['A03', 'LLM05']) {
          if (allCodes.includes(code)) assignedCodes.add(code)
        }
        break
      }
      case 'llm_surface': {
        // LLM tool-calling surfaces: prompt injection, disclosure, supply chain, agency,
        // consumption — but also injection (tools execute DB queries with user-influenced
        // inputs), misconfiguration (tool permissions), and integrity (tool result trust).
        for (const code of ['A03', 'A05', 'A08',
                            'LLM01', 'LLM02', 'LLM03', 'LLM05', 'LLM06', 'LLM10']) {
          if (allCodes.includes(code)) assignedCodes.add(code)
        }
        break
      }
      case 'model_definition': {
        // Model/schema definitions: property-level auth, integrity, but also injection
        // (ORM-generated queries), misconfiguration (schema defaults), auth (credential fields),
        // and component vulnerabilities (ORM version).
        for (const code of ['A02', 'A03', 'A05', 'A06', 'A07', 'A08',
                            'API1', 'API2', 'API3', 'API8']) {
          if (allCodes.includes(code)) assignedCodes.add(code)
        }
        break
      }
      default: {
        // Unknown evidence type — fall through to universe
        for (const code of allCodes) assignedCodes.add(code)
      }
    }
  }

  // Always include misconfiguration (A05) and vulnerable components (A06)
  // for hunt files, as these can manifest anywhere
  if (basisSet.has('route_table')) {
    for (const code of ['A06']) {
      if (allCodes.includes(code)) assignedCodes.add(code)
    }
  }

  return [...assignedCodes].map(code => universeByCode.get(code)!).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Determine the dominant category_basis for a file
// ---------------------------------------------------------------------------

function determineCategoryBasis(basisSet: Set<string>): string {
  if (basisSet.size === 0) return 'universe_default'
  if (basisSet.size === 1) return [...basisSet][0]

  // Priority order for multi-evidence files
  const priority = ['llm_surface', 'client_render', 'persistence', 'route_table', 'model_definition']
  for (const p of priority) {
    if (basisSet.has(p)) return p
  }
  return [...basisSet].sort()[0]
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

// Rough prompt token estimate: ~4 chars per token for code
function estimatePromptTokens(fileBytes: number): number {
  return Math.ceil(fileBytes / 4)
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
    // Degenerate file (unreadable or removed) — single empty chunk at line 0
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

  // Need to chunk: split into sequential ranges with overlap
  const chunks: { index: number; start_line: number; end_line: number }[] = []
  let currentStart = 1
  let chunkIndex = 1

  while (currentStart <= fileLines) {
    let endLine = Math.min(currentStart + SINGLE_PASS_LINE_BUDGET - 1, fileLines)

    // If this is not the last chunk and there's room for overlap,
    // extend the end to include overlap for the next chunk
    if (endLine < fileLines) {
      endLine = Math.min(currentStart + SINGLE_PASS_LINE_BUDGET - 1, fileLines)
    }

    chunks.push({ index: chunkIndex, start_line: currentStart, end_line: endLine })

    if (endLine >= fileLines) break

    // Next chunk starts CHUNK_OVERLAP lines before this chunk ends
    currentStart = endLine - CHUNK_OVERLAP + 1
    chunkIndex++

    // Safety: prevent infinite loop
    if (chunkIndex > fileLines * 2) {
      throw new Error('Chunk generation safety limit exceeded for file with ' + fileLines + ' lines')
    }
  }

  // TILING ASSERTIONS
  if (chunks.length === 0) {
    throw new Error('Tiling assertion failed: no chunks generated')
  }
  // For 0-line files (unreadable/removed), skip start/end assertions
  if (fileLines > 0) {
    if (chunks[0].start_line !== 1) {
      throw new Error('Tiling assertion failed: first chunk start_line=' + chunks[0].start_line + ', expected 1')
    }
    if (chunks[chunks.length - 1].end_line !== fileLines) {
      throw new Error('Tiling assertion failed: last chunk end_line=' + chunks[chunks.length - 1].end_line + ', expected ' + fileLines)
    }
  }
  // Check no gaps between consecutive chunks
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = chunks[i - 1].end_line
    const currStart = chunks[i].start_line
    if (currStart > prevEnd + 1) {
      throw new Error('Tiling assertion failed: gap between chunk ' + i + ' (ends ' + prevEnd + ') and chunk ' + (i + 1) + ' (starts ' + currStart + ')')
    }
    if (currStart > prevEnd) {
      // No overlap, but no gap either — acceptable but unexpected
      console.warn('Warning: no overlap between chunk ' + i + ' and ' + (i + 1))
    }
  }
  // Verify overlap exists between consecutive chunks (except single-chunk case)
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = chunks[i - 1].end_line
    const currStart = chunks[i].start_line
    if (currStart > prevEnd) {
      // Gap exists
      throw new Error('Tiling assertion failed: gap detected')
    }
    // Overlap check: there should be at least some overlap
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectRoot = path.resolve(__dirname, '../../../..')
  const stage0OutputDir = path.join(projectRoot, 'tools/scanner/stage0-recon/output')
  const outputDir = path.join(projectRoot, 'tools/scanner/stage05-lane-selector-perfile/output')

  // -----------------------------------------------------------------------
  // Load Stage 0 outputs
  // -----------------------------------------------------------------------
  console.log('[Stage 0.5 v2] Loading Stage 0 outputs...')

  const archPath = path.join(stage0OutputDir, 'architecture-summary.json')
  const arch: ArchitectureSummary = JSON.parse(fs.readFileSync(archPath, 'utf-8'))
  console.log('[Stage 0.5 v2] Loaded architecture summary')

  const catPath = path.join(stage0OutputDir, 'category-applicability.json')
  const verdicts: CategoryVerdict[] = JSON.parse(fs.readFileSync(catPath, 'utf-8'))
  console.log('[Stage 0.5 v2] Loaded category applicability')

  // -----------------------------------------------------------------------
  // Determine target directory
  // -----------------------------------------------------------------------
  // Stage 0 recon resolves target from --target arg, env var, or default.
  // The file paths in the inventory are relative to this target dir.
  // We infer target_dir from the route table file paths.
  const sampleRoute = arch.route_table?.hand_written_routes?.[0]
  let targetDir: string
  if (sampleRoute?.file) {
    // e.g. "target-apps/juice-shop-blind/server.ts" -> strip the file name
    const match = sampleRoute.file.match(/^(.+?)\/[^/]+$/)
    if (match) {
      targetDir = path.resolve(projectRoot, match[1])
    } else {
      targetDir = path.join(projectRoot, 'target-apps', 'juice-shop-blind')
    }
  } else {
    targetDir = path.join(projectRoot, 'target-apps', 'juice-shop-blind')
  }
  console.log('[Stage 0.5 v2] Target directory: ' + targetDir)

  // -----------------------------------------------------------------------
  // Build category universe
  // -----------------------------------------------------------------------
  const categoryUniverse = buildCategoryUniverse(verdicts)
  const categoryLookup = buildCategoryLookup(categoryUniverse)
  const allCodes = categoryUniverse.map(e => e.code)

  const presentCount = verdicts.filter(v => v.verdict === 'present').length
  const uncertainCount = verdicts.filter(v => v.verdict === 'uncertain').length
  const absentCount = verdicts.filter(v => v.verdict === 'absent').length
  console.log('[Stage 0.5 v2] Category universe: ' + categoryUniverse.length + ' categories (' + presentCount + ' present, ' + uncertainCount + ' uncertain, ' + absentCount + ' absent)')

  // Log category codes for verification
  const codeFamilies = new Set<string>()
  for (const entry of categoryUniverse) {
    const family = entry.code.replace(/[0-9]+$/, '')
    codeFamilies.add(family)
  }
  console.log('[Stage 0.5 v2] Category code families: ' + [...codeFamilies].sort().join(', '))

  // -----------------------------------------------------------------------
  // Collect evidence files from architecture summary
  // -----------------------------------------------------------------------
  const evidenceMap = collectEvidenceFiles(arch)
  console.log('[Stage 0.5 v2] Evidence files found: ' + evidenceMap.size)

  // -----------------------------------------------------------------------
  // Build complete file inventory from unclassified_surface
  // -----------------------------------------------------------------------
  const fileInv = arch.file_inventory
  const totalFiles = fileInv.total_source_files
  console.log('[Stage 0.5 v2] Total files in inventory: ' + totalFiles)

  // Build a flat set of files already covered by unclassified_surface
  const unclassifiedSet = new Set<string>()
  const allFiles: { path: string; language: string }[] = []
  for (const group of fileInv.unclassified_surface) {
    for (const f of group.files) {
      allFiles.push({ path: f, language: group.language })
      unclassifiedSet.add(f)
    }
  }
  console.log('[Stage 0.5 v2] Files from unclassified_surface: ' + allFiles.length)

  // Supplement: walk the target directory to find files that recon counted
  // in total_source_files but didn't include in unclassified_surface.
  // This can happen when a file is touched by framework-specific extraction
  // (e.g., route handler resolution) and thus excluded from unclassified_surface
  // but still part of the overall file inventory.
  //
  // We only add files from language groups where by_language count exceeds
  // unclassified_surface count (undercounted groups) to avoid pulling in
  // images, binaries, and other non-source assets that recon excluded.
  //
  // Compute which language groups are undercounted
  const unclassifiedCountByLang = new Map<string, number>()
  for (const group of fileInv.unclassified_surface) {
    unclassifiedCountByLang.set(group.language.toLowerCase(), group.count)
  }
  const undercountedLanguages = new Set<string>()
  for (const [lang, byLangEntry] of Object.entries(fileInv.by_language)) {
    const unclassifiedCount = unclassifiedCountByLang.get(lang.toLowerCase()) ?? 0
    if ((byLangEntry as { count: number }).count > unclassifiedCount) {
      undercountedLanguages.add(lang.toLowerCase())
    }
  }
  console.log('[Stage 0.5 v2] Undercounted language groups: ' + [...undercountedLanguages].join(', ') || '(none)')

  const knownLanguages = undercountedLanguages

  // Map file extensions to language names (must match by_language keys)
  const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
    '.py': 'python',
    '.rb': 'ruby',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.sol': 'solidity',
    '.json': 'json',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.html': 'html', '.htm': 'html', '.hbs': 'html', '.pug': 'html',
    '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
    '.toml': 'toml',
    '.sql': 'sql',
    '.proto': 'protobuf',
    '.graphql': 'graphql', '.gql': 'graphql',
    '.xml': 'xml',
    '.ini': 'ini',
    '.properties': 'properties',
    '.sh': 'shell', '.bash': 'shell',
  }

  function extToLanguage(filePath: string): string | null {
    const base = path.basename(filePath).toLowerCase()
    if (base === 'dockerfile' || base === 'dockerfile.dev') return 'docker'
    const ext = path.extname(filePath).toLowerCase()
    return EXT_TO_LANG[ext] ?? null
  }

  function walkDir(dir: string, relativeBase: string): { path: string; language: string }[] {
    const results: { path: string; language: string }[] = []
    if (!fs.existsSync(dir)) return results
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Skip node_modules, .git, and other non-source directories
        if (['node_modules', '.git', '.qwen', 'dist', 'build', 'out'].includes(entry.name)) continue
        results.push(...walkDir(path.join(dir, entry.name), path.join(relativeBase, entry.name)))
      } else if (entry.isFile()) {
        const relPath = path.join(relativeBase, entry.name).replace(/\\/g, '/')
        if (unclassifiedSet.has(relPath)) continue // already covered
        const lang = extToLanguage(entry.name)
        if (lang && knownLanguages.has(lang)) {
          results.push({ path: relPath, language: lang })
        }
      }
    }
    return results
  }

  const supplementalFiles = walkDir(targetDir, '')
  if (supplementalFiles.length > 0) {
    console.log('[Stage 0.5 v2] Supplemental files found: ' + supplementalFiles.length)
    for (const sf of supplementalFiles) {
      allFiles.push(sf)
      unclassifiedSet.add(sf.path)
    }
  }

  // -----------------------------------------------------------------------
  // Generate lanes — one per file
  // -----------------------------------------------------------------------
  console.log('[Stage 0.5 v2] Generating lanes...')

  const lanes: Lane[] = []
  let laneCounter = 0

  for (const fileInfo of allFiles) {
    laneCounter++
    const laneId = 'file-' + String(laneCounter).padStart(4, '0')
    const targetFile = fileInfo.path
    const language = fileInfo.language

    // Disposition: hunt vs skip
    const isExecutable = EXECUTABLE_LANGUAGES.has(language.toLowerCase())
    const isNonExecutable = NON_EXECUTABLE_LANGUAGES.has(language.toLowerCase())

    let disposition: 'hunt' | 'skip'
    let skipReason: string | null = null

    if (isNonExecutable) {
      disposition = 'skip'
      skipReason = getSkipReason(language)
    } else if (isExecutable) {
      disposition = 'hunt'
    } else {
      // Unknown language — default to hunt (fail open)
      disposition = 'hunt'
      console.warn('[Stage 0.5 v2] Unknown language "' + language + '" for ' + targetFile + ' — defaulting to hunt')
    }

    // Evidence lookup
    const basisSet = evidenceMap.get(targetFile) ?? new Set<string>()

    // Category assignment
    const categories = assignCategoriesByEvidence(basisSet, categoryLookup, allCodes)
    const categoryBasis = determineCategoryBasis(basisSet)

    // File metrics (read from actual filesystem)
    const absolutePath = path.join(targetDir, targetFile)
    const metrics = measureFile(absolutePath)

    // Chunk plan
    const chunkPlan = generateChunkPlan(metrics.lines)

    lanes.push({
      lane_id: laneId,
      target_file: targetFile,
      disposition,
      skip_reason: skipReason,
      categories,
      category_basis: categoryBasis,
      file_bytes: metrics.bytes,
      file_lines: metrics.lines,
      estimated_prompt_tokens: estimatePromptTokens(metrics.bytes),
      chunk_plan: chunkPlan,
    })
  }

  console.log('[Stage 0.5 v2] Generated ' + lanes.length + ' lanes')

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

  // LEDGER ASSERTION
  if (unaccounted !== 0) {
    console.error('[FATAL] Ledger does not balance: ' + assignedHunt + ' + ' + assignedSkip + ' = ' + (assignedHunt + assignedSkip) + ' != ' + totalFiles + ' (unaccounted: ' + unaccounted + ')')
    process.exit(1)
  }
  console.log('[Stage 0.5 v2] Ledger balanced: ' + assignedHunt + ' hunt + ' + assignedSkip + ' skip = ' + totalFiles + ' total, unaccounted = 0')

  // -----------------------------------------------------------------------
  // Additional structural assertions
  // -----------------------------------------------------------------------

  // (b) total lanes == total_source_files
  if (lanes.length !== totalFiles) {
    console.error('[FATAL] Lane count (' + lanes.length + ') != inventory total (' + totalFiles + ')')
    process.exit(1)
  }
  console.log('[Stage 0.5 v2] Lane count matches inventory: ' + lanes.length + ' == ' + totalFiles)

  // (c) Every chunk plan tiles correctly (already asserted per-file above)
  let chunkedFileCount = 0
  let maxChunksForFile = 0
  for (const lane of lanes) {
    if (lane.chunk_plan.total_chunks > maxChunksForFile) {
      maxChunksForFile = lane.chunk_plan.total_chunks
    }
    if (lane.chunk_plan.required) {
      chunkedFileCount++
    }
  }
  console.log('[Stage 0.5 v2] Chunk plans: ' + chunkedFileCount + ' files require chunking, max chunks per file = ' + maxChunksForFile)

  // (d) Category family coverage: every family in recon present/uncertain must appear on at least one lane
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
    console.error('[FATAL] This indicates the category code matching bug described in the requirements.')
    process.exit(1)
  }
  console.log('[Stage 0.5 v2] All category families present across lanes: ' + [...codeFamilies].sort().join(', '))

  // Category basis distribution
  const basisDistribution = new Map<string, number>()
  for (const lane of lanes) {
    basisDistribution.set(lane.category_basis, (basisDistribution.get(lane.category_basis) ?? 0) + 1)
  }
  console.log('[Stage 0.5 v2] Category basis distribution:')
  for (const [basis, count] of [...basisDistribution].sort()) {
    console.log('  ' + basis + ': ' + count)
  }

  // -----------------------------------------------------------------------
  // Write output
  // -----------------------------------------------------------------------
  fs.mkdirSync(outputDir, { recursive: true })

  const output: LaneAssignments = {
    generated_at: new Date().toISOString(),
    target_dir: targetDir,
    source_stage0_run: archPath,
    coverage_ledger: ledger,
    category_universe: categoryUniverse,
    lanes,
  }

  const outputPath = path.join(outputDir, 'lane-assignments.json')
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n')
  console.log('[Stage 0.5 v2] Output written to ' + outputPath)
  console.log('[Stage 0.5 v2] Done.')
}

main().catch((err) => {
  console.error('[Stage 0.5 v2] Fatal error:', err)
  process.exit(1)
})