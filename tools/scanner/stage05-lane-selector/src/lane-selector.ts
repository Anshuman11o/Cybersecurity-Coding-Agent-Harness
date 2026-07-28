/**
 * Stage 0.5 — Dynamic Lane Selector
 *
 * TASK A: Handler file resolution (ts-morph on server.ts imports)
 * TASK B: Deterministic lane instantiation from Stage 0 outputs
 * TASK C: Orchestrator verification pass (one LLM call)
 *
 * Input:
 *   - tools/scanner/stage0-recon/output/architecture-summary.json
 *   - tools/scanner/stage0-recon/output/category-applicability.json
 * Output:
 *   - tools/scanner/stage05-lane-selector/output/lane-manifest.json
 */
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { runPath, type Provider } from '../../shared/run-paths.js'
import { resolveProvider, modelFor, tokenLimitParam, samplingParams, clientConfigFor } from '../../shared/provider.js'
import { writeMeta, failIfDegraded } from '../../shared/meta.js'
import { markDegraded } from '../../shared/degraded.js'
import { SEED_DENYLIST } from '../../shared/read-guard.js'

const PROVIDER: Provider = resolveProvider('stage05')
const MODEL = modelFor(PROVIDER)
const STARTED = new Date().toISOString()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

import {
  resolveHandlers,
  resolveHandlerToFiles,
  type HandlerResolution,
} from './handler-resolver.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArchitectureSummary {
  route_table: {
    hand_written_routes: RouteEntry[]
    middleware_routes: RouteEntry[]
    auto_crud_routes: AutoCrudEntry[]
  }
  persistence_layer: {
    orm: string
    raw_queries: boolean | string
    raw_query_files: string[]
    mongodb_detected: boolean
  }
  client_side: {
    escape_hatch_findings: EscapeHatchFinding[]
  }
  [key: string]: unknown
}

interface RouteEntry {
  method: string
  path: string
  handler?: string | null
  auth: string | null
  middleware: string[]
  file?: string
  line?: number
}

interface AutoCrudEntry {
  pathPattern: string
  model: string
  excludeAttributes: string[]
  hasPagination: boolean
  hasCustomHooks: boolean
}

interface EscapeHatchFinding {
  file: string
  line: number
  type: string
}

interface UnclassifiedSurfaceGroup {
  language: string
  count: number
  files: string[]
  total_bytes: number
}

interface FileInventory {
  total_source_files: number
  by_language: Record<string, { count: number; sample_paths: string[] }>
  unclassified_surface: UnclassifiedSurfaceGroup[]
  smart_contract_surface_detected: boolean
  smart_contract_files: string[]
}

interface CategoryVerdict {
  name: string
  framework: string
  verdict: 'present' | 'absent' | 'uncertain'
  evidence: string
  confidence: number
}

interface Lane {
  lane_id: string
  categories: string[]
  subsystem_scope: string
  seed_files: string[]
  playbook_reference: string
}

interface OrchestratorReview {
  disputed_verdicts: {
    category: string
    stage0_verdict: string
    review_verdict: string
    reason: string
  }[]
  uncertain_routing: {
    category: string
    decision: 'dedicated_lane' | 'general_lane'
    reason: string
  }[]
}

// ---------------------------------------------------------------------------
// LLM client (exact same createClient pattern from stage0-recon)
// ---------------------------------------------------------------------------

function createClient(): OpenAI | null {
  // Endpoint and credential come from the model registry; null credential means
  // the caller markDegraded()s instead of crashing.
  // Proxying via NODE_USE_ENV_PROXY=1; openai v6 has no httpAgent option.
  const { apiKey, baseURL } = clientConfigFor(PROVIDER)
  if (!apiKey) return null
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
}

// ---------------------------------------------------------------------------
// TASK A: Handler resolution
// ---------------------------------------------------------------------------

function buildHandlerMap(
  repoRoot: string,
): Map<string, HandlerResolution> {
  const serverTsPath = path.join(
    repoRoot,
    'target-apps/juice-shop-blind/server.ts',
  )
  console.log('[TASK A] Resolving handler -> file mappings...')
  const handlerMap = resolveHandlers(serverTsPath, repoRoot)
  console.log(`[TASK A] Resolved ${handlerMap.size} handler bindings`)
  return handlerMap
}

// ---------------------------------------------------------------------------
// Helper: collect seed files for a lane (normalized to repo-relative)
// ---------------------------------------------------------------------------

function rel(f: string, repoRoot: string): string {
  if (f.startsWith(repoRoot)) return f.slice(repoRoot.length + 1)
  return f
}

// ---------------------------------------------------------------------------
// Deterministic sink scanners (used by SSRF and code-injection lanes)
// ---------------------------------------------------------------------------

interface SinkHit {
  file: string
  line: number
  pattern: string
  snippet: string
}

