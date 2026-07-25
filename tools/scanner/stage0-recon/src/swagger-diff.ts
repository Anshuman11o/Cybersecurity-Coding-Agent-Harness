/**
 * Diff AST-derived route table against swagger.yml declared paths.
 * Returns which surfaces are undocumented by the spec.
 */
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import type { RouteEntry, AutoCrudEntry } from './ast-extractor.js'

export interface UndocumentedSurface {
  type: 'hand-written' | 'auto-crud' | 'middleware'
  method: string
  routePath: string
  file: string
  line: number
}

export interface SwaggerDiffResult {
  documentedPaths: string[]
  undocumentedSurfaces: UndocumentedSurface[]
  coverageNote: string
}

/**
 * Parse swagger.yml and compare against the extracted routes.
 */
export function diff(
  swaggerPath: string,
  routes: RouteEntry[],
  autoCrudRoutes: AutoCrudEntry[],
): SwaggerDiffResult {
  const swaggerContent = fs.readFileSync(swaggerPath, 'utf-8')
  const swagger = yaml.load(swaggerContent) as any

  // Extract documented paths from swagger
  const documentedPaths: string[] = []
  const swaggerBase = swagger.servers?.[0]?.url ?? ''
  const paths = swagger.paths ?? {}

  for (const [pathKey] of Object.entries(paths)) {
    const fullPath = swaggerBase ? `${swaggerBase}${pathKey}` : pathKey
    documentedPaths.push(fullPath)
  }

  const undocumentedSurfaces: UndocumentedSurface[] = []

  // Check hand-written routes
  const routePaths = new Set(documentedPaths)
  for (const route of routes) {
    if (route.routePath === '*') continue // Skip catch-all for this diff
    // Normalize: remove trailing slashes, handle base paths
    const normalizedPath = normalizePath(route.routePath)
    let found = false
    for (const docPath of documentedPaths) {
      if (pathsMatch(normalizedPath, docPath)) {
        found = true
        break
      }
    }
    if (!found && route.method !== 'USE') {
      undocumentedSurfaces.push({
        type: 'hand-written',
        method: route.method,
        routePath: route.routePath,
        file: route.file,
        line: route.line,
      })
    }
  }

  // Check auto-CRUD routes
  for (const ac of autoCrudRoutes) {
    const normalizedPath = normalizePath(ac.pathPattern)
    let found = false
    for (const docPath of documentedPaths) {
      if (pathsMatch(normalizedPath, docPath)) {
        found = true
        break
      }
    }
    if (!found) {
      undocumentedSurfaces.push({
        type: 'auto-crud',
        method: ac.method,
        routePath: ac.pathPattern,
        file: ac.file,
        line: ac.line,
      })
    }
  }

  const coverageNote = generateCoverageNote(documentedPaths, undocumentedSurfaces)

  return { documentedPaths, undocumentedSurfaces, coverageNote }
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '').replace(/^\/+/, '/')
}

function pathsMatch(actual: string, documented: string): boolean {
  // Exact match
  if (actual === documented) return true
  // Parameterized match: /api/Users matches /api/Users/:id? No, but /api/Users/:id matches /api/Users/:id
  const actualParts = actual.split('/').filter(Boolean)
  const docParts = documented.split('/').filter(Boolean)

  if (actualParts.length !== docParts.length) return false

  for (let i = 0; i < actualParts.length; i++) {
    const a = actualParts[i]
    const d = docParts[i]
    // Parameters match any segment
    if (d.startsWith(':') || a.startsWith(':')) continue
    if (a !== d) return false
  }
  return true
}

function generateCoverageNote(documentedPaths: string[], undocumented: UndocumentedSurface[]): string {
  const hwCount = undocumented.filter(u => u.type === 'hand-written').length
  const acCount = undocumented.filter(u => u.type === 'auto-crud').length

  if (documentedPaths.length === 0) {
    return 'No API documentation found in swagger.yml'
  }

  let note = `Swagger documents ${documentedPaths.length} path(s). `
  if (hwCount > 0) {
    note += `${hwCount} hand-written route(s) are undocumented. `
  }
  if (acCount > 0) {
    note += `${acCount} auto-CRUD route(s) are undocumented. `
  }
  if (hwCount === 0 && acCount === 0) {
    note += 'All extracted routes appear to be covered.'
  }
  return note
}
