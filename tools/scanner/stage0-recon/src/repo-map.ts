/**
 * Repo map: the bounded, deterministic description of a repository that the
 * recon v3 architecture call reads (written to repo-map.md).
 *
 * The model cannot be handed the repository, so it is handed this instead: what
 * languages it is written in, how it is laid out, what it depends on, what it
 * says about itself, where execution starts, which routes it registers, and the
 * names each important file exports. Sections, in order, each capped:
 *
 *   1. language counts
 *   2. directory tree (depth <= 3, file counts)
 *   3. dependency manifests (shallowest first)
 *   4. root README
 *   5. entry points (Express entry file, conventional names, files declaring main)
 *   6. route registrations, when an enricher produced them
 *   7. exported-symbol outline of the top files (entry points first, then by signal count)
 *
 * Sections 1-6 have fixed caps. The symbol outline, last, gets whatever budget
 * those left unused, between a floor and a ceiling; the fixed caps plus the
 * floor sum to less than the total, so the total holds by construction and no
 * section can starve another. Identical input gives byte-identical output:
 * every list is sorted, nothing carries a timestamp.
 *
 * What may enter the map is decided by the read guard, not here. A file whose
 * content or symbols appear must be a non-test inventory file the guard allows
 * (isCorpusReadable), and content is read through readCorpusFile — so the
 * benchmark's seed denylist and a product run's target confinement hold for
 * this prompt exactly as they do for Stage 2's.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  isDependencyManifest,
  type InventoryEntry,
  type SymbolEntry,
  type SymbolTableArtifact,
} from './recon-contract.js'
import { REPO_ROOT } from '../../shared/run-context.js'
import { isCorpusReadable, readCorpusFile } from '../../shared/read-guard.js'

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * Every bound the map respects. Section caps include the section's own heading
 * and its "not shown" note. The six fixed caps plus the symbol outline's floor
 * sum to 58,800, under the 60,000 total; the outline's ceiling is reached only
 * when earlier sections leave that much unused.
 */
export const REPO_MAP_LIMITS = Object.freeze({
  total_chars: 60_000,
  languages_section_chars: 1_500,
  tree_max_depth: 3,
  tree_max_dirs: 150,
  tree_section_chars: 5_000,
  max_manifests: 8,
  manifest_chars: 4_000,
  manifests_section_chars: 12_000,
  readme_chars: 6_000,
  readme_section_chars: 6_300,
  max_entry_points: 6,
  entry_point_chars: 6_000,
  entry_points_section_chars: 14_000,
  max_route_lines: 200,
  route_line_chars: 160,
  routes_section_chars: 12_000,
  max_symbols_per_file: 12,
  max_outline_files: 300,
  symbols_section_min_chars: 8_000,
  symbols_section_chars: 24_000,
})

/** Room kept at the end of every section for its "N more not shown" note. */
const NOTE_RESERVE = 120
/** A file excerpt shorter than this is not worth starting. */
const MIN_EXCERPT = 400

/**
 * Languages that hold executable logic — the set Stage 0.5's per-file lane
 * selector hunts. Entry points and tool-calling candidates are drawn from it.
 */
export const EXECUTABLE_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript', 'javascript', 'python', 'ruby', 'java', 'go',
  'rust', 'c', 'cpp', 'csharp', 'php', 'kotlin', 'swift',
  'scala', 'solidity', 'dart', 'r', 'perl', 'lua', 'shell',
  'docker', 'graphql',
])

// ---------------------------------------------------------------------------
// Guard adapter
// ---------------------------------------------------------------------------

/** The read guard, addressed by target-relative path. */
export interface MapGuard {
  /** May this file's content or symbols enter a prompt? Does not read. */
  isReadable(relPath: string): boolean
  /** The file's content, or null when the guard refuses it. */
  read(relPath: string): string | null
}

/**
 * The process's read guard for one target. The guard takes repo-relative paths
 * (a product target outside the repo arrives as '../..'), as Stage 2 passes them.
 */
