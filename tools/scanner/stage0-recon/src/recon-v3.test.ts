/**
 * Recon v3 orchestration tests: repo map, architecture validation, auth
 * tagging, Express receivers, tool-calling candidates, target-neutral
 * fallbacks. Network-free: no probe that could reach a model is called.
 *
 * Run: npx tsx src/recon-v3.test.ts   (from tools/scanner/stage0-recon)
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { InventoryEntry, SymbolEntry, SymbolTableArtifact } from './recon-contract.js'
import {
  buildRepoMap, corpusGuard, selectEntryPoints, REPO_MAP_LIMITS, type MapGuard, type RepoMapRoute,
} from './repo-map.js'
import {
  validateArchitecture, deterministicArchitecture, rankToolCallingCandidates, buildToolCallingPrompt,
  buildArchitecturePrompt, detectToolCallingDeterministic, probeDeterministic, authPresence,
  detectToolCalling, probeCategoryApplicability, TOOL_CALLING_MAX_FILES, type ArchitectureValidationContext,
} from './llm-probe.js'
import { tagRouteAuth, extract, detectExpress, identifierKey } from './ast-extractor.js'
import { scan as frontendGrep } from './frontend-grep.js'
import { BENCHMARK_TARGET } from '../../shared/run-context.js'
import { isDegraded, degradedReasons, resetDegraded } from '../../shared/degraded.js'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-v3-test-'))

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

function entry(p: string, language: string, opts: Partial<InventoryEntry> = {}): InventoryEntry {
  return { path: p, language, bytes: 100, test: false, oversize: false, empty: false, ...opts }
}

function sym(name: string, kind: SymbolEntry['kind'], line: number, exported = true): SymbolEntry {
  return { name, kind, line, end_line: line, exported }
}

function symbolTable(files: Record<string, SymbolEntry[]>): SymbolTableArtifact {
  const out: SymbolTableArtifact = {
    schema_version: 1, generated_at: 'fixture', target_dir: '/fixture',
    parser: { runtime: 'fixture', grammars: 'fixture' }, languages: {}, skipped: {}, files: {},
  }
  for (const p of Object.keys(files).sort()) {
    out.files[p] = { language: 'typescript', grammar: 'typescript', symbols: files[p], imports: [], parse_error: false }
  }
  return out
}

/** A guard over a fixture directory that refuses the named paths. */
function fixtureGuard(root: string, denied: string[] = []): MapGuard {
  return {
    isReadable: (rel) => !denied.includes(rel) && fs.existsSync(path.join(root, rel)),
    read: (rel) => (denied.includes(rel) || !fs.existsSync(path.join(root, rel)) ? null : fs.readFileSync(path.join(root, rel), 'utf-8')),
  }
}

