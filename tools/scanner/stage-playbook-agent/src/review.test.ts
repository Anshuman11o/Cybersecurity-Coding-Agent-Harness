import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Response } from 'openai/resources/responses/responses'


import { modelFor, productDefaultProvider } from '../../shared/provider.js'
import type { ClassSelection } from '../../shared/playbook-overlay.js'

import type { ReviewOptions } from './review.js'


const root = mkdtempSync(join(tmpdir(), 'review-test-'))
process.env.SCANNER_PROFILE = 'product'
process.env.SCANNER_TARGET = root
process.env.SCANNER_RUN_ID = 'review-test'
process.env.SCANNER_RUNS_ROOT = join(root, 'runs')
after(() => rmSync(root, { recursive: true, force: true }))
const { getRunContext } = await import('../../shared/run-context.js')
const { runPath } = await import('../../shared/run-paths.js')
const { writeClassSelection, appendOverlayEntry } = await import('../../shared/playbook-overlay.js')
const { writeCachedPlaybook } = await import('../../shared/playbook-cache.js')
const { initializeClassReview, recordReviewBudget, runClassReview, resolveLocalClass, validateResolution } = await import('./review.js')
const { PlaybookMeter } = await import('./meter.js')

const provider = productDefaultProvider(), model = modelFor(provider)
const builtins = JSON.parse(readFileSync(new URL('../../shared/vuln-classes.json', import.meta.url), 'utf8'))
const signals = JSON.parse(readFileSync(new URL('../../shared/signal-classes.json', import.meta.url), 'utf8'))
const ctx = getRunContext(), dir = runPath(provider, 'stage-playbook-agent')
const original: ClassSelection = { schema: 'secscan.class-selection/1', created_at: '2026-01-01T00:00:00Z', model,
  builtin: ['injection'], added: [], classes: ['injection'] }
const good = 'Playbook for Synthetic (CWE-999)\n==========\nScope: synthetic\n## OWASP Categories Covered\n## Sink Patterns to Hunt For\n## Distinguishing Real Findings from False Positives\n## Hunting Discipline\n' + 'Generic security review guidance. '.repeat(70)
const newClass = { kind: 'new', id: 'synthetic-risk', framework: 'generic', codes: ['CWE-999'], signals: ['deserialize'] }
const response = (value: unknown, web = false, extra = {}): Response => ({ id: 'mock', model, status: 'completed', service_tier: 'default',
  usage: { input_tokens: 100, output_tokens: 30 }, output_text: JSON.stringify(value),
  output: web ? [{ type: 'web_search_call', action: { type: 'search', queries: ['generic synthetic risk'], sources: [] } }] : [], ...extra } as unknown as Response)
function fixture(create: (body: any, purpose: string) => Promise<Response>): ReviewOptions {
  assert.equal(ctx.runsRoot, join(root, 'runs'), 'fixture cleanup must stay inside its temp directory')
  rmSync(ctx.runsRoot, { recursive: true, force: true })
  rmSync(join(root, 'cache'), { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ provider, model, exit_code: 0, marker: 'original' }))
  writeClassSelection(provider, original, builtins, {})
  writeFileSync(join(dir, 'classes-overlay.json'), '{}')
  return { provider, action: 'add', input: 'some new class', builtins, signals, model, cacheRoot: join(root, 'cache'),
    meter: new PlaybookMeter(provider, ctx, null, 'default', create), maxOutputTokens: 8000, exampleFormat: good,
    recon: { architecture: {}, category_applicability: [], dependency_manifests: '', file_signals: { files: {} } } }
}
const read = (name: string) => readFileSync(join(dir, name), 'utf8')