export function corpusGuard(targetDir: string): MapGuard {
  const repoRel = (rel: string) => path.relative(REPO_ROOT, path.join(targetDir, rel))
  return {
    isReadable: (rel) => isCorpusReadable(repoRel(rel)),
    read: (rel) => readCorpusFile(repoRel(rel)),
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface RepoMapRoute {
  method: string
  path: string
  middleware: string[]
  /** Target-relative declaring file. */
  file: string
}

export interface RepoMapAutoCrud {
  pathPattern: string
  model: string
  file: string
}

export interface EntryPoint {
  path: string
  /** Which rule selected it, in words ("Express entry file", "declares main"). */
  reason: string
}

export interface RepoMapInput {
  targetDir: string
  inventory: readonly InventoryEntry[]
  symbols: SymbolTableArtifact
  /** file-signals.json `files`. */
  signals: Readonly<Record<string, readonly string[]>>
  routes: readonly RepoMapRoute[]
  autoCrud: readonly RepoMapAutoCrud[]
  /** Name of the enricher that produced the routes, for the section heading. */
  routeSource?: string
  entryPoints: readonly EntryPoint[]
  guard: MapGuard
}

export interface RepoMapSectionStats {
  name: string
  chars: number
  /** Lines or files shown. */
  shown: number
  /** Lines or files that did not fit. */
  omitted: number
}

export interface RepoMapResult {
  text: string
  sections: RepoMapSectionStats[]
  /** Target-relative files whose content or symbols are in the map. Sorted. */
  files: string[]
  manifests: string[]
  readme: string | null
}

// ---------------------------------------------------------------------------
// Selection helpers (also used by recon.ts and llm-probe.ts)
// ---------------------------------------------------------------------------

function depth(rel: string): number {
  return rel.split('/').length - 1
}

function byDepthThenPath(a: string, b: string): number {
  return depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0)
}

/** Non-test inventory files the guard lets into a prompt. Inventory order. */
export function mapEligible(inventory: readonly InventoryEntry[], guard: MapGuard): InventoryEntry[] {
  return inventory.filter(e => !e.test && guard.isReadable(e.path))
}

/** Dependency manifests for the map: readable, non-test, non-empty, shallowest first. */
export function selectManifests(inventory: readonly InventoryEntry[], guard: MapGuard): string[] {
  return mapEligible(inventory, guard)
    .filter(e => !e.oversize && !e.empty && isDependencyManifest(e.path))
    .map(e => e.path)
    .sort(byDepthThenPath)
    .slice(0, REPO_MAP_LIMITS.max_manifests)
}

const CONVENTIONAL_STEMS = ['server', 'app', 'main', 'index']
const FRAMEWORK_ENTRY_BASENAMES = new Set([
  'manage.py', 'wsgi.py', 'asgi.py', 'urls.py', 'program.cs', 'startup.cs', 'main.go',
])
const FRAMEWORK_ENTRY_SUFFIXES = ['config/routes.rb', 'routes/web.php']

/** '' for the root, 'src', or 'cmd/<name>' — the directories conventional names count in. */
function conventionalDirRank(dir: string): number {
  if (dir === '' || dir === '.') return 0
  if (dir === 'src') return 1
  if (/^cmd\/[^/]+$/.test(dir)) return 2
  return -1
}

/**
 * Where execution starts, best first, at most max_entry_points:
 *   1. the Express entry file, when the enricher found one
 *   2. server.* / app.* / main.* / index.* at the root, in src/ or in cmd/<name>/
 *   3. framework entry files: manage.py, wsgi.py, asgi.py, urls.py, Program.cs,
 *      Startup.cs, main.go, config/routes.rb, routes/web.php
 *   4. files that declare a function or method named `main`
 * Within a rule, shallowest first. Only readable, non-test, non-empty files
 * in an executable language under the byte cap qualify.
 */
export function selectEntryPoints(
  inventory: readonly InventoryEntry[],
  symbols: SymbolTableArtifact,
  expressEntry: string | null,
  guard: MapGuard,
): EntryPoint[] {
  const usable = mapEligible(inventory, guard)
    .filter(e => !e.oversize && !e.empty && EXECUTABLE_LANGUAGES.has(e.language))
  const usablePaths = new Set(usable.map(e => e.path))
  const out: EntryPoint[] = []
  const add = (p: string, reason: string) => {
    if (out.length >= REPO_MAP_LIMITS.max_entry_points) return
    if (!usablePaths.has(p) || out.some(o => o.path === p)) return
    out.push({ path: p, reason })
  }

  if (expressEntry) add(expressEntry, 'Express entry file')

  const conventional = usable
    .map(e => {
      const dir = path.posix.dirname(e.path)
      const stem = path.posix.basename(e.path, path.posix.extname(e.path)).toLowerCase()
      return { p: e.path, dirRank: conventionalDirRank(dir), stemRank: CONVENTIONAL_STEMS.indexOf(stem) }
    })
    .filter(c => c.dirRank >= 0 && c.stemRank >= 0)
    .sort((a, b) => a.dirRank - b.dirRank || a.stemRank - b.stemRank || (a.p < b.p ? -1 : 1))
  for (const c of conventional) add(c.p, 'conventional entry-point name')

  const framework = usable
    .map(e => e.path)
    .filter(p => {
      const lower = p.toLowerCase()
      if (FRAMEWORK_ENTRY_BASENAMES.has(path.posix.basename(lower))) return true
      return FRAMEWORK_ENTRY_SUFFIXES.some(s => lower === s || lower.endsWith('/' + s))
    })
    .sort(byDepthThenPath)
  for (const p of framework) add(p, `framework entry file (${path.posix.basename(p)})`)

  const declaresMain = usable
    .map(e => e.path)
    .filter(p => (symbols.files[p]?.symbols ?? []).some(s => s.name === 'main' && (s.kind === 'function' || s.kind === 'method')))
    .sort(byDepthThenPath)
  for (const p of declaresMain) add(p, 'declares main')

  return out
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** A fence longer than any backtick run in the content, so the content cannot close it. */
function fenceFor(content: string): string {
  let fence = '```'
  while (content.includes(fence)) fence += '`'
  return fence
}

/** Content cut to at most `max` characters, the cut marked inside the budget. */
function excerpt(content: string, max: number): string {
  if (content.length <= max) return content
  const marker = `\n… [truncated: first ${max} of ${content.length} characters]`
  return content.slice(0, Math.max(0, max - marker.length)) + marker
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' ').trim(), max)
}