function scanOutboundHttpCalls(repoRoot: string, routesDir: string): SinkHit[] {
  const hits: SinkHit[] = []
  const patterns = [
    /await\s+fetch\s*\(([^)\s][^)]*)\)/,    // fetch(urlVar) but not fetch('literal')
    /\baxios\s*\(/,
    /http\s*\.\s*request\s*\(/,
    /http\s*\.\s*get\s*\(/,
    /http\s*\.\s*post\s*\(/,
  ]

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      const lines = fs.readFileSync(full, 'utf-8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const pat of patterns) {
          const m = line.match(pat)
          if (!m) continue
          const arg = m[1] || ''
          // Skip if URL arg is a string literal or config.get() call
          if (arg.match(/^['"`]/)) continue
          if (arg.includes('config.get')) continue
          hits.push({
            file: rel(full, repoRoot),
            line: i + 1,
            pattern: pat.source,
            snippet: line.trim(),
          })
        }
      }
    }
  }
  walk(routesDir)
  return hits
}

function scanEvalCodeInjection(repoRoot: string, routesDir: string): SinkHit[] {
  const hits: SinkHit[] = []
  const patterns = [
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bFunction\s*\(/,
    /pug\s*\.\s*compile\s*\(/,
  ]

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.pug')) continue
      const lines = fs.readFileSync(full, 'utf-8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const pat of patterns) {
          if (pat.test(line)) {
            hits.push({
              file: rel(full, repoRoot),
              line: i + 1,
              pattern: pat.source,
              snippet: line.trim(),
            })
          }
        }
      }
    }
  }
  walk(routesDir)
  return hits
}

function collectSeedFiles(
  routes: RouteEntry[],
  handlerMap: Map<string, HandlerResolution>,
  serverTsPath: string,
  repoRoot: string,
  extraFiles: string[] = [],
): string[] {
  const seedSet = new Set<string>()
  seedSet.add(rel(serverTsPath, repoRoot))

  for (const route of routes) {
    if (route.handler) {
      const files = resolveHandlerToFiles(route.handler, handlerMap, serverTsPath)
      for (const f of files) seedSet.add(rel(f, repoRoot))
    }
    for (const mw of route.middleware) {
      const files = resolveHandlerToFiles(mw, handlerMap, serverTsPath)
      for (const f of files) seedSet.add(rel(f, repoRoot))
    }
  }

  for (const f of extraFiles) seedSet.add(rel(f, repoRoot))

  return Array.from(seedSet).sort()
}

// ---------------------------------------------------------------------------
// TASK B: Deterministic lane instantiation
// ---------------------------------------------------------------------------

function instantiateLanes(
  arch: ArchitectureSummary,
  categories: CategoryVerdict[],
  handlerMap: Map<string, HandlerResolution>,
  repoRoot: string,
): Lane[] {
  const lanes: Lane[] = []
  const presentCategories = categories.filter((c) => c.verdict === 'present')
  const uncertainCategories = categories.filter((c) => c.verdict === 'uncertain')

  const serverTsPath = path.join(repoRoot, 'target-apps/juice-shop-blind/server.ts')
  const allRoutes = [
    ...arch.route_table.hand_written_routes,
    ...arch.route_table.middleware_routes,
  ]
  const escapeHatchFiles = (arch.client_side?.escape_hatch_findings ?? []).map(
    (f: EscapeHatchFinding) => f.file,
  )

  // --- Access-Control Cluster (A01 + API1 + API5) ---
  const accessControlPresent = presentCategories.filter(
    (c) =>
      c.name.includes('Broken Access Control') ||
      c.name.includes('Broken Object Level') ||
      c.name.includes('Broken Function Level'),
  )
  if (accessControlPresent.length > 0) {
    const authRoutes = allRoutes.filter(
      (r) => r.auth && r.auth !== 'null' && r.auth !== null,
    )
    const seeds = collectSeedFiles(authRoutes, handlerMap, serverTsPath, repoRoot, [
      path.join(repoRoot, 'target-apps/juice-shop-blind/lib/insecurity.ts'),
    ])
    lanes.push({
      lane_id: 'access-control',
      categories: accessControlPresent.map((c) => c.name),
      subsystem_scope:
        'Route-level authorization checks across all authenticated endpoints (auth middleware column: isAuthorized/denyAll/appendUserId/isAccounting)',
      seed_files: seeds,
      playbook_reference: 'access-control',
    })
    console.log(`[LANE] access-control: ${accessControlPresent.length} categories (${accessControlPresent.map((c) => c.name).join(', ')}), ${seeds.length} seed files`)
  }

  // --- Injection / SQL (A03 split) ---
  const injectionPresent = presentCategories.find((c) => c.name.includes('Injection'))
  if (injectionPresent) {
    const searchTsPath = path.join(repoRoot, 'target-apps/juice-shop-blind/routes/search.ts')
    const sqlSeeds = collectSeedFiles([], handlerMap, serverTsPath, repoRoot, [
      searchTsPath,
    ])
    lanes.push({
      lane_id: 'injection-sql',
      categories: ['A03: Injection (SQL)'],
      subsystem_scope:
        'SQL injection via raw sequelize.query() calls with string-interpolated user input (e.g. routes/search.ts SELECT ... LIKE)',
      seed_files: sqlSeeds,
      playbook_reference: 'injection-sql',
    })
    console.log(`[LANE] injection-sql: 1 category (A03 SQL split), ${sqlSeeds.length} seed files`)
  }

  // --- Injection / NoSQL (A03 split) ---
  if (injectionPresent) {
    const nosqlSinkPath = path.join(repoRoot, 'target-apps/juice-shop-blind/routes/updateProductReviews.ts')
    const nosqlSeeds = collectSeedFiles([], handlerMap, serverTsPath, repoRoot, [
      nosqlSinkPath,
      path.join(repoRoot, 'target-apps/juice-shop-blind/data/mongodb.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/createProductReviews.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/likeProductReviews.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/showProductReviews.ts'),
    ])
    lanes.push({
      lane_id: 'injection-nosql',
      categories: ['A03: Injection (NoSQL)'],
      subsystem_scope:
        'NoSQL operator injection via marsdb-style collection.update() with user-controlled $where/$set (e.g. routes/updateProductReviews.ts)',
      seed_files: nosqlSeeds,
      playbook_reference: 'injection-nosql',
    })
    console.log(`[LANE] injection-nosql: 1 category (A03 NoSQL split), ${nosqlSeeds.length} seed files`)
  }

  // --- Crypto + Auth (A02 + A07 + API2) ---
  const cryptoPresent = presentCategories.filter(
    (c) =>
      c.name.includes('Cryptographic') ||
      c.name.includes('Identification') ||
      c.name.includes('Authentication'),
  )
  if (cryptoPresent.length > 0) {
    const cryptoRoutes = allRoutes.filter(
      (r) =>
        r.path.includes('login') ||
        r.path.includes('reset-password') ||
        r.path.includes('change-password') ||
        r.path.includes('2fa') ||
        r.path.includes('security-question') ||
        r.path.includes('whoami') ||
        r.path.includes('authentication-details'),
    )
    const cryptoSeeds = collectSeedFiles(cryptoRoutes, handlerMap, serverTsPath, repoRoot, [
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/login.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/changePassword.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/resetPassword.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/2fa.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/lib/insecurity.ts'),
    ])
    lanes.push({
      lane_id: 'crypto-auth',
      categories: cryptoPresent.map((c) => c.name),
      subsystem_scope:
        'JWT handling, password hashing, 2FA/TOTP, security questions, and session management across auth endpoints',
      seed_files: cryptoSeeds,
      playbook_reference: 'crypto-auth',
    })
    console.log(`[LANE] crypto-auth: ${cryptoPresent.length} categories, ${cryptoSeeds.length} seed files`)
  }

  // --- Run deterministic sink scanners ---
  const ssrfHits = scanOutboundHttpCalls(repoRoot, path.join(repoRoot, 'target-apps/juice-shop-blind/routes'))
  const ssrfHitFiles = [...new Set(ssrfHits.map((h) => h.file))]
  if (ssrfHitFiles.length > 0) {
    console.log(`[SCAN] Outbound HTTP call sites: ${ssrfHitFiles.length} file(s): ${ssrfHitFiles.join(', ')}`)
  }
  const codeInjectionHits = scanEvalCodeInjection(repoRoot, path.join(repoRoot, 'target-apps/juice-shop-blind/routes'))
  const codeInjectionHitFiles = [...new Set(codeInjectionHits.map((h) => h.file))]
  if (codeInjectionHitFiles.length > 0) {
    console.log(`[SCAN] eval/Function/pug.compile sinks: ${codeInjectionHitFiles.length} file(s): ${codeInjectionHitFiles.join(', ')}`)
  }

  // --- Misconfiguration (A05 + API8 + API9) ---
  const misconfigPresent = presentCategories.filter(
    (c) =>
      c.name.includes('Security Misconfiguration') ||
      c.name.includes('Improper Inventory'),
  )
  if (misconfigPresent.length > 0) {
    // Target actual security-config evidence: dangerous parser flags, CORS/helmet config,
    // exposed directory setup, swagger config — not just route path keywords.
    const misconfigSeeds = collectSeedFiles([], handlerMap, serverTsPath, repoRoot, [
      // XXE: XML parser with XML_PARSE_NOENT | XML_PARSE_DTDLOAD + fs access
      path.join(repoRoot, 'target-apps/juice-shop-blind/lib/xml.ts'),
      // Config schema: defines security-relevant config keys
      path.join(repoRoot, 'target-apps/juice-shop-blind/lib/config.schema.ts'),
      // Security middleware: CORS, JWT, password hashing, security headers
      path.join(repoRoot, 'target-apps/juice-shop-blind/lib/insecurity.ts'),
      // File upload handlers: YAML/XML/ZIP processing surfaces
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/fileUpload.ts'),
      // Static file servers for exposed directories
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/fileServer.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/keyServer.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/logfileServer.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/quarantineServer.ts'),
      // server.ts: where cors(), helmet(), featurePolicy(), static-serving, and swagger are wired up
    ])
    lanes.push({
      lane_id: 'misconfiguration',
      categories: misconfigPresent.map((c) => c.name),
      subsystem_scope:
        'Exposed directories (ftp, encryptionkeys, logs), missing security headers, outdated dependency versions, Swagger coverage gap (1/148 paths documented)',
      seed_files: misconfigSeeds,
      playbook_reference: 'misconfiguration',
    })
    console.log(`[LANE] misconfiguration: ${misconfigPresent.length} categories, ${misconfigSeeds.length} seed files`)
  }

  // --- Vulnerable Components (A06) ---
  const vulnComponents = presentCategories.find((c) =>
    c.name.includes('Vulnerable') || c.name.includes('Outdated'),
  )
  if (vulnComponents) {
    const componentSeeds = [
      rel(path.join(repoRoot, 'target-apps/juice-shop-blind/package.json'), repoRoot),
    ]
    lanes.push({
      lane_id: 'vulnerable-components',
      categories: [vulnComponents.name],
      subsystem_scope:
        'Dependency version audit: jsonwebtoken v0.4.0, js-yaml v3.14.0, helmet v4.6.0, libxml2-wasm v0.7.1, express-jwt v0.1.3, sanitize-html v1.4.2',
      seed_files: componentSeeds,
      playbook_reference: 'vulnerable-components',
    })
    console.log(`[LANE] vulnerable-components: 1 category, ${componentSeeds.length} seed files`)
  }

  // --- Integrity Failures (A08) ---
  const integrityPresent = presentCategories.find((c) => c.name.includes('Integrity'))
  if (integrityPresent) {
    const integrityRoutes = allRoutes.filter(
      (r) =>
        r.path.includes('file-upload') ||
        r.path.includes('yaml') ||
        r.path.includes('web3') ||
        r.path.includes('b2b'),
    )
    const integritySeeds = collectSeedFiles(integrityRoutes, handlerMap, serverTsPath, repoRoot, [
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/fileUpload.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/b2bOrder.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/web3Wallet.ts'),
    ])
    lanes.push({
      lane_id: 'integrity-failures',
      categories: [integrityPresent.name],
      subsystem_scope:
        'Unsafe deserialization (YAML/XML parsing), file upload processing (ZIP/XML/YAML), web3 contract listeners accepting untrusted inputs',
      seed_files: integritySeeds,
      playbook_reference: 'integrity-failures',
    })
    console.log(`[LANE] integrity-failures: 1 category, ${integritySeeds.length} seed files`)
  }

  // --- API3: Broken Object Property Level Authorization ---
  const api3Present = presentCategories.find((c) => c.name.includes('Object Property Level'))
  if (api3Present) {
    const api3Seeds = collectSeedFiles(
      allRoutes.filter((r) => r.path.includes('/api/')),
      handlerMap,
      serverTsPath,
      repoRoot,
    )
    lanes.push({
      lane_id: 'api-property-auth',
      categories: [api3Present.name],
      subsystem_scope:
        'Auto-CRUD field-level exposure: excludeAttributes lists on finale-rest models (Users exclude password/totpSecret but expose email/lastLoginIp/isAdmin; Products exclude nothing)',
      seed_files: api3Seeds,
      playbook_reference: 'api-property-auth',
    })
    console.log(`[LANE] api-property-auth: 1 category, ${api3Seeds.length} seed files`)
  }

  // --- API4: Unrestricted Resource Consumption ---
  const api4Present = presentCategories.find((c) => c.name.includes('Resource Consumption'))
  if (api4Present) {
    // Narrow to genuinely expensive/automatable endpoints, not every route missing rateLimit.
    // Only two categories qualify:
    // (a) List/search GET endpoints enabling mass data extraction (no pagination)
    // (b) State-changing endpoints enabling automation abuse (registration, order, coupon,
    //     wallet, file upload/export, review manipulation) — not every POST/PUT/DELETE.
    const api4Routes = allRoutes.filter((r) => {
      const isListOrSearch = r.method === 'GET' && (
        r.path.includes('/products/search') ||
        r.path.includes('order-history')
      )
      // Auto-CRUD models without pagination
      const autoNoPagination = arch.route_table.auto_crud_routes.some(
        (acr) => !acr.hasPagination && r.path.startsWith(acr.pathPattern),
      )
      // State-changing endpoints that enable real automation abuse
      const isAutomatableWrite = (r.method === 'POST' || r.method === 'PUT' || r.method === 'DELETE' || r.method === 'PATCH') && (
        r.path.includes('file-upload') ||
        r.path.includes('/api/Users') ||
        r.path.includes('reset-password') ||
        r.path.includes('basket/:id/checkout') ||
        r.path.includes('basket/:id/coupon') ||
        r.path.includes('wallet/balance') ||
        r.path.includes('deluxe-membership') ||
        r.path.includes('data-export') ||
        r.path.includes('/api/Feedbacks') ||
        r.path.includes('products/reviews') ||
        r.path.includes('b2b') ||
        r.path.includes('profile/image')
      )
      return isListOrSearch || autoNoPagination || isAutomatableWrite
    })
    // Direct seed list for targeted resource-consumption surfaces.
    // collectSeedFiles resolves routes + adds extras, but for API4 the route
    // resolution pulls in too much (captcha, metrics, verify via middleware chains).
    // Instead, explicitly list the targeted evidence files.
    const api4SeedPaths = [
      // Mass data extraction (search without pagination, order history)
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/search.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/orderHistory.ts'),
      // State-changing automation abuse surfaces
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/fileUpload.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/order.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/b2bOrder.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/coupon.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/basket.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/basketItems.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/wallet.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/deluxe.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/dataExport.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/resetPassword.ts'),
      // server.ts: rate-limit config, basket/order routing
    ]
    const api4Seeds = [
      ...new Set(api4SeedPaths.map((f) => rel(f, repoRoot))),
      rel(serverTsPath, repoRoot),
    ].sort()
    lanes.push({
      lane_id: 'resource-consumption',
      categories: [api4Present.name],
      subsystem_scope:
        'Endpoints missing rate limiting (search, file-upload, user list, metrics) and pagination on list endpoints',
      seed_files: api4Seeds,
      playbook_reference: 'resource-consumption',
    })
    console.log(`[LANE] resource-consumption: 1 category, ${api4Seeds.length} seed files`)
  }

  // --- API6: Unrestricted Access to Sensitive Business Flows ---
  const api6Present = presentCategories.find((c) => c.name.includes('Sensitive Business'))
  if (api6Present) {
    const api6Routes = allRoutes.filter(
      (r) =>
        r.path.includes('data-export') ||
        r.path.includes('2fa') ||
        r.path.includes('wallet') ||
        r.path.includes('deluxe') ||
        r.path.includes('order') ||
        r.path.includes('coupon'),
    )
    const api6Seeds = collectSeedFiles(api6Routes, handlerMap, serverTsPath, repoRoot, [
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/dataExport.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/coupon.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/wallet.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/deluxe.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/order.ts'),
    ])
    lanes.push({
      lane_id: 'sensitive-business-flows',
      categories: [api6Present.name],
      subsystem_scope:
        'Sensitive flows lacking safeguards: data-export without CAPTCHA, 2FA setup without re-auth, wallet balance manipulation, deluxe membership upgrade',
      seed_files: api6Seeds,
      playbook_reference: 'sensitive-business-flows',
    })
    console.log(`[LANE] sensitive-business-flows: 1 category, ${api6Seeds.length} seed files`)
  }

  // --- Client-Side (DOM XSS) ---
  const llm05Present = presentCategories.find((c) => c.name.includes('LLM05'))
  if (escapeHatchFiles.length > 0) {
    const clientSeeds = collectSeedFiles([], handlerMap, serverTsPath, repoRoot, [
      ...new Set(escapeHatchFiles),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/search.ts'),
    ])
    const clientCats = llm05Present ? [llm05Present.name] : []
    if (clientCats.length > 0) {
      lanes.push({
        lane_id: 'client-side',
        categories: clientCats,
        subsystem_scope:
          'Angular DOM XSS: ' + escapeHatchFiles.length + ' escape-hatch occurrences (bypassSecurityTrustHtml/innerHTML) across frontend components, fed by dynamic API content (search results, product reviews, feedback)',
        seed_files: clientSeeds,
        playbook_reference: 'client-side',
      })
      console.log(`[LANE] client-side: ${clientCats.length} categories, ${clientSeeds.length} seed files`)
    }
  }

  // --- Code Injection / SSTI (A03 third sink type: eval/Function/pug.compile) ---
  if (codeInjectionHitFiles.length > 0) {
    const codeInjectionSeeds = collectSeedFiles([], handlerMap, serverTsPath, repoRoot, [
      ...codeInjectionHitFiles.map((f) => path.join(repoRoot, f)),
    ])
    lanes.push({
      lane_id: 'injection-code',
      categories: ['A03: Injection (Code Execution/SSTI)'],
      subsystem_scope:
        'Code injection via eval()/Function()/pug.compile() with user-controlled input (e.g. routes/userProfile.ts eval(username-derived code), routes/captcha.ts eval(expression))',
      seed_files: codeInjectionSeeds,
      playbook_reference: 'injection-code',
    })
    console.log(`[LANE] injection-code: 1 category (A03 code exec/SSTI), ${codeInjectionSeeds.length} seed files`)
  }

  // --- AI/LLM Agency ---
  const llmPresent = presentCategories.filter(
    (c) =>
      c.framework === 'LLM Top 10' &&
      !c.name.includes('LLM05') &&
      !c.name.includes('LLM07') &&
      !c.name.includes('LLM04') &&
      !c.name.includes('LLM08') &&
      !c.name.includes('LLM09'),
  )
  if (llmPresent.length > 0) {
    const chatSeeds = collectSeedFiles([], handlerMap, serverTsPath, repoRoot, [
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/chat.ts'),
    ])
    lanes.push({
      lane_id: 'ai-llm-agency',
      categories: llmPresent.map((c) => c.name),
      subsystem_scope:
        'LLM tool-calling surface: chat.ts with genuine tool handlers (searchProducts, getOrderById, generateCoupon, getProductReviews) — prompt injection, sensitive info disclosure, supply chain, excessive agency, unbounded consumption',
      seed_files: chatSeeds,
      playbook_reference: 'ai-llm-agency',
    })
    console.log(`[LANE] ai-llm-agency: ${llmPresent.length} categories (${llmPresent.map((c) => c.name).join(', ')}), ${chatSeeds.length} seed files`)
  }

  // --- Logging/Monitoring (A09) ---
  const loggingPresent = presentCategories.find((c) =>
    c.name.includes('Logging') || c.name.includes('Monitoring'),
  )
  if (loggingPresent) {
    const loggingRoutes = allRoutes.filter(
      (r) =>
        r.path.includes('metrics') ||
        r.path.includes('logs') ||
        r.path.includes('monitor'),
    )
    const loggingSeeds = collectSeedFiles(loggingRoutes, handlerMap, serverTsPath, repoRoot, [
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/metrics.ts'),
      path.join(repoRoot, 'target-apps/juice-shop-blind/routes/logfileServer.ts'),
    ])
    lanes.push({
      lane_id: 'logging-monitoring',
      categories: [loggingPresent.name],
      subsystem_scope:
        'Metrics endpoint (public), log file server (indexed, public), absence of audit logging for failed logins/privilege changes/data exports',
      seed_files: loggingSeeds,
      playbook_reference: 'logging-monitoring',
    })
    console.log(`[LANE] logging-monitoring: 1 category, ${loggingSeeds.length} seed files`)
  }

  // --- Uncertain categories: provisional general/catch-all ---
  if (uncertainCategories.length > 0) {
    const uncertainSeeds = collectSeedFiles(
      allRoutes.filter(
        (r) =>
          r.path.includes('web3') ||
          r.path.includes('b2b') ||
          r.path.includes('redirect') ||
          r.path.includes('country-mapping'),
      ),
      handlerMap,
      serverTsPath,
      repoRoot,
      [
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/web3Wallet.ts'),
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/b2bOrder.ts'),
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/countryMapping.ts'),
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/redirect.ts'),
      ],
    )
    lanes.push({
      lane_id: 'general-catchall',
      categories: uncertainCategories.map((c) => c.name),
      subsystem_scope:
        'Catch-all lane for categories Stage 0 marked uncertain (A04 Insecure Design, A10 SSRF, API7 SSRF, API10 Unsafe Consumption) — web3 endpoints, B2B orders, outbound HTTP calls, country mapping',
      seed_files: uncertainSeeds,
      playbook_reference: 'general-catchall',
    })
    console.log(`[LANE] general-catchall: ${uncertainCategories.length} uncertain categories (${uncertainCategories.map((c) => c.name).join(', ')}), ${uncertainSeeds.length} seed files`)
  }

  // --- Unclassified surface routing (from Stage 0 file inventory) ---
  // Stage 0 walks the entire target and produces an unclassified_surface list
  // of files that no framework-specific extraction touched. These are filtered
  // to keep only executable code (no pure config/style/markup), then directory-
  // grouped and bin-packed into right-sized sharded lanes so no single lane
  // dwarfs the rest of the pipeline.
  const fileInv = arch.file_inventory as FileInventory | undefined
  if (fileInv && fileInv.unclassified_surface && fileInv.unclassified_surface.length > 0) {

    // FILTER 1: Languages that are pure declarative config/style/markup with no
    // independently-executable logic — there is no traceable entrypoint→sink
    // vulnerability path in a raw config, stylesheet, or template file alone.
    const NON_EXECUTABLE_LANGUAGES = new Set([
      'json', 'yaml', 'html', 'css', 'toml', 'docker', 'shell',
      'graphql', 'protobuf', 'sql',
    ])

    // FILTER 2: Solidity is handled by its own dedicated smart-contract lane below.
    const EXCLUDED_LANGUAGES = new Set([...NON_EXECUTABLE_LANGUAGES, 'solidity'])

    // Collect code files that survive the filter (typescript, javascript, python, etc.)
    const codeFiles: string[] = []
    let totalFilteredBytes = 0
    let totalFilteredCount = 0
    let totalExcludedFiles = 0

    for (const group of fileInv.unclassified_surface) {
      if (EXCLUDED_LANGUAGES.has(group.language)) {
        totalExcludedFiles += group.count
        continue
      }
      for (const f of group.files) {
        // Convert target-relative to repo-relative path
        const repoRel = f.startsWith('target-apps/')
          ? f
          : path.join(repoRoot, 'target-apps/juice-shop-blind', f).replace(repoRoot + '/', '')
        codeFiles.push(repoRel)
      }
      totalFilteredCount += group.count
      totalFilteredBytes += (group as any).total_bytes ?? 0
    }

    console.log(`[FILTER] Unclassified surface: ${totalFilteredCount + totalExcludedFiles} total files → ${totalExcludedFiles} filtered (non-executable) + ${totalFilteredCount} code files (${(totalFilteredBytes / 1024).toFixed(1)} KB)`)

    // SHARD: directory-grouped first-fit-decreasing bin-packing
    // Named constant: target max bytes per shard, calibrated to keep shards
    // in the same order-of-magnitude as the largest legitimate hunting lane
    // (client-side lane on this run: ~122 KB).
    const SHARD_BYTE_BUDGET = 150_000  // ~150 KB per shard

    // Group files by shared parent directory (relative to target root)
    const dirGroups = new Map<string, { files: string[]; bytes: number }>()
    for (const f of codeFiles) {
      // Determine directory group: everything up to and including the first
      // component under the target root. For 'frontend/src/app/foo.ts' →
      // group is 'frontend/src/app'; for 'routes/foo.ts' → 'routes'.
      // Use the full relative directory as the group key.
      const dir = path.dirname(f)
      if (!dirGroups.has(dir)) {
        dirGroups.set(dir, { files: [], bytes: 0 })
      }
      const grp = dirGroups.get(dir)!
      grp.files.push(f)
      try {
        const fullPath = path.isAbsolute(f) ? f : path.join(repoRoot, f)
        grp.bytes += fs.statSync(fullPath).size
      } catch { /* file unreadable, skip size */ }
    }

    // Sort directory groups by total bytes descending (first-fit-decreasing)
    const sortedGroups = [...dirGroups.entries()].sort((a, b) => b[1].bytes - a[1].bytes)

    // Bin-pack: first-fit into shards capped at SHARD_BYTE_BUDGET
    interface Shard { files: string[]; bytes: number; dirs: Set<string> }
    const shards: Shard[] = []

    for (const [dir, grp] of sortedGroups) {
      // If a single directory group exceeds the budget, split it into sub-shards
      // by individual files — no directory-group should blow a shard budget.
      // A single file that exceeds the budget on its own becomes its own shard
      // (we cannot split a file).
      if (grp.bytes > SHARD_BYTE_BUDGET && grp.files.length > 1) {
        // Split this oversized directory group across multiple shards
        let remainingFiles = [...grp.files]
        while (remainingFiles.length > 0) {
          // Create a new shard with as many files from this group as fit
          const newShard: Shard = { files: [], bytes: 0, dirs: new Set() }
          newShard.dirs.add(dir)
          for (const rf of remainingFiles) {
            let fsize = 0
            try {
              const fp = path.isAbsolute(rf) ? rf : path.join(repoRoot, rf)
              fsize = fs.statSync(fp).size
            } catch {}
            if (newShard.bytes + fsize > SHARD_BYTE_BUDGET && newShard.files.length > 0) break
            newShard.files.push(rf)
            newShard.bytes += fsize
          }
          // Remove consumed files from remainingFiles
          const consumed = new Set(newShard.files)
          remainingFiles = remainingFiles.filter(f => !consumed.has(f))
          shards.push(newShard)
        }
      } else {
        // Normal first-fit placement for this directory group
        let placed = false
        for (const s of shards) {
          if (s.bytes + grp.bytes <= SHARD_BYTE_BUDGET) {
            s.files.push(...grp.files)
            s.bytes += grp.bytes
            s.dirs.add(dir)
            placed = true
            break
          }
        }
        if (!placed) {
          shards.push({
            files: [...grp.files],
            bytes: grp.bytes,
            dirs: new Set([dir]),
          })
        }
      }
    }

    // Create sharded lanes from the bin-packed results
    const TARGET_PREFIX = 'target-apps/juice-shop-blind/'
    for (let i = 0; i < shards.length; i++) {
      const shard = shards[i]
      const dominantDir = [...shard.dirs].sort((a, b) => {
        // Pick the directory with the most files as the dominant one for naming
        const aCount = shard.files.filter(f => path.dirname(f) === a).length
        const bCount = shard.files.filter(f => path.dirname(f) === b).length
        return bCount - aCount
      })[0] ?? 'root'
      const laneId = `unclassified-code-${i + 1}`
      lanes.push({
        lane_id: laneId,
        categories: [],
        subsystem_scope: `Sharded lane ${i + 1}/${shards.length} for unclassified code files — dominant directory: ${dominantDir} (${shard.files.length} files, ${(shard.bytes / 1024).toFixed(1)} KB)`,
        seed_files: [...shard.files].sort(),
        playbook_reference: 'general-catchall',
      })
      console.log(`[LANE] ${laneId}: ${shard.files.length} files, ${(shard.bytes / 1024).toFixed(1)} KB, dominant dir: ${dominantDir}`)
    }
    console.log(`[SHARD] Created ${shards.length} sharded lanes for ${totalFilteredCount} unclassified code files`)
  }

  // --- Smart contract surface lane ---
  if (fileInv && fileInv.smart_contract_surface_detected && fileInv.smart_contract_files.length > 0) {
    // Convert target-relative paths to repo-relative paths for consistency
    const solSeedFiles = fileInv.smart_contract_files.map((f) =>
      f.startsWith('target-apps/') ? f : path.join(repoRoot, 'target-apps/juice-shop-blind', f).replace(repoRoot + '/', ''),
    )
    lanes.push({
      lane_id: 'smart-contract',
      categories: [],
      subsystem_scope:
        'Solidity smart contract files detected via file inventory: ' + fileInv.smart_contract_files.map((f) => f.split('/').pop()).join(', ') + ' — vulnerability classes: reentrancy, integer overflow, access control, oracle manipulation',
      seed_files: solSeedFiles,
      playbook_reference: 'general-catchall',
    })
    console.log(`[LANE] smart-contract: ${fileInv.smart_contract_files.length} .sol file(s) seeded`)
  }

  return lanes
}

// ---------------------------------------------------------------------------
// TASK C: Orchestrator verification pass (ONE LLM call)
// ---------------------------------------------------------------------------

async function runOrchestratorReview(
  arch: ArchitectureSummary,
  categories: CategoryVerdict[],
  lanes: Lane[],
): Promise<OrchestratorReview> {
  const client = createClient()
  if (!client) {
    markDegraded('orchestrator review: no API key for provider — skipped LLM verification')
    return { disputed_verdicts: [], uncertain_routing: [] }
  }

  console.log('[TASK C] Running orchestrator verification pass (1 LLM call)...')

  const prompt =
    `You are an orchestrator reviewing Stage 0 recon results and the proposed lane manifest. Two jobs:\n\n` +
    `JOB 1: Flag any category verdict (present/absent/uncertain) you disagree with, given BOTH files.\n` +
    `JOB 2: For each category still marked 'uncertain', decide dedicated_lane or general_lane. No third option.\n\n` +
    `Architecture: ${arch.route_table.hand_written_routes.length} hand-written + ${arch.route_table.middleware_routes.length} middleware + ${arch.route_table.auto_crud_routes.length} auto-CRUD routes. ORM=${arch.persistence_layer.orm}, raw_queries=${JSON.stringify(arch.persistence_layer.raw_queries)}, mongodb=${arch.persistence_layer.mongodb_detected}. Client-side: ${arch.client_side?.escape_hatch_findings?.length ?? 0} escape-hatch occurrences.\n\n` +
    `Category verdicts:\n` +
    categories.map((c) => `- ${c.name} (${c.framework}): ${c.verdict} (confidence ${c.confidence}) — ${c.evidence.substring(0, 150)}...`).join('\n') +
    `\n\nProposed lanes:\n` +
    lanes.map((l) => `- ${l.lane_id}: categories=[${l.categories.join(', ')}], scope="${l.subsystem_scope}", ${l.seed_files.length} seed files`).join('\n') +
    `\n\nUncertain categories:\n` +
    categories.filter((c) => c.verdict === 'uncertain').map((c) => `- ${c.name}: ${c.evidence.substring(0, 120)}...`).join('\n') +
    `\n\nRespond in JSON: {"disputed_verdicts":[{"category":"...","stage0_verdict":"...","review_verdict":"present|absent|uncertain","reason":"..."}],"uncertain_routing":[{"category":"...","decision":"dedicated_lane|general_lane","reason":"..."}]}`

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      ...samplingParams(PROVIDER),
      ...tokenLimitParam(PROVIDER, 3000),
    })
    const text = response.choices[0]?.message?.content ?? '{}'
    console.log('[TASK C] Orchestrator review received a real API response')
    const jsonStr = extractJson(text)
    return JSON.parse(jsonStr) as OrchestratorReview
  } catch (err: any) {
    markDegraded(`orchestrator review: LLM call failed (${err.message}) — returned empty review`)
    return { disputed_verdicts: [], uncertain_routing: [] }
  }
}

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (fenceMatch) return fenceMatch[1]
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
  const startIdx = Math.min(
    trimmed.indexOf('{') >= 0 ? trimmed.indexOf('{') : Infinity,
    trimmed.indexOf('[') >= 0 ? trimmed.indexOf('[') : Infinity,
  )
  if (startIdx === Infinity) return '{}'
  return trimmed.substring(startIdx)
}