/** The slice of the map between one '## ' heading and the next. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n\n${heading}`)
  if (start < 0) return ''
  const next = text.indexOf('\n\n## ', start + 2)
  return text.slice(start + 2, next < 0 ? undefined : next)
}

// ---------------------------------------------------------------------------
console.log('\n-- repo map: caps, exclusions, determinism --')
{
  const root = path.join(TMP, 'big-repo')
  const inventory: InventoryEntry[] = []
  const symbolFiles: Record<string, SymbolEntry[]> = {}
  const signals: Record<string, string[]> = {}

  // 12 manifests, each 9,000 chars, at several depths
  for (let i = 0; i < 12; i++) {
    const rel = i === 0 ? 'package.json' : `pkgs/p${String(i).padStart(2, '0')}/package.json`
    write(root, rel, JSON.stringify({ name: `p${i}`, dependencies: { express: '4' }, filler: 'x'.repeat(9_000) }))
    inventory.push(entry(rel, 'json'))
  }
  write(root, 'README.md', '# Big\n' + 'readme line\n'.repeat(2_000))
  // conventional entry points, each 20,000 chars
  for (const rel of ['server.ts', 'app.ts', 'main.ts', 'index.ts', 'src/server.ts', 'src/app.ts', 'src/main.ts', 'src/index.ts']) {
    write(root, rel, `export function start() {}\n${'// filler\n'.repeat(2_000)}`)
    inventory.push(entry(rel, 'typescript'))
    symbolFiles[rel] = [sym('start', 'function', 1)]
  }
  // 400 source files six directories deep, each exporting 30 symbols
  for (let i = 0; i < 400; i++) {
    const rel = `a/b${i % 5}/c${i % 7}/d/e/f/mod${String(i).padStart(3, '0')}.ts`
    write(root, rel, 'export const x = 1\n')
    inventory.push(entry(rel, 'typescript'))
    symbolFiles[rel] = Array.from({ length: 30 }, (_, j) => sym(`fn${j}`, 'function', j + 1))
    signals[rel] = i % 3 === 0 ? ['db_query', 'auth_check'] : ['logging']
  }
  // a test file and a guard-denied file, both with distinctive symbols
  write(root, 'test/secret.spec.ts', 'export function testOnlySymbol() {}\n')
  inventory.push(entry('test/secret.spec.ts', 'typescript', { test: true }))
  symbolFiles['test/secret.spec.ts'] = [sym('testOnlySymbol', 'function', 1)]
  write(root, 'lib/denied.ts', 'export function deniedOnlySymbol() {}\n')
  inventory.push(entry('lib/denied.ts', 'typescript'))
  symbolFiles['lib/denied.ts'] = [sym('deniedOnlySymbol', 'function', 1)]
  signals['lib/denied.ts'] = ['db_query', 'auth_check', 'crypto_op', 'file_io', 'html_sink']
  signals['test/secret.spec.ts'] = ['db_query', 'auth_check', 'crypto_op', 'file_io', 'html_sink']
  inventory.sort((a, b) => (a.path < b.path ? -1 : 1))

  const routes: RepoMapRoute[] = Array.from({ length: 500 }, (_, i) => ({
    method: 'GET', path: `/api/r${i}`, middleware: [`guard.check${i}()`, 'x'.repeat(300)], file: 'server.ts',
  }))
  const symbols = symbolTable(symbolFiles)
  const guard = fixtureGuard(root, ['lib/denied.ts'])
  const entryPoints = selectEntryPoints(inventory, symbols, 'src/server.ts', guard)
  const input = {
    targetDir: root, inventory, symbols, signals, routes, autoCrud: [], routeSource: 'Express enricher', entryPoints, guard,
  }
  const map = buildRepoMap(input)
  const text = map.text
  const caps: Record<string, number> = {
    languages: REPO_MAP_LIMITS.languages_section_chars, tree: REPO_MAP_LIMITS.tree_section_chars,
    manifests: REPO_MAP_LIMITS.manifests_section_chars, readme: REPO_MAP_LIMITS.readme_section_chars,
    entry_points: REPO_MAP_LIMITS.entry_points_section_chars, routes: REPO_MAP_LIMITS.routes_section_chars,
    symbols: REPO_MAP_LIMITS.symbols_section_chars,
  }

  check('total within 60,000 chars', text.length <= 60_000 && REPO_MAP_LIMITS.total_chars === 60_000)
  const fixedCaps = Object.entries(caps).filter(([n]) => n !== 'symbols').reduce((a, [, b]) => a + b, 0)
  check('fixed caps plus the outline floor sum below the total', fixedCaps + REPO_MAP_LIMITS.symbols_section_min_chars < REPO_MAP_LIMITS.total_chars)
  const outlineStats = map.sections.find(s => s.name === 'symbols')!
  check('symbol outline used its leftover budget (at least its floor when needed)', outlineStats.omitted > 0 && outlineStats.chars >= REPO_MAP_LIMITS.symbols_section_min_chars - 200)
  for (const s of map.sections) check(`section ${s.name} within its cap (${s.chars} <= ${caps[s.name]})`, s.chars <= caps[s.name])
  const headings: [string, string][] = [
    ['languages', '## Languages'], ['tree', '## Directory tree'], ['manifests', '## Dependency manifests'],
    ['readme', '## README'], ['entry_points', '## Entry points'], ['routes', '## Route registrations'],
    ['symbols', '## Exported symbols'],
  ]
  for (const [name, h] of headings) check(`section ${name} measured from the text within its cap`, section(text, h).length > 0 && section(text, h).length <= caps[name])
  check('sections appear in the specified order', headings.every(([, h], i) => i === 0 || text.indexOf(headings[i - 1][1]) < text.indexOf(h)))

  const manifestsText = section(text, '## Dependency manifests')
  const manifestBlocks = manifestsText.split('\n### ').slice(1)
  check(`at most ${REPO_MAP_LIMITS.max_manifests} manifests`, map.manifests.length === REPO_MAP_LIMITS.max_manifests && manifestBlocks.length <= REPO_MAP_LIMITS.max_manifests)
  check('manifests shallowest first', map.manifests[0] === 'package.json')
  check('each manifest excerpt within 4,000 chars', manifestBlocks.every(b => b.split('\n').slice(2, -1).join('\n').length <= REPO_MAP_LIMITS.manifest_chars))
  const readmeText = section(text, '## README')
  check('README within 6,000 chars of content', readmeText.length <= REPO_MAP_LIMITS.readme_section_chars && readmeText.includes('truncated'))
  check(`at most ${REPO_MAP_LIMITS.max_entry_points} entry points selected`, entryPoints.length === REPO_MAP_LIMITS.max_entry_points)
  check('Express entry file is the first entry point', entryPoints[0].path === 'src/server.ts' && entryPoints[0].reason === 'Express entry file')
  const entryBlocks = section(text, '## Entry points').split('\n### ').slice(1)
  check('each entry-point excerpt within 6,000 chars', entryBlocks.length > 0 && entryBlocks.every(b => b.split('\n').slice(2, -1).join('\n').length <= REPO_MAP_LIMITS.entry_point_chars))
  const routeLines = section(text, '## Route registrations').split('\n').filter(l => /^GET \/api\//.test(l))
  check(`route lines within ${REPO_MAP_LIMITS.max_route_lines} and each within ${REPO_MAP_LIMITS.route_line_chars} chars`,
    routeLines.length > 0 && routeLines.length <= REPO_MAP_LIMITS.max_route_lines && routeLines.every(l => l.length <= REPO_MAP_LIMITS.route_line_chars))
  check('omitted routes are announced', /more not shown/.test(section(text, '## Route registrations')))
  check('route line format: METHOD path, two spaces, middleware', routeLines[0].startsWith('GET /api/r0  guard.check0() '))
  const outline = section(text, '## Exported symbols').split('\n').filter(l => l.startsWith('- '))
  check(`at most ${REPO_MAP_LIMITS.max_symbols_per_file} symbols per file`, outline.length > 0 && outline.every(l => (l.split(': ')[1] ?? '').split(', ').length <= REPO_MAP_LIMITS.max_symbols_per_file))
  check('symbol outline starts with the entry points', outline[0].startsWith('- src/server.ts'))
  const treeLines = section(text, '## Directory tree').split('\n').slice(2).filter(l => !l.startsWith('…'))
  check(`tree depth at most ${REPO_MAP_LIMITS.tree_max_depth}`, treeLines.length > 0 && treeLines.every(l => (l.match(/^ */)![0].length / 2) <= REPO_MAP_LIMITS.tree_max_depth))
  check('tree counts files under a directory', /\n {2}a\/ {2}400\n/.test(section(text, '## Directory tree')))

  check('test file excluded (path)', !text.includes('test/secret.spec.ts') && !map.files.includes('test/secret.spec.ts'))
  check('test file excluded (symbols)', !text.includes('testOnlySymbol'))
  check('guard-denied file excluded (path)', !text.includes('lib/denied.ts') && !map.files.includes('lib/denied.ts'))
  check('guard-denied file excluded (symbols)', !text.includes('deniedOnlySymbol'))
  check('test directory absent from the tree', !/\btest\//.test(section(text, '## Directory tree')))

  // With little else in the map, the outline takes the unused budget up to its ceiling.
  const lean = buildRepoMap({ ...input, routes: [], inventory: inventory.filter(e => !e.path.endsWith('package.json')) })
  const leanOutline = lean.sections.find(s => s.name === 'symbols')!
  check('outline grows into unused budget, never past its ceiling or the total',
    leanOutline.chars > REPO_MAP_LIMITS.symbols_section_min_chars && leanOutline.chars <= REPO_MAP_LIMITS.symbols_section_chars && lean.text.length <= REPO_MAP_LIMITS.total_chars)

  const again = buildRepoMap({ ...input, inventory: [...inventory].reverse().sort((a, b) => (a.path < b.path ? -1 : 1)) })
  check('deterministic: identical input -> identical map', again.text === text)
  check('deterministic: entry point selection is stable', JSON.stringify(selectEntryPoints(inventory, symbols, 'src/server.ts', guard)) === JSON.stringify(entryPoints))
}