test('catalog ids, numbers, codes and aliases resolve locally and zero-cost drop/add preserves original audit', async () => {
  const o = fixture(async () => { throw new Error('must not call') })
  assert.equal(resolveLocalClass('3', builtins, {}), 'injection')
  assert.equal(resolveLocalClass('OWASP A03:2021', builtins, {}), 'injection')
  assert.equal(resolveLocalClass('broken access control', builtins, {}), 'access-control')
  const snapshot = initializeClassReview(provider)
  assert.deepEqual(snapshot.agent_selection, original)
  const dropped = await runClassReview({ ...o, action: 'drop', input: '1', rawInput: ' 1 ' })
  assert.equal(dropped.ok, true)
  assert.deepEqual(dropped.selection.classes, [])
  assert.equal(dropped.review.edits[0].input, ' 1 ')
  const added = await runClassReview({ ...o, input: 'A03' })
  assert.equal(added.ok, true)
  assert.equal(added.review.edits[1].cost_usd, 0)
  assert.deepEqual(JSON.parse(read('class-selection.agent.json')), original)
  assert.equal((await runClassReview({ ...o, input: 'injection' })).changed, false)
  assert.equal(o.meter.ledger.list().length, 0)
  assert.equal(recordReviewBudget(provider, 10).budget_changes[0].budget_usd, 10)
})

test('resolve built-in uses strict union, no web, one ledger entry and actual cost', async () => {
  const o = fixture(async (body, purpose) => {
    assert.equal(purpose, 'review:resolve'); assert.equal(body.tools, undefined)
    assert.equal(body.text.format.strict, true)
    assert.equal(body.text.format.schema.properties.resolution.anyOf.length, 3)
    return response({ resolution: { kind: 'builtin', id: 'ssrf' } })
  })
  const result = await runClassReview(o)
  assert.equal(result.ok, true)
  assert.deepEqual(result.selection.classes, ['injection', 'ssrf'])
  assert.equal(o.meter.ledger.list().length, 1)
  assert.equal(result.review.edits[0].cost_usd, o.meter.ledger.total())
})

test('invalid and rejected resolutions spend once and leave selection and meta byte-identical', async () => {
  for (const value of [{ kind: 'not_a_class', why: 'Not a vulnerability class' }, { ...newClass, signals: ['unknown'] }, { kind: 'builtin', id: 'ssrf', extra: true }]) {
    const o = fixture(async () => response({ resolution: value }))
    const before = read('class-selection.json'), meta = read('meta.json')
    const result = await runClassReview(o)
    assert.equal(result.ok, false)
    assert.equal(read('class-selection.json'), before)
    assert.equal(read('meta.json'), meta)
    assert.equal(o.meter.ledger.list().length, 1)
  }
  assert.throws(() => validateResolution({ ...newClass, id: '../escape' }, builtins, signals, model))
})

test('new class research retries once automatically, books attempts and publishes valid cache and overlay', async () => {
  let research = 0, confirmations = 0
  const o = fixture(async (body, purpose) => {
    if (purpose === 'review:resolve') return response({ resolution: newClass })
    assert.equal(body.tool_choice, 'required'); assert.equal(body.max_tool_calls, 3)
    return response({ playbook: ++research === 1 ? 'bad' : good, source_urls: [] }, true)
  })
  const result = await runClassReview({ ...o, confirmCall: async () => { confirmations++; return true } })
  assert.equal(result.ok, true)
  assert.equal(confirmations, 2, 'retry is automatic')
  assert.equal(research, 2)
  assert.deepEqual(o.meter.ledger.list().map(e => [e.label, e.attempt]), [['review:resolve', 1], ['review:research:synthetic-risk', 1], ['review:research:synthetic-risk', 2]])
  assert.equal(result.review.edits[0].resolved.kind, 'researched')
  assert.equal(result.review.edits[0].cost_usd, o.meter.ledger.total())
  assert.equal(JSON.parse(read('research-failures/synthetic-risk.json')).attempt, 1)
  const overlay = read('classes-overlay.json')
  await runClassReview({ ...o, action: 'drop', input: 'synthetic-risk' })
  assert.equal(read('classes-overlay.json'), overlay, 'dictionary grows only')
  const again = await runClassReview({ ...o, input: 'synthetic risk' })
  assert.equal(again.ok, true)
  assert.equal(o.meter.ledger.list().length, 3, 'overlay re-add needs no calls')
})

