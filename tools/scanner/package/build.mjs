#!/usr/bin/env node
/**
 * Builds the npm package's dist/ from the scanner sources (Task 1e; the design
 * is docs/architecture/npm-packaging-plan.md, "Package layout").
 *
 * Transpile, don't bundle. Every shipped .ts becomes a .js at the SAME relative
 * path under dist/tools/scanner/, so dist/ plays the part of the repository
 * root: shared/run-context.ts's REPO_ROOT (<shared>/../../..), the budget
 * governor's join(REPO_ROOT, 'tools/scanner/shared/vuln-classes.json') and
 * every import.meta.url-relative read resolve unchanged. Each module keeps its
 * own import.meta.url, so the per-stage entry guards keep their meaning.
 *
 * Runs in two places with one file:
 *   harness       tools/scanner/package/  sources at ../
 *   product repo  <repo root>/            sources at ./tools/scanner/
 *                 (tools/release/export-product.mjs lays it out that way)
 *
 * Steps: wipe dist/, transpile, copy the runtime assets, write the product
 * registry (lab_only entries removed), fix the CLI's shebang, write
 * build-info.json, then check that every import in dist/ resolves and that
 * every bare import is a declared dependency. Any failure exits non-zero.
 *
 *   node build.mjs
 */
import { builtinModules, createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PKG_DIR = dirname(fileURLToPath(import.meta.url))

/** Source directories (relative to tools/scanner) whose .ts files ship as .js. */
export const SOURCE_DIRS = [
  'shared',
  'cli/src',
  'report/src',
  'stage0-recon/src',
  'stage-playbook-agent/src',
  'stage05-lane-selector-perfile/src',
  'stage1-budget-governor/src',
  'stage2-hunt-lanes-perfile/src',
]

/**
 * Sources that never ship: tests and their helpers, the lab's live-API
 * preflight, and fixtures. report/src/fixtures.ts is the HTML tests' synthetic
 * report builder; the import check below fails the build if anything shipped
 * ever imports it.
 */
const EXCLUDED_BASENAMES = new Set(['test-harness.ts', 'test-breakdown.ts', 'preflight.ts', 'fixtures.ts'])

/** True for a tools/scanner-relative POSIX path of a .ts source that ships. */
export function isShippedSource(rel) {
  if (!rel.endsWith('.ts') || rel.endsWith('.d.ts') || rel.endsWith('.test.ts')) return false
  const parts = rel.split('/')
  if (parts.includes('node_modules') || parts.includes('fixtures')) return false
  if (EXCLUDED_BASENAMES.has(parts[parts.length - 1])) return false
  return SOURCE_DIRS.some(d => rel.startsWith(d + '/'))
}

/**
 * Non-TS files a shipped module reads at runtime, relative to tools/scanner.
 * Found by grepping the shipped sources for readFileSync, readdirSync,
 * `new URL(` and REPO_ROOT joins:
 *   shared/vuln-classes.json     playbook-overlay, review, main, lane selector,
 *                                budget governor, hunt executor, report
 *   shared/signal-classes.json   recon signal-detector, review, main, lane
 *                                selector, budget governor, hunt executor
 *   stage-playbook-agent/guidance.md   agent.ts and review.ts, via ../guidance.md
 *   stage2-hunt-lanes-perfile/src/playbooks/*.ts   read as TEXT by the budget
 *                                governor (size estimate) and report/impact.ts
 *                                (scope); their .js twins are what gets imported
 * shared/models.json is an asset too, but it is written filtered (below).
 * The tree-sitter WASM grammars come from the tree-sitter-wasms dependency
 * through createRequire, so they resolve from the package's node_modules.
 */
export const ASSET_FILES = [
  'shared/vuln-classes.json',
  'shared/signal-classes.json',
  'stage-playbook-agent/guidance.md',
]
export const PLAYBOOK_DIR = 'stage2-hunt-lanes-perfile/src/playbooks'

/** Every playbook source, copied verbatim as data next to its .js. */
export function playbookAssets(srcRoot) {
  return readdirSync(join(srcRoot, PLAYBOOK_DIR))
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map(f => `${PLAYBOOK_DIR}/${f}`)
}

/** tools/scanner in the harness, <repo>/tools/scanner in the product repo. */
export function resolveSourceRoot(pkgDir = PKG_DIR) {
  const harness = resolve(pkgDir, '..')
  if (existsSync(join(harness, 'shared', 'models.json'))) return { srcRoot: harness, inHarness: true }
  const product = join(pkgDir, 'tools', 'scanner')
  if (existsSync(join(product, 'shared', 'models.json'))) return { srcRoot: product, inHarness: false }
  throw new Error(`no scanner sources at ${harness} or ${product}`)
}

const toPosix = p => p.split(sep).join('/')

/** Shipped .ts sources, tools/scanner-relative POSIX paths, sorted. */
export function listSources(srcRoot) {
  const out = []
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) {
        const rel = toPosix(relative(srcRoot, abs))
        if (isShippedSource(rel)) out.push(rel)
      }
    }
  }
  for (const d of SOURCE_DIRS) if (existsSync(join(srcRoot, d))) walk(join(srcRoot, d))
  return out.sort()
}

