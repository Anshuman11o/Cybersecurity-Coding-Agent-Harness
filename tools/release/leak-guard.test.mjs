/**
 * Leak guard: every rule fires on a planted violation, clean trees and
 * tarballs pass, and the shipped package passes when it has been built.
 *
 *   node --test leak-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkContent, checkPath, readTarball, scanTarball, scanTree } from './leak-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUARD = join(HERE, 'leak-guard.mjs')
const DIST = join(HERE, '../scanner/package/dist')

/** Synthetic key-shaped values, assembled so this file holds no literal one. */
const fake = {
  sk: 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2',
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  ghp: 'ghp_' + 'a'.repeat(36),
  slack: 'xox' + 'b-123-456',
  pem: '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n',
}

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'leak-guard-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

const CLEAN = {
  'package.json': '{ "name": "x" }\n',
  'tools/scanner/shared/models.json': JSON.stringify({ targets: { a: { label: 'A' }, b: { label: 'B', transport: 'openai' } } }),
  'tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.ts': '// explains why the scanner must never see the answer key\nexport {}\n',
  'tools/scanner/shared/key-material.ts': "const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/\nexport {}\n",
  'README.md': 'Set OPENAI_API_KEY=sk-... and run.\n',
}

const rules = v => v.map(x => x.rule)

test('path rules: lab segments, v1 stages, tests, fixtures, .env, answer-key names', () => {
  for (const p of ['docs/a.md', 'tools/eval/x.py', 'results/r.json', 'runs/luna/x.json', 'prompts/p.md',
    'target-apps/app/server.ts', 'tools/scan-benchmark/s.py', 'tools/blind-development/split.py', 'tools/patcher/a.py',
    'tools/scanner/stage2-hunt-lanes/src/a.js', 'tools/scanner/stage05-lane-selector/src/a.js']) {
    assert.ok(checkPath(p).some(r => r.startsWith('lab path segment')), p)
  }
  for (const p of ['a.test.ts', 'src/a.test.js', 'src/a.test.mjs', 'src/a.spec.ts', 'src/test-harness.ts', 'src/test-breakdown.js']) {
    assert.ok(checkPath(p).some(r => /test/.test(r)), p)
  }
  assert.ok(checkPath('stage2/fixtures/a.json').includes('fixtures directory'))
  assert.ok(checkPath('report/src/fixtures.js').includes('test fixture module'))
  for (const p of ['.env', 'cfg/.env.local', '.env.production']) assert.ok(checkPath(p).includes('.env file'), p)
  assert.ok(checkPath('.npmrc').length > 0)
  for (const p of ['juice-shop-answer-key/x.json', 'answer-key.json', 'a/benchmark_ground_truth.json', 'harness-private/a']) {
    assert.ok(checkPath(p).some(r => r.startsWith('answer-key or private-store')), p)
  }
  assert.deepEqual(checkPath('node_modules/x/index.js'), [])
  assert.ok(checkPath('node_modules/x/index.js', { tarball: true }).length > 0)
})

test('path rules pass what ships', () => {
  for (const p of ['dist/tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.js',
    'dist/tools/scanner/stage05-lane-selector-perfile/src/lane-selector-perfile.js',
    'dist/tools/scanner/stage2-hunt-lanes-perfile/src/playbooks/injection.ts',
    'dist/tools/scanner/shared/models.json', 'dist/build-info.json', 'README.md', 'LICENSE', '.gitignore',
    'tools/scanner/cli/tsconfig.json', 'EXPORTED_FROM']) {
    assert.deepEqual(checkPath(p, { tarball: true }), [], p)
  }
})

test('content rules fire on planted markers, models and keys', () => {
  assert.deepEqual(rules(checkContent('a.json', '{"benchmark_ground_truth": []}')), ['ground-truth-marker'])
  assert.deepEqual(rules(checkContent('a.md', 'see /home/user/harness-private/runs')), ['private-store'])
  assert.deepEqual(rules(checkContent('a.md', 'cloned at ../juice-shop-answer-key')), ['answer-key-repo'])
  assert.deepEqual(rules(checkContent('a.md', 'read answer-key/answer-key.json')), ['answer-key-repo'])
  assert.deepEqual(rules(checkContent('a.md', 'the scanner must never see the answer key')), [])
  assert.deepEqual(rules(checkContent('x.json', '{ "t": { "lab_only": true } }')), ['lab-only-model'])
  assert.deepEqual(rules(checkContent('a.ts', 'if (t.lab_only === true) drop(t)')), [])
  for (const [k, rule] of [['sk', 'openai-style-key'], ['aws', 'aws-access-key'], ['ghp', 'github-token'], ['slack', 'slack-token'], ['pem', 'private-key-block']]) {
    const hits = checkContent('a.ts', `const v = ${JSON.stringify(fake[k])}`.replace(/\\n/g, '\n'))
    assert.deepEqual(rules(hits), [rule], k)
    // A secret is never echoed whole.
    assert.ok(!hits[0].detail.includes(fake[k]), k)
  }
  assert.deepEqual(rules(checkContent('a.ts', "const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/")), [])
})

