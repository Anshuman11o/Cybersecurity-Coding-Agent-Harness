/**
 * TASK A: Resolve handler names to their actual source files.
 *
 * Stage 0's route table has handler names like 'searchProducts(' and
 * 'profileImageUrlUpload(' registered in server.ts, but those are just
 * import references. This pass uses ts-morph to walk server.ts's import
 * declarations and build a handler-name -> source-file-path map.
 */
import { Project, type SourceFile } from 'ts-morph'
import * as path from 'node:path'
import * as fs from 'node:fs'

export interface HandlerResolution {
  handlerName: string          // normalized (no trailing paren)
  sourceFile: string           // resolved path relative to repo root
  importKind: 'named' | 'namespace' | 'default'
}

/**
 * Build a map from handler name (as seen in route registrations) to the
 * actual source file that implements it, using ts-morph to parse imports.
 */
export function resolveHandlers(
  serverTsPath: string,
  repoRoot: string,
): Map<string, HandlerResolution> {
  const project = new Project({ skipAddingFilesFromTsConfig: true })
  const sourceFile = project.addSourceFileAtPath(serverTsPath)

  const handlerMap = new Map<string, HandlerResolution>()

  for (const stmt of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = stmt.getModuleSpecifierValue()
    // Skip node_modules imports
    if (!moduleSpecifier.startsWith('.')) continue

    // Resolve the module path to a real file
    const resolvedFile = resolveImportToFile(
      moduleSpecifier,
      serverTsPath,
      repoRoot,
    )
    if (!resolvedFile) continue

    // Named imports: import { foo, bar } from './routes/x'
    const namedImports = stmt.getNamedImports()
    for (const named of namedImports) {
      const name = named.getName()
      handlerMap.set(name, {
        handlerName: name,
        sourceFile: resolvedFile,
        importKind: 'named',
      })
    }

    // Default import: import { foo } from './routes/x' (named but default export)
    const defaultImport = stmt.getDefaultImport()
    if (defaultImport) {
      const name = defaultImport.getText()
      handlerMap.set(name, {
        handlerName: name,
        sourceFile: resolvedFile,
        importKind: 'default',
      })
    }

    // Namespace imports: import * as security from './lib/insecurity'
    const namespaceImport = stmt.getNamespaceImport()
    if (namespaceImport) {
      const nsName = namespaceImport.getText()
      // For namespace imports, register the namespace itself
      // (e.g., 'security' -> './lib/insecurity.ts')
      handlerMap.set(nsName, {
        handlerName: nsName,
        sourceFile: resolvedFile,
        importKind: 'namespace',
      })
    }
  }

  return handlerMap
}

/**
 * Resolve an import specifier to the actual file path on disk.
 */
function resolveImportToFile(
  moduleSpecifier: string,
  importingFile: string,
  repoRoot: string,
): string | null {
  const importDir = path.dirname(importingFile)
  const candidate = path.resolve(importDir, moduleSpecifier)

  // Try exact path, then .ts, then /index.ts
  const extensions = ['', '.ts', '.tsx', '.js']
  for (const ext of extensions) {
    const withExt = candidate + ext
    if (fs.existsSync(withExt)) {
      return path.relative(repoRoot, withExt)
    }
  }

  // Try as directory with index.ts
  const indexPath = path.join(candidate, 'index.ts')
  if (fs.existsSync(indexPath)) {
    return path.relative(repoRoot, indexPath)
  }

  return null
}

/**
 * Given a handler name as it appears in a route registration (possibly with
 * trailing parens or namespace prefix like 'security.isAuthorized()'),
 * resolve to the actual source file.
 */
export function resolveHandlerToFiles(
  handlerExpr: string | null,
  handlerMap: Map<string, HandlerResolution>,
  serverTsPath: string,
): string[] {
  if (!handlerExpr) return []

  // Strip trailing parens: 'searchProducts(' -> 'searchProducts'
  const cleaned = handlerExpr.replace(/\(.*$/, '').trim()

  // Direct match: handler name is an imported binding
  const direct = handlerMap.get(cleaned)
  if (direct) {
    return [direct.sourceFile]
  }

  // Namespace member: 'security.isAuthorized' -> look up 'security', return its file
  const dotIndex = cleaned.indexOf('.')
  if (dotIndex > 0) {
    const nsName = cleaned.substring(0, dotIndex)
    const ns = handlerMap.get(nsName)
    if (ns) {
      return [ns.sourceFile]
    }
  }

  // utils.asyncHandler(someHandler()) -> extract inner handler
  const asyncHandlerMatch = cleaned.match(/asyncHandler\((.+?)\)/)
  if (asyncHandlerMatch) {
    const inner = asyncHandlerMatch[1].replace(/\(.*$/, '').trim()
    const innerDirect = handlerMap.get(inner)
    if (innerDirect) return [innerDirect.sourceFile]
    // inner might be namespaced: recycles.getRecycleItem
    const innerDot = inner.indexOf('.')
    if (innerDot > 0) {
      const innerNs = handlerMap.get(inner.substring(0, innerDot))
      if (innerNs) return [innerNs.sourceFile]
    }
  }

  // rateLimit(...) -> not a route handler file, skip
  // express.static(...) -> not a route handler file, skip
  // inline function -> no file to resolve

  return []
}
