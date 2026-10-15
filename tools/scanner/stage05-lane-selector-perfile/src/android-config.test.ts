import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { androidConfigSignals } from './android-config.js'
import { defaultProvider } from '../../shared/provider.js'

test('only Android platform manifests and XML configuration are selected', () => {
  for (const p of ['AndroidManifest.xml', 'app/src/main/AndroidManifest.xml', 'app/src/main/res/xml/network_policy.xml', 'lib/res/xml-v24/backup.xml']) {
    assert.ok(androidConfigSignals(p, 'xml').includes('config_file'), p)
  }
  for (const p of ['pom.xml', 'res/layout/screen.xml', 'res/values/strings.xml', 'docs/manifest.xml', 'res/xml/nested/data.xml']) {
    assert.deepEqual(androidConfigSignals(p, 'xml'), [])
  }
  assert.deepEqual(androidConfigSignals('AndroidManifest.xml', 'json'), [])
})

test('selector hunts configuration with policy classes and preserves inventory exclusions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-lanes-'))
  try {
    const target = path.join(tmp, 'target'), runs = path.join(tmp, 'runs')
    const provider = defaultProvider()
    const upstream = path.join(runs, provider, 'stage0-recon')
    fs.mkdirSync(upstream, { recursive: true })
    const paths = ['AndroidManifest.xml', 'res/xml/network_policy.xml', 'res/xml-v24/backup.xml', 'res/layout/screen.xml', 'res/values/strings.xml', 'pom.xml', 'empty/AndroidManifest.xml', 'test/AndroidManifest.xml', 'large/AndroidManifest.xml']
    const files = paths.map(p => {
      fs.mkdirSync(path.dirname(path.join(target, p)), { recursive: true })
      fs.writeFileSync(path.join(target, p), '<configuration />\n')
      return { path: p, language: 'xml', bytes: 18, test: p.startsWith('test/'), empty: p.startsWith('empty/'), oversize: p.startsWith('large/') }
    })
    for (const [name, value] of Object.entries({
      'file-inventory.json': { target_dir: target, files, options: { max_file_bytes: 10 }, totals: {} },
      'file-signals.json': { target_dir: target, files: {} },
      'architecture-summary.json': { file_inventory: { total_source_files: files.length } },
      'category-applicability.json': [],
    })) fs.writeFileSync(path.join(upstream, name), JSON.stringify(value))
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    execFileSync(path.join(pkg, 'node_modules/.bin/tsx'), ['src/lane-selector-perfile.ts'], {
      cwd: pkg, env: { ...process.env, SCANNER_PROVIDER: provider, SCANNER_PROFILE: 'product', SCANNER_TARGET: target, SCANNER_RUNS_ROOT: runs, SCANNER_REPORTS_ROOT: path.join(tmp, 'reports') }, stdio: 'pipe',
    })
    const result = JSON.parse(fs.readFileSync(path.join(runs, provider, 'stage05-lane-selector-perfile/lane-assignments.json'), 'utf8'))
    assert.equal(result.coverage_ledger.assigned_hunt, 3)
    assert.equal(result.coverage_ledger.unaccounted, 0)
    for (const lane of result.lanes.slice(0, 3)) {
      assert.equal(lane.disposition, 'hunt')
      for (const c of ['misconfiguration', 'access-control', 'crypto-auth']) assert.ok(lane.classes.includes(c))
    }
    for (const lane of result.lanes.slice(3)) assert.equal(lane.disposition, 'skip')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