test('a models.json with a lab_only target, a lab transport or bad JSON is refused', () => {
  const lab = checkContent('shared/models.json', JSON.stringify({ targets: { a: {}, arm: { lab_only: true } } }))
  assert.ok(lab.some(h => h.rule === 'lab-only-model' && h.detail.includes('"arm"')))
  const cli = checkContent('shared/models.json', JSON.stringify({ targets: { viaCli: { transport: 'claude-cli' } } }))
  assert.ok(cli.some(h => h.rule === 'lab-only-model' && h.detail.includes('claude-cli')))
  assert.ok(checkContent('shared/models.json', '{ nope').some(h => h.rule === 'lab-only-model'))
  assert.deepEqual(checkContent('shared/models.json', CLEAN['tools/scanner/shared/models.json']), [])
})

test('a clean tree passes; planted files are each refused', () => {
  const dir = tree(CLEAN)
  try {
    assert.deepEqual([...scanTree(dir)], [])
    const plants = {
      'tools/scanner/shared/answer-key.json': '{}',
      'notes.md': 'the key lives in ../juice-shop-answer-key',
      'tools/scanner/shared/models.json': JSON.stringify({ targets: { a: {}, arm: { lab_only: true } } }),
      '.env': 'X=1',
      'tools/scanner/cli/src/cli.test.ts': 'test()',
      'tools/scanner/stage2-hunt-lanes-perfile/fixtures/a.ts': '',
      'docs/plan.md': '# plan',
      'src/key.ts': `export const k = '${fake.sk}'`,
    }
    for (const [rel, text] of Object.entries(plants)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
    const v = scanTree(dir)
    for (const rel of Object.keys(plants)) assert.ok(v.some(x => x.file === rel), `${rel} not refused`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('tree scans skip .git and node_modules', () => {
  const dir = tree({ ...CLEAN, '.git/config': 'harness-private', 'node_modules/x/a.test.js': 'benchmark_ground_truth' })
  try { assert.deepEqual([...scanTree(dir)], []) } finally { rmSync(dir, { recursive: true, force: true }) }
})

function tarball(files, format) {
  const dir = tree(Object.fromEntries(Object.entries(files).map(([k, v]) => [`package/${k}`, v])))
  const out = join(dir, 'p.tgz')
  const args = [...(format ? [`--format=${format}`] : []), '-czf', out, '-C', dir, 'package']
  const r = spawnSync('tar', args, { encoding: 'utf8' })
  if (r.status !== 0) return { dir, out: null, why: r.stderr || r.error?.message }
  return { dir, out }
}

test('tarballs: entries read back exactly (long paths too); planted violations are refused', t => {
  const long = `dist/${'deep/'.repeat(25)}module.js`
  for (const format of ['pax', 'gnu', null]) {
    const clean = tarball({ ...CLEAN, [long]: 'export {}\n' }, format)
    try {
      if (!clean.out) { t.diagnostic(`tar --format=${format} unavailable: ${clean.why}`); continue }
      const paths = readTarball(clean.out).filter(e => e.type === 'file').map(e => e.path).sort()
      assert.deepEqual(paths, Object.keys({ ...CLEAN, [long]: '' }).map(p => `package/${p}`).sort(), String(format))
      assert.deepEqual([...scanTarball(clean.out)], [], String(format))
    } finally { rmSync(clean.dir, { recursive: true, force: true }) }
  }
  const dirty = tarball({ ...CLEAN, 'node_modules/x/index.js': '', 'dist/a.test.js': '', 'dist/x.json': '{"benchmark_ground_truth":1}' })
  try {
    if (!dirty.out) return t.skip(`tar unavailable: ${dirty.why}`)
    const v = scanTarball(dirty.out)
    for (const f of ['node_modules/x/index.js', 'dist/a.test.js', 'dist/x.json']) assert.ok(v.some(x => x.file === f), f)
  } finally { rmSync(dirty.dir, { recursive: true, force: true }) }
})

test('the CLI exits 1 on a violation and 0 on a clean tree', () => {
  const clean = tree(CLEAN)
  const dirty = tree({ ...CLEAN, 'tools/scanner/shared/models.json': JSON.stringify({ targets: { arm: { lab_only: true } } }) })
  try {
    assert.equal(spawnSync(process.execPath, [GUARD, clean]).status, 0)
    const r = spawnSync(process.execPath, [GUARD, dirty], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /lab-only-model/)
    assert.equal(spawnSync(process.execPath, [GUARD]).status, 2)
  } finally {
    rmSync(clean, { recursive: true, force: true })
    rmSync(dirty, { recursive: true, force: true })
  }
})

test('the built package (when built) passes', t => {
  if (!existsSync(DIST)) return t.skip('tools/scanner/package/dist not built; run npm run build there')
  const v = scanTree(DIST)
  assert.deepEqual(v.map(x => `${x.file}: ${x.rule}`), [])
  assert.ok(v.scanned > 50)
})
