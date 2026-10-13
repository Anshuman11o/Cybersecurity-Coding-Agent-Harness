import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import {
  runPlaybookAgent, type AgentOptions, type CoverageDecision, type DecisionChange, type ProposedClass, type SelectedBuiltin,
  type UsageCall,
} from './agent.js'
import { PlaybookMeter } from './meter.js'
import { readCachedPlaybook, cacheDirectory, textHash } from '../../shared/playbook-cache.js'
import { productDefaultProvider, webSearchUsdPerCall } from '../../shared/provider.js'
import { resolveRunContext } from '../../shared/run-context.js'

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
// The specified task strings, character for character.
const tasks = {
  coverage: "Select the built-in classes that apply to this target and decide coverage against the built-ins. Return every applicable built-in class in builtin_classes and every additional class needed for this run in classes, including applicable cached classes. Use web search when you judge the built-in classes do not cover a surface recon shows. Reuse cached identifiers.",
  turn1: "Decide which vulnerability classes this target needs. For every built-in class excluded go over the recon evidence behind it: platform, languages, frameworks, dependencies, file signals and category verdicts to reconcile your decision if applicable. Use web tool if applicable to find classes beyond built-ins if applicable. Include a class when the target has the kind of surface it covers. Exclude it only when recon shows that surface is absent, and name what shows it. If the target has a surface no built-in class covers, propose an additional class for it using web tool. Do not drop any class already selected.",
  turn2: "Reconsider every class you did not select: each excluded built-in, and any vulnerability family relevant to this platform that is not yet covered that you can use web tooling to search for. For each one, check recon's data again (platform, languages, frameworks, dependencies, file signals, category verdicts and architecture) and decide whether the target has a surface it applies to. Add it if recon supports it or does not rule it out. Do not drop any class already selected. Return the full updated decision in the same schema. If nothing is added, return the decision unchanged.",
  turn3: "Do a final check of the complete class set against recon's data. Confirm that every surface recon describes is covered by at least one selected class, and that each additional class you proposed names a distinct vulnerability family that the built-ins do not already cover. Add any class still missing whether from remaining in built-ins or from the web. Do not drop any class already selected. Return the final decision in the same schema, with a list of anything added and why.",
}
const researchTask = 'Research this missing class using web_search and produce one generic playbook, using the built-in format. Cite the sources used.'
const loopPurposes = ['coverage', 'turn1', 'turn2:pass1', 'turn3']

interface Search { query: string; url: string }
function response(value: unknown, search: boolean | Search[] = false): Response {
  const searches = search === true ? [{ query: 'worker epoch security', url: source }] : search || []
  return {
    id: 'mock-response', model: 'test-model', status: 'completed', output_text: JSON.stringify(value),
    output: searches.map(s => ({ type: 'web_search_call', status: 'completed', action: { type: 'search', queries: [s.query], sources: [{ type: 'url', url: s.url }] } })),
    usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 15 } },
  } as unknown as Response
}
const decision = (reason: string, builtin_classes: SelectedBuiltin[] = [], classes: ProposedClass[] = []): CoverageDecision =>
  ({ reason, builtin_classes, classes })
const pick = (id: string): SelectedBuiltin => ({ id, reason: `Selected ${id}.` })
// A review turn's reply carries the turn-only `changes` list.
const turn = (d: CoverageDecision, changes: DecisionChange[] = [], search: Search[] = []) => response({ ...d, changes }, search)
// Under the default loop a decision no turn extends takes four calls: coverage, turn1, turn2:pass1, turn3.
const unchanged = (d: CoverageDecision) => [response(d), turn(d), turn(d), turn(d)]
const research = () => response({ playbook: generated, source_urls: [source] }, true)

