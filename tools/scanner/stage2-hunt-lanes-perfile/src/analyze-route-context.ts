/**
 * Analysis script: per-lane route context, matched by the tree-sitter symbol
 * table (Stage 0's symbols.json) and by the regex the live prompt path still
 * uses (extractExportedSymbols), side by side.
 *
 * Usage:  npx tsx src/analyze-route-context.ts [lane-file ...]
 *
 *   lane-file   target-relative paths whose "## How This File Is Reached"
 *               section is printed in full. Default: the three hunt lanes with
 *               the most routes matched by the symbol table.
 *
 * Outputs:
 * - The rendered route context for those lanes (registrar block + matched
 *   routes, composed as huntLane() composes them)
 * - Route-match distribution across all hunt lanes, symbol table vs regex
 * - Every lane whose matched routes differ between the two, and why
 * - Prompt-size delta for lanes that match routes
 *
 * Read-only. The symbol-table side replicates matchRoutesForFile()'s rules
 * (whole-word handler/middleware match, auto-CRUD by model name or basename)
 * over a given name set, because hunt-executor.ts derives the names itself;
 * a self-check below proves the replica agrees with it on every lane, so the
 * symbol source is the only thing that differs between the two columns.
 *
 * The symbol-table names are exportedNames(): runtime exports only. A
 * TypeScript interface or type alias is in the table but cannot be a handler
 * or a model; counted, it matched auto-CRUD routes by name (data/types.ts'
 * `Product` interface claimed /api/Products).
 */
import { readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'
import {
  extractExportedSymbols,
  matchRoutesForFile,
  renderRouteContext,
  renderRegistrarRouteContext,
  type RouteContext,
} from './hunt-executor.js'
import { runPath, REPO_ROOT, type Provider } from '../../shared/run-paths.js'
import { resolveProvider } from '../../shared/provider.js'
import { readCorpusFile } from '../../shared/read-guard.js'
import { SYMBOLS_FILE, exportedNames, type SymbolTableArtifact } from '../../stage0-recon/src/recon-contract.js'

// ── Paths ─────────────────────────────────────────────────────────────────
// Analysis-only script, but still provider-scoped: reading one model's lane
// assignments while reporting them as another's is the mix-up runPath() exists
// to prevent, and an analysis number is quoted as readily as a run's.

const PROVIDER: Provider = resolveProvider('stage2perfile')
const LANE_ASSIGNMENTS_PATH = join(runPath(PROVIDER, 'stage05-lane-selector-perfile'), 'lane-assignments.json')
const ARCH_SUMMARY_PATH = join(runPath(PROVIDER, 'stage0-recon'), 'architecture-summary.json')
const SYMBOLS_PATH = join(runPath(PROVIDER, 'stage0-recon'), SYMBOLS_FILE)

const DEFAULT_RENDERED_LANES = 3

// ── Matching by a given set of exported names ─────────────────────────────

type ArchSummary = { route_table: { hand_written_routes: any[]; auto_crud_routes: any[]; middleware_routes?: any[] } }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nameMatchesAny(text: string, names: Set<string>): boolean {
  for (const name of names) {
    if (new RegExp('\\b' + escapeRegex(name) + '\\b').test(text)) return true
  }
  return false
}

/** matchRoutesForFile() with the exported names supplied instead of parsed from the content. */
function matchRoutesByNames(targetFileRel: string, names: Set<string>, arch: ArchSummary): RouteContext {
  if (names.size === 0) return { handWritten: [], autoCrud: [] }
  const basename = targetFileRel.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
  const handWritten = (arch.route_table.hand_written_routes ?? []).filter((route: any) => {
    if (route.handler && nameMatchesAny(route.handler, names)) return true
    return Array.isArray(route.middleware) && route.middleware.some((mw: string) => nameMatchesAny(mw, names))
  })
  const autoCrud = (arch.route_table.auto_crud_routes ?? []).filter((route: any) =>
    !!route.model && (names.has(route.model) || basename.toLowerCase() === route.model.toLowerCase()))
  return { handWritten, autoCrud }
}

const total = (c: RouteContext) => c.handWritten.length + c.autoCrud.length
const routeKey = (r: any) => `${r.method ?? '?'} ${r.path ?? '?'} (${r.file ?? '?'}:${r.line ?? '?'})`
const crudKey = (r: any) => `CRUD ${r.pathPattern ?? '?'}`
const keysOf = (c: RouteContext) => new Set([...c.handWritten.map(routeKey), ...c.autoCrud.map(crudKey)])

/** The section huntLane() would put in the prompt: registrar block first, then matched routes. */
function composeSection(targetFileRel: string, ctx: RouteContext, arch: ArchSummary): string | undefined {
  const matched = renderRouteContext(ctx)
  const registrar = renderRegistrarRouteContext(targetFileRel, arch.route_table)
  if (registrar && matched) return `${registrar}\n\n${matched}`
  return registrar ?? matched
}

// ── Main ──────────────────────────────────────────────────────────────────

interface LaneAnalysis {
  file: string
  content: string
  symtabNames: Set<string>
  regexNames: Set<string>
  symtab: RouteContext
  regex: RouteContext
}

function loadJson(path: string, what: string, hint: string): any {
  if (!existsSync(path)) {
    console.error(`${what} not found at ${path}`)
    console.error(hint)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function bucketLine(label: string, a: number, b: number): string {
  return `  ${label.padEnd(22)} ${String(a).padStart(8)}   ${String(b).padStart(8)}`
}

async function main() {
  const assignments = loadJson(LANE_ASSIGNMENTS_PATH, 'Lane assignments', 'Has Stage 0.5 (per-file) run yet?')
  const targetDir: string = assignments.target_dir
  console.log(`Loaded ${assignments.lanes.length} lanes from ${LANE_ASSIGNMENTS_PATH}`)
  console.log(`Target directory: ${targetDir}`)

  const archSummary = loadJson(ARCH_SUMMARY_PATH, 'Architecture summary', 'Has Stage 0 run yet?')
  const arch: ArchSummary = { route_table: archSummary.route_table }
  console.log(`Route table: ${arch.route_table.hand_written_routes.length} hand-written, ${arch.route_table.auto_crud_routes.length} auto-CRUD`)

  const symbols: SymbolTableArtifact = loadJson(
    SYMBOLS_PATH, 'Symbol table', 'It is written by Stage 0 from recon v3 on; re-run Stage 0.',
  )
  console.log(`Symbol table: ${Object.keys(symbols.files).length} files (${symbols.parser.runtime}, ${symbols.parser.grammars})`)
  console.log()

  // ── Analyse every hunt lane ──────────────────────────────────────────

  const readLane = (file: string): string => {
    // Through the guard, as huntLane() reads it; a hunt lane is never denied.
    return readCorpusFile(relative(REPO_ROOT, join(targetDir, file))) ?? ''
  }
  const analyse = (file: string): LaneAnalysis => {
    const content = readLane(file)
    const symtabNames = exportedNames(symbols.files[file])
    const regexNames = extractExportedSymbols(content)
    return {
      file, content, symtabNames, regexNames,
      symtab: matchRoutesByNames(file, symtabNames, arch),
      regex: matchRoutesForFile(file, content, arch),
    }
  }

  const huntLanes = assignments.lanes.filter((l: any) => l.disposition === 'hunt')
  const lanes: LaneAnalysis[] = huntLanes.map((l: any) => analyse(l.target_file))

  // Self-check: the replica, given the regex's names, must reproduce the live function exactly.
  const replicaMismatches = lanes.filter((l) => {
    const replica = matchRoutesByNames(l.file, l.regexNames, arch)
    return JSON.stringify(replica) !== JSON.stringify(l.regex)
  })
  console.log(`Replica check (matchRoutesByNames on regex names == matchRoutesForFile): ${lanes.length - replicaMismatches.length} / ${lanes.length} lanes identical`)
  for (const l of replicaMismatches) console.log(`  MISMATCH ${l.file}`)
  console.log()

  // ── Render the chosen lanes ──────────────────────────────────────────

  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const rendered = requested.length > 0
    ? requested
    : [...lanes]
        .map((l, i) => ({ l, i }))
        .sort((a, b) => total(b.l.symtab) - total(a.l.symtab) || a.i - b.i)
        .slice(0, DEFAULT_RENDERED_LANES)
        .map(({ l }) => l.file)

  console.log(`=== Rendered "## How This File Is Reached" (symbol table)${requested.length > 0 ? '' : `: top ${DEFAULT_RENDERED_LANES} lanes by matched routes`} ===\n`)
  for (const file of rendered) {
    if (!existsSync(join(targetDir, file))) {
      console.log(`--- ${file} ---\n  [FILE NOT FOUND at ${join(targetDir, file)}]\n`)
      continue
    }
    const l = lanes.find((x) => x.file === file) ?? analyse(file)
    const hunt = lanes.includes(l) ? '' : ' [not a hunt lane]'
    console.log(`--- Lane: ${file}${hunt} — exported names: ${l.symtabNames.size} (symbol table), ${l.regexNames.size} (regex); ` +
      `matched routes: ${total(l.symtab)} (symbol table), ${total(l.regex)} (regex) ---`)
    console.log(composeSection(file, l.symtab, arch) ?? '  [No matching routes]')
    console.log()
  }

  // ── Distribution, side by side ───────────────────────────────────────

  const dist = (pick: (l: LaneAnalysis) => RouteContext) => {
    const counts = lanes.map((l) => total(pick(l)))
    return {
      atLeastOne: counts.filter((n) => n > 0).length,
      zero: counts.filter((n) => n === 0).length,
      one: counts.filter((n) => n === 1).length,
      twoToFive: counts.filter((n) => n >= 2 && n <= 5).length,
      sixToFifteen: counts.filter((n) => n >= 6 && n <= 15).length,
      moreThanFifteen: counts.filter((n) => n > 15).length,
      routes: counts.reduce((s, n) => s + n, 0),
    }
  }
  const s = dist((l) => l.symtab)
  const r = dist((l) => l.regex)
  const pct = (n: number) => `${(n / Math.max(lanes.length, 1) * 100).toFixed(1)}%`

  console.log(`=== Route-match distribution over ${lanes.length} hunt lanes ===`)
  console.log(`  ${''.padEnd(22)} ${'symtab'.padStart(8)}   ${'regex'.padStart(8)}`)
  console.log(bucketLine('lanes matching >=1', s.atLeastOne, r.atLeastOne) + `   (${pct(s.atLeastOne)} vs ${pct(r.atLeastOne)})`)
  console.log(bucketLine('0 routes', s.zero, r.zero))
  console.log(bucketLine('1 route', s.one, r.one))
  console.log(bucketLine('2-5 routes', s.twoToFive, r.twoToFive))
  console.log(bucketLine('6-15 routes', s.sixToFifteen, r.sixToFifteen))
  console.log(bucketLine('>15 routes', s.moreThanFifteen, r.moreThanFifteen))
  console.log(bucketLine('lane-route pairs', s.routes, r.routes))
  console.log()

  // ── Lanes whose matches differ ───────────────────────────────────────

  const differing = lanes.filter((l) => JSON.stringify(l.symtab) !== JSON.stringify(l.regex))
  console.log(`=== Lanes whose matched routes differ (${differing.length}) ===`)
  for (const l of differing) {
    const sk = keysOf(l.symtab)
    const rk = keysOf(l.regex)
    const onlySym = [...sk].filter((k) => !rk.has(k))
    const onlyRegex = [...rk].filter((k) => !sk.has(k))
    const namesOnlySym = [...l.symtabNames].filter((n) => !l.regexNames.has(n))
    const namesOnlyRegex = [...l.regexNames].filter((n) => !l.symtabNames.has(n))
    console.log(`  ${l.file}: symtab ${l.symtab.handWritten.length} hand-written + ${l.symtab.autoCrud.length} CRUD, ` +
      `regex ${l.regex.handWritten.length} + ${l.regex.autoCrud.length}`)
    if (namesOnlySym.length) console.log(`    names only in symbol table: ${namesOnlySym.join(', ')}`)
    if (namesOnlyRegex.length) console.log(`    names only in regex:        ${namesOnlyRegex.join(', ')}`)
    for (const k of onlySym) console.log(`    + ${k}`)
    for (const k of onlyRegex) console.log(`    - ${k}`)
  }
  if (differing.length === 0) console.log('  (none)')
  console.log()

  // ── Prompt size impact ───────────────────────────────────────────────

  const impact = (label: string, pick: (l: LaneAnalysis) => RouteContext) => {
    const deltas = lanes
      .filter((l) => total(pick(l)) > 0)
      .map((l) => renderRouteContext(pick(l))?.length ?? 0)
    if (deltas.length === 0) {
      console.log(`  ${label}: no lanes with matched routes`)
      return
    }
    const avg = deltas.reduce((sum, d) => sum + d, 0) / deltas.length
    console.log(`  ${label}: ${deltas.length} lanes, average added chars ${avg.toFixed(0)} ` +
      `(min ${Math.min(...deltas)}, max ${Math.max(...deltas)}), ~${(avg / 4).toFixed(0)} tokens (est, ~4 chars/token)`)
  }
  console.log('=== Prompt size impact (matched-route block only, lanes with matched routes) ===')
  impact('symbol table', (l) => l.symtab)
  impact('regex       ', (l) => l.regex)
}

main().catch(err => {
  console.error('Analysis failed:', err)
  process.exit(1)
})