/**
 * Accumulates one section within its character cap. The first block that does
 * not fit closes the section, so what is shown is always a prefix of what was
 * offered — never a child line without its parent.
 */
class SectionWriter {
  private parts: string[] = []
  private used = 0
  private closed = false
  shown = 0
  omitted = 0

  constructor(readonly name: string, readonly cap: number, heading: string) {
    this.parts.push(heading)
    this.used = heading.length
  }

  /** Characters still available for content (the note reserve excluded). */
  room(): number {
    return this.cap - this.used - NOTE_RESERVE - 1
  }

  /** Append a block if it fits. Counts it as shown, or as omitted when it does not. */
  push(block: string, countsAsItem = true): boolean {
    if (this.closed || block.length > this.room()) {
      this.closed = true
      if (countsAsItem) this.omitted++
      return false
    }
    this.parts.push(block)
    this.used += block.length + 1
    if (countsAsItem) this.shown++
    return true
  }

  /** Append text that is not an item (a sub-heading, a note). */
  pushText(text: string): boolean {
    return this.push(text, false)
  }

  text(): string {
    const parts = [...this.parts]
    if (this.omitted > 0) parts.push(`… ${this.omitted} more not shown (section limit).`)
    const out = parts.join('\n')
    // Unreachable while room() keeps the reserve; kept so the cap is a guarantee.
    return out.length <= this.cap ? out : out.slice(0, this.cap)
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function languagesSection(files: readonly InventoryEntry[], testCount: number): SectionWriter {
  const s = new SectionWriter('languages', REPO_MAP_LIMITS.languages_section_chars, '## Languages')
  s.pushText(`${files.length} files are described in this map${testCount > 0 ? ` (${testCount} test files are not)` : ''}.`)
  const counts = new Map<string, number>()
  for (const f of files) counts.set(f.language, (counts.get(f.language) ?? 0) + 1)
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  for (const [lang, n] of rows) s.push(`- ${lang}: ${n}`)
  return s
}

interface DirNode { total: number; children: Map<string, DirNode> }

function treeSection(files: readonly InventoryEntry[]): SectionWriter {
  const s = new SectionWriter('tree', REPO_MAP_LIMITS.tree_section_chars, `## Directory tree (depth ${REPO_MAP_LIMITS.tree_max_depth}, files per directory including subdirectories)`)
  const root: DirNode = { total: 0, children: new Map() }
  let atRoot = 0
  for (const f of files) {
    const dirs = f.path.split('/').slice(0, -1)
    root.total++
    if (dirs.length === 0) atRoot++
    let node = root
    // Files deeper than the limit count toward their deepest shown ancestor.
    for (const d of dirs.slice(0, REPO_MAP_LIMITS.tree_max_depth)) {
      let child = node.children.get(d)
      if (!child) {
        child = { total: 0, children: new Map() }
        node.children.set(d, child)
      }
      child.total++
      node = child
    }
  }
  s.pushText(`./  ${root.total} files (${atRoot} at the root)`)
  let dirsShown = 0
  const walk = (node: DirNode, level: number) => {
    for (const name of [...node.children.keys()].sort()) {
      const child = node.children.get(name)!
      if (dirsShown >= REPO_MAP_LIMITS.tree_max_dirs) {
        s.omitted++
      } else if (s.push(`${'  '.repeat(level)}${name}/  ${child.total}`)) {
        dirsShown++
      }
      walk(child, level + 1)
    }
  }
  walk(root, 1)
  return s
}

function fileBlocksSection(
  s: SectionWriter,
  items: readonly { path: string; label: string; fenceLang: string }[],
  perFileMax: number,
  guard: MapGuard,
  included: Set<string>,
): void {
  for (const item of items) {
    const content = guard.read(item.path)
    if (content === null) continue
    const header = `### ${item.path}${item.label ? ` — ${item.label}` : ''}`
    // header + two fence lines + newlines
    const overhead = header.length + 2 * (fenceFor(content).length + item.fenceLang.length) + 4
    const budget = Math.min(perFileMax, s.room() - overhead)
    if (budget < MIN_EXCERPT) {
      s.omitted++
      continue
    }
    const body = excerpt(content, budget).replace(/\n$/, '')
    const fence = fenceFor(body)
    if (s.push(`${header}\n${fence}${item.fenceLang}\n${body}\n${fence}`)) included.add(item.path)
  }
}

/** Fence tag for a manifest or source file. */
function fenceLang(entry: InventoryEntry | undefined): string {
  if (!entry || entry.language === 'manifest') return ''
  return entry.language
}

function readmeSection(targetDir: string, guard: MapGuard): { s: SectionWriter; readme: string | null } {
  const s = new SectionWriter('readme', REPO_MAP_LIMITS.readme_section_chars, '## README')
  let names: string[] = []
  try {
    names = fs.readdirSync(targetDir).filter(n => /^readme(\.(md|markdown|rst|txt|adoc|org))?$/i.test(n))
  } catch { /* unreadable target root: no README */ }
  // README.md before README.rst before a bare README; ties by name.
  const rank = (n: string) => (/\.(md|markdown)$/i.test(n) ? 0 : /\./.test(n) ? 1 : 2)
  names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  for (const name of names) {
    if (!guard.isReadable(name)) continue
    const content = guard.read(name)
    if (content === null || !content.trim()) continue
    // Fenced, so the README's own headings cannot pass for sections of the map.
    const fence = fenceFor(content)
    const overhead = name.length + 2 * fence.length + 'markdown'.length + 8
    const body = excerpt(content, Math.min(REPO_MAP_LIMITS.readme_chars, s.room() - overhead)).replace(/\n$/, '')
    s.push(`(${name})\n${fence}markdown\n${body}\n${fence}`)
    return { s, readme: name }
  }
  s.pushText('(none at the repository root)')
  return { s, readme: null }
}

function routesSection(routes: readonly RepoMapRoute[], autoCrud: readonly RepoMapAutoCrud[], source: string): SectionWriter {
  const s = new SectionWriter('routes', REPO_MAP_LIMITS.routes_section_chars, `## Route registrations (${source})`)
  if (routes.length === 0 && autoCrud.length === 0) {
    s.pushText('(no framework enricher produced a route table)')
    return s
  }
  s.pushText('Format: METHOD path  middleware and handler arguments, in registration order.')
  let lines = 0
  let currentFile: string | null = null
  const line = (text: string, file: string) => {
    if (lines >= REPO_MAP_LIMITS.max_route_lines) {
      s.omitted++
      return
    }
    if (file !== currentFile) {
      if (!s.pushText(`Declared in ${file}:`)) {
        s.omitted++
        return
      }
      currentFile = file
    }
    if (s.push(clip(text, REPO_MAP_LIMITS.route_line_chars))) lines++
  }
  for (const r of routes) {
    const mw = r.middleware.map(m => oneLine(m, 48)).join(' ')
    line(`${oneLine(r.method, 10)} ${oneLine(r.path, 80)}  ${mw}`, r.file)
  }
  for (const a of autoCrud) line(`ALL ${oneLine(a.pathPattern, 80)}  (auto-CRUD, model ${oneLine(a.model, 40)})`, a.file)
  return s
}

function symbolLabel(sym: SymbolEntry): string {
  return sym.container && sym.kind === 'method' ? `${sym.kind} ${sym.container}.${sym.name}` : `${sym.kind} ${sym.name}`
}

function symbolsSection(
  eligible: readonly InventoryEntry[],
  symbols: SymbolTableArtifact,
  signals: Readonly<Record<string, readonly string[]>>,
  entryPoints: readonly EntryPoint[],
  included: Set<string>,
  cap: number,
): SectionWriter {
  const s = new SectionWriter('symbols', cap, `## Exported symbols (top files; at most ${REPO_MAP_LIMITS.max_symbols_per_file} per file)`)
  const exportedOf = (p: string) =>
    (symbols.files[p]?.symbols ?? []).filter(x => x.exported).sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : 1))
  const entryRank = new Map(entryPoints.map((e, i) => [e.path, i]))
  const candidates = eligible
    .filter(e => exportedOf(e.path).length > 0)
    .map(e => ({ p: e.path, entry: entryRank.get(e.path) ?? Infinity, sig: signals[e.path]?.length ?? 0 }))
    .sort((a, b) => a.entry - b.entry || b.sig - a.sig || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
  if (candidates.length === 0) {
    s.pushText('(no exported symbols in the symbol table)')
    return s
  }
  for (const [i, c] of candidates.entries()) {
    if (i >= REPO_MAP_LIMITS.max_outline_files) {
      s.omitted++
      continue
    }
    const syms = exportedOf(c.p)
    const shown = syms.slice(0, REPO_MAP_LIMITS.max_symbols_per_file).map(symbolLabel)
    const more = syms.length > shown.length ? ` (+${syms.length - shown.length} more)` : ''
    const sig = signals[c.p]?.length ? ` [${signals[c.p].join(', ')}]` : ''
    if (s.push(`- ${c.p}${sig}: ${shown.join(', ')}${more}`)) included.add(c.p)
  }
  return s
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Build the repo map. Pure apart from the guarded reads and the README lookup. */
export function buildRepoMap(input: RepoMapInput): RepoMapResult {
  const { targetDir, inventory, symbols, signals, guard } = input
  const eligible = mapEligible(inventory, guard)
  const eligiblePaths = new Set(eligible.map(e => e.path))
  const byPath = new Map(inventory.map(e => [e.path, e]))
  const testCount = inventory.filter(e => e.test).length
  const included = new Set<string>()

  const languages = languagesSection(eligible, testCount)
  const tree = treeSection(eligible)

  const manifestPaths = selectManifests(inventory, guard)
  const manifests = new SectionWriter('manifests', REPO_MAP_LIMITS.manifests_section_chars, '## Dependency manifests')
  if (manifestPaths.length === 0) manifests.pushText('(none found)')
  fileBlocksSection(
    manifests,
    manifestPaths.map(p => ({ path: p, label: '', fenceLang: fenceLang(byPath.get(p)) })),
    REPO_MAP_LIMITS.manifest_chars, guard, included,
  )

  const { s: readme, readme: readmeName } = readmeSection(targetDir, guard)

  // Re-checked here so a caller cannot pass in an entry point the guard refuses.
  const entryPoints = input.entryPoints.filter(e => eligiblePaths.has(e.path)).slice(0, REPO_MAP_LIMITS.max_entry_points)
  const entries = new SectionWriter('entry_points', REPO_MAP_LIMITS.entry_points_section_chars, '## Entry points')
  if (entryPoints.length === 0) entries.pushText('(none identified)')
  fileBlocksSection(
    entries,
    entryPoints.map(e => ({ path: e.path, label: e.reason, fenceLang: fenceLang(byPath.get(e.path)) })),
    REPO_MAP_LIMITS.entry_point_chars, guard, included,
  )

  const routes = routesSection(input.routes, input.autoCrud, input.routeSource ?? 'framework enricher')

  const header = '# Repository map\nA bounded, generated description of the repository: paths are relative to its root.'
  const fixed = [languages, tree, manifests, readme, entries, routes]
  // header + six sections + seven '\n\n' joiners + the trailing newline
  const used = header.length + fixed.reduce((n, s) => n + s.text().length, 0) + 2 * 7 + 1
  const outlineCap = Math.min(REPO_MAP_LIMITS.symbols_section_chars, REPO_MAP_LIMITS.total_chars - used)
  const outline = symbolsSection(eligible, symbols, signals, entryPoints, included, outlineCap)

  const sections = [...fixed, outline]
  let text = [header, ...sections.map(s => s.text())].join('\n\n') + '\n'
  // The outline's cap is what is left of the total, so this only trims if that arithmetic breaks.
  if (text.length > REPO_MAP_LIMITS.total_chars) text = text.slice(0, REPO_MAP_LIMITS.total_chars)

  return {
    text,
    sections: sections.map(s => ({ name: s.name, chars: s.text().length, shown: s.shown, omitted: s.omitted })),
    files: [...included].sort(),
    manifests: manifestPaths,
    readme: readmeName,
  }
}