console.log('\n-- repo map: the real read guard keeps denylisted benchmark files out --')
{
  // A hand-built inventory over the blind working copy. models/challenge.ts is
  // on the seed denylist: the map must not contain its path or its symbols,
  // and this test never reads it — only the guard decides.
  const inventory = [
    entry('package.json', 'json'), entry('server.ts', 'typescript'), entry('models/challenge.ts', 'typescript'),
  ]
  const symbols = symbolTable({
    'models/challenge.ts': [sym('denylistedModelSymbol', 'class', 1)],
    'server.ts': [sym('start', 'function', 1)],
  })
  const guard = corpusGuard(BENCHMARK_TARGET)
  check('guard refuses the denylisted file', !guard.isReadable('models/challenge.ts'))
  const entryPoints = selectEntryPoints(inventory, symbols, 'server.ts', guard)
  const map = buildRepoMap({
    targetDir: BENCHMARK_TARGET, inventory, symbols, signals: { 'models/challenge.ts': ['db_query'] },
    routes: [], autoCrud: [], entryPoints, guard,
  })
  check('denylisted path not in the map', !map.text.includes('challenge.ts') && !map.files.includes('models/challenge.ts'))
  check('denylisted symbols not in the map', !map.text.includes('denylistedModelSymbol'))
  check('readable entry file is in the map', map.files.includes('server.ts'))
  check('map within the total cap', map.text.length <= REPO_MAP_LIMITS.total_chars)
}

