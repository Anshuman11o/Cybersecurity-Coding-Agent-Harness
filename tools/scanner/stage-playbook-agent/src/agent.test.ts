import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { runPlaybookAgent, type AgentOptions, type ProposedClass, type UsageCall } from './agent.js'
import { readCachedPlaybook, cacheDirectory, textHash } from '../../shared/playbook-cache.js'

const builtins = JSON.parse(readFileSync(new URL('../../shared/vuln-classes.json', import.meta.url), 'utf8'))
const signals = JSON.parse(readFileSync(new URL('../../shared/signal-classes.json', import.meta.url), 'utf8'))
const texts = new Map<string, string>()
for (const entry of Object.values(builtins) as { playbook: string }[]) {
  const mod = await import(`../../stage2-hunt-lanes-perfile/src/playbooks/${entry.playbook}.js`)
  texts.set(entry.playbook, mod.playbook)
}
const proposed: ProposedClass = {
  id: 'worker-epoch-confusion', framework: 'example-queue', codes: ['CWE-362'],
  signals: ['deserialize', 'model_write'], reason: 'A protocol-specific replay boundary is not covered by the built-ins.',
}
const generated = texts.get('access-control')!.replace('Playbook for Access Control', 'Playbook for Worker Epoch Confusion')
const source = 'https://example.test/worker-security'

function response(value: unknown, search = false): Response {
  return {
    id: 'mock-response', model: 'test-model', status: 'completed', output_text: JSON.stringify(value),
    output: search ? [{ type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['worker epoch security'], sources: [{ type: 'url', url: source }] } }] : [],
    usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 15 } },
  } as unknown as Response
}