/**
 * The registry as shipped. With `product_models`, exactly those targets ship
 * and the generic endpoint template is removed, so the packaged CLI has one
 * fixed model and offers no model selection (cli/src/registry.ts cliMode()).
 * Without it, every `lab_only` target is removed. Aliases pointing at a dropped
 * target go with it. Throws when the product default would be missing, or when
 * a shipped target is lab_only or uses anything but the HTTP/OpenAI-compatible
 * transport (the claude-cli transport needs a local Claude Code binary).
 */
export function productRegistry(raw) {
  const reg = JSON.parse(JSON.stringify(raw))
  const targets = reg.targets ?? {}
  const keep = Array.isArray(reg.product_models) ? new Set(reg.product_models) : null
  if (keep) {
    for (const k of keep) if (!targets[k]) throw new Error(`product_models names "${k}", which is not a target`)
    for (const k of keep) if (targets[k].lab_only === true) throw new Error(`product_models names "${k}", which is marked lab_only`)
    delete reg.generic_openai_compatible
  }
  const dropped = Object.keys(targets).filter(k => keep ? !keep.has(k) : targets[k]?.lab_only === true).sort()
  for (const k of dropped) delete targets[k]
  const droppedAliases = []
  for (const [alias, canonical] of Object.entries(reg.aliases ?? {})) {
    if (dropped.includes(canonical)) { delete reg.aliases[alias]; droppedAliases.push(alias) }
  }
  const productDefault = reg.product_default_provider ?? reg.default_provider
  if (!targets[productDefault]) {
    throw new Error(`product default "${productDefault}" is not a shipped target` +
      (dropped.includes(productDefault) ? ' (it is marked lab_only)' : ''))
  }
  // The loader requires default_provider (the lab default) to be a target. The
  // product never resolves through it (the CLI always names a provider), so a
  // lab default that is itself lab_only falls back to the product default.
  if (!targets[reg.default_provider]) reg.default_provider = productDefault
  for (const [k, t] of Object.entries(targets)) {
    const transport = t.transport ?? 'openai'
    if (transport !== 'openai') throw new Error(`shipped target "${k}" uses transport "${transport}"; mark it lab_only or remove it`)
  }
  reg._comment = [
    'Model registry shipped with the secscan npm package. Generated from the',
    "research harness's registry by build.mjs: only the product models are kept",
    '(product_models), so the CLI runs with one fixed model.',
  ]
  return { registry: reg, shipped: Object.keys(targets).sort(), dropped, droppedAliases }
}

