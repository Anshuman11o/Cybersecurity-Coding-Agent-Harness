import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { PlaybookMeter } from './meter.js'
import { SpendLedger, ledgerPathFor, readLedgerTotals } from '../../shared/ledger.js'
import { modelFor, productDefaultProvider } from '../../shared/provider.js'
import { resolveRunContext } from '../../shared/run-context.js'
import { SpendGate } from '../../stage1-budget-governor/src/spend-gate.js'

const provider = productDefaultProvider()
const request: ResponseCreateParamsNonStreaming = {
  model: modelFor(provider), max_output_tokens: 8000, instructions: 'Synthetic guidance',
  input: JSON.stringify({ class: { id: 'example-class' } }), tools: [{ type: 'web_search' }],
}
const response = (extra: Record<string, unknown> = {}): Response => ({
  id: 'mock-search', model: request.model, status: 'completed', service_tier: 'flex',
  usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    output_tokens: 50, output_tokens_details: { reasoning_tokens: 15 } },
  output: [{ type: 'web_search_call', action: { type: 'search', queries: ['synthetic security'] } }],
  ...extra,
} as unknown as Response)

function context(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'playbook-ledger-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return resolveRunContext({ SCANNER_TARGET: root, SCANNER_PROFILE: 'product', SCANNER_RUN_ID: 'test' }, [])
}

test('playbook metering keeps recon spend, pins its tier, and includes cache, region and web costs in the live gate', async t => {
  const ctx = context(t)
  const ledger = new SpendLedger(ledgerPathFor(ctx.runsRoot, provider))
  ledger.append({ source: 'recon', stage: 'stage0-recon', label: 'synthetic', lane_id: null,
    attempt: 1, model: modelFor(provider), served_tier: 'flex', usage: null, chars_sent: 0,
    cost_usd: 0.2, basis: 'reservation' })
  const gate = new SpendGate({ capUsd: 0.225, deadlineMs: null,
    ledgerTotal: () => readLedgerTotals(ledger.path).total_usd })
  assert.equal(gate.decide(0.02).action, 'start')
  let calls = 0
  const meter = new PlaybookMeter(provider, ctx, 'https://eu.api.openai.com/v1', 'flex', async (body, purpose) => {
    calls++
    assert.equal(body.service_tier, 'flex')
    assert.equal(purpose, 'turn2:pass1')
    return response()
  })
  await meter.call(request, 'turn2:pass1')
  assert.equal(calls, 1)
  const entries = new SpendLedger(ledger.path).list()
  assert.equal(entries.length, 2)
  assert.equal(entries[0].source, 'recon')
  assert.equal(entries[1].source, 'playbook')
  assert.equal(entries[1].stage, 'stage-playbook-agent')
  assert.equal(entries[1].label, 'turn2:pass1', 'the label is the caller\'s purpose, whatever the request carries')
  const expected = ((90 * 0.1 + 20 * 0.01 + 10 * 0.125 + 50 * 0.5) * 0.5 * 1.1) / 1e6 + 0.01
  assert.equal(entries[1].cost_usd, expected)
  assert.equal(entries[1].usage!.cache_write_tokens, 10)
  assert.equal(gate.decide(0.02).action, 'stop', 'the hunt gate includes pre-hunt playbook spend')
})

test('missing-usage calls and failed requests reserve spend, and resumes append without resetting or retrying', async t => {
  const ctx = context(t)
  let calls = 0
  const failed = new PlaybookMeter(provider, ctx, null, 'default', async () => {
    calls++
    throw new Error('synthetic failure without usage')
  })
  await assert.rejects(failed.call(request, 'research:example-class'), /synthetic failure/)
  const first = failed.ledger.total()
  assert.ok(first > 0)
  const resumed = new PlaybookMeter(provider, ctx, null, 'default', async () => {
    calls++
    return response({ usage: undefined, service_tier: 'default' })
  })
  await resumed.call(request, 'research:example-class')
  const totals = readLedgerTotals(resumed.ledger.path)
  assert.equal(calls, 2)
  assert.equal(totals.reserved_calls, 2)
  assert.equal(totals.calls, 2)
  assert.ok(totals.total_usd > first)
})

test('failed requests carrying usage are booked at actual cost', async t => {
  const ctx = context(t)
  const meter = new PlaybookMeter(provider, ctx, null, 'flex', async () => {
    throw { error: { usage: response().usage, service_tier: 'flex' } }
  })
  await assert.rejects(meter.call(request, 'coverage'))
  const entry = meter.ledger.list()[0]
  assert.equal(entry.label, 'coverage')
  assert.equal(entry.basis, 'actual')
  assert.equal(entry.usage!.completion_tokens, 50)
  assert.equal(entry.usage!.cache_write_tokens, 10)
  assert.ok(entry.cost_usd! > 0)
})

test('an unpriced served tier stops after recording the attempted call', async t => {
  const ctx = context(t)
  const meter = new PlaybookMeter(provider, ctx, null, 'default', async () => response({ service_tier: 'ultrafast' }))
  await assert.rejects(meter.call(request, 'coverage'), /unpriced_service_tier/)
  assert.equal(meter.ledger.list().length, 1)
  assert.equal(meter.ledger.list()[0].served_tier, 'ultrafast')
  assert.equal(meter.ledger.list()[0].cost_usd, null)
})