function harness(t: { after: (fn: () => void) => void }, fixture: string, replies: Response[]) {
  const root = mkdtempSync(join(tmpdir(), 'playbook-agent-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const requests: ResponseCreateParamsNonStreaming[] = [], usage: UsageCall[] = []
  const options: AgentOptions = {
    recon: JSON.parse(readFileSync(new URL(`./fixtures/${fixture}.json`, import.meta.url), 'utf8')),
    builtins, builtinTexts: texts, signals, model: 'test-model', cacheRoot: root, maxOutputTokens: 8000,
    sampling: { reasoning_effort: 'high' },
    create: async r => { requests.push(r); assert.ok(replies.length, 'unexpected model/web call'); return replies.shift()! },
    recordUsage: r => usage.push(r),
  }
  return { options, requests, usage, replies, root }
}

test('covered recon: structured coverage call only, reason and all 14 built-ins recorded', async t => {
  const h = harness(t, 'covered', [response({ reason: 'All detected surfaces have built-in guidance.', builtin_classes: [], classes: [] })])
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.deepEqual(overlay, {})
  assert.equal(plan.searched, false)
  assert.match(plan.reason, /All detected/)
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.requests[0].tools, [])
  assert.equal(h.requests[0].tool_choice, 'none')
  assert.equal(h.requests[0].text?.format?.type, 'json_schema')
  assert.equal(h.requests[0].reasoning?.effort, 'high')
  assert.equal(plan.playbooks.length, 14)
  for (const record of plan.playbooks) {
    assert.equal(record.kind, 'builtin')
    assert.equal(record.sha256, textHash(texts.get(builtins[record.class_id].playbook)!))
    assert.match(record.source_file!, /playbooks\/.+\.ts$/)
    assert.deepEqual(record.source_urls, []) // Built-ins have local source, no invented web URLs.
  }
  const input = JSON.parse(h.requests[0].input as string)
  assert.equal(input.signal_counts.db_query, 1)
  assert.equal(input.recon.dependency_manifests, 'package.json: express, pg')
})

test('uncovered recon: research, full usage, plain text cache and subsequent reuse without web', async t => {
  const decision = response({ reason: 'Worker protocol needs additional guidance.', builtin_classes: [], classes: [proposed] })
  const h = harness(t, 'uncovered', [decision, response({ playbook: generated, source_urls: [source] }, true)])
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.equal(plan.searched, true)
  assert.equal(plan.classes[0].cache, 'created')
  assert.deepEqual(h.requests[1].tools, [{ type: 'web_search' }]) // Empty default: unrestricted search.
  assert.equal(h.requests[1].tool_choice, 'required')
  assert.equal(h.usage.length, 2)
  assert.deepEqual(h.usage[1].queries, ['worker epoch security'])
  assert.deepEqual(h.usage[1].usage, {
    input_tokens: 120, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    output_tokens: 50, output_tokens_details: { reasoning_tokens: 15 },
  })
  const cached = readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!
  assert.equal(cached.text, generated)
  assert.equal(cached.meta.sha256, textHash(generated))
  assert.deepEqual(cached.meta.source_urls, [source])
  assert.deepEqual(cached.meta.queries, ['worker epoch security'])
  assert.ok(Number.isFinite(Date.parse(cached.meta.created_at)))
  assert.equal(plan.playbooks.at(-1)!.sha256, overlay[proposed.id].sha256)
  assert.deepEqual(plan.playbooks.at(-1)!.source_urls, [source])
  h.replies.push(decision)
  const reused = await runPlaybookAgent(h.options)
  assert.equal(h.requests.length, 3, 'second run makes a coverage call, no search call')
  assert.equal(reused.plan.searched, false)
  assert.equal(reused.plan.classes[0].cache, 'hit')
  assert.deepEqual(reused.overlay, overlay)
  assert.deepEqual(reused.plan.playbooks, plan.playbooks)
})

test('configured domains use Responses filters.allowed_domains', async t => {
  const h = harness(t, 'uncovered', [response({ reason: 'Uncovered.', builtin_classes: [], classes: [proposed] }), response({ playbook: generated, source_urls: [source] }, true)])
  h.options.allowedDomains = ['example.test']
  await runPlaybookAgent(h.options)
  assert.deepEqual(h.requests[1].tools, [{ type: 'web_search', filters: { allowed_domains: ['example.test'] } }])
})

test('research cannot claim source URLs absent from returned search evidence', async t => {
  const h = harness(t, 'uncovered', [response({ reason: 'Uncovered.', builtin_classes: [], classes: [proposed] }),
    response({ playbook: generated, source_urls: ['https://example.test/not-retrieved'] }, true)])
  await assert.rejects(runPlaybookAgent(h.options), /absent from the search sources/)
  assert.equal(h.usage.length, 2)
  assert.equal(readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model'), null)
})

test('cache hash mismatch is a failure, never used as guidance', async t => {
  const h = harness(t, 'uncovered', [response({ reason: 'Uncovered.', builtin_classes: [], classes: [proposed] }), response({ playbook: generated, source_urls: [source] }, true)])
  await runPlaybookAgent(h.options)
  writeFileSync(join(cacheDirectory(h.root, proposed.id, proposed.framework, 'test-model'), 'playbook.md'), 'tampered')
  await assert.rejects(runPlaybookAgent(h.options), /sha256 mismatch/)
  assert.equal(h.requests.length, 2, 'corrupt entries fail before any model request')
})

test('invalid additions fail before search: built-ins, traversal, unknown signals, duplicate classes', async t => {
  for (const classes of [
    [{ ...proposed, id: 'injection' }], [{ ...proposed, id: '../escape' }],
    [{ ...proposed, signals: ['invented_signal'] }], [proposed, proposed],
  ]) {
    const h = harness(t, 'uncovered', [response({ reason: 'Uncovered.', builtin_classes: [], classes })])
    await assert.rejects(runPlaybookAgent(h.options), /built-in class|class id|signals|duplicate proposed/)
    assert.equal(h.requests.length, 1)
  }
})

test('incomplete and malformed responses retain usage and never publish a playbook', async t => {
  for (const bad of [
    { ...response({}), status: 'incomplete' },
    { ...response({}), output_text: 'not json' },
  ]) {
    const h = harness(t, 'covered', [bad as Response])
    await assert.rejects(runPlaybookAgent(h.options))
    assert.equal(h.usage.length, 1)
    assert.equal(h.usage[0].usage!.output_tokens, 50)
  }
})

test('a failed request is recorded with unknown usage; no hidden retry', async t => {
  const h = harness(t, 'covered', [])
  h.options.create = async () => { throw new Error('mock network failure') }
  await assert.rejects(runPlaybookAgent(h.options), /mock network/)
  assert.equal(h.usage.length, 1)
  assert.equal(h.usage[0].status, 'request_failed')
  assert.equal(h.usage[0].usage, null)
})

test('coverage request asks for built-in selection with the built-in ids as an enum', async t => {
  const h = harness(t, 'covered', [response({ reason: 'Covered.', builtin_classes: [], classes: [] })])
  const { plan, selection } = await runPlaybookAgent(h.options)
  const schema = (h.requests[0].text?.format as { schema: any }).schema
  assert.deepEqual(Object.keys(schema.properties), ['reason', 'builtin_classes', 'classes'])
  assert.deepEqual(schema.required, ['reason', 'builtin_classes', 'classes'])
  const item = schema.properties.builtin_classes.items
  assert.deepEqual(item.properties.id.enum, Object.keys(builtins))
  assert.deepEqual(item.required, ['id', 'reason'])
  assert.equal(item.additionalProperties, false)
  assert.match(JSON.parse(h.requests[0].input as string).task, /^Select the built-in classes that apply/)
  // An empty selection is valid: the run hunts nothing.
  assert.deepEqual(plan.selected_classes, [])
  assert.deepEqual(selection.classes, [])
})

test('unknown, duplicate or unexplained built-in selections fail before any search', async t => {
  for (const builtin_classes of [
    [{ id: 'not-a-builtin', reason: 'Invented.' }],
    [{ id: 'injection', reason: 'Queries.' }, { id: 'injection', reason: 'Again.' }],
    [{ id: 'injection', reason: ' ' }],
  ]) {
    const h = harness(t, 'uncovered', [response({ reason: 'Uncovered.', builtin_classes, classes: [proposed] })])
    await assert.rejects(runPlaybookAgent(h.options), /selected built-in/)
    assert.equal(h.requests.length, 1, 'no research call after an invalid selection')
    assert.equal(readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model'), null)
  }
})

test('selected_classes and the class selection hold the sorted union of built-ins and additions', async t => {
  const builtin_classes = [{ id: 'injection', reason: 'Queries.' }, { id: 'access-control', reason: 'Routes.' }]
  const h = harness(t, 'uncovered', [response({ reason: 'Uncovered.', builtin_classes, classes: [proposed] }),
    response({ playbook: generated, source_urls: [source] }, true)])
  const { plan, overlay, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.builtin_classes, builtin_classes)
  assert.deepEqual(plan.selected_classes, ['access-control', 'injection', proposed.id])
  assert.equal(selection.schema, 'secscan.class-selection/1')
  assert.equal(selection.model, 'test-model')
  assert.deepEqual(selection.builtin, ['access-control', 'injection'])
  assert.deepEqual(selection.added, Object.keys(overlay))
  assert.deepEqual(selection.classes, plan.selected_classes)
})
