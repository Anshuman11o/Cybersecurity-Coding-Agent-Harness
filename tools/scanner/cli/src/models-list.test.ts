/**
 * `secscan models`: which entries the listing shows, and that the registry
 * flags the lab-only ones. No stage runs, no model calls.
 *
 *   npx tsx --test src/models-list.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { renderModels, MODELS_README } from './display.js'
import { loadRegistryModules, type ModelInfo } from './registry.js'

const base: ModelInfo = {
  key: 'm', label: 'Model M', model: 'm-1', origin: 'registry', transport: 'openai',
  apiKeyEnv: 'M_KEY', keyPresent: false, baseUrl: null, price: { input: 1, output: 2 }, priceAsOf: 'd',
  measured: false, benchmark: null, maxConcurrency: null, isDefault: false,
}
const models: ModelInfo[] = [
  { ...base, key: 'shown', isDefault: true },
  { ...base, key: 'arm', labOnly: true },
  { ...base, key: 'cli', transport: 'claude-cli', labOnly: true },
  { ...base, key: 'cli-unflagged', transport: 'claude-cli' },
]
const keys = (out: string) => out.split('\n').slice(1).map(l => l.trim().replace(/^\* /, '').split(/\s+/)[0]).filter(Boolean)

test('lab-only entries and lab transports are hidden unless --all', () => {
  const out = renderModels(models, false)
  const rows = keys(out.split('\n\n')[0])
  assert.deepEqual(rows, ['shown'])
  assert.match(out, /3 lab-only model\(s\) hidden; --all shows them\./)

  const all = renderModels(models, true)
  assert.deepEqual(keys(all.split('\n\n')[0]), ['shown', 'arm', 'cli', 'cli-unflagged'])
  assert.doesNotMatch(all, /hidden; --all/)
})

test('an absent labOnly reads as a normal entry', () => {
  const { labOnly: _, ...plain } = { ...base, key: 'plain' }
  assert.deepEqual(keys(renderModels([plain as ModelInfo], false).split('\n\n')[0]), ['plain'])
})

test('the footer points at the README, not at a lab document', () => {
  const out = renderModels(models, false)
  assert.ok(out.includes(MODELS_README))
  assert.doesNotMatch(out, /docs\//)
})

test('every models.json entry marked lab_only is labOnly in the CLI, and no other', async () => {
  const shared = join(dirname(fileURLToPath(import.meta.url)), '../../shared')
  const raw = JSON.parse(readFileSync(join(shared, 'models.json'), 'utf-8'))
  const reg = await loadRegistryModules()
  const listed = reg.list()
  const flagged = Object.entries(raw.targets as Record<string, { lab_only?: boolean }>)
    .filter(([, t]) => t.lab_only === true).map(([k]) => k).sort()
  assert.deepEqual(listed.filter(m => m.labOnly).map(m => m.key).sort(), flagged)
  // The product default must never be a lab instrument.
  assert.equal(listed.find(m => m.isDefault)?.labOnly, false)
  assert.ok(!renderModels(listed, false).split('\n').some(l => flagged.some(k => l.trim().replace(/^\* /, '').startsWith(k + ' '))))
})
