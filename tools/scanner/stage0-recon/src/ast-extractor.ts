/**
 * Express framework enricher: deterministic AST extraction via ts-morph.
 *
 * Optional in recon v3 — it runs only when detectExpress() finds an express
 * dependency and an entry file. Extracts route registrations
 * (<receiver>.<method>(...), <receiver>.use(...), <receiver>.route(...)) and
 * finale auto-CRUD routes from that one entry file.
 *
 * Routes come out with `auth: null`. Which middleware counts as authentication
 * is not something this file decides any more: it used to carry a fixed list of
 * one application's guard names, which tagged nothing in any other codebase.
 * The architecture call names the target's own auth identifiers, validation
 * keeps the ones that exist, and tagRouteAuth() applies them.
 */
import { Project, Node, SyntaxKind, Expression, PropertyAccessExpression, PropertyAssignment, SourceFile } from 'ts-morph'
import * as fs from 'fs'
import * as path from 'path'
import { getRunContext, isBenchmark } from '../../shared/run-context.js'

export interface RouteEntry {
  method: string
  routePath: string
  handler: string | null        // imported handler name or null
  middleware: string[]           // middleware function names found in the call chain
  auth: string | null           // auth middleware, set by tagRouteAuth(); null from extract()
  file: string                   // source file (repo-relative)
  line: number
}

export interface AutoCrudEntry {
  method: 'ALL'                  // finale-resource exposes full CRUD
  pathPattern: string            // e.g. /api/Users, /api/Users/:id
  model: string
  excludeAttributes: string[]
  hasPagination: boolean
  hasCustomHooks: boolean        // whether custom hooks (before/after) are attached
  file: string
  line: number
}

export interface PersistenceLayerInfo {
  orm: string
  database: string
  models: string[]
  rawQueries: boolean
  rawQueryFiles: string[]
}

export interface DependencyInfo {
  name: string
  version: string | null
}

export interface AstExtractionResult {
  routes: RouteEntry[]
  autoCrudRoutes: AutoCrudEntry[]
  persistence: PersistenceLayerInfo
  dependencies: DependencyInfo[]
  /** Identifiers whose method calls were read as route registrations. */
  receivers: string[]
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface ExpressDetection {
  isExpress: boolean
  /** Absolute path of the entry file, or null. */
  entryFile: string | null
  reason: string
}

/** Conventional entry-file stems, in the order they are tried, at the root and then in src/. */
const ENTRY_STEMS = ['server', 'app', 'index', 'main']
const ENTRY_DIRS = ['', 'src/']
/** .ts first: the order before recon v3 was .ts only, so a TypeScript entry still wins. */
const ENTRY_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs']

/** Target-relative entry-file candidates, in priority order. */
export function expressEntryCandidates(): string[] {
  const out: string[] = []
  for (const dir of ENTRY_DIRS) {
    for (const stem of ENTRY_STEMS) {
      for (const ext of ENTRY_EXTENSIONS) out.push(`${dir}${stem}${ext}`)
    }
  }
  return out
}

/**
 * Detect whether the target looks like an Express application: an `express`
 * dependency in the root package.json plus an entry file. The entry file is
 * the first conventional name that exists, else the package.json `main`
 * target. `isSelected`, when given, must accept the candidate — recon passes
 * inventory membership so an ignored or build-output file is never parsed.
 */
export function detectExpress(
  targetDir: string,
  isSelected: (relPath: string) => boolean = () => true,
): ExpressDetection {
  const pkgPath = path.join(targetDir, 'package.json')
  let pkg: any

  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch {
    return { isExpress: false, entryFile: null, reason: 'No package.json found in target directory' }
  }

  const allDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]
  if (!allDeps.includes('express')) {
    return { isExpress: false, entryFile: null, reason: 'No "express" dependency in package.json' }
  }

  const exists = (rel: string) => {
    try { return fs.statSync(path.join(targetDir, rel)).isFile() } catch { return false }
  }

