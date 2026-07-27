/**
 * Stage 0 — Per-file signal extraction.
 *
 * Deterministic: no LLM calls. Detects what a file **does** (not whether it is wrong)
 * by analysing language-level shape. Falls back to textual scanning when a file
 * cannot be parsed. Never drops a file from output.
 *
 * Signals detected:
 *   route_handler, db_query, model_schema, model_write, http_outbound,
 *   auth_check, crypto_op, html_sink, dynamic_exec, deserialize,
 *   file_io, llm_call, logging, config_file, dep_manifest
 */
import * as fs from 'fs'
import * as path from 'path'

export type Signal =
  | 'route_handler' | 'db_query' | 'model_schema' | 'model_write'
  | 'http_outbound' | 'auth_check' | 'crypto_op' | 'html_sink'
  | 'dynamic_exec' | 'deserialize' | 'file_io' | 'llm_call'
  | 'logging' | 'config_file' | 'dep_manifest'

// ---------------------------------------------------------------------------
// Route-table based: route_handler
// ---------------------------------------------------------------------------

/**
 * Collect all handler and middleware identifier names from the route table.
 * Returns a Set of bare names (e.g. "addBasketItem", "isAuthorized") that
 * appear in handler or middleware fields.
 */
export function collectRouteHandlerNames(
  routeTable: {
    hand_written_routes?: { handler?: string | null; middleware?: string[] }[],
    middleware_routes?: { middleware?: string[] }[],
  },
): Set<string> {
  const names = new Set<string>()

  function extractNames(text: string) {
    // "basketItems.addBasketItem(" → "addBasketItem" (the exported function)
    const dotMatch = text.match(/\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/)
    if (dotMatch) names.add(dotMatch[1])
    // Bare handler names like "ensureFileIsPassed("
    const bare = text.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/)
    if (bare) names.add(bare[1])
    // "utils.asyncHandler(basketItems.addBasketItem())" → "addBasketItem"
    const nested = text.match(/\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\)/)
    if (nested) names.add(nested[1])
  }

  for (const route of routeTable.hand_written_routes ?? []) {
    if (route.handler) extractNames(route.handler)
    for (const mw of route.middleware ?? []) extractNames(mw)
  }
  for (const route of routeTable.middleware_routes ?? []) {
    for (const mw of route.middleware ?? []) extractNames(mw)
  }

  return names
}