// ---------------------------------------------------------------------------
console.log('\n-- architecture output validation --')
{
  const ctx: ArchitectureValidationContext = {
    inventoryPaths: new Set(['src/app.py', 'src/auth.py', 'src/db.py']),
    symbolNames: new Set(['require_login', 'get_db']),
    routeText: 'security.checkToken()\nlistUsers()',
    targetDir: '/repo',
  }
  const info = validateArchitecture({
    summary: 'A web app.',
    frameworks: [{ name: 'Flask', language: 'python', evidence: 'requirements' }, { evidence: 'nameless' }],
    entry_points: [
      { file: './src/app.py', kind: 'http_server', description: 'app' },
      { file: 'src/missing.py', kind: 'cli', description: 'invented' },
      { file: '/repo/src/db.py:12', kind: 'worker', description: 'absolute with line' },
    ],
    auth_mechanisms: [{
      name: 'login check', kind: 'authentication',
      identifiers: ['auth.require_login', 'security.checkToken', 'imaginaryGuard'],
      defined_in: ['src/auth.py', 'lib/nowhere.py'], protects: ['/admin'], evidence: 'decorator',
    }, { name: 'odd', kind: 'telepathy', identifiers: [] }],
    data_stores: [{ name: 'Postgres', kind: 'relational', files: ['src/db.py', 'src/ghost.py'], evidence: 'driver' }],
    trust_boundaries: [{ name: 'HTTP', description: 'requests', files: ['nope.py'] }],
  }, ctx, 'llm', 'test-model')!

  check('validation returns an object', info !== null && info.source === 'llm' && info.model === 'test-model')
  check('entry point with a path not in the inventory is dropped', info.entry_points.map(e => e.file).join(',') === 'src/app.py,src/db.py')
  check('dropped records the invented path', info.dropped.some(d => d.field === 'entry_points[1].file' && d.value === 'src/missing.py'))
  check('defined_in keeps only inventory paths', JSON.stringify(info.auth_mechanisms[0].defined_in) === '["src/auth.py"]')
  check('data store and trust boundary files filtered', JSON.stringify(info.data_stores[0].files) === '["src/db.py"]' && info.trust_boundaries[0].files.length === 0)
  check('identifier verified by the symbol table (last dotted segment)', info.auth_mechanisms[0].verified_identifiers.includes('auth.require_login'))
  check('identifier verified by the route table (whole word)', info.auth_mechanisms[0].verified_identifiers.includes('security.checkToken'))
  check('unverified identifier kept in identifiers, not verified', info.auth_mechanisms[0].identifiers.includes('imaginaryGuard') && !info.auth_mechanisms[0].verified_identifiers.includes('imaginaryGuard'))
  check('unverified identifier recorded in dropped', info.dropped.some(d => d.value === 'imaginaryGuard' && /identifier/.test(d.reason)))
  check('every dropped path recorded', ['lib/nowhere.py', 'src/ghost.py', 'nope.py'].every(v => info.dropped.some(d => d.value === v)))
  check('unknown auth kind becomes other', info.auth_mechanisms[1].kind === 'other')
  check('nameless framework removed', info.frameworks.length === 1)
  check('non-object answer is rejected', validateArchitecture([1, 2], ctx, 'llm', null) === null && validateArchitecture('x', ctx, 'llm', null) === null)
  check('identifier must be a whole word in the route text', validateArchitecture({ auth_mechanisms: [{ name: 'x', identifiers: ['check'] }] }, ctx, 'llm', null)!.auth_mechanisms[0].verified_identifiers.length === 0)
  check('identifierKey strips decorators, attributes and arguments',
    identifierKey('@login_required') === 'login_required' && identifierKey('[Authorize(Roles = "Admin")]') === 'Authorize' &&
    identifierKey('security.isAuthorized()') === 'isAuthorized' && identifierKey('passport.authenticate("jwt")') === 'authenticate')

  const prompt = buildArchitecturePrompt('MAP-BODY')
  check('architecture prompt carries the auth-mechanism definition',
    prompt.includes('every function, middleware, decorator or annotation the code uses to authenticate a caller or authorize access') &&
    prompt.includes('Not rate limiting, validation or logging') && prompt.endsWith('MAP-BODY'))
  check('architecture prompt does not ask for the fields recon fills in', !/verified_identifiers|"dropped"|"source"|"model"/.test(prompt))
}

