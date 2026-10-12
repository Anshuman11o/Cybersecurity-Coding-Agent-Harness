/**
 * Stage 0 — tree-sitter symbol table (recon v3, symbols.json).
 *
 * Deterministic, no LLM calls. For every inventory file in a language with a
 * grammar, lists what the file declares (functions, methods, classes, types
 * ...), whether each is visible to other files by that language's own rule,
 * and what the file imports. Implements ExtractSymbolTable from
 * recon-contract.ts.
 *
 * Why a parser: route context, the route_handler signal and the repo map all
 * need "what does this file export". Before recon v3 that was a JS-only regex
 * over `export function|const|class`, which is blind to every other language
 * and to CommonJS, and which also matched inside comments and strings.
 *
 * The extractors walk named node types with a small table per language rather
 * than tree-sitter queries: the prebuilt grammars in tree-sitter-wasms span
 * several grammar generations (Kotlin has no field names at all), and a query
 * that names a field or node the grammar lacks fails to compile for the whole
 * language. A walker only ever misses the construct it does not know.
 *
 * Content is read through the supplied guard: its output is names and line
 * numbers, never a model prompt. The read guard decides which files
 * are looked at, so the benchmark's denylisted bookkeeping files contribute no
 * symbols (skipped as guard_denied) and cannot leak into anything derived from
 * the table.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { Parser, Language, type Node as TSNode } from 'web-tree-sitter'
import { isCorpusReadable, readCorpusFile, type ReadGuard } from '../../shared/read-guard.js'
import { REPO_ROOT } from '../../shared/run-context.js'
import type {
  ExtractSymbolTable,
  FileSymbols,
  ImportEntry,
  InventoryEntry,
  SymbolEntry,
  SymbolKind,
  SymbolTableArtifact,
} from './recon-contract.js'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Grammars
// ---------------------------------------------------------------------------

/** Inventory language -> tree-sitter-wasms grammar name. `.tsx` files use 'tsx' (grammarFor). */
export const SYMBOL_GRAMMARS: Readonly<Record<string, string>> = Object.freeze({
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  java: 'java',
  go: 'go',
  ruby: 'ruby',
  php: 'php',
  csharp: 'c_sharp',
  rust: 'rust',
  c: 'c',
  cpp: 'cpp',
  kotlin: 'kotlin',
  swift: 'swift',
})

/** The grammar a file is parsed with, or null when its language has none. */
export function grammarFor(language: string, relPath: string): string | null {
  // The typescript grammar rejects JSX; the tsx grammar accepts both, but a
  // `<T>expr` cast in a .ts file is JSX to it, so each extension keeps its own.
  if (language === 'typescript' && relPath.toLowerCase().endsWith('.tsx')) return 'tsx'
  return SYMBOL_GRAMMARS[language] ?? null
}

function wasmPath(grammar: string): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`)
}

/** Recorded in symbols.json so a table can be traced to the parser that produced it. */
function packageVersion(pkgJsonPath: string): string {
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function parserInfo(): SymbolTableArtifact['parser'] {
  // web-tree-sitter's exports map hides its package.json; its entry point sits
  // at the package root, so the file is found beside it.
  const runtimeDir = path.dirname(require.resolve('web-tree-sitter'))
  return {
    runtime: `web-tree-sitter@${packageVersion(path.join(runtimeDir, 'package.json'))}`,
    grammars: `tree-sitter-wasms@${packageVersion(require.resolve('tree-sitter-wasms/package.json'))}`,
  }
}

let runtimeReady: Promise<void> | null = null
let parser: Parser | null = null
const languages = new Map<string, Language>()

/**
 * Initialise the runtime once and load the grammars for these inventory
 * languages (default: all of them). Idempotent; grammars load lazily so a
 * Python-only repo never pays for the C++ grammar.
 */
export async function initSymbolParsers(langs: Iterable<string> = Object.keys(SYMBOL_GRAMMARS)): Promise<void> {
  if (!runtimeReady) runtimeReady = Parser.init()
  await runtimeReady
  if (!parser) parser = new Parser()
  const wanted = new Set<string>()
  for (const lang of langs) {
    const g = SYMBOL_GRAMMARS[lang]
    if (g) wanted.add(g)
    if (lang === 'typescript') wanted.add('tsx')
  }
  for (const g of [...wanted].sort()) {
    if (!languages.has(g)) languages.set(g, await Language.load(wasmPath(g)))
  }
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function kids(n: TSNode | null | undefined): TSNode[] {
  return n ? (n.namedChildren.filter(Boolean) as TSNode[]) : []
}

function fieldOf(n: TSNode | null | undefined, name: string): TSNode | null {
  return n ? n.childForFieldName(name) : null
}

function firstOfType(n: TSNode | null | undefined, ...types: string[]): TSNode | null {
  return kids(n).find((c) => types.includes(c.type)) ?? null
}

/** Anonymous children (keywords, punctuation) by type: `public`, `static`, `interface` ... */
function keywordsOf(n: TSNode | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const c of n?.children ?? []) if (c && !c.isNamed) out.add(c.type)
  return out
}

const line = (n: TSNode) => n.startPosition.row + 1
const endLine = (n: TSNode) => n.endPosition.row + 1

const STRING_PARTS = new Set(['string_fragment', 'string_content', 'interpreted_string_literal_content', 'escape_sequence'])

/** The value of a string literal as written between its quotes. */
function stringText(n: TSNode): string {
  const parts = kids(n).filter((c) => STRING_PARTS.has(c.type))
  if (parts.length > 0) return parts.map((p) => p.text).join('')
  return n.text.replace(/^[`'"<]+|[`'">]+$/g, '')
}