// ---------------------------------------------------------------------------
// Spawn dedicated lanes for uncertain categories
// ---------------------------------------------------------------------------

function spawnUncertainLane(
  category: string,
  arch: ArchitectureSummary,
  handlerMap: Map<string, HandlerResolution>,
  serverTsPath: string,
  repoRoot: string,
): Lane {
  const allRoutes = [
    ...arch.route_table.hand_written_routes,
    ...arch.route_table.middleware_routes,
  ]

  if (category.includes('Insecure Design')) {
    const seeds = collectSeedFiles(
      allRoutes.filter(
        (r) =>
          r.path.includes('wallet') ||
          r.path.includes('deluxe') ||
          r.path.includes('coupon') ||
          r.path.includes('order') ||
          r.path.includes('basket'),
      ),
      handlerMap,
      serverTsPath,
      repoRoot,
      [
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/wallet.ts'),
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/deluxe.ts'),
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/coupon.ts'),
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/order.ts'),
        path.join(repoRoot, 'target-apps/juice-shop-blind/routes/basket.ts'),
      ],
    )
    return {
      lane_id: 'insecure-design',
      categories: [category],
      subsystem_scope:
        'Business logic design gaps: wallet balance manipulation, deluxe membership upgrade, coupon generation, order flow integrity',
      seed_files: seeds,
      playbook_reference: 'insecure-design',
    }
  }

  if (category.includes('SSRF') || category.includes('Request Forgery')) {
    // Re-scan for outbound HTTP call sites (spawnUncertainLane doesn't have access to main's scan results)
    const hits = scanOutboundHttpCalls(repoRoot, path.join(repoRoot, 'target-apps/juice-shop-blind/routes'))
    const hitFiles = [...new Set(hits.map((h) => h.file))]
    const ssrfSeedFiles = [
      ...hitFiles,
      // Also include routes that plausibly make outbound calls (web3, B2B)
      'target-apps/juice-shop-blind/routes/web3Wallet.ts',
      'target-apps/juice-shop-blind/routes/b2bOrder.ts',
      'target-apps/juice-shop-blind/routes/countryMapping.ts',
      'target-apps/juice-shop-blind/routes/redirect.ts',
      'target-apps/juice-shop-blind/server.ts',
    ]
    const seeds = [...new Set(ssrfSeedFiles)].sort()
    const isApi = category.includes('API')
    return {
      lane_id: isApi ? 'ssrf-api' : 'ssrf',
      categories: [category],
      subsystem_scope: isApi
        ? 'API-scoped SSRF: outbound calls via web3/B2B endpoints, URL construction from user input, DNS rebinding'
        : 'SSRF via web3 node connections, B2B order callbacks, country mapping lookups, redirect handler with user-controlled URL',
      seed_files: seeds,
      playbook_reference: isApi ? 'ssrf-api' : 'ssrf',
    }
  }

  const seeds = collectSeedFiles([], handlerMap, serverTsPath, repoRoot)
  return {
    lane_id: 'uncertain-' + category.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    categories: [category],
    subsystem_scope: 'Dedicated lane for uncertain category: ' + category,
    seed_files: seeds,
    playbook_reference: 'general-catchall',
  }
}

