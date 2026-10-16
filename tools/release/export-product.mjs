#!/usr/bin/env node
/**
 * Exports the product repository (github.com/anshuman11o/secscan) from this
 * harness (Task 1e; docs/architecture/npm-packaging-plan.md, "Export and leak
 * guard"). Code flows one way, harness -> product, and only through here.
 *
 * Copies an ALLOWLIST, never the harness minus a denylist: exactly the sources
 * and runtime assets tools/scanner/package/build.mjs ships (same selection
 * functions), each shipped stage's tsconfig.json, and the package files. The
 * layout keeps tools/scanner/... as is and puts the package files at the root,
 * so the same build.mjs works in both repositories:
 *
 *   <dest>/package.json  package-lock.json  build.mjs  smoke.mjs  README.md
 *   <dest>/LICENSE  THIRD-PARTY-NOTICES.md  EXPORTED_FROM  .gitignore
 *   <dest>/tools/scanner/<shipped sources and assets>
 *
 * shared/models.json is written already filtered (lab_only entries removed),
 * so a lab-only entry never leaves the harness, even as source. Then the leak
 * guard runs over <dest>; on any violation the export is removed again (a
 * .git directory is left alone) and the command exits 1.
 *
 *   node tools/release/export-product.mjs <dest>
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanTree, formatViolation } from './leak-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const HARNESS_ROOT = resolve(HERE, '..', '..')
export const PACKAGE_DIR = join(HARNESS_ROOT, 'tools', 'scanner', 'package')

/** Stage directories whose tsconfig.json travels with the sources. */
const TSCONFIG_DIRS = ['cli', 'report', 'stage0-recon', 'stage-playbook-agent', 'stage05-lane-selector-perfile',
  'stage1-budget-governor', 'stage2-hunt-lanes-perfile', 'shared']

/** Package files that are NOT exported as is: built, installed, or replaced below. */
const PACKAGE_SKIP = new Set(['node_modules', 'dist', '.gitignore', 'LICENSE', 'EXPORTED_FROM'])

export const PRODUCT_GITIGNORE = ['node_modules/', 'dist/', '*.tgz', '.secscan/', ''].join('\n')

/** The nearest existing ancestor's realpath, joined with the rest. */
function realish(p) {
  let cur = resolve(p)
  const rest = []
  while (!existsSync(cur)) {
    rest.unshift(cur.slice(dirname(cur).length + 1))
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return join(realpathSync(cur), ...rest)
}

const within = (child, parent) => {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** Throws when <dest> is inside the harness or holds anything but .git. */
export function assertDestination(dest, harnessRoot = HARNESS_ROOT) {
  const real = realish(dest)
  if (within(real, realpathSync(harnessRoot))) {
    throw new Error(`${dest} is inside the harness (${harnessRoot}); export to a directory outside it`)
  }
  if (existsSync(real)) {
    if (!statSync(real).isDirectory()) throw new Error(`${dest} exists and is not a directory`)
    const other = readdirSync(real).filter(n => n !== '.git')
    if (other.length) throw new Error(`${dest} is not empty (${other.slice(0, 5).join(', ')}${other.length > 5 ? ', …' : ''}); only .git may be there`)
  }
  return real
}

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

/** Remove everything an export wrote, leaving a .git directory alone. */
function clean(dest) {
  if (!existsSync(dest)) return
  for (const n of readdirSync(dest)) if (n !== '.git') rmSync(join(dest, n), { recursive: true, force: true })
}

export async function exportProduct(destArg, { log = console.log, harnessRoot = HARNESS_ROOT } = {}) {
  const dest = assertDestination(destArg, harnessRoot)
  const pkgDir = join(harnessRoot, 'tools', 'scanner', 'package')
  const build = await import(pathToFileURL(join(pkgDir, 'build.mjs')).href)
  const { srcRoot, inHarness } = build.resolveSourceRoot(pkgDir)
  if (!inHarness) throw new Error(`${pkgDir} does not sit in a harness checkout`)

  mkdirSync(dest, { recursive: true })
  const written = []
  try {
    // ── Sources and assets: the build's own selection ─────────────────────
    const scannerDest = join(dest, 'tools', 'scanner')
    const files = [...build.listSources(srcRoot), ...build.ASSET_FILES, ...build.playbookAssets(srcRoot)]
    for (const d of TSCONFIG_DIRS) if (existsSync(join(srcRoot, d, 'tsconfig.json'))) files.push(`${d}/tsconfig.json`)
    for (const rel of [...new Set(files)].sort()) {
      copy(join(srcRoot, rel), join(scannerDest, rel))
      written.push(`tools/scanner/${rel}`)
    }
    // The same registry the package ships; the product build's filter is then a no-op.
    const product = build.productRegistry(JSON.parse(readFileSync(join(srcRoot, 'shared', 'models.json'), 'utf8')))
    writeFileSync(join(scannerDest, 'shared', 'models.json'), JSON.stringify(product.registry, null, 2) + '\n')
    written.push('tools/scanner/shared/models.json')

    // ── Package files at the root ─────────────────────────────────────────
    for (const n of readdirSync(pkgDir).sort()) {
      if (PACKAGE_SKIP.has(n) || n.endsWith('.tgz')) continue
      const from = join(pkgDir, n)
      if (!statSync(from).isFile()) continue
      copy(from, join(dest, n))
      written.push(n)
    }
    // The package's own THIRD-PARTY-NOTICES.md came with the package files
    // above; the harness's notices describe the vendored benchmark target.
    copy(join(harnessRoot, 'LICENSE'), join(dest, 'LICENSE'))
    written.push('LICENSE')
    writeFileSync(join(dest, '.gitignore'), PRODUCT_GITIGNORE)
    written.push('.gitignore')
    const commit = build.harnessCommit(pkgDir, srcRoot, true)
    writeFileSync(join(dest, 'EXPORTED_FROM'), JSON.stringify({ harness_commit: commit, exported_at: new Date().toISOString() }, null, 2) + '\n')
    written.push('EXPORTED_FROM')

    // ── Leak guard ────────────────────────────────────────────────────────
    const violations = scanTree(dest)
    if (violations.length) {
      clean(dest)
      throw Object.assign(new Error(`leak guard refused the export (${violations.length} violation(s)); nothing was left in ${dest}:\n  ` +
        violations.map(formatViolation).join('\n  ')), { violations })
    }
    let branch = 'unknown'
    try { branch = execFileSync('git', ['-C', harnessRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* not a checkout */ }
    log(`exported ${written.length} files to ${dest}`)
    log(`  harness ${commit} (branch ${branch})${commit.endsWith('-dirty') ? ' — uncommitted changes were exported; commit them first for a traceable export' : ''}`)
    log(`  models: ${product.shipped.length} shipped, dropped ${product.dropped.join(', ') || 'none'}`)
    log(`  leak guard: ${violations.scanned} files, 0 violations`)
    return { dest, written, commit, product }
  } catch (e) {
    if (!e.violations) clean(dest)
    throw e
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const dest = process.argv[2]
  if (!dest || process.argv.length > 3) {
    console.error('usage: node tools/release/export-product.mjs <product-repo-dir>')
    process.exit(2)
  }
  exportProduct(dest).catch(e => {
    console.error(`export-product: ${e?.message ?? e}`)
    process.exit(1)
  })
}