// ---------------------------------------------------------------------------
console.log('\n-- tagRouteAuth --')
{
  const routes = [
    { method: 'GET', routePath: '/a', middleware: ['security.isAuthorized()', 'listA()'], auth: null as string | null },
    { method: 'POST', routePath: '/login', middleware: ['login()'], auth: null as string | null },
    { method: 'GET', routePath: '/b', middleware: ['loginRateLimit', 'security.denyAll()', 'security.isAuthorized()'], auth: null as string | null },
    { method: 'GET', routePath: '/c', middleware: ['security.isAuthorizedish()'], auth: null as string | null },
  ]
  const byDotted = tagRouteAuth(routes, ['security.isAuthorized'])
  const byBare = tagRouteAuth(routes, ['isAuthorized'])
  check('security.isAuthorized() tagged by identifier security.isAuthorized', byDotted[0].auth === 'security.isAuthorized()')
  check('security.isAuthorized() tagged by identifier isAuthorized', byBare[0].auth === 'security.isAuthorized()')
  check('login() handler NOT tagged by loginRateLimit', tagRouteAuth(routes, ['loginRateLimit'])[1].auth === null)
  check('loginRateLimit NOT tagged by login', tagRouteAuth(routes, ['login'])[2].auth === null && tagRouteAuth(routes, ['login'])[1].auth === 'login()')
  check('first matching middleware wins', tagRouteAuth(routes, ['security.isAuthorized', 'security.denyAll'])[2].auth === 'security.denyAll()')
  check('prefix of a longer identifier does not match', byBare[3].auth === null)
  check('no identifiers -> every route null', tagRouteAuth(routes, []).every(r => r.auth === null))
  check('input routes are not modified', routes.every(r => r.auth === null))
  check('$ counts as an identifier character', tagRouteAuth([{ middleware: ['$auth()'], auth: null }], ['auth'])[0].auth === null)
}

// ---------------------------------------------------------------------------
console.log('\n-- Express enricher: receivers and detection --')
{
  const dir = path.join(TMP, 'express-fixtures')
  write(dir, 'router.js', `const express = require('express')
const router = express.Router()
router.get('/items', requireUser, listItems)
router.route('/items/:id').put(updateItem)
module.exports = router
`)
  write(dir, 'server.ts', `import express from 'express'
const server = express()
server.post('/orders', checkAuth(), createOrder())
server.use('/static', serveStatic)
app.get('/not-a-receiver', nope)
`)
  write(dir, 'mount.ts', `export function mount (app) {
  app.get('/health', health)
  app.use('/api', apiRouter)
}
`)
  write(dir, 'named.ts', `import { Router } from 'express'
const r = Router() as any
r.delete('/things/:id', removeThing)
`)
  const router = extract(path.join(dir, 'router.js'))
  check('const router = express.Router() -> receiver router', JSON.stringify(router.receivers) === '["router"]')
  check('router.get and router.route(...).put extracted', JSON.stringify(router.routes.map(r => `${r.method} ${r.routePath}`)) === '["GET /items","PUT /items/:id"]')
  check('routes come out with auth null', router.routes.every(r => r.auth === null))
  const server = extract(path.join(dir, 'server.ts'))
  check('const server = express() -> receiver server', JSON.stringify(server.receivers) === '["server"]')
  check('only the receiver\'s routes are extracted', JSON.stringify(server.routes.map(r => `${r.method} ${r.routePath}`)) === '["POST /orders","USE /static"]')
  check('middleware text kept in order', JSON.stringify(server.routes[0].middleware) === '["checkAuth()","createOrder()"]' && server.routes[0].handler === 'createOrder')
  const mount = extract(path.join(dir, 'mount.ts'))
  check('no factory in the file -> fallback receiver app', JSON.stringify(mount.receivers) === '["app"]' && mount.routes.length === 2)
  const named = extract(path.join(dir, 'named.ts'))
  check('const r = Router() as any -> receiver r', JSON.stringify(named.receivers) === '["r"]' && named.routes[0]?.routePath === '/things/:id')

  const appDir = path.join(TMP, 'express-detect')
  write(appDir, 'package.json', JSON.stringify({ main: 'lib/boot', dependencies: { express: '^4' } }))
  write(appDir, 'lib/boot.js', 'module.exports = 1\n')
  const viaMain = detectExpress(appDir)
  check('package.json main (extensionless) is the entry when no conventional name exists', viaMain.isExpress && viaMain.entryFile === path.join(appDir, 'lib/boot.js'))
  write(appDir, 'app.cjs', 'module.exports = 1\n')
  check('.cjs conventional name wins over main', detectExpress(appDir).entryFile === path.join(appDir, 'app.cjs'))
  check('an entry the inventory did not select is skipped', detectExpress(appDir, rel => rel !== 'app.cjs').entryFile === path.join(appDir, 'lib/boot.js'))
  write(appDir, 'server.ts', 'export {}\n')
  check('server.ts still wins over app.*', detectExpress(appDir).entryFile === path.join(appDir, 'server.ts'))
  const noExpress = path.join(TMP, 'no-express')
  write(noExpress, 'package.json', JSON.stringify({ dependencies: { koa: '2' } }))
  write(noExpress, 'server.js', '')
  check('no express dependency -> not detected', !detectExpress(noExpress).isExpress)
}

