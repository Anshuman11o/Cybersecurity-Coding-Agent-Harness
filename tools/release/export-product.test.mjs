/**
 * Product export: where it refuses to write, exactly what it copies, that the
 * leak guard passes on it and refuses it once a violation is planted, and that
 * the exported repository installs and builds on its own (`npm ci && npm run
 * build`; skipped, and said so, when the npm registry is unreachable).
 *
 *   node --test export-product.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDestination, exportProduct, HARNESS_ROOT, PACKAGE_DIR, PRODUCT_GITIGNORE } from './export-product.mjs'
import { listTree, scanTree } from './leak-guard.mjs'
import { ASSET_FILES, listSources, playbookAssets, resolveSourceRoot } from '../scanner/package/build.mjs'

const quiet = { log: () => {} }
const WIN = process.platform === 'win32'
const npm = (args, cwd, timeout = 600_000) => spawnSync(WIN ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', timeout, shell: WIN })

test('refuses a destination inside the harness, and a non-empty one', () => {
  const inside = join(HARNESS_ROOT, 'tools', 'scanner', 'package', 'export-here')
  assert.throws(() => assertDestination(inside), /inside the harness/)
  assert.ok(!existsSync(inside))
  const dir = mkdtempSync(join(tmpdir(), 'secscan-export-'))
  try {
    mkdirSync(join(dir, '.git'))
    assert.equal(assertDestination(dir) !== undefined, true) // only .git: accepted
    writeFileSync(join(dir, 'stray.txt'), 'x')
    assert.throws(() => assertDestination(dir), /not empty/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('exports exactly the allowlist, passes the leak guard, and installs and builds on its own', async t => {
  const dest = join(mkdtempSync(join(tmpdir(), 'secscan-export-')), 'secscan')
  try {
    const out = await exportProduct(dest, quiet)

    // Layout: package files at the root, sources under tools/scanner/.
    for (const f of ['package.json', 'package-lock.json', 'build.mjs', 'smoke.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'EXPORTED_FROM', '.gitignore']) {
      assert.ok(existsSync(join(dest, f)), f)
    }
    assert.equal(readFileSync(join(dest, '.gitignore'), 'utf8'), PRODUCT_GITIGNORE)
    const from = JSON.parse(readFileSync(join(dest, 'EXPORTED_FROM'), 'utf8'))
    assert.equal(from.harness_commit, out.commit)
    assert.ok(from.exported_at)
    if (existsSync(join(PACKAGE_DIR, 'README.md'))) assert.ok(existsSync(join(dest, 'README.md')))

    // Exactness: everything under tools/scanner/ is a shipped source, a
    // runtime asset, a stage tsconfig or the (filtered) registry. Nothing else.
    const { srcRoot } = resolveSourceRoot(PACKAGE_DIR)
    const allowed = new Set([...listSources(srcRoot), ...ASSET_FILES, ...playbookAssets(srcRoot), 'shared/models.json'])
    const files = listTree(dest)
    for (const f of files.filter(f => f.startsWith('tools/scanner/'))) {
      const rel = f.slice('tools/scanner/'.length)
      assert.ok(allowed.has(rel) || /^[\w-]+\/tsconfig\.json$/.test(rel), `unexpected ${f}`)
    }
    for (const f of files.filter(f => !f.startsWith('tools/'))) assert.ok(!/[\\/]/.test(f), `unexpected nested ${f}`)
    assert.ok(!files.some(f => /node_modules|(^|\/)dist\/|\.tgz$|\.test\.[cm]?[jt]s$/.test(f)))
    assert.ok(files.includes('tools/scanner/cli/src/secscan.ts'))

    const models = JSON.parse(readFileSync(join(dest, 'tools/scanner/shared/models.json'), 'utf8'))
    assert.ok(models.targets[models.product_default_provider])
    assert.ok(Object.values(models.targets).every(t => !t.lab_only && (t.transport ?? 'openai') === 'openai'))

    assert.deepEqual([...scanTree(dest)], [])

    // npm ci && npm run build, in the export, with nothing from the harness.
    const ping = npm(['ping'], dest, 30_000)
    if (ping.status !== 0) {
      t.diagnostic('npm registry unreachable: skipped npm ci && npm run build in the export')
    } else {
      const ci = npm(['ci', '--no-audit', '--no-fund'], dest)
      assert.equal(ci.status, 0, ci.stderr)
      const build = npm(['run', 'build'], dest)
      assert.equal(build.status, 0, build.stderr || build.stdout)
      const info = JSON.parse(readFileSync(join(dest, 'dist/build-info.json'), 'utf8'))
      assert.equal(info.harness_commit, out.commit)
      const v = spawnSync(process.execPath, [join(dest, 'dist/tools/scanner/cli/src/secscan.js'), '--version'], { encoding: 'utf8' })
      assert.equal(v.status, 0, v.stderr)
      assert.match(v.stdout, new RegExp(`\\(harness ${out.commit}\\)`))
      // The built tree (dist/ included; node_modules is skipped) still passes.
      assert.deepEqual([...scanTree(dest)], [])
    }

    // The guard refuses the export once an answer-key file or a lab_only model is planted.
    writeFileSync(join(dest, 'tools/scanner/shared/answer-key.json'), '{"benchmark_ground_truth": []}')
    assert.ok(scanTree(dest).some(v => v.file === 'tools/scanner/shared/answer-key.json'))
    rmSync(join(dest, 'tools/scanner/shared/answer-key.json'))
    models.targets.arm = { ...models.targets[models.product_default_provider], lab_only: true }
    writeFileSync(join(dest, 'tools/scanner/shared/models.json'), JSON.stringify(models, null, 2))
    assert.ok(scanTree(dest).some(v => v.rule === 'lab-only-model'))
  } finally {
    rmSync(join(dest, '..'), { recursive: true, force: true })
  }
})