function harness(t: { after: (fn: () => void) => void }, fixture: string, replies: Response[]) {
  const root = mkdtempSync(join(tmpdir(), 'playbook-agent-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const requests: ResponseCreateParamsNonStreaming[] = [], purposes: string[] = [], usage: UsageCall[] = []
  const options: AgentOptions = {
    recon: JSON.parse(readFileSync(new URL(`./fixtures/${fixture}.json`, import.meta.url), 'utf8')),
    builtins, builtinTexts: texts, signals, model: 'test-model', cacheRoot: root, maxOutputTokens: 8000,
    sampling: { reasoning_effort: 'high' },
    create: async (r, purpose) => {
      requests.push(r); purposes.push(purpose)
      assert.ok(replies.length, 'unexpected model/web call')
      return replies.shift()!
    },
    recordUsage: r => usage.push(r),
  }
  const request = (purpose: string) => requests[purposes.indexOf(purpose)]
  const input = (purpose: string) => JSON.parse(request(purpose).input as string)
  return { options, requests, purposes, usage, replies, root, request, input }
}

test('covered recon: decision calls only, reason and all 14 built-ins recorded', async t => {
  const h = harness(t, 'covered', unchanged(decision('All detected surfaces have built-in guidance.')))
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.deepEqual(overlay, {})
  assert.equal(plan.searched, false)
  assert.match(plan.reason, /All detected/)
  assert.deepEqual(h.purposes, loopPurposes)
  for (const r of h.requests) {
    assert.equal(r.text?.format?.type, 'json_schema')
    assert.equal(r.reasoning?.effort, 'high')
  }
  assert.equal(plan.playbooks.length, 14)
  for (const record of plan.playbooks) {
    assert.equal(record.kind, 'builtin')
    assert.equal(record.sha256, textHash(texts.get(builtins[record.class_id].playbook)!))
    assert.match(record.source_file!, /playbooks\/.+\.ts$/)
    assert.deepEqual(record.source_urls, []) // Built-ins have local source, no invented web URLs.
  }
  const input = h.input('coverage')
  assert.equal(input.signal_counts.db_query, 1)
  assert.equal(input.recon.dependency_manifests, 'package.json: express, pg')
})

test('uncovered recon: research, full usage, plain text cache and subsequent reuse without research', async t => {
  const d = decision('Worker protocol needs additional guidance.', [], [proposed])
  const h = harness(t, 'uncovered', [...unchanged(d), research()])
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.equal(plan.searched, true)
  assert.equal(plan.classes[0].cache, 'created')
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`])
  assert.deepEqual(h.request(`research:${proposed.id}`).tools, [{ type: 'web_search' }]) // Empty default: unrestricted search.
  assert.equal(h.request(`research:${proposed.id}`).tool_choice, 'required')
  assert.equal(h.usage.length, 5)
  assert.deepEqual(h.usage.map(u => u.purpose), h.purposes)
  assert.deepEqual(h.usage[4].queries, ['worker epoch security'])
  assert.deepEqual(h.usage[4].usage, {
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
  h.replies.push(...unchanged(d))
  const reused = await runPlaybookAgent(h.options)
  assert.equal(h.requests.length, 9, 'second run makes the decision calls, no research call')
  assert.equal(reused.plan.searched, false)
  assert.equal(reused.plan.classes[0].cache, 'hit')
  assert.deepEqual(reused.overlay, overlay)
  assert.deepEqual(reused.plan.playbooks, plan.playbooks)
})

test('configured domains use Responses filters.allowed_domains on decision and research calls', async t => {
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])), research()])
  h.options.allowedDomains = ['example.test']
  await runPlaybookAgent(h.options)
  assert.equal(h.requests.length, 5)
  for (const r of h.requests) assert.deepEqual(r.tools, [{ type: 'web_search', filters: { allowed_domains: ['example.test'] } }])
})

test('research cannot claim source URLs absent from returned search evidence', async t => {
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])),
    response({ playbook: generated, source_urls: ['https://example.test/not-retrieved'] }, true)])
  await assert.rejects(runPlaybookAgent(h.options), /absent from the search sources/)
  assert.equal(h.usage.length, 5)
  assert.equal(readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model'), null)
})

test('cache hash mismatch is a failure, never used as guidance', async t => {
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])), research()])
  await runPlaybookAgent(h.options)
  writeFileSync(join(cacheDirectory(h.root, proposed.id, proposed.framework, 'test-model'), 'playbook.md'), 'tampered')
  await assert.rejects(runPlaybookAgent(h.options), /sha256 mismatch/)
  assert.equal(h.requests.length, 5, 'corrupt entries fail before any model request')
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

test('every review turn is validated like the initial decision, before the union and any research', async t => {
  const d = decision('Uncovered.', [], [proposed])
  for (const [bad, error] of [
    [{ ...d, builtin_classes: [{ id: 'not-a-builtin', reason: 'Invented.' }], changes: [] }, /selected built-in/],
    [{ ...d, builtin_classes: [pick('injection'), pick('injection')], changes: [] }, /selected built-in/],
    [{ ...d, classes: [proposed, proposed], changes: [] }, /duplicate proposed/],
    [{ ...d, classes: [{ ...proposed, id: 'injection' }], changes: [] }, /built-in class/],
    [{ ...d, classes: [{ ...proposed, signals: ['invented_signal'] }], changes: [] }, /signals/],
    [{ ...d, reason: ' ', changes: [] }, /Invalid turn1 decision/],
    [d, /Invalid turn1 changes/],
  ] as [unknown, RegExp][]) {
    const h = harness(t, 'uncovered', [response(d), response(bad)])
    await assert.rejects(runPlaybookAgent(h.options), error)
    assert.deepEqual(h.purposes, ['coverage', 'turn1'])
    assert.equal(readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model'), null)
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

test('decision schemas: built-in ids as an enum; review turns add a required changes list', async t => {
  const h = harness(t, 'covered', unchanged(decision('Covered.')))
  const { plan, selection } = await runPlaybookAgent(h.options)
  const schema = (h.request('coverage').text?.format as { schema: any }).schema
  assert.deepEqual(Object.keys(schema.properties), ['reason', 'builtin_classes', 'classes'])
  assert.deepEqual(schema.required, ['reason', 'builtin_classes', 'classes'])
  const item = schema.properties.builtin_classes.items
  assert.deepEqual(item.properties.id.enum, Object.keys(builtins))
  assert.deepEqual(item.required, ['id', 'reason'])
  assert.equal(item.additionalProperties, false)
  for (const purpose of loopPurposes.slice(1)) {
    const turnSchema = (h.request(purpose).text?.format as { schema: any }).schema
    assert.deepEqual(turnSchema.required, ['reason', 'builtin_classes', 'classes', 'changes'])
    const { changes, ...rest } = turnSchema.properties
    assert.deepEqual(rest, schema.properties, 'the existing decision schema plus changes')
    assert.deepEqual(changes.items, {
      type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'],
    })
  }
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
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', builtin_classes, [proposed])), research()])
  const { plan, overlay, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.builtin_classes, builtin_classes)
  assert.deepEqual(plan.selected_classes, ['access-control', 'injection', proposed.id])
  assert.equal(selection.schema, 'secscan.class-selection/1')
  assert.equal(selection.model, 'test-model')
  assert.deepEqual(selection.builtin, ['access-control', 'injection'])
  assert.deepEqual(selection.added, Object.keys(overlay))
  assert.deepEqual(selection.classes, plan.selected_classes)
})

test('decision calls offer web_search with tool_choice auto and sources; research calls are unchanged', async t => {
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])), research()])
  await runPlaybookAgent(h.options)
  for (const purpose of loopPurposes) {
    const r = h.request(purpose)
    assert.deepEqual(r.tools, [{ type: 'web_search' }])
    assert.equal(r.tool_choice, 'auto')
    assert.deepEqual(r.include, ['web_search_call.action.sources'])
    assert.equal((r.text?.format as any).name, 'coverage_decision')
    assert.equal((r.text?.format as any).strict, true)
  }
  const r = h.request(`research:${proposed.id}`)
  assert.deepEqual(r.tools, [{ type: 'web_search' }])
  assert.equal(r.tool_choice, 'required')
  assert.deepEqual(r.include, ['web_search_call.action.sources'])
  assert.equal((r.text?.format as any).name, 'playbook')
  assert.deepEqual(Object.keys((r.text?.format as any).schema.properties), ['playbook', 'source_urls'])
  assert.deepEqual(Object.keys(h.input(`research:${proposed.id}`)), ['task', 'class', 'stack', 'example_format'])
  assert.equal(h.input(`research:${proposed.id}`).task, researchTask)
})

test('decision tasks are the specified strings, and every decision input starts with the same base prefix', async t => {
  const h = harness(t, 'covered', unchanged(decision('Covered.')))
  await runPlaybookAgent(h.options)
  const inputs = h.requests.map(r => r.input as string)
  assert.deepEqual(inputs.map(i => JSON.parse(i).task), [tasks.coverage, tasks.turn1, tasks.turn2, tasks.turn3])
  const { task, ...base } = JSON.parse(inputs[0])
  assert.deepEqual(Object.keys(base), ['recon', 'signal_counts', 'signal_classes', 'builtins', 'cached_classes'])
  assert.equal(base.builtins.length, 14)
  const prefix = JSON.stringify(base).slice(0, -1) + ',"task":'
  for (const i of inputs) assert.ok(i.startsWith(prefix), 'decision input must start with the shared base')
  for (const i of inputs.slice(1)) {
    assert.deepEqual(Object.keys(JSON.parse(i)), [...Object.keys(base), 'task', 'current_decision', 'searches_so_far'])
  }
})

test('review turns receive the union decision so far and the searches of all earlier decision calls', async t => {
  const s1 = { query: 'graphql security', url: 'https://example.test/graphql' }
  const s2 = { query: 'websocket security', url: 'https://example.test/ws' }
  const first = decision('Initial.', [pick('access-control')])
  const second = decision('Turn one.', [pick('access-control'), pick('injection')])
  const h = harness(t, 'covered', [response(first, [s1]), turn(second, [{ id: 'injection', why: 'Queries.' }], [s2]), turn(second), turn(second)])
  const { plan } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.input('turn1').current_decision, first)
  assert.deepEqual(h.input('turn1').searches_so_far, { queries: [s1.query], source_urls: [s1.url] })
  assert.deepEqual(h.input('turn2:pass1').current_decision, second)
  assert.deepEqual(h.input('turn2:pass1').searches_so_far, { queries: [s1.query, s2.query], source_urls: [s1.url, s2.url] })
  assert.deepEqual(h.input('turn3').searches_so_far, h.input('turn2:pass1').searches_so_far)
  assert.equal(plan.searched, true, 'a search in a decision call counts')
  assert.deepEqual(plan.turns[0], {
    purpose: 'turn1', added: ['injection'], restored: [], changes: [{ id: 'injection', why: 'Queries.' }],
    web_search_calls: 1, queries: [s2.query], source_urls: [s2.url],
  })
  assert.deepEqual(plan.turns.slice(1).map(x => x.web_search_calls), [0, 0])
})

test('loop order: coverage, turn1, turn2 passes, turn3; turn2 stops on the first pass that adds nothing', async t => {
  const start = decision('Start.', [pick('access-control')])
  const grown = decision('Grown.', [pick('access-control'), pick('injection')])
  const h = harness(t, 'covered', [response(start), turn(start), turn(grown), turn(grown), turn(decision('Final.', grown.builtin_classes))])
  const { plan, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, ['coverage', 'turn1', 'turn2:pass1', 'turn2:pass2', 'turn3'])
  assert.deepEqual(plan.loop, { enabled: true, max_passes: 3, passes_run: 2 })
  assert.deepEqual(plan.turns.map(x => [x.purpose, x.added]),
    [['turn1', []], ['turn2:pass1', ['injection']], ['turn2:pass2', []], ['turn3', []]])
  assert.equal(plan.reason, 'Final.')
  assert.equal(plan.decision.reason, 'Final.')
  assert.deepEqual(selection.builtin, ['access-control', 'injection'])
})

test('turn2 stops at max_passes when every pass adds', async t => {
  for (const maxPasses of [undefined, 2]) {
    const n = maxPasses ?? 3, ids = Object.keys(builtins).slice(0, n)
    const passes = ids.map((_, k) => turn(decision(`Pass ${k + 1}.`, ids.slice(0, k + 1).map(pick))))
    const h = harness(t, 'covered', [response(decision('Start.')), turn(decision('Turn one.')), ...passes, turn(decision('Final.'))])
    if (maxPasses) h.options.loop = { enabled: true, maxPasses }
    const { plan, selection } = await runPlaybookAgent(h.options)
    assert.deepEqual(h.purposes, ['coverage', 'turn1', ...ids.map((_, k) => `turn2:pass${k + 1}`), 'turn3'])
    assert.deepEqual(plan.loop, { enabled: true, max_passes: n, passes_run: n })
    assert.deepEqual(plan.turns.slice(1, -1).map(x => x.added), ids.map(id => [id]))
    assert.deepEqual(selection.builtin, [...ids].sort())
  }
})

test('a turn that omits a selected class cannot drop it: restored, recorded, and still in the class selection', async t => {
  const start = decision('Start.', [pick('injection'), pick('access-control')], [proposed])
  const narrowed = decision('Narrowed.', [{ id: 'injection', reason: 'A later, different reason.' }])
  const h = harness(t, 'uncovered', [response(start), turn(narrowed), turn(narrowed), turn(decision('Final.', narrowed.builtin_classes)), research()])
  const { plan, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.turns.map(x => x.restored), Array(3).fill(['access-control', proposed.id]))
  assert.deepEqual(plan.turns.map(x => x.added), [[], [], []])
  assert.deepEqual(plan.decision.builtin_classes, start.builtin_classes, 'the first reason for an id is kept')
  assert.deepEqual(plan.decision.classes, [proposed])
  assert.equal(plan.reason, 'Final.')
  assert.deepEqual(selection.classes, ['access-control', 'injection', proposed.id])
  assert.deepEqual(selection.added, [proposed.id])
})

test('a turn cannot redefine an existing additional class', async t => {
  const redefined = { ...proposed, framework: 'other-queue', codes: ['CWE-400'], signals: ['http_outbound'], reason: 'Redefined.' }
  const start = decision('Start.', [], [proposed])
  // Later turns omit the class, so only the union can bring back the first definition.
  const h = harness(t, 'uncovered', [response(start), turn(decision('Turn one.', [], [redefined])),
    turn(decision('Pass one.')), turn(decision('Final.')), research()])
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.turns.map(x => x.added), [[], [], []])
  assert.deepEqual(plan.turns.map(x => x.restored), [[], [proposed.id], [proposed.id]])
  assert.deepEqual(plan.decision.classes, [proposed])
  assert.deepEqual(h.input(`research:${proposed.id}`).class, proposed)
  assert.deepEqual(overlay[proposed.id].codes, proposed.codes)
  assert.deepEqual(overlay[proposed.id].signals, proposed.signals)
  assert.equal(overlay[proposed.id].framework, proposed.framework)
})

test('a class first proposed in a turn is researched when uncached, using its final definition', async t => {
  const start = decision('Start.', [pick('injection')])
  const added = decision('Added.', start.builtin_classes, [proposed])
  const h = harness(t, 'uncovered', [response(start), turn(added, [{ id: proposed.id, why: 'Replay boundary.' }]), turn(added),
    turn(decision('Final.', [], [{ ...proposed, codes: ['CWE-400'], signals: ['http_outbound'] }])), research()])
  const { plan, overlay, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`])
  assert.deepEqual(plan.turns[0].added, [proposed.id])
  assert.deepEqual(plan.turns[0].changes, [{ id: proposed.id, why: 'Replay boundary.' }])
  assert.deepEqual(plan.turns.at(-1)!.restored, ['injection'])
  assert.deepEqual(plan.decision.classes, [proposed])
  assert.deepEqual(h.input(`research:${proposed.id}`).class, proposed)
  assert.equal(plan.classes[0].cache, 'created')
  assert.deepEqual(overlay[proposed.id].codes, proposed.codes)
  assert.deepEqual(selection.classes, ['injection', proposed.id])
})