// ---------------------------------------------------------------------------
console.log('\n-- tool-calling candidates and prompt --')
{
  const contents: Record<string, string> = {
    'src/agent.ts': `import { generateText, tool } from 'ai'\nconst r = await generateText({ tools: { search: tool({ execute }) }, tool_choice: 'auto' })`,
    'src/plain.ts': `import OpenAI from 'openai'\nconst x = await client.chat.completions.create({ tools: [lookup] })`,
    'src/bare.ts': `import { tool } from 'ai'\nexport const llm = 1`,
    'src/agent.spec.ts': `const t = { tools: [a], tool_choice: 'auto', tool_calls: [] }`,
    'src/huge.ts': `tools: [a]`,
    'config/llm.json': `{ "tools": [], "type": "function" }`,
    'src/nosignal.ts': `const tools = [a, b]`,
    'src/denied.py': `@tool\ndef secret(): pass\ntools=[secret]`,
  }
  const entries = [
    entry('config/llm.json', 'json'), entry('src/agent.spec.ts', 'typescript', { test: true }), entry('src/agent.ts', 'typescript'),
    entry('src/bare.ts', 'typescript'), entry('src/denied.py', 'python'), entry('src/huge.ts', 'typescript', { oversize: true }),
    entry('src/nosignal.ts', 'typescript'), entry('src/plain.ts', 'typescript'),
  ]
  const signals: Record<string, string[]> = {}
  for (const p of Object.keys(contents)) signals[p] = p === 'src/nosignal.ts' ? ['logging'] : ['llm_call']
  const ranked = rankToolCallingCandidates(entries, signals, rel => (rel === 'src/denied.py' ? null : contents[rel] ?? null))
  const paths = ranked.map(c => c.path)
  check('test file excluded', !paths.includes('src/agent.spec.ts'))
  check('oversize file excluded', !paths.includes('src/huge.ts'))
  check('non-executable language excluded', !paths.includes('config/llm.json'))
  check('file without the llm_call signal excluded', !paths.includes('src/nosignal.ts'))
  check('file the guard refuses excluded', !paths.includes('src/denied.py'))
  check('bare import scores zero and is excluded', !paths.includes('src/bare.ts'))
  check('tool({ + tools: + tool_choice ranks above tools: [ alone', JSON.stringify(paths) === '["src/agent.ts","src/plain.ts"]')
  check('scores count distinct indicators', ranked[0].score === 3 && ranked[1].score === 1)
  check(`at most ${TOOL_CALLING_MAX_FILES} files are probed`, TOOL_CALLING_MAX_FILES === 3)

  const prompt = buildToolCallingPrompt('services/assistant/agent.py', 'python', 'def f(): pass')
  check('tool-calling prompt has no "TypeScript file"', !prompt.includes('TypeScript file'))
  check('tool-calling prompt has no fixed chat.ts path', !prompt.includes('chat.ts'))
  check('tool-calling prompt names the file and its language', prompt.includes('File: services/assistant/agent.py (python)') && prompt.includes('```python\ndef f(): pass\n```'))
  check('content with a fence cannot close the prompt fence', buildToolCallingPrompt('a.md.ts', 'typescript', 'x ``` y').includes('````typescript'))
}