/** harness_commit: EXPORTED_FROM when present, else git in the harness, else "unknown". */
export function harnessCommit(pkgDir, srcRoot, inHarness) {
  const exported = join(pkgDir, 'EXPORTED_FROM')
  if (existsSync(exported)) {
    try {
      const c = JSON.parse(readFileSync(exported, 'utf8')).harness_commit
      if (typeof c === 'string' && c) return c
    } catch { /* fall through */ }
  }
  if (!inHarness) return 'unknown'
  const git = (...args) => execFileSync('git', ['-C', srcRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    const sha = git('rev-parse', '--short', 'HEAD')
    // A build from uncommitted shipped sources is not the commit it names.
    const dirty = git('status', '--porcelain', '--', ...SOURCE_DIRS, ...ASSET_FILES, relative(srcRoot, pkgDir) || '.')
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

/**
 * What esbuild's metafile cannot list: template-literal dynamic imports
 * (`./playbooks/${name}.js`) and require.resolve() of a dependency's files
 * (the tree-sitter grammars). Static and literal dynamic imports come from the
 * metafile, which reads the syntax tree and so is not fooled by import-like
 * text inside strings, as a regex over the output would be.
 */
export function runtimeResolutions(code) {
  const out = []
  for (const m of code.matchAll(/\bimport\(\s*`([^`]*)`\s*\)/g)) out.push(m[1])
  // esbuild renames a module-level `require` (createRequire's result) to require2.
  for (const m of code.matchAll(/\brequire\d*\.resolve\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s*\)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

const BUILTINS = new Set(builtinModules)
const isBuiltin = spec => spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])
const packageOf = spec => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]

/**
 * Every relative import in dist/ must name an existing file; every bare one a
 * node builtin or a declared dependency, installed with the files a template
 * names; and every declared dependency must be used. Returns problems as
 * strings. `imports` maps a dist-relative output file to its import paths.
 */
export function checkImports(distScanner, imports, dependencies, pkgDir) {
  const problems = []
  const used = new Set()
  const requireFromPkg = createRequire(join(pkgDir, 'package.json'))
  const bare = (rel, spec) => {
    const name = packageOf(spec)
    used.add(name)
    if (!dependencies[name]) problems.push(`${rel}: "${spec}" is not a declared dependency`)
    return name
  }
  for (const [rel, specs] of Object.entries(imports)) {
    const file = join(distScanner, rel)
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        if (!existsSync(resolve(dirname(file), spec))) problems.push(`${rel}: import "${spec}" does not resolve`)
      } else if (!isBuiltin(spec)) bare(rel, spec)
    }
    for (const t of runtimeResolutions(readFileSync(file, 'utf8'))) {
      const cut = t.indexOf('${')
      const head = cut < 0 ? t : t.slice(0, cut)
      const ext = cut < 0 ? '' : t.slice(t.lastIndexOf('}') + 1)
      if (head.startsWith('.')) {
        // `./playbooks/${name}.js`: the directory must exist and hold such modules.
        const dir = resolve(dirname(file), head.slice(0, head.lastIndexOf('/') + 1))
        if (!existsSync(dir) || !readdirSync(dir).some(f => f.endsWith(ext))) {
          problems.push(`${rel}: \`${t}\` matches no ${ext} file in ${toPosix(relative(distScanner, dir))}/`)
        }
        continue
      }
      if (isBuiltin(head)) continue
      const name = bare(rel, head)
      if (!dependencies[name]) continue
      // The package directory itself: a dependency's `exports` map may hide its package.json.
      const pkgRoot = (requireFromPkg.resolve.paths(name) ?? [])
        .map(d => join(d, name)).find(d => existsSync(join(d, 'package.json')))
      if (!pkgRoot) {
        problems.push(`${rel}: dependency "${name}" is not installed`)
        continue
      }
      const sub = head.slice(name.length + 1)
      const dir = join(pkgRoot, sub.slice(0, sub.lastIndexOf('/') + 1))
      const leaf = sub.slice(sub.lastIndexOf('/') + 1)
      const hit = cut < 0 ? existsSync(join(pkgRoot, sub))
        : existsSync(dir) && readdirSync(dir).some(f => f.startsWith(leaf) && f.endsWith(ext))
      if (!hit) problems.push(`${rel}: \`${t}\` matches nothing in the installed ${name}`)
    }
  }
  for (const dep of Object.keys(dependencies)) {
    if (!used.has(dep)) problems.push(`dependency "${dep}" is declared but nothing in dist/ imports it`)
  }
  return problems
}