/** An import target that is not a plain literal (`__DIR__ . '/x.php'`), as written, bounded. */
function rawText(n: TSNode): string {
  return n.text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function literalOrRaw(n: TSNode): string {
  return /string|literal/.test(n.type) && !/concat|binary|interpol/.test(n.type) ? stringText(n) : rawText(n)
}

// ---------------------------------------------------------------------------
// Per-file accumulator
// ---------------------------------------------------------------------------

class FileBuilder {
  symbols: SymbolEntry[] = []
  imports: ImportEntry[] = []

  add(
    name: string | null | undefined,
    kind: SymbolKind,
    nameNode: TSNode,
    decl: TSNode,
    exported: boolean,
    container?: string,
  ): SymbolEntry | null {
    if (!name) return null
    const s: SymbolEntry = { name, kind, line: line(nameNode), end_line: endLine(decl), exported }
    if (container) s.container = container
    this.symbols.push(s)
    return s
  }

  imp(source: string | null | undefined, names: string[], at: TSNode): void {
    if (!source) return
    this.imports.push({ source, names, line: line(at) })
  }

  /** Sorted and de-duplicated, so identical input gives a byte-identical table. */
  result(): { symbols: SymbolEntry[]; imports: ImportEntry[] } {
    const dedupe = <T>(xs: T[]) => {
      const seen = new Set<string>()
      return xs.filter((x) => {
        const k = JSON.stringify(x)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
    }
    const cmp = (a: string | undefined, b: string | undefined) => ((a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0)
    const symbols = dedupe(this.symbols).sort(
      (a, b) => a.line - b.line || cmp(a.container, b.container) || cmp(a.name, b.name) || cmp(a.kind, b.kind) || a.end_line - b.end_line,
    )
    const imports = dedupe(this.imports).sort((a, b) => a.line - b.line || cmp(a.source, b.source))
    return { symbols, imports }
  }
}

type Extractor = (root: TSNode, b: FileBuilder) => void

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------
// Exported = module-level bindings only. Class methods are reached through the
// class, never imported by name; counting them would hand a frontend service's
// `login()` method the route_handler signal of the backend's `login` handler.

const JS_FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function'])
const JS_CLASS_VALUES = new Set(['class'])

function extractJs(root: TSNode, b: FileBuilder): void {
  /** Top-level names exported by a list (`export { a }`, `module.exports = { a }`), resolved after the walk. */
  const exportedLocal = new Map<string, TSNode>()
  /** `export { a as c }`, `exports.c = a`: the exported name differs from the local one. */
  const aliasExports: { local: string; exported: string; at: TSNode }[] = []
  /** Top-level bindings to plain values: not symbols unless something exports them. */
  const plainBindings = new Map<string, { kind: SymbolKind; nameNode: TSNode; decl: TSNode }>()

  const classMembers = (body: TSNode | null, className: string) => {
    for (const m of kids(body)) {
      if (m.type === 'method_definition') {
        const n = fieldOf(m, 'name')
        if (n) b.add(n.text, 'method', n, m, false, className)
      } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
        // `handle = async (req, res) => {}` is a method in all but syntax.
        const n = fieldOf(m, 'name') ?? fieldOf(m, 'property')
        const v = fieldOf(m, 'value')
        if (n && v && JS_FUNCTION_VALUES.has(v.type)) b.add(n.text, 'method', n, m, false, className)
      }
    }
  }

  const declaration = (d: TSNode, exported: boolean): void => {
    switch (d.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const n = fieldOf(d, 'name')
        if (n) b.add(n.text, 'function', n, d, exported)
        return
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const n = fieldOf(d, 'name')
        if (!n) return
        b.add(n.text, 'class', n, d, exported)
        classMembers(fieldOf(d, 'body'), n.text)
        return
      }
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration': {
        const n = fieldOf(d, 'name')
        const kind: SymbolKind = d.type === 'interface_declaration' ? 'interface' : d.type === 'enum_declaration' ? 'enum' : 'type'
        if (n) b.add(n.text, kind, n, d, exported)
        return
      }
      case 'internal_module':
      case 'module': {
        // `namespace X {}` creates a value; `declare module 'x' {}` (a string name) declares someone else's.
        const n = fieldOf(d, 'name')
        if (n && n.type !== 'string') b.add(n.text, 'module', n, d, exported)
        return
      }
      case 'ambient_declaration':
        for (const c of kids(d)) declaration(c, exported)
        return
      case 'expression_statement':
        for (const c of kids(d)) if (c.type === 'internal_module' || c.type === 'module') declaration(c, exported)
        return
      case 'lexical_declaration':
      case 'variable_declaration': {
        const constant = d.type === 'lexical_declaration' && d.child(0)?.type === 'const'
        for (const v of kids(d)) {
          if (v.type !== 'variable_declarator') continue
          const n = fieldOf(v, 'name')
          if (!n || n.type !== 'identifier') continue
          const value = fieldOf(v, 'value')
          if (value && JS_FUNCTION_VALUES.has(value.type)) {
            b.add(n.text, 'function', n, v, exported)
          } else if (value && JS_CLASS_VALUES.has(value.type)) {
            b.add(n.text, 'class', n, v, exported)
            classMembers(fieldOf(value, 'body'), n.text)
          } else {
            const kind: SymbolKind = constant ? 'constant' : 'variable'
            // An `export const` is part of the file's interface whatever it holds.
            if (exported) b.add(n.text, kind, n, v, true)
            else plainBindings.set(n.text, { kind, nameNode: n, decl: v })
          }
        }
        return
      }
    }
  }

  const exportSpecifiers = (clause: TSNode | null) =>
    kids(clause)
      .filter((s) => s.type === 'export_specifier')
      .map((s) => ({ spec: s, name: fieldOf(s, 'name'), alias: fieldOf(s, 'alias') }))

  const exportStatement = (stmt: TSNode): void => {
    const decl = fieldOf(stmt, 'declaration')
    if (decl) return declaration(decl, true)
    const clause = firstOfType(stmt, 'export_clause')
    const source = fieldOf(stmt, 'source')
    if (source) {
      // Re-export: an import of the source and an export of the names.
      const specs = exportSpecifiers(clause)
      const nsExport = firstOfType(stmt, 'namespace_export')
      b.imp(stringText(source), specs.length > 0 ? specs.map((s) => s.name?.text ?? '').filter(Boolean) : ['*'], stmt)
      for (const s of specs) {
        const out = s.alias ?? s.name
        if (out) b.add(out.text, 'variable', out, stmt, true)
      }
      const nsName = firstOfType(nsExport, 'identifier')
      if (nsName) b.add(nsName.text, 'variable', nsName, stmt, true)
      return
    }
    if (clause) {
      for (const s of exportSpecifiers(clause)) {
        if (!s.name) continue
        if (s.alias && s.alias.text !== s.name.text) aliasExports.push({ local: s.name.text, exported: s.alias.text, at: s.spec })
        else exportedLocal.set(s.name.text, s.spec)
      }
      return
    }
    // `export default X`, `export = X`
    const value = fieldOf(stmt, 'value') ?? firstOfType(stmt, 'identifier')
    if (!value) return
    if (value.type === 'identifier') exportedLocal.set(value.text, stmt)
    else if (JS_FUNCTION_VALUES.has(value.type) || JS_CLASS_VALUES.has(value.type)) {
      const n = fieldOf(value, 'name')
      if (n) b.add(n.text, JS_CLASS_VALUES.has(value.type) ? 'class' : 'function', n, value, true)
    }
  }

  const isModuleExports = (n: TSNode | null) =>
    !!n && n.type === 'member_expression' && fieldOf(n, 'object')?.text === 'module' && fieldOf(n, 'property')?.text === 'exports'

  /** `exports.X` or `module.exports.X` -> the X node. */
  const exportsMember = (n: TSNode | null): TSNode | null => {
    if (!n || n.type !== 'member_expression') return null
    const obj = fieldOf(n, 'object')
    if (!obj || !(obj.text === 'exports' || isModuleExports(obj))) return null
    return fieldOf(n, 'property')
  }

  const exportValue = (exportedName: TSNode, value: TSNode, at: TSNode) => {
    if (value.type === 'identifier') {
      if (value.text === exportedName.text) exportedLocal.set(value.text, at)
      else aliasExports.push({ local: value.text, exported: exportedName.text, at })
    } else if (JS_FUNCTION_VALUES.has(value.type)) {
      b.add(exportedName.text, 'function', exportedName, at, true)
    } else if (JS_CLASS_VALUES.has(value.type)) {
      b.add(exportedName.text, 'class', exportedName, at, true)
      classMembers(fieldOf(value, 'body'), exportedName.text)
    } else {
      b.add(exportedName.text, 'variable', exportedName, at, true)
    }
  }

  const commonJs = (assign: TSNode): void => {
    const left = fieldOf(assign, 'left')
    let right = fieldOf(assign, 'right')
    if (!right) return
    // `module.exports = exports = X`, `exports.a = exports.b = fn`
    if (right.type === 'assignment_expression') {
      commonJs(right)
      right = fieldOf(right, 'right')
      if (!right) return
    }
    if (isModuleExports(left)) {
      if (right.type === 'identifier') exportedLocal.set(right.text, assign)
      else if (right.type === 'object') {
        for (const p of kids(right)) {
          if (p.type === 'shorthand_property_identifier') exportedLocal.set(p.text, p)
          else if (p.type === 'pair') {
            const key = fieldOf(p, 'key')
            const value = fieldOf(p, 'value')
            if (key && value && (key.type === 'property_identifier' || key.type === 'identifier')) exportValue(key, value, p)
          } else if (p.type === 'method_definition') {
            const n = fieldOf(p, 'name')
            if (n) b.add(n.text, 'function', n, p, true)
          }
        }
      } else if (JS_FUNCTION_VALUES.has(right.type) || JS_CLASS_VALUES.has(right.type)) {
        const n = fieldOf(right, 'name')
        if (n) b.add(n.text, JS_CLASS_VALUES.has(right.type) ? 'class' : 'function', n, right, true)
      }
      return
    }
    const member = exportsMember(left)
    if (member) exportValue(member, right, assign)
  }

  for (const stmt of kids(root)) {
    if (stmt.type === 'export_statement') exportStatement(stmt)
    else if (stmt.type === 'expression_statement') {
      const expr = kids(stmt)[0]
      if (expr?.type === 'assignment_expression') commonJs(expr)
      else declaration(stmt, false)
    } else declaration(stmt, false)
  }

  // Resolve list exports against what the walk found.
  const topLevel = (name: string) => b.symbols.filter((s) => s.name === name && s.container === undefined)
  for (const [name, at] of exportedLocal) {
    const found = topLevel(name)
    if (found.length > 0) {
      for (const s of found) s.exported = true
      continue
    }
    const binding = plainBindings.get(name)
    if (binding) b.add(name, binding.kind, binding.nameNode, binding.decl, true)
    else b.add(name, 'variable', at, at, true) // imported, then re-exported
  }
  for (const a of aliasExports) {
    const local = topLevel(a.local)[0]
    const binding = plainBindings.get(a.local)
    if (local) b.symbols.push({ name: a.exported, kind: local.kind, line: local.line, end_line: local.end_line, exported: true })
    else if (binding) b.add(a.exported, binding.kind, binding.nameNode, binding.decl, true)
    else b.add(a.exported, 'variable', a.at, a.at, true)
  }

  // Imports: ES import statements, require() and dynamic import() anywhere.
  for (const n of root.descendantsOfType(['import_statement', 'call_expression'])) {
    if (!n) continue
    if (n.type === 'import_statement') {
      const clause = firstOfType(n, 'import_clause')
      const req = firstOfType(n, 'import_require_clause')
      if (req) {
        const src = fieldOf(req, 'source')
        const id = firstOfType(req, 'identifier')
        if (src) b.imp(stringText(src), id ? [id.text] : [], n)
        continue
      }
      const src = fieldOf(n, 'source')
      if (!src) continue
      const names: string[] = []
      for (const c of kids(clause)) {
        if (c.type === 'identifier') names.push(c.text)
        else if (c.type === 'namespace_import') {
          const id = firstOfType(c, 'identifier')
          if (id) names.push(id.text)
        } else if (c.type === 'named_imports') {
          for (const s of kids(c)) {
            if (s.type !== 'import_specifier') continue
            const bound = fieldOf(s, 'alias') ?? fieldOf(s, 'name')
            if (bound) names.push(bound.text)
          }
        }
      }
      b.imp(stringText(src), names, n)
      continue
    }
    const fn = fieldOf(n, 'function')
    if (!fn || !((fn.type === 'identifier' && fn.text === 'require') || fn.type === 'import')) continue
    const arg = kids(fieldOf(n, 'arguments'))[0]
    if (!arg) continue
    const source = arg.type === 'string' ? stringText(arg) : rawText(arg)
    // `const x = require('m')`, `const { a, b: c } = require('m')`, `await import('m')`
    let holder = n.parent
    if (holder?.type === 'await_expression') holder = holder.parent
    const names: string[] = []
    const target = holder?.type === 'variable_declarator' ? fieldOf(holder, 'name') : null
    if (target?.type === 'identifier') names.push(target.text)
    else if (target?.type === 'object_pattern') {
      for (const p of kids(target)) {
        if (p.type === 'shorthand_property_identifier_pattern') names.push(p.text)
        else if (p.type === 'pair_pattern') {
          const v = fieldOf(p, 'value')
          if (v?.type === 'identifier') names.push(v.text)
        }
      }
    }
    b.imp(source, names, n)
  }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
// Exported = module level without a leading underscore. Methods and nested
// classes are reached through their class.

/** Blocks whose definitions still belong to the enclosing scope (`if TYPE_CHECKING:`, `try: ... except ImportError:`). */
const PY_TRANSPARENT = new Set([
  'if_statement', 'elif_clause', 'else_clause', 'try_statement', 'except_clause', 'except_group_clause',
  'finally_clause', 'with_statement', 'block',
])

function extractPython(root: TSNode, b: FileBuilder): void {
  const walk = (node: TSNode | null, container: string | undefined) => {
    for (const n of kids(node)) {
      const def = n.type === 'decorated_definition' ? fieldOf(n, 'definition') ?? n : n
      if (def.type === 'function_definition' || def.type === 'class_definition') {
        const nameNode = fieldOf(def, 'name')
        if (!nameNode) continue
        const name = nameNode.text
        const exported = container === undefined && !name.startsWith('_')
        if (def.type === 'function_definition') {
          b.add(name, container ? 'method' : 'function', nameNode, def, exported, container)
        } else {
          b.add(name, 'class', nameNode, def, exported, container)
          walk(fieldOf(def, 'body'), name)
        }
        continue
      }
      if (container === undefined && n.type === 'expression_statement') {
        // `handler = lambda req: ...`
        const a = kids(n)[0]
        const left = fieldOf(a, 'left')
        const right = fieldOf(a, 'right')
        if (a?.type === 'assignment' && left?.type === 'identifier' && right?.type === 'lambda') {
          b.add(left.text, 'function', left, a, !left.text.startsWith('_'))
        }
        continue
      }
      if (PY_TRANSPARENT.has(n.type)) walk(n, container)
    }
  }
  walk(root, undefined)

  for (const n of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (!n) continue
    if (n.type === 'import_statement') {
      for (const c of n.childrenForFieldName('name')) {
        if (!c) continue
        if (c.type === 'aliased_import') {
          const alias = fieldOf(c, 'alias')
          b.imp(fieldOf(c, 'name')?.text, alias ? [alias.text] : [], n)
        } else b.imp(c.text, [], n)
      }
      continue
    }
    const mod = fieldOf(n, 'module_name')
    const names: string[] = []
    for (const c of n.childrenForFieldName('name')) {
      if (!c) continue
      names.push(c.type === 'aliased_import' ? fieldOf(c, 'alias')?.text ?? c.text : c.text)
    }
    if (firstOfType(n, 'wildcard_import')) names.push('*')
    b.imp(mod?.text, names, n)
  }
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------
// Exported = `public`, or a member of an interface (implicitly public).

const JAVA_TYPES: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'class',
  annotation_type_declaration: 'interface',
}

function extractJava(root: TSNode, b: FileBuilder): void {
  const mods = (n: TSNode) => keywordsOf(firstOfType(n, 'modifiers'))
  const exportedIn = (n: TSNode, inInterface: boolean) => {
    const m = mods(n)
    return m.has('public') || (inInterface && !m.has('private'))
  }
  const walk = (node: TSNode | null, container: string | undefined, inInterface: boolean) => {
    for (const n of kids(node)) {
      const kind = JAVA_TYPES[n.type]
      if (kind) {
        const nameNode = fieldOf(n, 'name')
        if (!nameNode) continue
        b.add(nameNode.text, kind, nameNode, n, exportedIn(n, inInterface), container)
        walk(fieldOf(n, 'body'), nameNode.text, kind === 'interface')
      } else if (n.type === 'method_declaration' || n.type === 'constructor_declaration') {
        const nameNode = fieldOf(n, 'name')
        if (nameNode) b.add(nameNode.text, 'method', nameNode, n, exportedIn(n, inInterface), container)
      } else if (n.type === 'enum_body_declarations') {
        walk(n, container, false)
      } else if (n.type === 'import_declaration') {
        const target = firstOfType(n, 'scoped_identifier', 'identifier')
        if (!target) continue
        const wildcard = !!firstOfType(n, 'asterisk')
        b.imp(target.text, [wildcard ? '*' : target.text.split('.').pop() ?? target.text], n)
      }
    }
  }
  walk(root, undefined, false)
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
// Exported = the identifier starts with an upper-case letter, methods included.

function extractGo(root: TSNode, b: FileBuilder): void {
  const exported = (name: string) => /^\p{Lu}/u.test(name)
  const receiverType = (recv: TSNode | null): string | undefined => {
    const t = recv?.descendantsOfType('type_identifier')[0]
    return t?.text
  }
  for (const n of kids(root)) {
    switch (n.type) {
      case 'import_declaration':
        for (const spec of n.descendantsOfType('import_spec')) {
          if (!spec) continue
          const p = fieldOf(spec, 'path')
          const alias = fieldOf(spec, 'name')
          if (p) b.imp(stringText(p), alias ? [alias.text] : [], spec)
        }
        break
      case 'function_declaration': {
        const nameNode = fieldOf(n, 'name')
        if (nameNode) b.add(nameNode.text, 'function', nameNode, n, exported(nameNode.text))
        break
      }
      case 'method_declaration': {
        const nameNode = fieldOf(n, 'name')
        if (nameNode) b.add(nameNode.text, 'method', nameNode, n, exported(nameNode.text), receiverType(fieldOf(n, 'receiver')))
        break
      }
      case 'type_declaration':
        for (const spec of kids(n)) {
          if (spec.type !== 'type_spec' && spec.type !== 'type_alias') continue
          const nameNode = fieldOf(spec, 'name')
          if (!nameNode) continue
          const t = fieldOf(spec, 'type')
          const kind: SymbolKind = t?.type === 'struct_type' ? 'struct' : t?.type === 'interface_type' ? 'interface' : 'type'
          b.add(nameNode.text, kind, nameNode, spec, exported(nameNode.text))
          if (kind === 'interface') {
            for (const m of kids(t)) {
              if (m.type !== 'method_spec' && m.type !== 'method_elem') continue
              const mn = fieldOf(m, 'name')
              if (mn) b.add(mn.text, 'method', mn, m, exported(mn.text), nameNode.text)
            }
          }
        }
        break
      case 'var_declaration':
      case 'const_declaration':
        // `var Handler = func(w http.ResponseWriter, r *http.Request) {...}`
        for (const spec of [...n.descendantsOfType('var_spec'), ...n.descendantsOfType('const_spec')]) {
          if (!spec || spec.parent?.type === 'block') continue
          const names = spec.childrenForFieldName('name').filter(Boolean) as TSNode[]
          const values = kids(fieldOf(spec, 'value'))
          names.forEach((nm, i) => {
            if (values[i]?.type === 'func_literal') b.add(nm.text, 'function', nm, spec, exported(nm.text))
          })
        }
        break
    }
  }
}

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------
// Exported = everything at top level, classes and modules anywhere, and methods
// not made private/protected (`private` section, `private def x`, `private :x`).

const RUBY_VISIBILITY = /^(private|protected|public)$/

function extractRuby(root: TSNode, b: FileBuilder): void {
  const lastSegment = (t: string) => t.split('::').pop() ?? t
  const walk = (node: TSNode | null, container: string | undefined) => {
    let visibility = 'public'
    const hiddenByName = new Set<string>()
    const added: SymbolEntry[] = []
    const method = (m: TSNode, vis: string) => {
      const nameNode = fieldOf(m, 'name')
      if (!nameNode) return
      const s = b.add(nameNode.text, container ? 'method' : 'function', nameNode, m, !container || vis === 'public', container)
      if (s) added.push(s)
    }
    for (const n of kids(node)) {
      switch (n.type) {
        case 'class':
        case 'module': {
          const nameNode = fieldOf(n, 'name')
          if (!nameNode) break
          const name = lastSegment(nameNode.text)
          b.add(name, n.type === 'class' ? 'class' : 'module', nameNode, n, true, container)
          walk(fieldOf(n, 'body'), name)
          break
        }
        case 'singleton_class': // class << self
          walk(fieldOf(n, 'body') ?? firstOfType(n, 'body_statement'), container)
          break
        case 'method':
          method(n, visibility)
          break
        case 'singleton_method': {
          const nameNode = fieldOf(n, 'name')
          if (nameNode) b.add(nameNode.text, 'method', nameNode, n, true, container)
          break
        }
        case 'identifier':
          if (container && RUBY_VISIBILITY.test(n.text)) visibility = n.text
          break
        case 'call': {
          const m = fieldOf(n, 'method')
          if (!container || fieldOf(n, 'receiver') || !m || !RUBY_VISIBILITY.test(m.text)) break
          for (const a of kids(fieldOf(n, 'arguments'))) {
            if (a.type === 'method') method(a, m.text)
            else if (m.text !== 'public' && (a.type === 'simple_symbol' || a.type === 'string')) {
              hiddenByName.add(a.text.replace(/^:|^['"]|['"]$/g, ''))
            }
          }
          break
        }
      }
    }
    for (const s of added) if (hiddenByName.has(s.name)) s.exported = false
  }
  walk(root, undefined)

  for (const n of root.descendantsOfType('call')) {
    if (!n || fieldOf(n, 'receiver')) continue
    const m = fieldOf(n, 'method')
    if (!m || (m.text !== 'require' && m.text !== 'require_relative')) continue
    const arg = kids(fieldOf(n, 'arguments'))[0]
    if (arg) b.imp(literalOrRaw(arg), [], n)
  }
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------
// Exported = everything at top level; methods unless `private`/`protected`.

const PHP_TYPES: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
}

/** Statements whose function definitions are still top level (`if (!function_exists('x')) { function x() {} }`). */
const PHP_TRANSPARENT = new Set(['compound_statement', 'if_statement', 'else_clause', 'else_if_clause', 'declaration_list'])

function extractPhp(root: TSNode, b: FileBuilder): void {
  const useClause = (clause: TSNode, prefix: string, at: TSNode) => {
    const target = firstOfType(clause, 'qualified_name', 'namespace_name', 'name')
    if (!target) return
    const alias = firstOfType(firstOfType(clause, 'namespace_aliasing_clause'), 'name')
    const full = prefix ? `${prefix}\\${target.text}` : target.text
    b.imp(full, [alias?.text ?? full.split('\\').pop() ?? full], at)
  }
  const walk = (node: TSNode | null, container: string | undefined, inInterface: boolean) => {
    for (const n of kids(node)) {
      const kind = PHP_TYPES[n.type]
      if (kind) {
        const nameNode = fieldOf(n, 'name')
        if (!nameNode) continue
        b.add(nameNode.text, kind, nameNode, n, true, container)
        walk(fieldOf(n, 'body'), nameNode.text, kind === 'interface')
        continue
      }
      switch (n.type) {
        case 'namespace_definition':
          walk(fieldOf(n, 'body'), container, false)
          break
        case 'namespace_use_declaration': {
          const group = firstOfType(n, 'namespace_use_group')
          if (group) {
            const prefix = firstOfType(n, 'namespace_name')?.text ?? ''
            for (const c of kids(group)) if (c.type === 'namespace_use_group_clause') useClause(c, prefix, n)
          } else {
            for (const c of kids(n)) if (c.type === 'namespace_use_clause') useClause(c, '', n)
          }
          break
        }
        case 'function_definition': {
          const nameNode = fieldOf(n, 'name')
          if (nameNode) b.add(nameNode.text, 'function', nameNode, n, true, container)
          break
        }
        case 'method_declaration': {
          const nameNode = fieldOf(n, 'name')
          const vis = firstOfType(n, 'visibility_modifier')?.text.toLowerCase()
          const exported = inInterface || !vis || vis === 'public'
          if (nameNode) b.add(nameNode.text, 'method', nameNode, n, exported, container)
          break
        }
        default:
          if (PHP_TRANSPARENT.has(n.type)) walk(n, container, inInterface)
      }
    }
  }
  walk(root, undefined, false)

  const includes = ['require_expression', 'require_once_expression', 'include_expression', 'include_once_expression']
  for (const n of root.descendantsOfType(includes)) {
    const arg = kids(n)[0]
    if (n && arg) b.imp(literalOrRaw(arg), [], n)
  }
}

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------
// Exported = `public`, or a member of an interface (implicitly public).

const CS_TYPES: Record<string, SymbolKind> = {
  class_declaration: 'class',
  struct_declaration: 'struct',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'class',
  record_struct_declaration: 'struct',
  delegate_declaration: 'type',
}

function extractCsharp(root: TSNode, b: FileBuilder): void {
  const modifiers = (n: TSNode) => new Set(kids(n).filter((c) => c.type === 'modifier').map((c) => c.text))
  const exportedIn = (n: TSNode, inInterface: boolean) => {
    const m = modifiers(n)
    return m.has('public') || (inInterface && !m.has('private'))
  }
  const walk = (node: TSNode | null, container: string | undefined, inInterface: boolean) => {
    for (const n of kids(node)) {
      const kind = CS_TYPES[n.type]
      if (kind) {
        const nameNode = fieldOf(n, 'name')
        if (!nameNode) continue
        b.add(nameNode.text, kind, nameNode, n, exportedIn(n, inInterface), container)
        walk(fieldOf(n, 'body'), nameNode.text, kind === 'interface')
        continue
      }
      switch (n.type) {
        case 'using_directive': {
          const aliasNode = firstOfType(n, 'name_equals')
          const target = kids(n).filter((c) => c.type !== 'name_equals')[0]
          const alias = firstOfType(aliasNode, 'identifier')
          if (target) b.imp(target.text, alias ? [alias.text] : [], n)
          break
        }
        case 'namespace_declaration':
          walk(fieldOf(n, 'body'), container, false)
          break
        case 'file_scoped_namespace_declaration':
        case 'declaration_list':
          walk(n, container, inInterface)
          break
        case 'method_declaration':
        case 'constructor_declaration': {
          const nameNode = fieldOf(n, 'name')
          if (nameNode) b.add(nameNode.text, 'method', nameNode, n, exportedIn(n, inInterface), container)
          break
        }
      }
    }
  }
  walk(root, undefined, false)
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------
// Exported = `pub` (any `pub(...)` but `pub(self)`). Trait items and methods
// of a trait impl have no `pub`; they are as visible as the trait.

function extractRust(root: TSNode, b: FileBuilder): void {
  const pub = (n: TSNode) => {
    const v = firstOfType(n, 'visibility_modifier')
    return !!v && v.text.replace(/\s+/g, '') !== 'pub(self)'
  }
  const typeName = (t: TSNode | null): string | undefined => {
    if (!t) return undefined
    if (t.type === 'generic_type') return typeName(fieldOf(t, 'type'))
    if (t.type === 'scoped_type_identifier') return fieldOf(t, 'name')?.text
    if (t.type === 'reference_type') return typeName(fieldOf(t, 'type'))
    return t.text
  }
  const useNames = (list: TSNode | null): string[] => {
    const out: string[] = []
    for (const c of kids(list)) {
      if (c.type === 'identifier' || c.type === 'self' || c.type === 'crate' || c.type === 'super') out.push(c.text)
      else if (c.type === 'scoped_identifier') out.push(fieldOf(c, 'name')?.text ?? c.text)
      else if (c.type === 'use_as_clause') out.push(fieldOf(c, 'alias')?.text ?? c.text)
      else if (c.type === 'use_wildcard') out.push('*')
      else if (c.type === 'scoped_use_list') out.push(...useNames(fieldOf(c, 'list')))
    }
    return out
  }
  const use = (n: TSNode) => {
    const arg = fieldOf(n, 'argument')
    if (!arg) return
    switch (arg.type) {
      case 'use_as_clause':
        b.imp(fieldOf(arg, 'path')?.text, [fieldOf(arg, 'alias')?.text ?? ''].filter(Boolean), n)
        return
      case 'use_wildcard':
        b.imp(kids(arg)[0]?.text ?? '*', ['*'], n)
        return
      case 'scoped_use_list':
        b.imp(fieldOf(arg, 'path')?.text ?? '', useNames(fieldOf(arg, 'list')), n)
        return
      case 'use_list':
        b.imp('{}', useNames(arg), n)
        return
      default:
        b.imp(arg.text, [arg.text.split('::').pop() ?? arg.text], n)
    }
  }
  type Mode = 'module' | 'impl' | 'trait_impl' | 'trait'
  const walk = (node: TSNode | null, container: string | undefined, mode: Mode, containerExported: boolean) => {
    for (const n of kids(node)) {
      const nameNode = fieldOf(n, 'name')
      switch (n.type) {
        case 'use_declaration':
          use(n)
          break
        case 'extern_crate_declaration': {
          const alias = fieldOf(n, 'alias')
          b.imp(nameNode?.text, alias ? [alias.text] : [], n)
          break
        }
        case 'mod_item':
          if (!nameNode) break
          b.add(nameNode.text, 'module', nameNode, n, pub(n), container)
          walk(fieldOf(n, 'body'), nameNode.text, 'module', pub(n))
          break
        case 'function_item':
        case 'function_signature_item': {
          if (!nameNode) break
          const inType = mode !== 'module'
          const exported = mode === 'trait_impl' || mode === 'trait' ? containerExported : pub(n)
          b.add(nameNode.text, inType ? 'method' : 'function', nameNode, n, exported, container)
          break
        }
        case 'struct_item':
        case 'union_item':
        case 'enum_item':
        case 'type_item':
          if (nameNode) {
            const kind: SymbolKind = n.type === 'enum_item' ? 'enum' : n.type === 'type_item' ? 'type' : 'struct'
            b.add(nameNode.text, kind, nameNode, n, pub(n), container)
          }
          break
        case 'trait_item':
          if (!nameNode) break
          b.add(nameNode.text, 'trait', nameNode, n, pub(n), container)
          walk(fieldOf(n, 'body'), nameNode.text, 'trait', pub(n))
          break
        case 'impl_item': {
          const self = typeName(fieldOf(n, 'type'))
          walk(fieldOf(n, 'body'), self, fieldOf(n, 'trait') ? 'trait_impl' : 'impl', true)
          break
        }
      }
    }
  }
  walk(root, undefined, 'module', true)
}

// ---------------------------------------------------------------------------
// C / C++
// ---------------------------------------------------------------------------
// Exported = not `static` (and, in C++, not in an anonymous namespace); class
// members by access section. A prototype and its definition in the same file
// are one symbol: the definition, exported only if both are (C linkage is set
// by the first declaration; an out-of-class C++ method takes its access from
// the class body).

const C_SPECIFIER_KINDS: Record<string, SymbolKind> = {
  struct_specifier: 'struct',
  union_specifier: 'struct',
  class_specifier: 'class',
  enum_specifier: 'enum',
}
const C_TRANSPARENT = new Set([
  'preproc_if', 'preproc_ifdef', 'preproc_else', 'preproc_elif', 'preproc_elifdef', 'declaration_list',
])

function extractC(root: TSNode, b: FileBuilder, cpp: boolean): void {
  const declarations = new Set<SymbolEntry>() // prototypes and in-class method declarations
  const isStatic = (n: TSNode) => kids(n).some((c) => c.type === 'storage_class_specifier' && c.text === 'static')

  /** The function a declarator declares; null for a variable, including a function pointer. */
  const functionName = (decl: TSNode | null): { nameNode: TSNode; scope?: string } | null => {
    let d = decl
    while (d && (d.type === 'pointer_declarator' || d.type === 'reference_declarator' || d.type === 'attributed_declarator')) {
      d = fieldOf(d, 'declarator') ?? kids(d).find((c) => c.type.endsWith('declarator') || c.type === 'identifier') ?? null
    }
    if (!d || d.type !== 'function_declarator') return null
    let inner = fieldOf(d, 'declarator')
    let scope: string | undefined
    while (inner?.type === 'qualified_identifier') {
      scope = fieldOf(inner, 'scope')?.text ?? scope
      inner = fieldOf(inner, 'name')
    }
    if (!inner || !['identifier', 'field_identifier', 'destructor_name', 'operator_name'].includes(inner.type)) return null
    return { nameNode: inner, scope }
  }

  const typeDeclarator = (decl: TSNode | null): TSNode | null => {
    if (!decl) return null
    if (decl.type === 'type_identifier') return decl
    return decl.descendantsOfType('type_identifier')[0] ?? null
  }

  const specifier = (spec: TSNode | null, container: string | undefined, exported: boolean) => {
    if (!spec) return
    const kind = C_SPECIFIER_KINDS[spec.type]
    const nameNode = fieldOf(spec, 'name')
    const body = fieldOf(spec, 'body')
    if (!kind || !nameNode || !body) return
    const name = nameNode.text
    b.add(name, kind, nameNode, spec, exported, container)
    if (cpp && kind !== 'enum') members(body, name, spec.type === 'class_specifier' ? 'private' : 'public')
  }

  const members = (body: TSNode, className: string, defaultAccess: string) => {
    let access = defaultAccess
    const member = (m: TSNode) => {
      switch (m.type) {
        case 'access_specifier':
          access = m.text.replace(/:$/, '').trim()
          break
        case 'field_declaration':
        case 'declaration':
          for (const d of m.childrenForFieldName('declarator')) {
            const fn = functionName(d)
            const s = fn && b.add(fn.nameNode.text, 'method', fn.nameNode, m, access === 'public', className)
            if (s) declarations.add(s)
          }
          specifier(fieldOf(m, 'type'), className, access === 'public')
          break
        case 'function_definition': {
          const fn = functionName(fieldOf(m, 'declarator'))
          if (fn) b.add(fn.nameNode.text, 'method', fn.nameNode, m, access === 'public', className)
          break
        }
        case 'template_declaration':
          for (const c of kids(m)) member(c)
          break
        default:
          if (C_SPECIFIER_KINDS[m.type]) specifier(m, className, access === 'public')
      }
    }
    for (const m of kids(body)) member(m)
  }

  const walk = (node: TSNode | null, anonymousNs: boolean) => {
    for (const n of kids(node)) {
      switch (n.type) {
        case 'function_definition': {
          const fn = functionName(fieldOf(n, 'declarator'))
          if (!fn) break
          const exported = !isStatic(n) && !anonymousNs
          b.add(fn.nameNode.text, fn.scope ? 'method' : 'function', fn.nameNode, n, exported, fn.scope)
          break
        }
        case 'declaration':
          for (const d of n.childrenForFieldName('declarator')) {
            const fn = functionName(d)
            const s = fn && b.add(fn.nameNode.text, fn.scope ? 'method' : 'function', fn.nameNode, n, !isStatic(n) && !anonymousNs, fn.scope)
            if (s) declarations.add(s)
          }
          specifier(fieldOf(n, 'type'), undefined, !anonymousNs)
          break
        case 'type_definition': {
          specifier(fieldOf(n, 'type'), undefined, !anonymousNs)
          for (const d of n.childrenForFieldName('declarator')) {
            const t = typeDeclarator(d)
            if (t) b.add(t.text, 'type', t, n, !anonymousNs)
          }
          break
        }
        case 'alias_declaration': {
          const nameNode = fieldOf(n, 'name')
          if (nameNode) b.add(nameNode.text, 'type', nameNode, n, !anonymousNs)
          break
        }
        case 'namespace_definition':
          walk(fieldOf(n, 'body'), anonymousNs || !fieldOf(n, 'name'))
          break
        case 'linkage_specification': // extern "C" { ... }
          walk(fieldOf(n, 'body') ?? n, anonymousNs)
          break
        case 'template_declaration':
          walk(n, anonymousNs)
          break
        default:
          if (C_SPECIFIER_KINDS[n.type]) specifier(n, undefined, !anonymousNs)
          else if (C_TRANSPARENT.has(n.type)) walk(n, anonymousNs)
      }
    }
  }
  walk(root, false)

  // Merge each declaration into its definition.
  const key = (s: SymbolEntry) => `${s.container ?? ''}::${s.name}`
  const definitions = new Map<string, SymbolEntry>()
  for (const s of b.symbols) if (!declarations.has(s) && (s.kind === 'function' || s.kind === 'method')) definitions.set(key(s), s)
  b.symbols = b.symbols.filter((s) => {
    if (!declarations.has(s)) return true
    const def = definitions.get(key(s))
    if (!def) return true
    def.exported = def.exported && s.exported
    return false
  })

  for (const n of root.descendantsOfType('preproc_include')) {
    const p = fieldOf(n, 'path')
    if (n && p) b.imp(p.type === 'system_lib_string' ? p.text.replace(/^<|>$/g, '') : literalOrRaw(p), [], n)
  }
}

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------
// The tree-sitter-kotlin grammar in tree-sitter-wasms has no field names, so
// declarations are read by child type. Exported = not `private`/`internal`.

function extractKotlin(root: TSNode, b: FileBuilder): void {
  const visible = (n: TSNode) => {
    const vis = kids(firstOfType(n, 'modifiers')).filter((c) => c.type === 'visibility_modifier').map((c) => c.text)
    return !vis.includes('private') && !vis.includes('internal')
  }
  const importHeader = (h: TSNode) => {
    const id = firstOfType(h, 'identifier')
    if (!id) return
    const alias = firstOfType(firstOfType(h, 'import_alias'), 'type_identifier', 'simple_identifier')
    const wildcard = !!firstOfType(h, 'wildcard_import')
    b.imp(id.text, [wildcard ? '*' : alias?.text ?? id.text.split('.').pop() ?? id.text], h)
  }
  const walk = (node: TSNode | null, container: string | undefined) => {
    for (const n of kids(node)) {
      switch (n.type) {
        case 'import_list':
          for (const h of kids(n)) if (h.type === 'import_header') importHeader(h)
          break
        case 'import_header':
          importHeader(n)
          break
        case 'class_declaration':
        case 'object_declaration': {
          const nameNode = firstOfType(n, 'type_identifier')
          if (!nameNode) break
          const kw = keywordsOf(n)
          const kind: SymbolKind = kw.has('interface') ? 'interface' : kw.has('enum') || firstOfType(n, 'enum_class_body') ? 'enum' : 'class'
          b.add(nameNode.text, kind, nameNode, n, visible(n), container)
          walk(firstOfType(n, 'class_body', 'enum_class_body'), nameNode.text)
          break
        }
        case 'companion_object':
          walk(firstOfType(n, 'class_body'), container)
          break
        case 'function_declaration': {
          const nameNode = firstOfType(n, 'simple_identifier')
          if (nameNode) b.add(nameNode.text, container ? 'method' : 'function', nameNode, n, visible(n), container)
          break
        }
        case 'type_alias': {
          const nameNode = firstOfType(n, 'type_identifier')
          if (nameNode) b.add(nameNode.text, 'type', nameNode, n, visible(n), container)
          break
        }
        case 'property_declaration': {
          // `val handler = { call: ApplicationCall -> ... }`
          if (container || !firstOfType(n, 'lambda_literal', 'anonymous_function')) break
          const nameNode = firstOfType(firstOfType(n, 'variable_declaration'), 'simple_identifier')
          if (nameNode) b.add(nameNode.text, 'function', nameNode, n, visible(n))
          break
        }
      }
    }
  }
  walk(root, undefined)
}

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------
// Exported = `public` or `open`. An extension declares no new type; its
// members are listed with the extended type as container.

function extractSwift(root: TSNode, b: FileBuilder): void {
  const isPublic = (n: TSNode) => {
    const v = kids(firstOfType(n, 'modifiers')).find((c) => c.type === 'visibility_modifier')
    return !!v && /^(public|open)\b/.test(v.text)
  }
  const walk = (node: TSNode | null, container: string | undefined, protocolExported: boolean | null) => {
    for (const n of kids(node)) {
      switch (n.type) {
        case 'import_declaration': {
          const id = firstOfType(n, 'identifier')
          if (id) b.imp(id.text, [], n)
          break
        }
        case 'class_declaration': {
          const nameNode = fieldOf(n, 'name')
          if (!nameNode) break
          const declKind = fieldOf(n, 'declaration_kind')?.type
          if (declKind === 'extension') {
            walk(fieldOf(n, 'body'), nameNode.text, null)
            break
          }
          const kind: SymbolKind = declKind === 'struct' ? 'struct' : declKind === 'enum' ? 'enum' : 'class'
          b.add(nameNode.text, kind, nameNode, n, isPublic(n), container)
          walk(fieldOf(n, 'body'), nameNode.text, null)
          break
        }
        case 'protocol_declaration': {
          const nameNode = fieldOf(n, 'name')
          if (!nameNode) break
          b.add(nameNode.text, 'interface', nameNode, n, isPublic(n), container)
          walk(fieldOf(n, 'body'), nameNode.text, isPublic(n))
          break
        }
        case 'function_declaration':
        case 'protocol_function_declaration': {
          const nameNode = fieldOf(n, 'name')
          const exported = protocolExported ?? isPublic(n)
          if (nameNode) b.add(nameNode.text, container ? 'method' : 'function', nameNode, n, exported, container)
          break
        }
        case 'init_declaration':
          if (container) b.add('init', 'method', n, n, protocolExported ?? isPublic(n), container)
          break
        case 'typealias_declaration': {
          const nameNode = fieldOf(n, 'name')
          if (nameNode) b.add(nameNode.text, 'type', nameNode, n, isPublic(n), container)
          break
        }
        case 'property_declaration': {
          // `let handler = { (req: Request) in ... }`
          if (container || fieldOf(n, 'value')?.type !== 'lambda_literal') break
          const nameNode = fieldOf(fieldOf(n, 'name'), 'bound_identifier') ?? fieldOf(n, 'name')
          if (nameNode) b.add(nameNode.text, 'function', nameNode, n, isPublic(n))
          break
        }
      }
    }
  }
  walk(root, undefined, null)
}

const EXTRACTORS: Record<string, Extractor> = {
  javascript: extractJs,
  typescript: extractJs,
  tsx: extractJs,
  python: extractPython,
  java: extractJava,
  go: extractGo,
  ruby: extractRuby,
  php: extractPhp,
  c_sharp: extractCsharp,
  rust: extractRust,
  c: (r, b) => extractC(r, b, false),
  cpp: (r, b) => extractC(r, b, true),
  kotlin: extractKotlin,
  swift: extractSwift,
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

/**
 * Symbols and imports of one file's source. Synchronous once initSymbolParsers()
 * has loaded the grammar (throws if it has not — a programming error, not a
 * bad file). Returns null when the language has no grammar. Never throws on
 * file content: an unparseable file is parse_error: true with whatever the
 * walk recovered.
 */
export function extractFileSymbols(source: string, language: string, relPath: string): FileSymbols | null {
  const grammar = grammarFor(language, relPath)
  if (!grammar) return null
  const lang = languages.get(grammar)
  if (!lang || !parser) throw new Error(`[symbols] grammar '${grammar}' is not loaded; call initSymbolParsers() first`)
  parser.setLanguage(lang)

  let tree: ReturnType<Parser['parse']> = null
  try {
    tree = parser.parse(source)
  } catch {
    tree = null
  }
  if (!tree) return { language, grammar, symbols: [], imports: [], parse_error: true }

  const b = new FileBuilder()
  let walkFailed = false
  try {
    EXTRACTORS[grammar](tree.rootNode, b)
  } catch {
    // A grammar shape the walker did not expect. Keep what it found and say
    // the file was not fully read, rather than failing the whole table.
    walkFailed = true
  }
  const parseError = tree.rootNode.hasError || walkFailed
  tree.delete()
  return { language, grammar, ...b.result(), parse_error: parseError }
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of Object.keys(r).sort()) out[k] = r[k]
  return out
}

/**
 * Build symbols.json for an inventory. `guard` defaults to this process's read
 * guard; tests pass one built for an explicit run context.
 */
export async function extractSymbolTable(
  targetDir: string,
  entries: readonly InventoryEntry[],
  guard: Pick<ReadGuard, 'isCorpusReadable'> & Partial<Pick<ReadGuard, 'readCorpusFile'>> = { isCorpusReadable, readCorpusFile },
): Promise<SymbolTableArtifact> {
  const skipped: Record<string, number> = {}
  const parsed: Record<string, number> = {}
  const files: Record<string, FileSymbols> = {}
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }

  const toParse: { entry: InventoryEntry; abs: string }[] = []
  for (const entry of entries) {
    if (entry.test) { skip('test'); continue }
    if (entry.oversize) { skip('oversize'); continue }
    if (entry.empty) { skip('empty'); continue }
    if (!grammarFor(entry.language, entry.path)) { skip('unsupported_language'); continue }
    const abs = path.join(targetDir, entry.path)
    if (!guard.isCorpusReadable(path.relative(REPO_ROOT, abs))) { skip('guard_denied'); continue }
    toParse.push({ entry, abs })
  }

  await initSymbolParsers(new Set(toParse.map((t) => t.entry.language)))

  for (const { entry, abs } of toParse) {
    let source: string
    try {
      const content = guard.readCorpusFile
        ? guard.readCorpusFile(path.relative(REPO_ROOT, abs))
        : fs.readFileSync(abs, 'utf-8')
      if (content === null) { skip('guard_denied'); continue }
      source = content
    } catch {
      skip('read_error')
      continue
    }
    const fileSymbols = extractFileSymbols(source, entry.language, entry.path)
    if (!fileSymbols) { skip('unsupported_language'); continue }
    files[entry.path] = fileSymbols
    parsed[entry.language] = (parsed[entry.language] ?? 0) + 1
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    target_dir: path.resolve(targetDir),
    parser: parserInfo(),
    languages: sortedRecord(parsed),
    skipped: sortedRecord(skipped),
    files: sortedRecord(files),
  }
}

// Compile-time check that the implementation satisfies the contract.
const _contract: ExtractSymbolTable = extractSymbolTable
void _contract
