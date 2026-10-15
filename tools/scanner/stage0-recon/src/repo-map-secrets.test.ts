import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRepoMap, selectEntryPoints } from './repo-map.js'
import type { InventoryEntry, SymbolTableArtifact } from './recon-contract.js'

test('newly huntable key-material entry points cannot put raw keys in the recon map', () => {
  const secret = 'synthetic-non-pem-secret'
  const inventory: InventoryEntry[] = [{ path: 'main.key', language: 'key-material', bytes: secret.length,
    test: false, oversize: false, empty: false }]
  const guard = { isReadable: () => true, read: (name: string) => name === 'main.key' ? secret : null }
  const symbols: SymbolTableArtifact = { schema_version: 1, generated_at: 'synthetic', target_dir: '/synthetic',
    parser: { runtime: 'synthetic', grammars: 'synthetic' }, languages: {}, skipped: {}, files: {} }
  const entryPoints = selectEntryPoints(inventory, symbols, null, guard)
  assert.ok(entryPoints.some(e => e.path === 'main.key'))
  const map = buildRepoMap({ targetDir: '/synthetic', inventory, symbols, signals: {}, routes: [], autoCrud: [], entryPoints, guard })
  assert.ok(map.text.includes('KEY-MATERIAL SUMMARY'))
  assert.ok(!map.text.includes(secret))
})