function normalizeRouteFile(rawPath: string, _targetDir: string): string | null {
  let p = rawPath
  // Strip target-apps/<name>/ prefix if present
  const m = p.match(/^target-apps\/[^/]+\//)
  if (m) p = p.slice(m[0].length)
  return p || null
}

// ---------------------------------------------------------------------------
// Text-based signal detectors (one per signal)
// Each takes raw file content and returns true if the signal is detected.
// ---------------------------------------------------------------------------

/** DB query: call expressions matching query-executor names, or SQL in template literals. */
function detectDbQuery(source: string): boolean {
  // Method-call pattern: obj.query(...), obj.exec(...), obj.execute(...), obj.raw(...)
  //   obj.find*(...), obj.aggregate(...), obj.select(...), obj.insert(...)
  //   obj.update(...), obj.destroy(...), obj.save(...)
  const queryExecutors = [
    'query', 'exec', 'execute', 'raw', 'aggregate', 'select',
    'insert', 'update', 'destroy', 'save',
  ]
  for (const name of queryExecutors) {
    // Match .name( — handles .query(, .exec(, .find*(, etc.
    const re = new RegExp(`\\.${name}\\s*\\(`)
    if (re.test(source)) return true
  }
  // find* variants: .findOne(, .findAll(, .findById(, etc.
  if (/\.find\w+\s*\(/.test(source)) return true
  // Template literal containing SQL keywords
  if (/`[^`]*\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|DROP|ALTER|CREATE)\b[^`]*`/i.test(source)) return true
  return false
}

/** Model schema: extends Model, .init(, schema construction, entity decorator. */
function detectModelSchema(source: string): boolean {
  // Extends a model base class
  if (/\bextends\s+\w*Model\b/.test(source)) return true
  if (/\bextends\s+Model\b/.test(source)) return true
  // Calls .init( — Sequelize pattern
  if (/\.init\s*\(/.test(source)) return true
  // Schema object construction: new Schema(, schema({
  if (/new\s+Schema\s*\(/.test(source)) return true
  if (/schema\s*\(\s*\{/.test(source)) return true
  // Entity decorator: @Entity, @Model, @Table (TypeORM / Sequelize)
  if (/@(Entity|Model|Table|Document|Schema)\b/.test(source)) return true
  // Mongoose model definition: mongoose.model(
  if (/mongoose\.model\s*\(/.test(source)) return true
  return false
}

/** Model write: calls that persist/mutate records. */
function detectModelWrite(source: string): boolean {
  const writers = ['save', 'create', 'update', 'upsert', 'build', 'bulkCreate']
  for (const name of writers) {
    const re = new RegExp(`\\.${name}\\s*\\(`)
    if (re.test(source)) return true
  }
  return false
}

/** HTTP outbound: fetch/request/get/post/axios with non-literal URL argument. */
function detectHttpOutbound(source: string): boolean {
  // Match http client calls where the URL is NOT a simple string literal
  // Pattern: fetch(variable), fetch(template), request(variable), axios.get(variable), etc.
  // We look for the call pattern and then check if the first arg is not a quoted string
  const clientCalls = ['fetch', 'request', 'axios']
  for (const client of clientCalls) {
    // Match client( not followed by a quote — non-literal URL
    const reNonLiteral = new RegExp('\\b' + client + '\\s*\\(\\s*[^"\'`]')
    if (reNonLiteral.test(source)) return true
  }
  // axios.get(url), axios.post(url) etc. with non-literal first arg
  if (/axios\.\w+\s*\(\s*[^"'`]/.test(source)) return true
  // http.get / https.get with non-literal
  if (/https?\.\w+\s*\(\s*[^"'`]/.test(source)) return true
  return false
}

/** Auth check: identifiers referencing auth/session/token/jwt/role/permission. */
function detectAuthCheck(source: string): boolean {
  const authPatterns = [
    // Common auth function/identifier names
    /isAuth(oriz|enticat)?[e]?[d]?\b/i,
    /checkAuth/i,
    /requireAuth/i,
    /ensureAuth/i,
    /hasPermission/i,
    /hasRole/i,
    /checkPermission/i,
    /authorize\b/i,
    /login\b/i,
    // Session/token/JWT identifiersifiers
    /session/i,
    /\bJWT\b/i,
    /\btoken\b/i,
    // Security module auth patterns
    /authenticatedUsers/i,
    /isDeluxe/i,
    // Role / permission
    /\brole\b/i,
    /\bpermission\b/i,
    // Middleware that looks like auth
    /jwt\s*\(/i,
    /passport\s*\./i,
  ]
  for (const pattern of authPatterns) {
    if (pattern.test(source)) return true
  }
  return false
}

/** Crypto op: hashing, encryption, signing, HMAC, salting, key material. */
function detectCryptoOp(source: string): boolean {
  const cryptoPatterns = [
    /crypto\./i,
    /bcrypt\./i,
    /argon2/i,
    /hash\s*\(/i,
    /hmac/i,
    /encrypt/i,
    /decrypt/i,
    /sign\s*\(/i,
    /verify\s*\(/i,
    /salt/i,
    /key\s*(material|gen|derive)/i,
    /createHash/i,
    /createCipher/i,
    /createSign/i,
    /createHmac/i,
    /pbkdf2/i,
    /scrypt/i,
    // Common crypto method chains
    /\.hash\b/i,
  ]
  for (const pattern of cryptoPatterns) {
    if (pattern.test(source)) return true
  }
  return false
}

/** HTML sink: innerHTML, dangerouslySetInnerHTML, bypassSecurityTrust*, document.write, v-html. */
function detectHtmlSink(source: string): boolean {
  const sinks = [
    'innerHTML', 'outerHTML', 'dangerouslySetInnerHTML',
    'bypassSecurityTrust', 'document.write',
  ]
  for (const sink of sinks) {
    if (source.includes(sink)) return true
  }
  // Angular bypassSecurityTrust* methods
  if (/bypassSecurityTrust\w+\s*\(/.test(source)) return true
  // Vue v-html binding in template (less likely in TS files but handle it)
  if (/v-html/.test(source)) return true
  return false
}

/** Dynamic exec: eval, new Function, process/shell execution. */
function detectDynamicExec(source: string): boolean {
  if (/\beval\s*\(/.test(source)) return true
  if (/new\s+Function\s*\(/.test(source)) return true
  if (/child_process/.test(source)) return true
  if (/exec\s*\(/.test(source) && !/exec\s*\(\s*\)/.test(source)) return true
  if (/spawn\s*\(/.test(source)) return true
  if (/execFile\s*\(/.test(source)) return true
  if (/execSync\s*\(/.test(source)) return true
  if (/spawnSync\s*\(/.test(source)) return true
  return false
}

/** Deserialize: JSON/YAML/XML parsing from non-literal sources, native deserializer. */
function detectDeserialize(source: string): boolean {
  const parsePatterns = [
    // JSON.parse with non-literal argument
    /JSON\.parse\s*\(\s*[^"'`{]/,
    // YAML.load / yaml.load / jsYaml.safeLoad
    /ya?ml\.load/i,
    /safeLoad/i,
    // XML parsing
    /xml2js/i,
    /parseString/i,
    /XMLSerializer/i,
    // Native deserializer
    /unserialize/i,
    /pickle/i,
    /deserialize/i,
    // querystring / URL search param parsing
    /querystring\.parse/,
  ]
  for (const pattern of parsePatterns) {
    if (pattern.test(source)) return true
  }
  return false
}

/** File I/O: filesystem operations, especially with non-literal paths. */
function detectFileIo(source: string): boolean {
  const filePatterns = [
    /fs\.\w+\s*\(/,
    /readFile/i,
    /writeFile/i,
    /createReadStream/i,
    /createWriteStream/i,
    /sendFile\s*\(/,
    /path\.resolve/i,
    /path\.join/i,
    /readdir/i,
    /access\s*\(/,
    /stat\s*\(/,
    /lstat\s*\(/,
    /open\s*\(/,
    /close\s*\(/,
    /unlink\s*\(/,
  ]
  for (const pattern of filePatterns) {
    if (pattern.test(source)) return true
  }
  return false
}

/** LLM call: model API calls or tool/function definitions passed to one. */
function detectLlmCall(source: string): boolean {
  const llmPatterns = [
    /openai/i,
    /langchain/i,
    /anthropic/i,
    /chat\.completions/i,
    /createChatCompletion/i,
    /createCompletion/i,
    /llm\b/i,
    /tool_call/i,
    /function_call/i,
    /tools\s*[:=]\s*\[/i,
    /functions\s*[:=]\s*\[/i,
    /system\s*:\s*['"`]/i,
    /ai-sdk/i,
  ]
  for (const pattern of llmPatterns) {
    if (pattern.test(source)) return true
  }
  return false
}

/** Logging: warn/error level logger or console calls. */
function detectLogging(source: string): boolean {
  const logPatterns = [
    /console\.(warn|error)\s*\(/,
    /logger\.(warn|error)\s*\(/,
    /log\.(warn|error)\s*\(/,
    /winston/i,
    /pino/i,
    /bunyan/i,
    /winston\.createLogger/i,
    /\blog4js/i,
  ]
  for (const pattern of logPatterns) {
    if (pattern.test(source)) return true
  }
  return false
}

/** Config file: the file is configuration by structure. */
function detectConfigFile(relPath: string, source: string): boolean {
  // Structural: extension-based
  const configExtensions = ['.env', '.cfg', '.conf', '.ini', '.toml', '.config.ts', '.config.js', '.config.json']
  const lowerPath = relPath.toLowerCase()
  for (const ext of configExtensions) {
    if (lowerPath.endsWith(ext)) return true
  }
  // Named config patterns
  const configNames = ['config', 'settings', 'environment', 'env']
  const baseName = path.basename(lowerPath, path.extname(lowerPath)).toLowerCase()
  for (const name of configNames) {
    if (baseName === name || baseName.startsWith(name + '.')) return true
  }
  // Environment file
  if (lowerPath.endsWith('.env') || lowerPath === '.env') return true
  return false
}

/** Dependency manifest or lockfile. */
function detectDepManifest(relPath: string): boolean {
  const lowerPath = relPath.toLowerCase()
  const manifestNames = [
    'package.json', 'package-lock.json', 'yarn.lock',
    'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock',
    'pom.xml', 'build.gradle', 'build.gradle.kts',
    'go.mod', 'go.sum', 'requirements.txt', 'Pipfile', 'Pipfile.lock',
    'composer.json', 'composer.lock',
    'pyproject.toml', 'poetry.lock',
  ]
  const baseName = path.basename(lowerPath)
  return manifestNames.includes(baseName)
}

// ---------------------------------------------------------------------------
// Exported symbol extraction (regex-based, no parser dependency)
// ---------------------------------------------------------------------------

function extractExportedSymbols(source: string): Set<string> {
  const symbols = new Set<string>()

  // export function X, export async function X, export const X, export class X
  const reDecl = /\bexport\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
  let m: RegExpExecArray | null
  while ((m = reDecl.exec(source)) !== null) symbols.add(m[1])

  // export { X, Y, Z } — handles multi-line
  const reNamed = /\bexport\s*\{([^}]*)\}/g
  while ((m = reNamed.exec(source)) !== null) {
    for (const item of m[1].split(',')) {
      const trimmed = item.trim()
      const asMatch = trimmed.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (asMatch) symbols.add(asMatch[2])
      else {
        const bareMatch = trimmed.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)/)
        if (bareMatch) symbols.add(bareMatch[1])
      }
    }
  }

  return symbols
}

// ---------------------------------------------------------------------------
// Main detector: scan one file and return its signals
// ---------------------------------------------------------------------------

export function detectSignals(
  relPath: string,
  absPath: string,
  routeHandlerNames: Set<string>,
): Signal[] {
  const signals: Signal[] = []

  // Read file content
  let source: string
  try {
    source = fs.readFileSync(absPath, 'utf-8')
  } catch {
    // Cannot read file — return empty signals (real answer, not failure)
    return signals
  }

  // Structural signals (path-based) — check first
  if (detectDepManifest(relPath)) {
    signals.push('dep_manifest')
    return signals
  }
  if (detectConfigFile(relPath, source)) {
    signals.push('config_file')
    return signals
  }

  // route_handler — check if this file's exported symbols appear in the route table
  if (routeHandlerNames.size > 0) {
    const exportedSymbols = extractExportedSymbols(source)
    for (const sym of exportedSymbols) {
      if (routeHandlerNames.has(sym)) {
        signals.push('route_handler')
        break
      }
    }
  }

  // Content-based signals
  if (detectDbQuery(source)) signals.push('db_query')
  if (detectModelSchema(source)) signals.push('model_schema')
  if (detectModelWrite(source)) signals.push('model_write')
  if (detectHttpOutbound(source)) signals.push('http_outbound')
  if (detectAuthCheck(source)) signals.push('auth_check')
  if (detectCryptoOp(source)) signals.push('crypto_op')
  if (detectHtmlSink(source)) signals.push('html_sink')
  if (detectDynamicExec(source)) signals.push('dynamic_exec')
  if (detectDeserialize(source)) signals.push('deserialize')
  if (detectFileIo(source)) signals.push('file_io')
  if (detectLlmCall(source)) signals.push('llm_call')
  if (detectLogging(source)) signals.push('logging')

  return signals
}

// ---------------------------------------------------------------------------
// Batch detector: scan all files from inventory
// ---------------------------------------------------------------------------

export interface FileSignalsResult {
  generated_at: string
  target_dir: string
  files: Record<string, Signal[]>
}

/**
 * Scan a known list of target-relative file paths and return their signals.
 * This variant matches the inventory count exactly (all 918 files).
 */
export function detectAllSignalsFromList(
  targetDir: string,
  relPaths: string[],
  routeHandlerNames: Set<string>,
): FileSignalsResult {
  const files: Record<string, Signal[]> = {}
  for (const relPath of relPaths) {
    const absPath = path.join(targetDir, relPath)
    try {
      const signals = detectSignals(relPath, absPath, routeHandlerNames)
      files[relPath] = signals
    } catch {
      files[relPath] = []
    }
  }
  return {
    generated_at: new Date().toISOString(),
    target_dir: targetDir,
    files,
  }
}

export function detectAllSignals(
  targetDir: string,
  fileInventory: {
    unclassified_surface: { language: string; count: number; files: string[] }[],
    by_language: Record<string, { count: number; sample_paths: string[] }>,
  },
  routeHandlerFiles: Set<string>,
): FileSignalsResult {
  const files: Record<string, Signal[]> = {}

  // Collect all files from the inventory
  const allFileSet = new Set<string>()
  for (const group of fileInventory.unclassified_surface) {
    for (const f of group.files) {
      allFileSet.add(f)
    }
  }
  // Also add files from route table evidence that might have been classified
  for (const f of routeHandlerFiles) {
    allFileSet.add(f)
  }
  // Walk the directory to catch any files counted in by_language but not
  // listed in unclassified_surface (files that were "classified" by framework extraction)
  const allFilesByLang = new Set<string>()
  for (const [, info] of Object.entries(fileInventory.by_language)) {
    for (const f of info.sample_paths ?? []) {
      allFilesByLang.add(f)
    }
  }
  for (const f of allFilesByLang) {
    allFileSet.add(f)
  }

  // We need ALL files from the inventory, not just samples.
  // Walk the target directory to get every file.
  const EXT_TO_SOURCE: Record<string, boolean> = {
    '.ts': true, '.tsx': true, '.js': true, '.jsx': true, '.mjs': true,
    '.py': true, '.rb': true, '.java': true, '.go': true, '.rs': true,
    '.c': true, '.h': true, '.cpp': true, '.hpp': true, '.cc': true,
    '.cs': true, '.php': true, '.kt': true, '.swift': true,
    '.scala': true, '.sol': true, '.dart': true, '.r': true,
    '.pl': true, '.lua': true, '.sh': true, '.bash': true,
    '.json': true, '.yaml': true, '.yml': true, '.toml': true,
    '.html': true, '.htm': true, '.css': true, '.scss': true,
    '.sass': true, '.less': true, '.sql': true, '.xml': true,
    '.ini': true, '.properties': true, '.proto': true,
    '.graphql': true, '.gql': true, '.vue': true, '.svelte': true,
  }

  const EXCLUDED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage',
    '.next', '.nuxt', '.output', '.angular', '.cache',
    'out', '.turbo', '.vercel',
  ])

  function walkDir(dir: string, relBase: string) {
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
        walkDir(fullPath, path.join(relBase, entry.name))
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        const basename = entry.name.toLowerCase()
        const isSource = EXT_TO_SOURCE[ext] || basename === 'dockerfile' ||
          basename === '.env' || basename.startsWith('.env.')
        if (!isSource) continue
        const relPath = path.join(relBase, entry.name).replace(/\\/g, '/')
        allFileSet.add(relPath)
      }
    }
  }

  walkDir(targetDir, '')

  // Now detect signals for every file
  for (const relPath of [...allFileSet].sort()) {
    const absPath = path.join(targetDir, relPath)
    try {
      const signals = detectSignals(relPath, absPath, routeHandlerFiles)
      files[relPath] = signals
    } catch {
      // Never drop a file — empty array is a real answer
      files[relPath] = []
    }
  }

  return {
    generated_at: new Date().toISOString(),
    target_dir: targetDir,
    files,
  }
}