test('twice-failed research preserves valid selection/meta and all attempted spend', async () => {
  const o = fixture(async (_, purpose) => purpose === 'review:resolve' ? response({ resolution: newClass }) : response({ playbook: 'bad', source_urls: [] }, true))
  const before = read('class-selection.json'), meta = read('meta.json')
  const result = await runClassReview(o)
  assert.equal(result.ok, false)
  assert.equal(read('class-selection.json'), before); assert.equal(read('meta.json'), meta)
  assert.equal(read('classes-overlay.json'), '{}')
  assert.equal(o.meter.ledger.list().length, 3)
  assert.equal(result.review.edits[0].cost_usd, o.meter.ledger.total())
  assert.equal(JSON.parse(read('research-failures/synthetic-risk.json')).attempt, 2)
})

test('transport failures book reservations once per attempt and retain research failure audit', async () => {
  const o = fixture(async (_, purpose) => {
    if (purpose === 'review:resolve') return response({ resolution: newClass })
    throw new Error('transport failed')
  })
  const result = await runClassReview(o)
  assert.equal(result.ok, false)
  assert.equal(o.meter.ledger.list().length, 3)
  assert.equal(o.meter.ledger.list()[2].basis, 'reservation')
  assert.ok(o.meter.ledger.list()[2].cost_usd! >= 0.03)
  assert.equal(JSON.parse(read('research-failures/synthetic-risk.json')).attempt, 2)
})

test('budget gate blocks before spend, including retry reservation after first failed attempt', async () => {
  let calls = 0
  const o = fixture(async (_, purpose) => {
    calls++
    return purpose === 'review:resolve' ? response({ resolution: newClass }) : response({ playbook: 'bad', source_urls: [] }, true, { usage: undefined })
  })
  assert.equal((await runClassReview({ ...o, budgetUsd: 0 })).ok, false)
  assert.equal(calls, 0); assert.equal(o.meter.ledger.list().length, 0)
  let cap = 1
  const result = await runClassReview({ ...o, get budgetUsd() { return cap }, confirmCall: async info => {
    if (info.purpose.startsWith('review:research:')) cap = o.meter.ledger.total() + info.reservation_usd
    return true
  } })
  assert.equal(result.ok, false)
  assert.match(result.message, /budget/)
  assert.equal(calls, 2)
})

test('pre-call cancellation costs zero; in-flight abort is booked once without retry or selection/meta changes', async () => {
  const controller = new AbortController()
  const o = fixture(async (_, purpose) => {
    if (purpose === 'review:resolve') return response({ resolution: newClass })
    controller.abort()
    throw new DOMException('Aborted', 'AbortError')
  })
  assert.equal((await runClassReview({ ...o, confirmCall: async () => false })).ok, false)
  assert.equal(o.meter.ledger.list().length, 0)
  const meta = read('meta.json'), before = read('class-selection.json')
  const result = await runClassReview({ ...o, signal: controller.signal })
  assert.equal(result.ok, false); assert.equal(o.meter.ledger.list().length, 2)
  assert.equal(read('meta.json'), meta); assert.equal(read('class-selection.json'), before)
})

test('local cache and resolved framework/model cache hits avoid research', async () => {
  const o = fixture(async () => response({ resolution: newClass }))
  writeCachedPlaybook(o.cacheRoot, good, { ...newClass, class_id: newClass.id, playbook: newClass.id, model,
    source_urls: [], queries: [], created_at: new Date().toISOString() })
  const result = await runClassReview({ ...o, input: 'synthetic risk' })
  assert.equal(result.ok, true); assert.equal(o.meter.ledger.list().length, 0)
  assert.equal(result.review.edits[0].resolved.kind, 'cached')
  await runClassReview({ ...o, action: 'drop', input: newClass.id })
  const resolved = await runClassReview({ ...o, input: 'unrecognized synonym' })
  assert.equal(resolved.ok, true); assert.equal(o.meter.ledger.list().length, 1)
})

test('validated write helpers never replace valid selection or overwrite existing overlay entry', () => {
  fixture(async () => { throw new Error('no call') })
  const before = read('class-selection.json')
  assert.throws(() => writeClassSelection(provider, { ...original, classes: [] }, builtins, {}))
  assert.equal(read('class-selection.json'), before)
  const entry = { playbook: newClass.id, codes: newClass.codes, signals: newClass.signals, framework: 'generic', model, sha256: 'a'.repeat(64) }
  appendOverlayEntry(provider, newClass.id, entry, builtins, signals)
  const overlay = read('classes-overlay.json')
  assert.throws(() => appendOverlayEntry(provider, newClass.id, { ...entry, codes: ['different'] }, builtins, signals))
  assert.equal(read('classes-overlay.json'), overlay)
})