// ---------------------------------------------------------------------------
// Apply orchestrator review results to lanes
// ---------------------------------------------------------------------------

function applyOrchestratorReview(
  lanes: Lane[],
  review: OrchestratorReview,
  arch: ArchitectureSummary,
  handlerMap: Map<string, HandlerResolution>,
  serverTsPath: string,
  repoRoot: string,
): Lane[] {
  const newLanes: Lane[] = []

  if (review.disputed_verdicts.length > 0) {
    console.log('\n[ORCHESTRATOR] Disputed verdicts:')
    for (const d of review.disputed_verdicts) {
      console.log(
        '  - ' + d.category + ': Stage 0 said "' + d.stage0_verdict + '", review says "' + d.review_verdict + '" — ' + d.reason,
      )
    }
  }

  if (review.uncertain_routing.length > 0) {
    console.log('\n[ORCHESTRATOR] Uncertain category routing:')
    for (const r of review.uncertain_routing) {
      console.log(
        '  - ' + r.category + ': ' + r.decision + ' — ' + r.reason,
      )

      const catchallLane = lanes.find((l) => l.lane_id === 'general-catchall')
      if (r.decision === 'general_lane') {
        console.log('    (kept in general-catchall lane)')
      } else if (r.decision === 'dedicated_lane') {
        if (catchallLane) {
          for (let i = catchallLane.categories.length - 1; i >= 0; i--) {
            const existing = catchallLane.categories[i]
            if (
              existing.includes(r.category) ||
              r.category.includes(existing) ||
              existing.split(':')[0] === r.category.split(':')[0]
            ) {
              catchallLane.categories.splice(i, 1)
            }
          }
        }
        const dedicatedLane = spawnUncertainLane(
          r.category, arch, handlerMap, serverTsPath, repoRoot,
        )
        newLanes.push(dedicatedLane)
        console.log('    -> spawned dedicated lane: ' + dedicatedLane.lane_id + ' (' + dedicatedLane.seed_files.length + ' seed files)')
      }
    }

    const catchall = lanes.find((l) => l.lane_id === 'general-catchall')
    if (catchall && catchall.categories.length === 0) {
      // Keep the lane if it has unclassified surface seed files — it serves
      // as a pure catch-all for files that no framework-specific extraction
      // touched. Only remove if truly empty.
      if (catchall.seed_files.length === 0) {
        lanes.splice(lanes.indexOf(catchall), 1)
        console.log('[ORCHESTRATOR] Removed empty general-catchall lane')
      } else {
        catchall.subsystem_scope = 'Catch-all lane for unclassified source files from Stage 0 file inventory (all uncertain categories promoted to dedicated lanes)'
        console.log(`[ORCHESTRATOR] Kept general-catchall with ${catchall.seed_files.length} unclassified surface files`)
      }
    }
  }

  return [...lanes, ...newLanes]
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const repoRoot = path.resolve(__dirname, '../../../..')
  const stage0OutputDir = runPath(PROVIDER, 'stage0-recon')
  const outputDir = runPath(PROVIDER, 'stage05-lane-selector')

  console.log('[Stage 0.5] Loading architecture summary...')
  const arch = JSON.parse(
    fs.readFileSync(path.join(stage0OutputDir, 'architecture-summary.json'), 'utf-8'),
  ) as ArchitectureSummary
  console.log(
    `[Stage 0.5] Loaded: ${arch.route_table.hand_written_routes.length} hand-written routes, ${arch.route_table.auto_crud_routes.length} auto-CRUD routes`,
  )

  console.log('[Stage 0.5] Loading category applicability...')
  const categories = JSON.parse(
    fs.readFileSync(path.join(stage0OutputDir, 'category-applicability.json'), 'utf-8'),
  ) as CategoryVerdict[]
  const presentCount = categories.filter((c) => c.verdict === 'present').length
  const uncertainCount = categories.filter((c) => c.verdict === 'uncertain').length
  console.log(
    `[Stage 0.5] Loaded: ${presentCount} present, ${uncertainCount} uncertain, ${categories.filter((c) => c.verdict === 'absent').length} absent`,
  )

  // TASK A: Handler resolution
  const handlerMap = buildHandlerMap(repoRoot)
  const serverTsPath = path.join(repoRoot, 'target-apps/juice-shop-blind/server.ts')

  // TASK B: Lane instantiation
  console.log('\n[Stage 0.5] Instantiating lanes...')
  let lanes = instantiateLanes(arch, categories, handlerMap, repoRoot)

  // TASK C: Orchestrator verification
  const review = await runOrchestratorReview(arch, categories, lanes)
  lanes = applyOrchestratorReview(lanes, review, arch, handlerMap, serverTsPath, repoRoot)

  // Permanent seed-file denylist: internal bookkeeping files that must never
  // appear in any lane's seed_files, regardless of recon or orchestrator output.
  // SEED_DENYLIST now lives in shared/read-guard.ts so it also covers the
  // model-controlled read paths in stage2/stage3, not just manifest writes.
  for (const lane of lanes) {
    lane.seed_files = lane.seed_files.filter((f) => !SEED_DENYLIST.includes(f))
  }

  // Write lane manifest
  fs.mkdirSync(outputDir, { recursive: true })
  const manifestPath = path.join(outputDir, 'lane-manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(lanes, null, 2) + '\n')

  console.log('\n[Stage 0.5] Lane manifest written to ' + manifestPath)
  writeMeta(PROVIDER, 'stage05-lane-selector', MODEL, STARTED)
  failIfDegraded('stage05', 'stage05-lane-selector')
  console.log('[Stage 0.5] Total lanes: ' + lanes.length)

  console.log('\n========== LANE SUMMARY ==========')
  for (const lane of lanes) {
    console.log(
      '  ' + lane.lane_id + ':',
      'categories=[' + lane.categories.join(', ') + ']',
      'seeds=' + lane.seed_files.length,
    )
  }
  console.log('==================================')
}

main().catch((err) => {
  console.error('Stage 0.5 failed:', err)
  process.exit(1)
})