export async function build({ pkgDir = PKG_DIR, log = console.log } = {}) {
  const { srcRoot, inHarness } = resolveSourceRoot(pkgDir)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const dist = join(pkgDir, 'dist')
  const distScanner = join(dist, 'tools', 'scanner')
  log(`secscan build: ${pkg.name}@${pkg.version} from ${srcRoot}`)

  rmSync(dist, { recursive: true, force: true })
  mkdirSync(distScanner, { recursive: true })

  // ── Transpile ────────────────────────────────────────────────────────────
  const { build: esbuild } = await import('esbuild')
  const sources = listSources(srcRoot)
  const result = await esbuild({
    entryPoints: sources.map(s => join(srcRoot, s)),
    outbase: srcRoot,
    outdir: distScanner,
    bundle: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
    metafile: true,
  })
  const imports = {}
  for (const [out, meta] of Object.entries(result.metafile.outputs)) {
    imports[toPosix(relative(distScanner, resolve(out)))] = meta.imports.map(i => i.path)
  }
  log(`  transpiled ${sources.length} modules`)

  // ── Assets ───────────────────────────────────────────────────────────────
  const assets = [...ASSET_FILES, ...playbookAssets(srcRoot)]
  for (const a of assets) {
    const to = join(distScanner, a)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(srcRoot, a), to)
  }
  log(`  copied ${assets.length} assets (${ASSET_FILES.join(', ')}, ${assets.length - ASSET_FILES.length} playbook sources)`)

  // ── Product registry ─────────────────────────────────────────────────────
  const raw = JSON.parse(readFileSync(join(srcRoot, 'shared', 'models.json'), 'utf8'))
  const product = productRegistry(raw)
  writeFileSync(join(distScanner, 'shared', 'models.json'), JSON.stringify(product.registry, null, 2) + '\n')
  log(`  models: ${product.shipped.length} shipped (default ${product.registry.product_default_provider}), ` +
    `${product.dropped.length} dropped${product.dropped.length ? ` (${product.dropped.join(', ')})` : ''}`)

  // ── CLI entry ────────────────────────────────────────────────────────────
  const binRel = pkg.bin?.secscan
  if (!binRel) throw new Error('package.json has no bin.secscan')
  const bin = join(pkgDir, binRel)
  if (!existsSync(bin)) throw new Error(`bin ${binRel} was not produced`)
  const code = readFileSync(bin, 'utf8')
  const body = code.startsWith('#!') ? code.slice(code.indexOf('\n') + 1) : code
  writeFileSync(bin, '#!/usr/bin/env node\n' + body)
  chmodSync(bin, 0o755)

  // ── Provenance ───────────────────────────────────────────────────────────
  const info = {
    name: pkg.name,
    version: pkg.version,
    harness_commit: harnessCommit(pkgDir, srcRoot, inHarness),
    built_at: new Date().toISOString(),
  }
  writeFileSync(join(dist, 'build-info.json'), JSON.stringify(info, null, 2) + '\n')
  log(`  build-info: ${info.version} (harness ${info.harness_commit})`)

  // In the harness LICENSE is a copy of the repository's own (git-ignored
  // here); the product repository commits it at its root. The package's
  // THIRD-PARTY-NOTICES.md is its own file: the repository's notices describe
  // the vendored benchmark target, which the package does not contain.
  if (inHarness) {
    const repoRoot = resolve(srcRoot, '..', '..')
    if (existsSync(join(repoRoot, 'LICENSE'))) copyFileSync(join(repoRoot, 'LICENSE'), join(pkgDir, 'LICENSE'))
  }

  // ── Checks ───────────────────────────────────────────────────────────────
  const problems = checkImports(distScanner, imports, pkg.dependencies ?? {}, pkgDir)
  // The shipped loader must accept the shipped registry, with no overlay.
  try {
    const models = await import(pathToFileURL(join(distScanner, 'shared', 'models.js')).href)
    models.loadRegistry({}, join(distScanner, 'shared', 'models.json'))
  } catch (e) {
    problems.push(`shipped models.json does not load: ${e?.message ?? e}`)
  }
  if (problems.length) {
    throw new Error(`build checks failed:\n  ${problems.join('\n  ')}`)
  }
  log(`  checks: every import resolves; dependencies ${Object.keys(pkg.dependencies ?? {}).join(', ')} all used`)
  return { srcRoot, inHarness, sources, assets, product, info }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  build().catch(e => {
    console.error(`secscan build failed: ${e?.message ?? e}`)
    process.exit(1)
  })
}