// ---------------------------------------------------------------------------
console.log('\n-- deterministic fallbacks are target-neutral --')
{
  const source = fs.readFileSync(path.join(HERE, 'llm-probe.ts'), 'utf-8')
  const extractorSource = fs.readFileSync(path.join(HERE, 'ast-extractor.ts'), 'utf-8')
  const repoMapSource = fs.readFileSync(path.join(HERE, 'repo-map.ts'), 'utf-8')
  // The identifiers the pre-v3 fallbacks and auth list looked for, plus the
  // probe's old fixed path.
  const benchmarkIdentifiers = [
    'isAuthorized', 'appendUserId', 'jwtChallenges', 'generateCoupon', 'stepCountIs',
    'isAccounting', 'denyAll', 'updateAuthenticatedUsers', 'chat.ts', 'juice',
  ]
  for (const id of benchmarkIdentifiers) {
    check(`llm-probe.ts does not mention ${id}`, !source.toLowerCase().includes(id.toLowerCase()))
  }
  check('ast-extractor.ts no longer carries an auth name list', !['isAuthorized', 'appendUserId', 'jwtChallenges', 'denyAll'].some(id => extractorSource.includes(id)))
  check('repo-map.ts carries no benchmark identifiers', !benchmarkIdentifiers.some(id => repoMapSource.toLowerCase().includes(id.toLowerCase())))

  // Category probe: auth comes from what recon found, not from a name in the text.
  const noTool = { hasGenuineToolCalling: false, evidence: '', toolsDetected: [], confidence: 0 }
  const textOnly = { route_table: { hand_written_routes: [{ method: 'GET', path: '/x/:id', handler: 'isAuthorized', auth: null, middleware: ['isAuthorized()'] }] } }
  const withMechanism = { ...textOnly, architecture: { auth_mechanisms: [{ name: 'session check' }] } }
  const withTaggedRoute = { route_table: { hand_written_routes: [{ method: 'GET', path: '/x/:id', auth: 'requireUser()', middleware: [] }] } }
  check('authPresence: a guard name in the text alone is not auth', !authPresence(textOnly))
  check('authPresence: an architecture auth mechanism is auth', authPresence(withMechanism))
  check('authPresence: an auth-tagged route is auth', authPresence(withTaggedRoute))
  const a01 = (summary: object) => probeDeterministic(JSON.stringify(summary), authPresence(summary), noTool, [], '').find(v => v.name.startsWith('A01'))!.verdict
  check('A01 not present on a guard name alone', a01(textOnly) === 'uncertain')
  check('A01 present with an auth mechanism', a01(withMechanism) === 'present')
  const llm = probeDeterministic('{}', false, { hasGenuineToolCalling: true, evidence: 'x', toolsDetected: ['a'], confidence: 1 }, [], '')
  check('LLM10 evidence assumes no step cap', !/step cap detected/i.test(llm.find(v => v.name.startsWith('LLM10'))!.evidence))

  // Tool-calling fallback works on a non-TypeScript SDK shape.
  const py = detectToolCallingDeterministic(`from langchain.tools import tool\n@tool\ndef lookup_order(order_id: str):\n    return db.orders.update(order_id)\nllm = ChatOpenAI().bind_tools([lookup_order])\nllm.invoke(messages)\n`)
  check('deterministic tool-calling finds a Python @tool', py.hasGenuineToolCalling && JSON.stringify(py.toolsDetected) === '["lookup_order"]')
  check('deterministic tool-calling: state change from code, not a tool name', py.evidence.includes('state-changing'))
  const sdk = detectToolCallingDeterministic(`const r = streamText({ tools: { find: tool({ execute: async () => db.findAll() }) } })`)
  check('deterministic tool-calling still finds AI SDK tool({', sdk.hasGenuineToolCalling && sdk.toolsDetected[0] === 'find')

  // Architecture fallback: from manifests and the symbol table only.
  const arch = deterministicArchitecture({
    manifests: [
      { path: 'package.json', content: JSON.stringify({ dependencies: { express: '4', sequelize: '6', jsonwebtoken: '9' } }) },
      { path: 'api/requirements.txt', content: 'Flask==3.0\nflask-login>=0.6\npsycopg2-binary\npgx-not-a-dep\n' },
    ],
    symbols: symbolTable({
      'src/guards.ts': [sym('requireLogin', 'function', 1), sym('ensureAdmin', 'function', 5), sym('formatDate', 'function', 9), sym('isAuthenticatedHelper', 'function', 12, false)],
      'test/guards.spec.ts': [sym('requireTestUser', 'function', 1)],
    }),
    eligiblePaths: new Set(['src/guards.ts', 'package.json', 'api/requirements.txt']),
    entryPoints: [{ path: 'src/server.ts', reason: 'Express entry file' }],
    languages: { typescript: 3, python: 1 },
    fileCount: 4,
    routeCount: 2,
    routeSource: 'Express enricher',
  }) as any
  const names = (xs: any[]) => xs.map(x => x.name)
  check('fallback frameworks from manifests', JSON.stringify(names(arch.frameworks)) === '["Express","Flask"]')
  check('fallback data stores from manifests', names(arch.data_stores).includes('Sequelize (SQL ORM)') && names(arch.data_stores).includes('PostgreSQL'))
  check('fallback auth: libraries from manifests', names(arch.auth_mechanisms).includes('jsonwebtoken (JWT) (dependency)') && names(arch.auth_mechanisms).includes('Flask-Login (dependency)'))
  check('fallback auth: guard-shaped exported symbols, by their own names', names(arch.auth_mechanisms).includes('requireLogin') && names(arch.auth_mechanisms).includes('ensureAdmin'))
  check('fallback auth: not a non-guard name, not an unexported one, not a test file\'s',
    !names(arch.auth_mechanisms).some((n: string) => ['formatDate', 'isAuthenticatedHelper', 'requireTestUser'].includes(n)))
  const ctx: ArchitectureValidationContext = {
    inventoryPaths: new Set(['package.json', 'api/requirements.txt', 'src/guards.ts', 'src/server.ts']),
    symbolNames: new Set(['requireLogin', 'ensureAdmin', 'formatDate']),
    routeText: '',
  }
  const validated = validateArchitecture(arch, ctx, 'deterministic', null)!
  check('fallback passes validation unchanged in substance', validated.source === 'deterministic' && validated.dropped.length === 0 &&
    validated.auth_mechanisms.find(m => m.name === 'requireLogin')!.verified_identifiers[0] === 'requireLogin')
  const archText = JSON.stringify(validated)
  check('fallback output carries no benchmark identifiers', !benchmarkIdentifiers.some(id => archText.toLowerCase().includes(id.toLowerCase())))
}