test('loop.enabled false makes exactly one decision call, with web search still available', async t => {
  const h = harness(t, 'covered', [response(decision('Covered.'), [{ query: 'graphql security', url: source }])])
  h.options.loop = { enabled: false, maxPasses: 3 }
  const { plan } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, ['coverage'])
  assert.equal(h.requests[0].tool_choice, 'auto')
  assert.deepEqual(plan.turns, [])
  assert.deepEqual(plan.loop, { enabled: false, max_passes: 3, passes_run: 0 })
  assert.equal(plan.searched, true)
})

test('ledger labels are the call purposes, and searches in decision calls are priced', async t => {
  const target = mkdtempSync(join(tmpdir(), 'playbook-agent-ledger-'))
  t.after(() => rmSync(target, { recursive: true, force: true }))
  const provider = productDefaultProvider()
  const ctx = resolveRunContext({ SCANNER_TARGET: target, SCANNER_PROFILE: 'product', SCANNER_RUN_ID: 'test' }, [])
  const d = decision('Uncovered.', [], [proposed])
  const searches = [{ query: 'a', url: 'https://example.test/a' }, { query: 'b', url: 'https://example.test/b' }]
  const h = harness(t, 'uncovered', [response(d, searches), turn(d), turn(d), turn(d), research()])
  const meter = new PlaybookMeter(provider, ctx, null, 'flex', h.options.create)
  h.options.create = (request, purpose) => meter.call(request, purpose)
  await runPlaybookAgent(h.options)
  const entries = meter.ledger.list()
  assert.deepEqual(entries.map(e => e.label), [...loopPurposes, `research:${proposed.id}`])
  assert.deepEqual(h.purposes, entries.map(e => e.label), 'the meter passes the purpose through')
  const rate = webSearchUsdPerCall(provider)!
  assert.ok(rate > 0)
  // Every reply has the same usage, so a call's cost differs from a search-free turn's only by its searches.
  assert.ok(Math.abs(entries[0].cost_usd! - entries[1].cost_usd! - 2 * rate) < 1e-12, 'coverage call: two searches priced')
  assert.ok(Math.abs(entries[4].cost_usd! - entries[1].cost_usd! - rate) < 1e-12, 'research call: one search priced')
})
