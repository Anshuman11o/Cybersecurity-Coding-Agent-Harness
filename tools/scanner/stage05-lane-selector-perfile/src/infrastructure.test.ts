import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { selectFilesWithRunsRoot } from '../../stage0-recon/src/file-selection.js'
import { detectAllSignalsFromList, detectSinkSignals } from '../../stage0-recon/src/signal-detector.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('infrastructure signals include security-relevant declarations and reject near misses', () => {
  const cases: [string, string, string][] = [
    ['route_handler', 'cidr_blocks = ["0.0.0.0/0"]', 'cidr_blocks = ["10.0.0.0/8"]'],
    ['auth_check', 'Action = "*"', 'Action = "s3:GetObject"'],
    ['auth_check', 'principals = ["*"]', 'principals = ["service"]'],
    ['auth_check', 'acl = "public-read"', 'acl = "private"'],
    ['crypto_op', 'storage_encrypted = false', 'storage_encrypted = true'],
    ['crypto_op', 'password = "fixture-value"', 'password = var.password'],
    ['logging', 'debug = true', 'debug = false'],
  ]
  for (const [signal, positive, negative] of cases) {
    assert.ok(detectSinkSignals('terraform', positive).includes(signal as any), positive)
    assert.ok(!detectSinkSignals('terraform', negative).includes(signal as any), negative)
  }
})

test('product inventory reaches v2 hunt lanes; config naming does not erase infrastructure signals', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infrastructure-lanes-'))
  try {
    const target = path.join(tmp, 'target'), runs = path.join(tmp, 'runs')
    fs.mkdirSync(target)
    const sources = {
      'config.tf': 'actions = ["*"]\nstorage_encrypted = false',
      'values.tfvars': 'debug = true', 'policy.hcl': 'acl = "public-read"',
      'config.key': 'synthetic key material', 'certificate.crt': 'synthetic certificate',
      'empty.pem': '', 'package.json': '{}',
    }
    for (const [file, content] of Object.entries(sources)) fs.writeFileSync(path.join(target, file), content)
    const inventory = selectFilesWithRunsRoot(target, {}, runs, { profile: 'product' })
    const signals = detectAllSignalsFromList(target, inventory.files, new Set())
    assert.ok(signals.files['config.tf'].includes('auth_check'))
    assert.ok(signals.files['config.tf'].includes('crypto_op'))
    assert.deepEqual(signals.files['config.key'], ['crypto_op'])
    const provider = JSON.parse(fs.readFileSync(path.join(root, 'scanner/shared/models.json'), 'utf8')).default_provider
    const upstream = path.join(runs, provider, 'stage0-recon')
    fs.mkdirSync(upstream, { recursive: true })
    for (const [name, data] of Object.entries({
      'file-inventory': inventory, 'file-signals': signals,
      'architecture-summary': { file_inventory: { total_source_files: inventory.files.length } },
      'category-applicability': [],
    })) fs.writeFileSync(path.join(upstream, `${name}.json`), JSON.stringify(data))
    const env = { ...process.env, SCANNER_TARGET: target, SCANNER_PROFILE: 'product', SCANNER_RUNS_ROOT: runs, SCANNER_PROVIDER: provider }
    delete env.SCANNER_PLAYBOOK_AGENT
    execFileSync(process.execPath, [path.join(root, 'scanner/shared/node_modules/tsx/dist/cli.mjs'),
      path.join(root, 'scanner/stage05-lane-selector-perfile/src/lane-selector-perfile.ts')], { env, stdio: 'pipe' })
    const manifest = JSON.parse(fs.readFileSync(path.join(runs, provider, 'stage05-lane-selector-perfile/lane-assignments.json'), 'utf8'))
    const lanes = Object.fromEntries(manifest.lanes.map((l: any) => [l.target_file, l])) as Record<string, any>
    for (const f of ['config.tf', 'values.tfvars', 'policy.hcl', 'config.key', 'certificate.crt']) assert.equal(lanes[f].disposition, 'hunt', f)
    assert.ok(lanes['config.key'].classes.includes('crypto-auth'))
    assert.equal(lanes['empty.pem'].disposition, 'skip')
    assert.equal(lanes['package.json'].disposition, 'skip')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