// ---------------------------------------------------------------------------
console.log('\n-- tool-calling probe with no candidates --')
{
  // No candidate means no model call and no client: safe to run offline.
  const verdict = await detectToolCalling(TMP, [])
  check('no candidates -> not tool-calling, nothing probed', !verdict.hasGenuineToolCalling && verdict.filesProbed.length === 0 && verdict.confidence === 0)
}

// ---------------------------------------------------------------------------
console.log('\n-- category probe: a thrown LLM call marks the run degraded --')
{
  // A client whose call throws, as a network error or a 5xx would. Nothing
  // leaves the process: the fake never reaches a transport.
  let calls = 0
  const throwingClient = {
    chat: { completions: { create: async () => { calls++; throw new Error('simulated 503') } } },
  } as any
  resetDegraded()
  const summary = { route_table: { hand_written_routes: [] }, architecture: { auth_mechanisms: [{ name: 'session' }] } }
  const noTool = { hasGenuineToolCalling: false, evidence: '', toolsDetected: [], confidence: 0 }
  const verdicts = await probeCategoryApplicability(summary, noTool, [], '', () => throwingClient)
  check('the injected client was called', calls === 1)
  check('a throwing client marks the run degraded', isDegraded())
  check('the reason names the category probe and the error',
    degradedReasons().some(r => r === 'category probe: LLM call failed (simulated 503) — used deterministic analysis'))
  check('deterministic verdicts are still returned', verdicts.length >= 10 && verdicts.every(v => ['present', 'absent', 'uncertain'].includes(v.verdict)))
  check('fallback verdicts match probeDeterministic on the same input',
    JSON.stringify(verdicts) === JSON.stringify(probeDeterministic(JSON.stringify(summary), authPresence(summary), noTool, [], '')))
  resetDegraded()
}

// ---------------------------------------------------------------------------
console.log('\n-- frontend escape-hatch grep over a file list --')
{
  const dir = path.join(TMP, 'frontend')
  write(dir, 'web/b.component.html', '<div [innerHTML]="x"></div>\n<p></p>\n<span [innerHTML]="y"></span>\n')
  write(dir, 'web/a.component.ts', 'this.s.bypassSecurityTrustHtml(v)\n')
  write(dir, 'web/a.component.spec.ts', 'this.s.bypassSecurityTrustHtml(v)\n')
  write(dir, 'web/c.jsx', '<div dangerouslySetInnerHTML={{ __html: v }} />\n')
  const findings = frontendGrep(dir, ['web/b.component.html', 'web/c.jsx', 'web/a.component.spec.ts', 'web/a.component.ts'], ['angular', 'react'])
  const keys = findings.map(f => `${path.basename(f.file)}:${f.line}`)
  check('findings sorted by file then line', JSON.stringify(keys) === '["a.component.ts:1","b.component.html:1","b.component.html:3","c.jsx:1"]')
  check('.spec.ts still excluded', !keys.some(k => k.includes('spec')))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