test('review entrypoint rejects benchmark profile without a call or artifact change', () => {
  const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
  assert.throws(() => execFileSync(tsx, [fileURLToPath(new URL('./review.ts', import.meta.url)), '--action', 'add', '--input', 'injection'], {
    env: { ...process.env, SCANNER_PROFILE: 'benchmark' }, stdio: 'pipe',
  }), (error: any) => /only in product runs/.test(error.stderr.toString()))
})

test('no-search research responses fail twice; valid-looking text never enters overlay', async () => {
  const o = fixture(async (_, purpose) => purpose === 'review:resolve' ? response({ resolution: newClass }) : response({ playbook: good, source_urls: [] }))
  const result = await runClassReview(o)
  assert.equal(result.ok, false)
  assert.equal(o.meter.ledger.list().length, 3)
  assert.equal(JSON.parse(read('research-failures/synthetic-risk.json')).check, 'no_search')
  assert.equal(read('classes-overlay.json'), '{}')
})

test('review budget permits equality and refuses one cent below the exact reservation plus existing spend', async () => {
  const o = fixture(async () => response({ resolution: { kind: 'builtin', id: 'ssrf' } }))
  o.meter.ledger.append({ source: 'recon', stage: 'stage0-recon', label: 'existing', lane_id: null, attempt: 1,
    model, served_tier: 'default', usage: null, chars_sent: 0, cost_usd: 0.25, basis: 'reservation' })
  let reservation = 0
  await runClassReview({ ...o, confirmCall: async info => { reservation = info.reservation_usd; return false } })
  const below = await runClassReview({ ...o, budgetUsd: 0.25 + reservation - 0.001 })
  assert.equal(below.ok, false)
  assert.equal(o.meter.ledger.list().length, 1)
  const equal = await runClassReview({ ...o, budgetUsd: 0.25 + reservation })
  assert.equal(equal.ok, true)
  assert.equal(o.meter.ledger.list().length, 2)
  assert.equal(equal.review.cost_usd, o.meter.ledger.list()[1].cost_usd)
})

test('resolve failure carrying usage and unknown served tier are each booked exactly once', async () => {
  for (const unknown of [false, true]) {
    const o = fixture(async () => {
      if (unknown) return response({ resolution: { kind: 'builtin', id: 'ssrf' } }, false, { service_tier: 'unpriced-tier' })
      throw { error: { usage: { input_tokens: 100, output_tokens: 20 }, service_tier: 'default' } }
    })
    const before = read('class-selection.json'), meta = read('meta.json')
    const result = await runClassReview(o)
    assert.equal(result.ok, false)
    assert.equal(o.meter.ledger.list().length, 1)
    assert.equal(o.meter.ledger.list()[0].basis, 'actual')
    assert.equal(read('class-selection.json'), before); assert.equal(read('meta.json'), meta)
  }
})

test('a later edit replaces the same attempt number with its own transport failure', async () => {
  let controller = new AbortController(), edit = 1
  const o = fixture(async (_, purpose) => {
    if (purpose === 'review:resolve') return response({ resolution: newClass })
    controller.abort()
    throw new Error(`Transport interrupted in edit ${edit}`)
  })
  for (edit = 1; edit <= 2; edit++) {
    controller = new AbortController()
    const result = await runClassReview({ ...o, signal: controller.signal })
    assert.equal(result.ok, false)
    const failure = JSON.parse(read('research-failures/synthetic-risk.json'))
    assert.equal(failure.attempt, 1)
    assert.equal(failure.error, `Transport interrupted in edit ${edit}`)
    assert.ok(Number.isFinite(Date.parse(failure.at)))
  }
  assert.equal(o.meter.ledger.list().length, 4)
  assert.deepEqual(JSON.parse(read('class-selection.json')), original)
})
