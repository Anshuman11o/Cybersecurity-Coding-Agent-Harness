/** Generic Solidity fixtures; no target, answer key or model calls. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { detectSinkSignals } from './signal-detector.js'

test('Solidity risk surfaces use contract signals, including historical syntax', () => {
  for (const source of ['recipient.call{value: amount}("");', 'recipient.call.value(amount)("");',
    'recipient.send(amount);', 'recipient.transfer(amount);', 'selfdestruct(recipient);', 'suicide(recipient);']) {
    assert.ok(detectSinkSignals('solidity', source).includes('model_write'), source)
  }
  for (const source of ['recipient.delegatecall(data);', 'recipient.call(data);', 'assembly { sstore(0, 1) }']) {
    assert.ok(detectSinkSignals('solidity', source).includes('dynamic_exec'), source)
  }
  assert.ok(detectSinkSignals('solidity', 'require(tx.origin == owner);').includes('auth_check'))
  for (const source of ['if (block.timestamp > deadline) {}', 'require(now > deadline);',
    'if (block.number > height) {}', 'uint draw = uint(blockhash(height)) % 10;']) {
    assert.ok(detectSinkSignals('solidity', source).includes('crypto_op'), source)
  }
  const arithmetic = 'contract Counter { function add(uint a, uint b) public returns(uint) { return a + b; } }'
  assert.ok(detectSinkSignals('solidity', 'pragma solidity ^0.4.24; ' + arithmetic).includes('model_write'))
  assert.ok(!detectSinkSignals('solidity', 'pragma solidity ^0.8.20; ' + arithmetic).includes('model_write'))
  assert.ok(detectSinkSignals('solidity', 'function update(uint n) external payable { amount = n; }').includes('route_handler'))
  for (const header of ['function update() public onlyOwner {', 'function update() public view {', 'function update() external pure {']) {
    assert.ok(!detectSinkSignals('solidity', header).includes('route_handler'), header)
  }
  // A low-level call is a surface signal, even when its result is checked.
  assert.ok(detectSinkSignals('solidity', '(bool ok,) = recipient.call(data); require(ok);').includes('dynamic_exec'))
  assert.deepEqual(detectSinkSignals('solidity', 'fetch(url); db.query(sql);'), [])
})

test('routeless Solidity without a manifest survives Stage 0 fallback and actual lane selection', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const scratch = mkdtempSync(join(tmpdir(), 'solidity-readiness-'))
  const target = join(scratch, 'source')
  const runs = join(scratch, 'artifacts')
  mkdirSync(target)
  writeFileSync(join(target, 'Vault.sol'), 'pragma solidity ^0.4.24; contract Vault { function deposit() public payable {} }\n')
  writeFileSync(join(target, 'Math.sol'), 'pragma solidity ^0.8.20; library Math { function add(uint a, uint b) internal pure returns(uint) { return a + b; } }\n')
  const registry = JSON.parse(readFileSync(join(root, 'tools/scanner/shared/models.json'), 'utf8'))
  const env = { ...process.env }
  // Clear every registered credential and inherited run override. The default
  // HTTP transport sees no key, so createClient returns null before any call.
  for (const key of Object.keys(env)) if (key.startsWith('SCANNER_') || key.startsWith('HUNT_')) delete env[key]
  for (const provider of Object.values<any>(registry.targets)) delete env[provider.api_key_env]
  delete env[registry.generic_openai_compatible.api_key_env]
  assert.notEqual(registry.targets[registry.default_provider].transport, 'claude-cli')
  Object.assign(env, { SCANNER_TARGET: target, SCANNER_PROFILE: 'product', SCANNER_RUNS_ROOT: runs })
  function run(stage: string, entry: string) {
    const result = spawnSync(join(root, 'tools/scanner', stage, 'node_modules/.bin/tsx'),
      [join(root, 'tools/scanner', stage, 'src', entry)], { cwd: root, env, encoding: 'utf8', timeout: 60_000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  function artifact(stage: string, name: string) {
    return JSON.parse(readFileSync(join(runs, registry.default_provider, stage, name), 'utf8'))
  }
  try {
    run('stage0-recon', 'recon.ts')
    const arch = artifact('stage0-recon', 'architecture-summary.json')
    assert.equal(arch.route_table.total_routes, 0)
    assert.equal(arch.file_inventory.total_source_files, 2)
    assert.equal(arch.architecture.source, 'deterministic')
    const meta = artifact('stage0-recon', 'meta.json')
    assert.equal(meta.degraded, true) // no live recon claim
    assert.equal(artifact('stage0-recon', 'api-profile.json').recon_calls, 0)
    run('stage05-lane-selector-perfile', 'lane-selector-perfile.ts')
    const manifest = artifact('stage05-lane-selector-perfile', 'lane-assignments.json')
    assert.equal(manifest.coverage_ledger.assigned_hunt, 2)
    assert.equal(manifest.coverage_ledger.unaccounted, 0)
    assert.ok(manifest.lanes.every((lane: any) => lane.disposition === 'hunt' && lane.classes.length > 0))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
