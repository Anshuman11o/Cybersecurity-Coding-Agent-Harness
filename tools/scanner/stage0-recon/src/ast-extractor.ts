/**
 * Deterministic AST-based static extraction via ts-morph.
 * Extracts route registrations (app.<method>(...)) and auto-CRUD routes
 * from a given server.ts entry point.
 */
import { Project, Node, CallExpression, SyntaxKind, Expression } from 'ts-morph'
import * as fs from 'fs'

export interface RouteEntry {
  method: string
  routePath: string
  handler: string | null        // imported handler name or null
  middleware: string[]           // middleware function names found in the call chain
  auth: string | null           // auth middleware indicator
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
}

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
 * Given a server.ts file path, extract all route registrations and auto-CRUD definitions.
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

  // 1. Extract all route registrations: app.<method>(...) or app.use(...)
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)

  for (const call of callExpressions) {
    const expr = call.getExpression()

    // Match app.<method>('path', ...) pattern
    if (Node.isPropertyAccessExpression(expr)) {
      const propName = expr.getName()
      const objText = expr.getExpression().getText()

      // Direct route methods: app.get, app.post, app.put, app.delete, app.patch, app.use
      const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']
      if (objText === 'app' && httpMethods.includes(propName)) {
        const args = call.getArguments()
        if (args.length >= 1) {
          const routePath = extractStringLiteral(args[0])
          if (routePath) {
            const middlewares = args.slice(1).map(a => a.getText())
            const authMiddleware = detectAuthMiddleware(middlewares)
            const handler = extractHandlerName(args[args.length - 1])
            routes.push({
              method: propName.toUpperCase(),
              routePath,
              handler,
              middleware: middlewares,
              auth: authMiddleware,
              file: relPath,
              line: call.getStartLineNumber(),
            })
          }
        }
      }

      // app.route('/path').get/post/etc(...) pattern
      if (objText.startsWith('app.route(') ||
          (Node.isCallExpression(expr.getExpression()) &&
           expr.getExpression().getExpression().getText() === 'app' &&
           expr.getExpression().getName() === 'route')) {
        const routeCall = expr.getExpression()
        if (Node.isCallExpression(routeCall)) {
          const routeArgs = routeCall.getArguments()
          const routePath = extractStringLiteral(routeArgs[0])
          if (routePath) {
            const methodArgs = call.getArguments()
            const middlewares = methodArgs.map(a => a.getText())
            const authMiddleware = detectAuthMiddleware(middlewares)
            const handler = extractHandlerName(methodArgs[methodArgs.length - 1])
            routes.push({
              method: propName.toUpperCase(),
              routePath,
              handler,
              middleware: middlewares,
              auth: authMiddleware,
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
          const modelText = modelProp ? modelProp.getInitializer()?.getText() : null

          // Check if endpoints is a template expression (it is in this app)
          // If so, we'll resolve it from autoModels instead
          let endpoints: string[] = []
          const endpointsInit = endpointsProp ? endpointsProp.getInitializer() : null
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
              ? paginationProp.getInitializer()?.getText() !== 'false'
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

    // Also handle app.use('/path', ...) as a catch-all for middleware
    if (Node.isPropertyAccessExpression(expr) &&
        expr.getName() === 'use' &&
        expr.getExpression().getText() === 'app') {
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
          const authMiddleware = detectAuthMiddleware(middlewares)
          routes.push({
            method: 'USE',
            routePath,
            handler: null,
            middleware: middlewares,
            auth: authMiddleware,
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

  return { routes, autoCrudRoutes, persistence, dependencies }
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

function detectAuthMiddleware(middlewares: string[]): string | null {
  const authPatterns = ['isAuthorized', 'isAccounting', 'appendUserId', 'jwtChallenges',
    'denyAll', 'updateAuthenticatedUsers']
  for (const m of middlewares) {
    for (const pattern of authPatterns) {
      if (m.includes(pattern)) return m
    }
  }
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

function makeRelativePath(absPath: string): string {
  const idx = absPath.indexOf('target-apps/')
  if (idx >= 0) return absPath.substring(idx)
  return absPath
}

/**
 * Extract dependencies from a package.json file.
 */
export function extractDependencies(packageJsonPath: string): DependencyInfo[] {
  const content = fs.readFileSync(packageJsonPath, 'utf-8')
  const pkg = JSON.parse(content)
  const deps: DependencyInfo[] = []
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    deps.push({ name, version })
  }
  for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
    deps.push({ name, version })
  }
  return deps
}