  for (const candidate of expressEntryCandidates()) {
    if (exists(candidate) && isSelected(candidate)) {
      return { isExpress: true, entryFile: path.join(targetDir, candidate), reason: `Express dependency + entry file "${candidate}" found` }
    }
  }

  // The declared entry, when none of the conventional names exist. An
  // extensionless main ("main": "lib/server") resolves the way Node would.
  if (typeof pkg.main === 'string' && pkg.main.trim()) {
    const main = path.posix.normalize(pkg.main.trim().replace(/\\/g, '/')).replace(/^\.\//, '')
    if (!main.startsWith('../') && !path.posix.isAbsolute(main)) {
      const variants = path.posix.extname(main) ? [main] : [main, ...ENTRY_EXTENSIONS.map(e => main + e)]
      for (const candidate of variants) {
        if (exists(candidate) && isSelected(candidate)) {
          return { isExpress: true, entryFile: path.join(targetDir, candidate), reason: `Express dependency + package.json main "${candidate}" found` }
        }
      }
    }
  }

  return {
    isExpress: false,
    entryFile: null,
    reason: 'Express dependency found but no entry file: none of server/app/index/main (.ts/.js/.mjs/.cjs, at the root or in src/) exists, and package.json "main" does not name one',
  }
}

// ---------------------------------------------------------------------------
// Route receivers
// ---------------------------------------------------------------------------

/** Calls whose result is something routes are registered on. */
const ROUTER_FACTORIES = new Set(['express', 'express.Router', 'Router'])

/** `express() as Express`, `(express())`, `express()!` — look through the wrapper. */
function unwrapExpression(node: Node): Node {
  let n = node
  while (
    Node.isAsExpression(n) || Node.isParenthesizedExpression(n) ||
    Node.isNonNullExpression(n) || Node.isSatisfiesExpression(n) || Node.isTypeAssertion(n)
  ) {
    n = n.getExpression()
  }
  return n
}

/**
 * The identifiers routes are registered on: every variable initialised from
 * express(), express.Router() or Router() in the file, in declaration order.
 * Falls back to `app` — the name nearly every Express tutorial uses — when the
 * file creates none itself (an app handed in from another module).
 */
export function findRouteReceivers(sourceFile: SourceFile): string[] {
  const names: string[] = []
  for (const vd of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer()
    if (!init) continue
    const call = unwrapExpression(init)
    if (!Node.isCallExpression(call)) continue
    if (!ROUTER_FACTORIES.has(call.getExpression().getText())) continue
    const nameNode = vd.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue
    const name = nameNode.getText()
    if (!names.includes(name)) names.push(name)
  }
  return names.length > 0 ? names : ['app']
}

// ---------------------------------------------------------------------------
// Auth tagging
// ---------------------------------------------------------------------------

const IDENT_CHAR = 'A-Za-z0-9_$'

/**
 * The part of an auth identifier that appears at a call site: the last dotted
 * segment, without decorator/attribute syntax or arguments.
 *   auth.requireUser        -> requireUser
 *   @login_required         -> login_required
 *   [Authorize(Roles="A")]  -> Authorize
 * Null when nothing identifier-shaped is left.
 */
export function identifierKey(identifier: string): string | null {
  let s = identifier.trim().replace(/^@+/, '')
  const bracketed = s.match(/^\[(.*)\]$/s)
  if (bracketed) s = bracketed[1].trim()
  s = s.replace(/\(.*\)$/s, '').trim()
  const parts = s.split(/\.|::|->|#/).filter(Boolean)
  const last = parts[parts.length - 1]
  return last && new RegExp(`^[A-Za-z_$][${IDENT_CHAR}]*$`).test(last) ? last : null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when `word` occurs in `text` as a whole identifier: `requireUser` is in
 * `auth.requireUser()`, `login` is not in `loginRateLimit`. `$` counts as
 * an identifier character, as it does in JavaScript.
 */
export function containsWholeWord(text: string, word: string): boolean {
  return new RegExp(`(?<![${IDENT_CHAR}])${escapeRegExp(word)}(?![${IDENT_CHAR}])`).test(text)
}

/**
 * Set each route's `auth` to the first middleware text containing a whole-word
 * match of an identifier's last dotted segment, else null. Returns new route
 * objects; the input is not modified. With no identifiers every route is null —
 * "auth unknown" and "no auth" are the same thing to a reader of the table, so
 * nothing is tagged on a guess.
 *
 * A route whose `handler` was resolved has that handler as its last argument,
 * and a handler is never its own guard: the architecture call may rightly list
 * the login handler as part of authentication, and without this exclusion
 * `post('/login', loginRateLimit, login)` would read as guarded by `login`.
 * USE registrations and routes with no resolved handler keep every argument
 * in play — there a lone guard call such as `requireAdmin()` is the guard,
 * not a handler.
 */
export function tagRouteAuth<T extends { middleware: string[]; auth?: string | null; handler?: string | null }>(
  routes: readonly T[],
  identifiers: readonly string[],
): T[] {
  const keys = [...new Set(identifiers.map(identifierKey).filter((k): k is string => k !== null))]
  return routes.map(r => {
    const args = r.middleware ?? []
    const guards = r.handler ? args.slice(0, -1) : args
    const auth = keys.length === 0
      ? null
      : guards.find(mw => keys.some(k => containsWholeWord(mw, k))) ?? null
    return { ...r, auth }
  })
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a string literal from a ts-morph expression.
 * Handles simple string literals, template literals, and variable references.
 */
function extractStringLiteral(expr: Expression | undefined): string | null {
  if (!expr) return null
  if (Node.isStringLiteral(expr)) return expr.getLiteralText()
  if (Node.isPropertyAccessExpression(expr)) return expr.getText()
  if (Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralText()
  if (Node.isTemplateExpression(expr)) {
    // For template expressions like `/api/${name}s`, return the raw text
    return expr.getText()
  }
  return null
}

/**
 * Given an Express entry file, extract all route registrations and auto-CRUD
 * definitions. Every route's `auth` is null; see tagRouteAuth().
 */
export function extract(serverTsPath: string): AstExtractionResult {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: false,
    compilerOptions: {
      allowJs: true,
      skipLibCheck: true,
      noEmit: true,
      strict: false,
      esModuleInterop: true,
      moduleResolution: 100, // NodeNext
    },
  })

  const sourceFile = project.addSourceFileAtPath(serverTsPath)
  const relPath = makeRelativePath(serverTsPath)

  const routes: RouteEntry[] = []
  const autoCrudRoutes: AutoCrudEntry[] = []

  // ---- Extract autoModels array first (needed for auto-CRUD resolution) ----
  const autoModelsData = extractAutoModelsArray(sourceFile)

  // Which identifiers are routers. Before recon v3 this was the literal `app`.
  // A second express() instance that is only configured (.set(), passed to a
  // helper) adds nothing: only HTTP-method, .use() and .route() calls are read.
  const receivers = findRouteReceivers(sourceFile)
  const isReceiver = (text: string) => receivers.includes(text)

  // 1. Extract all route registrations: <receiver>.<method>(...) or <receiver>.use(...)
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)

  for (const call of callExpressions) {
    const expr = call.getExpression()

    // Match <receiver>.<method>('path', ...) pattern
    if (Node.isPropertyAccessExpression(expr)) {
      const propName = expr.getName()
      const objText = expr.getExpression().getText()

      // Direct route methods: app.get, app.post, app.put, app.delete, app.patch, app.use
      const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']
      if (isReceiver(objText) && httpMethods.includes(propName)) {
        const args = call.getArguments()
        if (args.length >= 1) {
          const routePath = extractStringLiteral(args[0] as Expression)
          if (routePath) {
            const middlewares = args.slice(1).map(a => a.getText())
            const handler = extractHandlerName(args[args.length - 1] as Expression)
            routes.push({
              method: propName.toUpperCase(),
              routePath,
              handler,
              middleware: middlewares,
              auth: null,
              file: relPath,
              line: call.getStartLineNumber(),
            })
          }
        }
      }

      // <receiver>.route('/path').get/post/etc(...) pattern
      const inner = expr.getExpression()
      if (receivers.some(r => objText.startsWith(`${r}.route(`)) ||
          (Node.isCallExpression(inner) &&
           Node.isPropertyAccessExpression(inner.getExpression()) &&
           isReceiver((inner.getExpression() as PropertyAccessExpression).getExpression().getText()) &&
           (inner.getExpression() as PropertyAccessExpression).getName() === 'route')) {
        const routeCall = expr.getExpression()
        if (Node.isCallExpression(routeCall)) {
          const routeArgs = routeCall.getArguments()
          const routePath = extractStringLiteral(routeArgs[0] as Expression)
          if (routePath) {
            const methodArgs = call.getArguments()
            const middlewares = methodArgs.map(a => a.getText())
            const handler = extractHandlerName(methodArgs[methodArgs.length - 1] as Expression)
            routes.push({
              method: propName.toUpperCase(),
              routePath,
              handler,
              middleware: middlewares,
              auth: null,
              file: relPath,
              line: call.getStartLineNumber(),
            })
          }
        }
      }

      // finale.resource({...}) - auto-CRUD
      if (objText === 'finale' && propName === 'resource') {
        const args = call.getArguments()
        if (args.length >= 1 && Node.isObjectLiteralExpression(args[0])) {
          const obj = args[0]
          const modelProp = obj.getProperty('model')
          const endpointsProp = obj.getProperty('endpoints')
          const excludeProp = obj.getProperty('excludeAttributes')
          const paginationProp = obj.getProperty('pagination')

          // The model property is likely a loop variable reference (e.g. 'model' from for...of loop)
          // We need to resolve it from the autoModels array
          // Type-only casts below: the property may be shorthand (`{ model }`); runtime is as before.
          const modelText = modelProp ? (modelProp as PropertyAssignment).getInitializer()?.getText() : null

          // Check if endpoints is a template expression (it is in this app)
          // If so, we'll resolve it from autoModels instead
          let endpoints: string[] = []
          const endpointsInit = endpointsProp ? (endpointsProp as PropertyAssignment).getInitializer() : null
          if (endpointsInit && Node.isArrayLiteralExpression(endpointsInit)) {
            const els = endpointsInit.getElements()
            for (const el of els) {
              const s = extractStringLiteral(el)
              if (s) endpoints.push(s)
            }
          }

          // Check if endpoints are template literals (e.g. `/api/${name}s`)
          // If so, resolve from autoModels
          const hasTemplateEndpoints = endpoints.some(e => e.includes('${'))

          if (hasTemplateEndpoints && autoModelsData.length > 0) {
            // Resolve concrete endpoints from autoModels
            for (const am of autoModelsData) {
              for (const epTemplate of endpoints) {
                // Simple template resolution: replace ${name} with am.name
                const resolvedPath = epTemplate.replace(/`/g, '')
                  .replace(/\$\{name\}/g, am.name)
                  .replace(/\$\{name\.toLowerCase\(\)\}/g, am.name.toLowerCase())
                autoCrudRoutes.push({
                  method: 'ALL',
                  pathPattern: resolvedPath,
                  model: am.modelName,
                  excludeAttributes: am.excludeAttributes,
                  hasPagination: am.hasPagination,
                  hasCustomHooks: false, // Will be updated below
                  file: relPath,
                  line: call.getStartLineNumber(),
                })
              }
            }
          } else if (!hasTemplateEndpoints && endpoints.length > 0) {
            // Static endpoints -- also extract exclude/pagination from properties
            const excludeAttrs: string[] = []
            if (excludeProp && Node.isPropertyAssignment(excludeProp)) {
              const val = excludeProp.getInitializer()
              if (val && Node.isArrayLiteralExpression(val)) {
                for (const el of val.getElements()) {
                  const s = extractStringLiteral(el)
                  if (s) excludeAttrs.push(s)
                }
              }
            }

            const hasPagination = paginationProp
              ? (paginationProp as PropertyAssignment).getInitializer()?.getText() !== 'false'
              : true

            for (const ep of endpoints) {
              autoCrudRoutes.push({
                method: 'ALL',
                pathPattern: ep,
                model: modelText || 'unknown',
                excludeAttributes: excludeAttrs,
                hasPagination,
                hasCustomHooks: false,
                file: relPath,
                line: call.getStartLineNumber(),
              })
            }
          }
        }
      }
    }

    // Also handle <receiver>.use('/path', ...) as a catch-all for middleware
    if (Node.isPropertyAccessExpression(expr) &&
        expr.getName() === 'use' &&
        isReceiver(expr.getExpression().getText())) {
      const args = call.getArguments()
      if (args.length >= 1) {
        const firstArg = args[0]
        let routePath: string | null = null
        let startIndex = 0
        if (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg)) {
          routePath = extractStringLiteral(firstArg)
          startIndex = 1
        } else if (Node.isArrayLiteralExpression(firstArg)) {
          const paths: string[] = []
          for (const el of firstArg.getElements()) {
            const s = extractStringLiteral(el)
            if (s) paths.push(s)
          }
          if (paths.length > 0) {
            routePath = paths.join(', ')
            startIndex = 1
          }
        }
        if (!routePath) {
          routePath = '*'
          startIndex = 0
        }

        if (routePath && startIndex < args.length) {
          const middlewares = args.slice(startIndex).map(a => a.getText())
          routes.push({
            method: 'USE',
            routePath,
            handler: null,
            middleware: middlewares,
            auth: null,
            file: relPath,
            line: call.getStartLineNumber(),
          })
        }
      }
    }
  }

  // 2. Detect custom hooks on auto-CRUD resources
  const autoCrudHookCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(c => {
      const expr = c.getExpression()
      const text = expr.getText()
      return text.includes('resource.') &&
        (text.includes('.before(') || text.includes('.after('))
    })

  if (autoCrudHookCalls.length > 0) {
    for (const ac of autoCrudRoutes) {
      ac.hasCustomHooks = true
    }
  }

  // 3. Extract persistence layer info
  const persistence = extractPersistenceInfo(sourceFile, serverTsPath)

  // 4. Dependencies filled by caller
  const dependencies: DependencyInfo[] = []

  return { routes, autoCrudRoutes, persistence, dependencies, receivers }
}

/**
 * Extract the autoModels array from server.ts.
 * This resolves the concrete model names, exclude lists, and pagination settings
 * that are used in the finale.resource() for-loop.
 */
function extractAutoModelsArray(sourceFile: any): {
  name: string
  modelName: string
  excludeAttributes: string[]
  hasPagination: boolean
}[] {
  const results: { name: string; modelName: string; excludeAttributes: string[]; hasPagination: boolean }[] = []

  // Find the variable declaration: const autoModels = [...]
  const varDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
  for (const vd of varDeclarations) {
    if (vd.getName() === 'autoModels') {
      const initializer = vd.getInitializer()
      if (initializer && Node.isArrayLiteralExpression(initializer)) {
        for (const element of initializer.getElements()) {
          if (Node.isObjectLiteralExpression(element)) {
            let name = 'unknown'
            let modelName = 'unknown'
            const excludeAttributes: string[] = []
            let hasPagination = true

            for (const prop of element.getProperties()) {
              if (Node.isPropertyAssignment(prop)) {
                const key = prop.getName()
                const init = prop.getInitializer()
                const initText = init?.getText() ?? ''

                if (key === 'name' && init) {
                  name = extractStringLiteral(init) ?? initText.replace(/['"]/g, '')
                } else if (key === 'model' && init) {
                  // Extract model name from "UserModel" -> "User"
                  const modelText = initText
                  const match = modelText.match(/^(\w+)Model$/)
                  modelName = match ? match[1] : modelText
                } else if (key === 'exclude' && init && Node.isArrayLiteralExpression(init)) {
                  for (const el of init.getElements()) {
                    const s = extractStringLiteral(el)
                    if (s) excludeAttributes.push(s)
                  }
                } else if (key === 'excludeAttributes' && init && Node.isArrayLiteralExpression(init)) {
                  for (const el of init.getElements()) {
                    const s = extractStringLiteral(el)
                    if (s) excludeAttributes.push(s)
                  }
                } else if (key === 'pagination' && init) {
                  hasPagination = initText !== 'false'
                }
              }
            }

            results.push({ name, modelName, excludeAttributes, hasPagination })
          }
        }
      }
    }
  }

  return results
}

function extractHandlerName(arg: Expression): string | null {
  const text = arg.getText()
  // Handle utils.asyncHandler(someFunc()) or someFunc()
  const callMatch = text.match(/asyncHandler\(([^)]+)\)/)
  if (callMatch) return callMatch[1].replace(/\(\)$/, '')
  // Handle just someFunc()
  const simpleCall = text.match(/^(\w+)\(\)$/)
  if (simpleCall) return simpleCall[1]
  // Handle a named reference
  if (/^\w+$/.test(text)) return text
  return null
}

function extractPersistenceInfo(sourceFile: any, serverTsPath: string): PersistenceLayerInfo {
  const imports = sourceFile.getImportDeclarations()
  let orm = 'unknown'
  let database = 'unknown'
  const models: string[] = []
  let rawQueries = false
  const rawQueryFiles: string[] = []

  for (const imp of imports) {
    const module = imp.getModuleSpecifierValue()
    if (module.includes('sequelize')) {
      orm = 'sequelize'
    }
    if (module.includes('mongodb') || module.includes('mongo')) {
      database = 'mongodb'
    }
  }

  const allCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
  for (const call of allCalls) {
    const expr = call.getExpression()
    if (Node.isPropertyAccessExpression(expr)) {
      const name = expr.getName()
      if (name === 'query' || name === 'raw') {
        rawQueries = true
        rawQueryFiles.push(makeRelativePath(sourceFile.getFilePath()))
      }
    }
  }

  if (orm === 'unknown' && database === 'unknown') {
    for (const imp of imports) {
      const module = imp.getModuleSpecifierValue()
      if (module.startsWith('./models')) {
        if (orm === 'unknown') orm = 'sequelize'
        break
      }
    }
  }

  for (const imp of imports) {
    const module = imp.getModuleSpecifierValue()
    if (module.startsWith('./models')) {
      const namedImports = imp.getNamedImports()
      for (const ni of namedImports) {
        const name = ni.getName()
        const modelMatch = name.match(/^(\w+)Model$/)
        if (modelMatch) models.push(modelMatch[1])
      }
    }
  }

  database = orm === 'sequelize' ? 'sqlite/mysql/postgres' : database
  if (database === 'unknown' && orm === 'sequelize') database = 'sqlite (default)'

  return { orm, database, models, rawQueries, rawQueryFiles: [...new Set(rawQueryFiles)] }
}

/**
 * Benchmark: repo-relative ('target-apps/juice-shop-blind/server.ts'), as every
 * committed artifact records it. Product: relative to the target root
 * ('src/server.ts') — the target can live anywhere, so there is no repo prefix
 * to anchor on. Stage 2 matches either form by suffix.
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

/**
 * Extract dependencies from a package.json file.
 */
export function extractDependencies(packageJsonPath: string): DependencyInfo[] {
  const content = fs.readFileSync(packageJsonPath, 'utf-8')
  const pkg = JSON.parse(content)
  const deps: DependencyInfo[] = []
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    deps.push({ name, version: version as string | null })
  }
  for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
    deps.push({ name, version: version as string | null })
  }
  return deps
}
