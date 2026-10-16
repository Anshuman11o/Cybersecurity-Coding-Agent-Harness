/**
 * The package build's pure parts: which sources ship, the product registry
 * filter, provenance, and the runtime-resolution scan. The full build runs in
 * export-product.test.mjs (npm ci && npm run build in an exported repo).
 *
 *   node --test build.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ASSET_FILES, harnessCommit, isShippedSource, listSources, playbookAssets, productRegistry, resolveSourceRoot,
  runtimeResolutions,
} from '../scanner/package/build.mjs'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../scanner/package')

const synthetic = () => ({
  _comment: ['lab text'],
  default_provider: 'lab',
  product_default_provider: 'prod',
  aliases: { p: 'prod', arm2: 'arm', viaCli: 'cli' },
  targets: {
    lab: { label: 'L' },
    prod: { label: 'P', transport: 'openai' },
    arm: { label: 'A', lab_only: true },
    cli: { label: 'C', transport: 'claude-cli', lab_only: true },
  },
})

test('the product registry drops lab_only targets and the aliases that point at them', () => {
  const r = productRegistry(synthetic())
  assert.deepEqual(r.shipped, ['lab', 'prod'])
  assert.deepEqual(r.dropped, ['arm', 'cli'])
  assert.deepEqual(r.droppedAliases.sort(), ['arm2', 'viaCli'])
  assert.deepEqual(r.registry.aliases, { p: 'prod' })
  assert.equal(r.registry.default_provider, 'lab')
  assert.notDeepEqual(r.registry._comment, ['lab text'])
  // The input is not modified.
  assert.ok(synthetic().targets.arm)
})

test('the product registry refuses a lab_only default and a shipped lab transport', () => {
  const lab = synthetic()
  lab.targets.prod.lab_only = true
  assert.throws(() => productRegistry(lab), /product default "prod".*lab_only/)
  const missing = synthetic()
  missing.product_default_provider = 'nope'
  assert.throws(() => productRegistry(missing), /product default "nope"/)
  const cli = synthetic()
  delete cli.targets.cli.lab_only
  assert.throws(() => productRegistry(cli), /"cli" uses transport "claude-cli"/)
})

test('a lab default that is itself lab_only falls back to the product default', () => {
  const r = synthetic()
  r.targets.lab.lab_only = true
  assert.equal(productRegistry(r).registry.default_provider, 'prod')
})

test('the real registry ships its product default and no lab entry', () => {
  const { srcRoot } = resolveSourceRoot(PKG_DIR)
  const raw = JSON.parse(readFileSync(join(srcRoot, 'shared/models.json'), 'utf8'))
  const r = productRegistry(raw)
  assert.ok(r.shipped.includes(raw.product_default_provider))
  assert.deepEqual(r.dropped, Object.keys(raw.targets).filter(k => raw.targets[k].lab_only).sort())
  for (const t of Object.values(r.registry.targets)) {
    assert.equal(t.lab_only, undefined)
    assert.equal(t.transport ?? 'openai', 'openai')
  }
  for (const c of Object.values(r.registry.aliases)) assert.ok(r.registry.targets[c], c)
})

test('which sources ship', () => {
  for (const p of ['cli/src/secscan.ts', 'shared/models.ts', 'report/src/build.ts',
    'stage2-hunt-lanes-perfile/src/playbooks/injection.ts', 'stage-playbook-agent/src/review.ts']) {
    assert.ok(isShippedSource(p), p)
  }
  for (const p of ['cli/src/cli.test.ts', 'stage1-budget-governor/src/test-harness.ts',
    'stage2-hunt-lanes-perfile/src/test-breakdown.ts', 'shared/preflight.ts', 'report/src/fixtures.ts',
    'stage2-hunt-lanes-perfile/fixtures/routes.ts', 'stage-playbook-agent/src/fixtures/x.ts',
    'shared/node_modules/openai/index.d.ts', 'stage2-hunt-lanes/src/hunt-executor.ts',
    'stage05-lane-selector/src/lane-selector.ts', 'cli/README.md', 'shared/registry-cli.mjs']) {
    assert.ok(!isShippedSource(p), p)
  }
  const { srcRoot } = resolveSourceRoot(PKG_DIR)
  const sources = listSources(srcRoot)
  assert.ok(sources.includes('cli/src/secscan.ts'))
  assert.ok(sources.every(isShippedSource))
  assert.ok(!sources.some(s => /\.test\.ts$|\/fixtures\//.test(s)))
  assert.ok(playbookAssets(srcRoot).length > 0)
  assert.ok(ASSET_FILES.includes('stage-playbook-agent/guidance.md'))
})

test('runtime resolutions: template imports and (renamed) require.resolve', () => {
  const code = [
    'const mod = await import(`./playbooks/${name}.js`);',
    'const require2 = createRequire(import.meta.url);',
    'require2.resolve(`tree-sitter-wasms/out/tree-sitter-${g}.wasm`);',
    'require2.resolve("web-tree-sitter");',
    "const s = 'import \"not-a-module\"';",
  ].join('\n')
  assert.deepEqual(runtimeResolutions(code), ['./playbooks/${name}.js', 'tree-sitter-wasms/out/tree-sitter-${g}.wasm', 'web-tree-sitter'])
})

test('harness_commit: EXPORTED_FROM wins; outside the harness without it, "unknown"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secscan-build-'))
  try {
    assert.equal(harnessCommit(dir, dir, false), 'unknown')
    writeFileSync(join(dir, 'EXPORTED_FROM'), JSON.stringify({ harness_commit: 'abc1234', exported_at: 'x' }))
    assert.equal(harnessCommit(dir, dir, true), 'abc1234')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const { srcRoot } = resolveSourceRoot(PKG_DIR)
  assert.match(harnessCommit(PKG_DIR, srcRoot, true), /^([0-9a-f]{7,}(-dirty)?|unknown)$/)
})
