import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import {
  playbookProblems, runPlaybookAgent, validatePlaybook, type AgentOptions, type ClassDecision, type CoverageDecision,
  type DecisionChange, type Likelihood, type ProposedClass, type ResearchFailure, type SelectedBuiltin, type UsageCall,
} from './agent.js'
import { PlaybookMeter } from './meter.js'
import { readCachedPlaybook, cacheDirectory, textHash, addOverlayPlaybookSizes } from '../../shared/playbook-cache.js'
import { validateOverlay, type ClassesOverlay } from '../../shared/playbook-overlay.js'
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
  turn2: "Reconsider every class you did not select: each excluded built-in, and any vulnerability family relevant to this platform that is not yet covered that you can use web tooling to search for. For each one, check recon's data again (platform, languages, frameworks, dependencies, file signals, category verdicts and architecture) and decide whether the target has a surface it applies to. Add it only if recon shows the target has that surface, and name the recon evidence in changes. Do not add a class only because recon does not rule it out. Do not drop any class already selected. Return the full updated decision in the same schema. If nothing is added, return the decision unchanged.",
  turn3: "Re-think the class selection using turn2_review (turn2's reasoning and the recon evidence it named for each class it added), the current class list and recon's data. For every class you return, set likelihood: how likely it is that this target contains an exploitable vulnerability of that class, judged only from recon's evidence. Use high when recon shows a concrete sink, risky pattern, unsafe configuration or missing control that the class hunts for; medium when recon shows the surface and a plausible attacker-reachable path to such a weakness; low when recon shows only that the feature, technology or dependency exists. Return every currently selected class with its likelihood; classes rated low are removed. Include a class not selected only when recon shows such evidence, and list it in changes with the evidence and why. Return the final decision in the same schema.",
}
const researchTask = 'Research this missing class using web_search and produce one generic playbook, using the built-in format. Cite the sources used. Keep the playbook under 8000 bytes.'
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
// turn3's reply also rates every class it returns: high unless `rates` names the id.
const rethought = (d: CoverageDecision, changes: DecisionChange[] = [], rates: Record<string, Likelihood> = {}) => {
  const rate = <T extends { id: string }>(c: T) => ({ ...c, likelihood: rates[c.id] ?? 'high' })
  return turn({ ...d, builtin_classes: d.builtin_classes.map(rate), classes: d.classes.map(rate) }, changes)
}
// Under the default loop a decision no turn extends takes four calls: coverage, turn1, turn2:pass1, turn3.
const unchanged = (d: CoverageDecision) => [response(d), turn(d), turn(d), rethought(d)]
const research = () => response({ playbook: generated, source_urls: [source] }, true)

function harness(t: { after: (fn: () => void) => void }, fixture: string, replies: Response[]) {
  const root = mkdtempSync(join(tmpdir(), 'playbook-agent-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const requests: ResponseCreateParamsNonStreaming[] = [], purposes: string[] = [], usage: UsageCall[] = []
  // Each decision is kept with the number of requests made when it was recorded.
  const decisions: { decision: ClassDecision; after: number }[] = [], failures: ResearchFailure[] = [], logs: string[] = []
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
    recordDecision: decision => decisions.push({ decision, after: requests.length }),
    recordResearchFailure: f => failures.push(f),
    log: line => logs.push(line),
  }
  const request = (purpose: string) => requests[purposes.indexOf(purpose)]
  const input = (purpose: string) => JSON.parse(request(purpose).input as string)
  return { options, requests, purposes, usage, replies, root, request, input, decisions, failures, logs }
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
  assert.deepEqual(cached.meta.verified_source_urls, [source])
  assert.deepEqual(cached.meta.unverified_source_urls, [])
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

test('cited URLs absent from the search sources complete the run, kept in order and labelled unverified', async t => {
  const absent = ['https://example.test/not-retrieved', 'https://example.test/also-not-retrieved']
  const cited = [absent[0], source, absent[1]]
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])),
    response({ playbook: generated, source_urls: cited }, true)])
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.failures, [])
  assert.equal(plan.classes[0].cache, 'created')
  const { meta } = readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!
  assert.deepEqual(meta.source_urls, cited)
  assert.deepEqual(meta.verified_source_urls, [source])
  assert.deepEqual(meta.unverified_source_urls, absent)
  const onDisk = JSON.parse(readFileSync(join(cacheDirectory(h.root, proposed.id, proposed.framework, 'test-model'), 'meta.json'), 'utf8'))
  assert.deepEqual([onDisk.source_urls, onDisk.verified_source_urls, onDisk.unverified_source_urls], [cited, [source], absent])
  const record = plan.playbooks.at(-1)!
  assert.equal(record.sha256, overlay[proposed.id].sha256)
  assert.deepEqual([record.source_urls, record.verified_source_urls, record.unverified_source_urls], [cited, [source], absent])
  assert.match(h.logs.at(-1)!, / bytes=\d+ unverified=2$/)
})

test('a research output citing no URLs completes and is cached with empty source lists', async t => {
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])), response({ playbook: generated, source_urls: [] }, true)])
  const { plan } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.failures, [])
  const { meta } = readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!
  assert.deepEqual([meta.source_urls, meta.verified_source_urls, meta.unverified_source_urls], [[], [], []])
  const record = plan.playbooks.at(-1)!
  assert.deepEqual([record.source_urls, record.verified_source_urls, record.unverified_source_urls], [[], [], []])
  assert.match(h.logs.at(-1)!, / unverified=0$/)
})

test('a malformed cited URL completes and is listed as unverified, even when it appears among the search sources', async t => {
  const ftp = 'ftp://example.test/x'
  const cited = ['not a url', ftp, source, '']
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])),
    response({ playbook: generated, source_urls: cited }, [{ query: 'worker epoch security', url: source }, { query: 'ftp', url: ftp }])])
  const { plan } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.failures, [])
  const { meta } = readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!
  assert.deepEqual(meta.source_urls, cited)
  assert.deepEqual(meta.verified_source_urls, [source])
  assert.deepEqual(meta.unverified_source_urls, ['not a url', ftp, ''])
  assert.deepEqual(plan.playbooks.at(-1)!.unverified_source_urls, ['not a url', ftp, ''])
  assert.match(h.logs.at(-1)!, / unverified=3$/)
})

test('a cache entry written before URL labelling still loads, is reused and sized, and gains no invented labels', async t => {
  const h = harness(t, 'uncovered', unchanged(decision('Uncovered.', [], [proposed])))
  const dir = cacheDirectory(h.root, proposed.id, proposed.framework, 'test-model')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'playbook.md'), generated)
  // The exact key set the cache wrote before this change.
  const legacy = { playbook: proposed.id, codes: proposed.codes, signals: proposed.signals, framework: proposed.framework,
    model: 'test-model', sha256: textHash(generated), class_id: proposed.id, source_urls: [source],
    queries: ['worker epoch security'], created_at: '2026-01-01T00:00:00.000Z' }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(legacy, null, 2) + '\n')
  assert.deepEqual(readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!.meta, legacy)
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.equal(h.requests.length, 4, 'a cache hit: no research call')
  assert.equal(plan.classes[0].cache, 'hit')
  const record = plan.playbooks.at(-1)!
  assert.deepEqual(record.source_urls, [source])
  assert.ok(!('verified_source_urls' in record) && !('unverified_source_urls' in record))
  // Stage 1's hook loads the same entry.
  const registry = { ...builtins }, sizes = new Map<string, number>()
  addOverlayPlaybookSizes(registry, sizes, overlay, signals, h.root)
  assert.equal(sizes.get(proposed.id), generated.length)
  // The source lists must still be arrays of strings when present.
  for (const bad of [{ source_urls: 'https://example.test/' }, { source_urls: [42] }, { verified_source_urls: 'x' },
    { unverified_source_urls: [null] }]) {
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...legacy, ...bad }))
    assert.throws(() => readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model'), /Missing provenance/)
  }
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

test('overlay codes: at least one, any non-blank single-line text of at most 100 characters', () => {
  const overlay = (codes: unknown) => ({ [proposed.id]: {
    playbook: proposed.id, codes, signals: proposed.signals, framework: proposed.framework, model: 'test-model', sha256: '0'.repeat(64),
  } }) as ClassesOverlay
  const check = (codes: unknown) => () => validateOverlay(overlay(codes), builtins, signals)
  const invalid = { message: `Invalid codes for ${proposed.id}` }
  for (const codes of [['API10:2023'], ['M3'], ['MASVS-STORAGE'], ['CWE-79'], ['A03'],
    ['API10:2023', 'M3', 'MASVS-STORAGE', 'CWE-79', 'A03'], ['x'.repeat(100)]]) assert.doesNotThrow(check(codes))
  for (const codes of [[], 'CWE-79', null, [''], ['   '], [' \t'], [42], [null], ['x'.repeat(101)],
    ['API10:2023\nM3'], ['M3\r'], ['M3\u2028'], ['\u2029M3'], ['API10:2023', '']]) {
    assert.throws(check(codes), invalid)
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

test('decision schemas: built-in ids as an enum; review turns add a required changes list; turn3 also requires a likelihood', async t => {
  const h = harness(t, 'covered', unchanged(decision('Covered.')))
  const { plan, selection } = await runPlaybookAgent(h.options)
  const schema = (h.request('coverage').text?.format as { schema: any }).schema
  assert.deepEqual(Object.keys(schema.properties), ['reason', 'builtin_classes', 'classes'])
  assert.deepEqual(schema.required, ['reason', 'builtin_classes', 'classes'])
  const item = schema.properties.builtin_classes.items
  assert.deepEqual(item.properties.id.enum, Object.keys(builtins))
  assert.deepEqual(item.required, ['id', 'reason'])
  assert.equal(item.additionalProperties, false)
  const likelihood = { type: 'string', enum: ['high', 'medium', 'low'] }
  for (const purpose of loopPurposes.slice(1)) {
    const turnSchema = (h.request(purpose).text?.format as { schema: any }).schema
    assert.deepEqual(turnSchema.required, ['reason', 'builtin_classes', 'classes', 'changes'])
    const { changes, ...rest } = turnSchema.properties
    assert.deepEqual(changes.items, {
      type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'],
    })
    if (purpose !== 'turn3') {
      assert.deepEqual(rest, schema.properties, 'the existing decision schema plus changes')
      continue
    }
    // turn3 alone: each item kind gains a required three-value likelihood, appended after its existing fields.
    for (const kind of ['builtin_classes', 'classes']) {
      const { properties, required, ...shape } = rest[kind].items, base = schema.properties[kind].items
      const { likelihood: rated, ...others } = properties
      assert.deepEqual(rated, likelihood, kind)
      assert.deepEqual(others, base.properties, kind)
      assert.deepEqual(required, [...base.required, 'likelihood'], kind)
      assert.deepEqual({ ...rest[kind], items: shape }, { ...schema.properties[kind], items: { type: 'object', additionalProperties: false } })
    }
    assert.equal(rest.reason.type, 'string')
  }
  for (const purpose of ['coverage', 'turn1', 'turn2:pass1']) {
    const { properties } = (h.request(purpose).text?.format as { schema: any }).schema
    for (const kind of ['builtin_classes', 'classes']) {
      assert.ok(!('likelihood' in properties[kind].items.properties) && !properties[kind].items.required.includes('likelihood'), purpose)
    }
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
  for (const i of inputs.slice(1, -1)) {
    assert.deepEqual(Object.keys(JSON.parse(i)), [...Object.keys(base), 'task', 'current_decision', 'searches_so_far'])
  }
  // turn3 alone appends turn2_review, after the fields every turn shares.
  assert.deepEqual(Object.keys(JSON.parse(inputs.at(-1)!)), [...Object.keys(base), 'task', 'current_decision', 'searches_so_far', 'turn2_review'])
})

test('review turns receive the union decision so far and the searches of all earlier decision calls', async t => {
  const s1 = { query: 'graphql security', url: 'https://example.test/graphql' }
  const s2 = { query: 'websocket security', url: 'https://example.test/ws' }
  const first = decision('Initial.', [pick('access-control')])
  const second = decision('Turn one.', [pick('access-control'), pick('injection')])
  const h = harness(t, 'covered', [response(first, [s1]), turn(second, [{ id: 'injection', why: 'Queries.' }], [s2]), turn(second), rethought(second)])
  const { plan } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.input('turn1').current_decision, first)
  assert.deepEqual(h.input('turn1').searches_so_far, { queries: [s1.query], source_urls: [s1.url] })
  assert.deepEqual(h.input('turn2:pass1').current_decision, second)
  assert.deepEqual(h.input('turn2:pass1').searches_so_far, { queries: [s1.query, s2.query], source_urls: [s1.url, s2.url] })
  assert.deepEqual(h.input('turn3').searches_so_far, h.input('turn2:pass1').searches_so_far)
  assert.equal(plan.searched, true, 'a search in a decision call counts')
  assert.deepEqual(plan.turns[0], {
    purpose: 'turn1', added: ['injection'], restored: [], removed: [], changes: [{ id: 'injection', why: 'Queries.' }],
    web_search_calls: 1, queries: [s2.query], source_urls: [s2.url],
  })
  assert.deepEqual(plan.turns.slice(1).map(x => x.web_search_calls), [0, 0])
})

test('loop order: coverage, turn1, turn2 passes, turn3; turn2 stops on the first pass that adds nothing', async t => {
  const start = decision('Start.', [pick('access-control')])
  const grown = decision('Grown.', [pick('access-control'), pick('injection')])
  const h = harness(t, 'covered', [response(start), turn(start), turn(grown), turn(grown), rethought(decision('Final.', grown.builtin_classes))])
  h.options.loop = { enabled: true, maxPasses: 3 }
  const { plan, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, ['coverage', 'turn1', 'turn2:pass1', 'turn2:pass2', 'turn3'])
  assert.deepEqual(plan.loop, { enabled: true, max_passes: 3, passes_run: 2 })
  assert.deepEqual(plan.turns.map(x => [x.purpose, x.added]),
    [['turn1', []], ['turn2:pass1', ['injection']], ['turn2:pass2', []], ['turn3', []]])
  assert.equal(plan.reason, 'Final.')
  assert.equal(plan.decision.reason, 'Final.')
  assert.deepEqual(selection.builtin, ['access-control', 'injection'])
})

test('turn2 stops at max_passes when every pass adds; the default is one pass', async t => {
  for (const maxPasses of [undefined, 2, 3]) {
    const n = maxPasses ?? 1, ids = Object.keys(builtins).slice(0, n)
    const passes = ids.map((_, k) => turn(decision(`Pass ${k + 1}.`, ids.slice(0, k + 1).map(pick))))
    const h = harness(t, 'covered', [response(decision('Start.')), turn(decision('Turn one.')), ...passes, rethought(decision('Final.', ids.map(pick)))])
    if (maxPasses) h.options.loop = { enabled: true, maxPasses }
    const { plan, selection } = await runPlaybookAgent(h.options)
    assert.deepEqual(h.purposes, ['coverage', 'turn1', ...ids.map((_, k) => `turn2:pass${k + 1}`), 'turn3'])
    assert.deepEqual(plan.loop, { enabled: true, max_passes: n, passes_run: n })
    assert.deepEqual(plan.turns.slice(1, -1).map(x => x.added), ids.map(id => [id]))
    assert.deepEqual(selection.builtin, [...ids].sort())
    assert.equal(h.replies.length, 0)
  }
})

test('a turn1 or turn2 that omits a selected class cannot drop it: restored, recorded, and still in the class selection', async t => {
  const start = decision('Start.', [pick('injection'), pick('access-control')], [proposed])
  const narrowed = decision('Narrowed.', [{ id: 'injection', reason: 'A later, different reason.' }])
  const h = harness(t, 'uncovered', [response(start), turn(narrowed), turn(narrowed), rethought(decision('Final.', start.builtin_classes, [proposed])), research()])
  const { plan, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.turns.map(x => x.restored), [['access-control', proposed.id], ['access-control', proposed.id], []])
  assert.deepEqual(plan.turns.map(x => x.added), [[], [], []])
  assert.deepEqual(plan.turns.map(x => x.removed), [[], [], []])
  assert.deepEqual(plan.decision.builtin_classes, start.builtin_classes, 'the first reason for an id is kept')
  assert.deepEqual(plan.decision.classes, [proposed])
  assert.equal(plan.reason, 'Final.')
  assert.deepEqual(selection.classes, ['access-control', 'injection', proposed.id])
  assert.deepEqual(selection.added, [proposed.id])
})

test('a turn cannot redefine an existing additional class', async t => {
  const redefined = { ...proposed, framework: 'other-queue', codes: ['CWE-400'], signals: ['http_outbound'], reason: 'Redefined.' }
  const start = decision('Start.', [], [proposed])
  // turn2 omits the class, so only the union can bring back the first definition; turn3 cannot redefine it either.
  const h = harness(t, 'uncovered', [response(start), turn(decision('Turn one.', [], [redefined])),
    turn(decision('Pass one.')), rethought(decision('Final.', [], [redefined])), research()])
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.turns.map(x => x.added), [[], [], []])
  assert.deepEqual(plan.turns.map(x => x.restored), [[], [proposed.id], []])
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
    rethought(decision('Final.', start.builtin_classes, [{ ...proposed, codes: ['CWE-400'], signals: ['http_outbound'] }])), research()])
  const { plan, overlay, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`])
  assert.deepEqual(plan.turns[0].added, [proposed.id])
  assert.deepEqual(plan.turns[0].changes, [{ id: proposed.id, why: 'Replay boundary.' }])
  assert.deepEqual(plan.turns.at(-1)!.removed, [])
  assert.deepEqual(plan.decision.classes, [proposed])
  assert.deepEqual(h.input(`research:${proposed.id}`).class, proposed)
  assert.equal(plan.classes[0].cache, 'created')
  assert.deepEqual(overlay[proposed.id].codes, proposed.codes)
  assert.deepEqual(selection.classes, ['injection', proposed.id])
})

const other: ProposedClass = {
  id: 'cache-key-poisoning', framework: 'example-cache', codes: ['CWE-349'],
  signals: ['http_outbound'], reason: 'A cache keying boundary is not covered by the built-ins.',
}
const classIdsOf = (d: CoverageDecision) => [...d.builtin_classes.map(b => b.id), ...d.classes.map(c => c.id)]

test('turn3 receives turn2_review: each turn2 pass\'s own reason and changes, in order, after searches_so_far', async t => {
  const start = decision('Start.', [pick('injection')], [proposed])
  const grown = decision('Grown.', [pick('injection'), pick('ssrf')], [proposed])
  // Pass 1 omits the additional class and adds ssrf; pass 2 adds access-control. Each review carries the pass's own output.
  const pass1 = { ...decision('Pass one reasoning.', [pick('injection'), pick('ssrf')]), changes: [{ id: 'ssrf', why: 'http_outbound signal in recon.' }] }
  const pass2 = { ...decision('Pass two reasoning.', [...grown.builtin_classes, pick('access-control')], [proposed]),
    changes: [{ id: 'access-control', why: 'Route handlers in architecture.' }] }
  const h = harness(t, 'uncovered', [response(start), turn(start), response(pass1), response(pass2), rethought(start), research()])
  h.options.loop = { enabled: true, maxPasses: 2 }
  await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, ['coverage', 'turn1', 'turn2:pass1', 'turn2:pass2', 'turn3', `research:${proposed.id}`])
  const input = h.input('turn3')
  assert.deepEqual(Object.keys(input).slice(-3), ['current_decision', 'searches_so_far', 'turn2_review'])
  assert.deepEqual(input.turn2_review, [
    { purpose: 'turn2:pass1', reason: pass1.reason, changes: pass1.changes },
    { purpose: 'turn2:pass2', reason: pass2.reason, changes: pass2.changes },
  ])
  for (const purpose of ['turn1', 'turn2:pass1', 'turn2:pass2']) assert.ok(!('turn2_review' in h.input(purpose)), purpose)
  // A pass that adds nothing ends the loop and is still reviewed.
  const one = harness(t, 'uncovered', [response(start), turn(start), turn(decision('Nothing to add.')), rethought(start), research()])
  one.options.loop = { enabled: true, maxPasses: 2 }
  await runPlaybookAgent(one.options)
  assert.deepEqual(one.input('turn3').turn2_review, [{ purpose: 'turn2:pass1', reason: 'Nothing to add.', changes: [] }])
})

test('turn3 removes an explained built-in and additional class: gone from every artifact, and the removed class is not researched', async t => {
  const start = decision('Start.', [pick('injection'), pick('access-control')], [proposed, other])
  const kept = decision('Re-thought.', [pick('injection')], [proposed])
  const changes = [{ id: 'access-control', why: 'No route evidence.' }, { id: other.id, why: 'No cache dependency.' }]
  const h = harness(t, 'uncovered', [response(start), turn(start), turn(start), rethought(kept, changes), research()])
  const { plan, overlay, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`], 'no research call for the removed class')
  const turn3 = plan.turns.at(-1)!
  assert.deepEqual([turn3.purpose, turn3.removed, turn3.added, turn3.restored, turn3.unexplained], ['turn3', ['access-control', other.id], [], [], []])
  assert.ok(!('prune_rejected' in turn3) && !('ignored' in turn3))
  assert.deepEqual(turn3.changes, changes)
  assert.deepEqual(plan.turns.slice(0, -1).map(x => x.removed), [[], []])
  assert.ok(plan.turns.slice(0, -1).every(x => !('unexplained' in x)))
  const [{ decision: d }] = h.decisions
  assert.deepEqual([d.builtin, d.added, d.classes], [['injection'], [proposed], ['injection', proposed.id]])
  assert.deepEqual(d.turns, plan.turns)
  assert.deepEqual([selection.builtin, selection.added, selection.classes], [['injection'], [proposed.id], ['injection', proposed.id]])
  assert.deepEqual(plan.decision, { reason: 'Re-thought.', builtin_classes: [pick('injection')], classes: [proposed] })
  assert.equal(plan.reason, 'Re-thought.')
  assert.deepEqual(plan.builtin_classes, [pick('injection')])
  assert.deepEqual(plan.selected_classes, ['injection', proposed.id])
  assert.deepEqual(plan.classes.map(c => c.id), [proposed.id])
  assert.ok(!plan.playbooks.some(p => p.class_id === other.id))
  assert.deepEqual(Object.keys(overlay), [proposed.id])
  assert.equal(readCachedPlaybook(h.root, other.id, other.framework, 'test-model'), null)
  assert.equal(h.logs[3], `[playbook-agent] turn3 completed in=120 out=50 searches=0 added=- removed=access-control,${other.id}`)
})

test('turn3 includes an explained new built-in and additional class: both selected, the new class researched with turn3\'s definition', async t => {
  const start = decision('Start.', [pick('injection')])
  const final = decision('Included.', [{ id: 'injection', reason: ' ' }, pick('ssrf')], [other])
  const changes = [{ id: 'ssrf', why: 'http_outbound signal.' }, { id: other.id, why: 'Cache dependency in the manifest.' }]
  const h = harness(t, 'uncovered', [response(start), turn(start), turn(start), rethought(final, changes),
    response({ playbook: generated, source_urls: [source] }, true)])
  const { plan, overlay, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${other.id}`])
  assert.deepEqual(h.input(`research:${other.id}`).class, other)
  const turn3 = plan.turns.at(-1)!
  assert.deepEqual([turn3.added, turn3.removed, turn3.restored, turn3.unexplained], [['ssrf', other.id], [], [], []])
  assert.deepEqual(plan.decision, { reason: 'Included.', builtin_classes: [pick('injection'), pick('ssrf')], classes: [other] })
  assert.deepEqual([selection.builtin, selection.added, selection.classes], [['injection', 'ssrf'], [other.id], [other.id, 'injection', 'ssrf']])
  assert.deepEqual(h.decisions[0].decision.classes, selection.classes)
  assert.deepEqual(h.decisions[0].decision.added, [other])
  assert.deepEqual([overlay[other.id].codes, overlay[other.id].signals, overlay[other.id].framework], [other.codes, other.signals, other.framework])
  assert.equal(plan.classes[0].cache, 'created')
  assert.equal(h.logs[3], `[playbook-agent] turn3 completed in=120 out=50 searches=0 added=ssrf,${other.id} removed=-`)
})

test('turn3 applies no unexplained change: an omitted class stays selected, a new one is not added; both recorded', async t => {
  const start = decision('Start.', [pick('injection'), pick('access-control')], [proposed])
  // access-control has no changes entry; ssrf's why is blank; other is explained and included.
  const final = decision('Final.', [pick('injection'), pick('ssrf')], [proposed, other])
  const h = harness(t, 'uncovered', [response(start), turn(start), turn(start),
    rethought(final, [{ id: 'ssrf', why: ' ' }, { id: other.id, why: 'Cache dependency.' }]), research(), research()])
  const { plan, selection } = await runPlaybookAgent(h.options)
  const turn3 = plan.turns.at(-1)!
  assert.deepEqual([turn3.added, turn3.removed, turn3.unexplained], [[other.id], [], ['access-control', 'ssrf']])
  assert.deepEqual(selection.classes, ['access-control', other.id, 'injection', proposed.id])
  assert.deepEqual(plan.decision.builtin_classes, start.builtin_classes)
  assert.equal(plan.reason, 'Final.')
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`, `research:${other.id}`])
})

test('turn3 validation: a kept class may come back with a blank reason and keeps its earlier one; a new class may not', async t => {
  const start = decision('Start.', [pick('injection')], [proposed])
  const blank = decision('Kept.', [{ id: 'injection', reason: '' }], [{ ...proposed, reason: ' ' }])
  const h = harness(t, 'uncovered', [response(start), turn(start), turn(start), rethought(blank), research()])
  const { plan } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.decision.builtin_classes, [pick('injection')])
  assert.deepEqual(plan.decision.classes, [proposed])
  for (const [bad, error] of [
    [decision('New.', [pick('injection'), { id: 'ssrf', reason: ' ' }], [proposed]), /selected built-in/],
    [decision('New.', [pick('injection')], [proposed, { ...other, reason: '' }]), /proposed class/],
  ] as [CoverageDecision, RegExp][]) {
    const failing = harness(t, 'uncovered', [response(start), turn(start), turn(start), rethought(bad, [{ id: 'ssrf', why: 'x' }, { id: other.id, why: 'x' }])])
    await assert.rejects(runPlaybookAgent(failing.options), error)
    assert.deepEqual(failing.decisions, [])
  }
  // turn1 and turn2 are unchanged: a blank reason fails even for a class already selected.
  const strict = harness(t, 'uncovered', [response(start), turn(blank)])
  await assert.rejects(runPlaybookAgent(strict.options), /selected built-in/)
})

test('turn3 cannot redefine a kept class: its earlier definition and reason stand', async t => {
  const start = decision('Start.', [pick('injection')], [proposed])
  const redefined = { ...proposed, framework: 'other-queue', codes: ['CWE-400'], signals: ['http_outbound'], reason: 'Redefined.' }
  const h = harness(t, 'uncovered', [response(start), turn(start), turn(start),
    rethought(decision('Final.', [{ id: 'injection', reason: 'A later, different reason.' }], [redefined]), [{ id: proposed.id, why: 'Redefined.' }]), research()])
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.decision.builtin_classes, [pick('injection')])
  assert.deepEqual(plan.decision.classes, [proposed])
  assert.deepEqual(h.decisions[0].decision.added, [proposed])
  assert.deepEqual(h.input(`research:${proposed.id}`).class, proposed)
  assert.deepEqual([overlay[proposed.id].codes, overlay[proposed.id].signals, overlay[proposed.id].framework],
    [proposed.codes, proposed.signals, proposed.framework])
  assert.deepEqual([plan.turns.at(-1)!.removed, plan.turns.at(-1)!.added, plan.turns.at(-1)!.unexplained], [[], [], []])
})

test('turn3 leaving no class is rejected: the set before it is kept and prune_rejected recorded', async t => {
  const start = decision('Start.', [pick('injection'), pick('access-control')], [proposed])
  const all = classIdsOf(start).map(id => ({ id, why: 'No recon evidence.' }))
  // Every removal explained; in the second case the only new id is unexplained, so it is not added either; in the third
  // every class comes back rated low.
  for (const [final, unexplained, rates] of [[decision('Nothing applies.'), [], {}], [decision('Only new.', [pick('ssrf')]), ['ssrf'], {}],
    [decision('All low.', start.builtin_classes, [proposed]), [], Object.fromEntries(classIdsOf(start).map(id => [id, 'low']))]] as
    [CoverageDecision, string[], Record<string, Likelihood>][]) {
    const h = harness(t, 'uncovered', [response(start), turn(start), turn(start), rethought(final, all, rates), research()])
    const { plan, selection } = await runPlaybookAgent(h.options)
    const before = h.input('turn3').current_decision
    assert.deepEqual(plan.decision, before, 'the pre-turn3 decision, reason included')
    assert.deepEqual(selection.classes, ['access-control', 'injection', proposed.id])
    assert.deepEqual(h.decisions[0].decision.classes, selection.classes)
    const turn3 = plan.turns.at(-1)!
    assert.equal(turn3.prune_rejected, 'empty')
    assert.deepEqual([turn3.removed, turn3.added, turn3.restored, turn3.unexplained], [[], [], [], unexplained])
    assert.deepEqual(turn3.ratings, Object.fromEntries(classIdsOf(final).map(id => [id, rates[id] ?? 'high'])))
    assert.match(h.logs[3], / added=- removed=-$/)
  }
})

test('turn3 removes a built-in and an additional class rated low, without a changes entry: gone from every artifact, not researched', async t => {
  const start = decision('Start.', [pick('injection'), pick('access-control')], [proposed, other])
  const rates: Record<string, Likelihood> = { injection: 'high', 'access-control': 'low', [proposed.id]: 'medium', [other.id]: 'low' }
  const h = harness(t, 'uncovered', [response(start), turn(start), turn(start), rethought(decision('Rated.', start.builtin_classes, start.classes), [], rates), research()])
  const { plan, overlay, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`], 'no research call for the class rated low')
  const turn3 = plan.turns.at(-1)!
  assert.deepEqual([turn3.removed, turn3.added, turn3.restored, turn3.unexplained, turn3.changes], [['access-control', other.id], [], [], [], []])
  assert.deepEqual(turn3.ratings, rates)
  assert.ok(!('prune_rejected' in turn3))
  assert.ok(plan.turns.slice(0, -1).every(x => !('ratings' in x)))
  const [{ decision: d }] = h.decisions
  assert.deepEqual([d.builtin, d.added, d.classes], [['injection'], [proposed], ['injection', proposed.id]])
  assert.deepEqual(d.turns, plan.turns)
  assert.deepEqual([selection.builtin, selection.added, selection.classes], [['injection'], [proposed.id], ['injection', proposed.id]])
  // Kept classes keep their earlier definition and reason, without the rating.
  assert.deepEqual(plan.decision, { reason: 'Rated.', builtin_classes: [pick('injection')], classes: [proposed] })
  assert.deepEqual(plan.selected_classes, ['injection', proposed.id])
  assert.deepEqual(plan.classes.map(c => c.id), [proposed.id])
  assert.ok(!plan.playbooks.some(p => p.class_id === other.id))
  assert.deepEqual(Object.keys(overlay), [proposed.id])
  assert.equal(readCachedPlaybook(h.root, other.id, other.framework, 'test-model'), null)
  assert.equal(h.logs[3], `[playbook-agent] turn3 completed in=120 out=50 searches=0 added=- removed=access-control,${other.id}`)
})

test('turn3 ratings: high and medium keep; an explained new class rated medium is included; an explained new one rated low is not', async t => {
  const start = decision('Start.', [pick('injection'), pick('access-control')], [proposed])
  const final = decision('Rated.', [...start.builtin_classes, pick('ssrf')], [proposed, other])
  const rates: Record<string, Likelihood> = { injection: 'high', 'access-control': 'medium', [proposed.id]: 'high', ssrf: 'low', [other.id]: 'medium' }
  const changes = [{ id: 'ssrf', why: 'http_outbound signal.' }, { id: other.id, why: 'Cache dependency in the manifest.' }]
  const h = harness(t, 'uncovered', [response(start), turn(start), turn(start), rethought(final, changes, rates), research(), research()])
  const { plan, overlay, selection } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`, `research:${other.id}`])
  assert.deepEqual(h.input(`research:${other.id}`).class, other, 'researched with turn3\'s definition, without the rating')
  const turn3 = plan.turns.at(-1)!
  assert.deepEqual([turn3.added, turn3.removed, turn3.unexplained], [[other.id], [], []])
  assert.deepEqual(turn3.ratings, rates)
  assert.deepEqual(plan.decision, { reason: 'Rated.', builtin_classes: start.builtin_classes, classes: [proposed, other] })
  assert.deepEqual(h.decisions[0].decision.added, [proposed, other])
  assert.deepEqual([selection.builtin, selection.added, selection.classes],
    [['access-control', 'injection'], [other.id, proposed.id].sort(), ['access-control', other.id, 'injection', proposed.id]])
  assert.deepEqual(Object.keys(overlay).sort(), [other.id, proposed.id].sort())
  assert.equal(h.logs[3], `[playbook-agent] turn3 completed in=120 out=50 searches=0 added=${other.id} removed=-`)
  // Rated low and unexplained: not included, and not listed as unexplained either.
  const quiet = harness(t, 'uncovered', [response(start), turn(start), turn(start),
    rethought(decision('Rated.', [...start.builtin_classes, pick('ssrf')], [proposed]), [], { ssrf: 'low' }), research()])
  const rerun = await runPlaybookAgent(quiet.options)
  assert.deepEqual([rerun.plan.turns.at(-1)!.added, rerun.plan.turns.at(-1)!.unexplained], [[], []])
  assert.deepEqual(rerun.selection.classes, ['access-control', 'injection', proposed.id])
})

test('turn3 validation: every returned class must carry high, medium or low; turn1 and turn2 need none', async t => {
  const start = decision('Start.', [pick('injection')], [proposed])
  const rated = (likelihood: unknown, id: string) => ({ ...start, builtin_classes: [{ ...pick('injection'), likelihood: id === 'injection' ? likelihood : 'high' }],
    classes: [{ ...proposed, likelihood: id === proposed.id ? likelihood : 'high' }], changes: [] })
  for (const id of ['injection', proposed.id]) {
    for (const likelihood of [undefined, '', 'High', 'none', 1, null]) {
      const h = harness(t, 'uncovered', [response(start), turn(start), turn(start), response(rated(likelihood, id))])
      await assert.rejects(runPlaybookAgent(h.options), /Invalid turn3 likelihood/, `${id} ${likelihood}`)
      assert.deepEqual(h.decisions, [])
    }
  }
  const h = harness(t, 'uncovered', [response(start), turn(start), turn(start), response(rated('medium', proposed.id)), research()])
  const { plan } = await runPlaybookAgent(h.options)
  assert.deepEqual(plan.turns.at(-1)!.ratings, { injection: 'high', [proposed.id]: 'medium' })
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
  const h = harness(t, 'uncovered', [response(d, searches), turn(d), turn(d), rethought(d), research()])
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

test('the final union is recorded once, after the last decision call and before any research call', async t => {
  const start = decision('Start.', [pick('injection')])
  const added = decision('Added.', [pick('access-control')], [proposed])
  const short = () => response({ playbook: 'too short', source_urls: [source] }, true)
  for (const last of [[research()], [short(), short(), short()]]) {
    const all = decision('All.', [...start.builtin_classes, ...added.builtin_classes], [proposed])
    const h = harness(t, 'uncovered', [response(start), turn(added, [{ id: proposed.id, why: 'Replay.' }]), turn(added), rethought(all), ...last])
    const run = runPlaybookAgent(h.options)
    if (last.length > 1) await assert.rejects(run, { message: 'Generated playbook does not match the built-in section format' })
    else await run
    assert.equal(h.decisions.length, 1)
    const [{ decision: d, after }] = h.decisions
    assert.equal(after, loopPurposes.length, 'recorded before the research request')
    assert.equal(d.schema, 'secscan.class-decision/1')
    assert.equal(d.model, 'test-model')
    assert.ok(Number.isFinite(Date.parse(d.created_at)))
    assert.deepEqual(d.builtin, ['access-control', 'injection'])
    assert.deepEqual(d.added, [proposed])
    assert.deepEqual(d.classes, ['access-control', 'injection', proposed.id])
    assert.deepEqual(d.turns.map(x => [x.purpose, x.added]), [['turn1', ['access-control', proposed.id]], ['turn2:pass1', []], ['turn3', []]])
    assert.deepEqual(d.loop, { enabled: true, max_passes: 1, passes_run: 1 })
  }
})

test('a decision call that fails never records a decision', async t => {
  const h = harness(t, 'uncovered', [response(decision('Start.')), response({ ...decision('Bad.'), reason: ' ', changes: [] })])
  await assert.rejects(runPlaybookAgent(h.options), /Invalid turn1 decision/)
  assert.deepEqual(h.decisions, [])
})

test('validatePlaybook messages are unchanged; playbookProblems lists every failed check in order', () => {
  const format = 'Generated playbook does not match the built-in section format'
  const size = 'Generated playbook must be roughly 2–6 KB'
  const short = 'Playbook for X\n=====\nScope: x\n## OWASP Categories Covered\n## Sink Patterns to Hunt For\n' +
    '## Distinguishing Real Findings from False Positives\n## Hunting Discipline\n'
  const cases: [unknown, string | null, string[]][] = [
    [generated, null, []],
    [42, format, ['format', 'sections']],
    [generated.replace('Playbook for', 'Guide for'), format, ['format']],
    [generated.replace('## Hunting Discipline', '## Discipline'), format, ['sections']],
    ['Guide\n', format, ['format', 'sections', 'size']],
    [short, size, ['size']],
    [generated + 'x'.repeat(6000), size, ['size']],
  ]
  for (const [text, message, problems] of cases) {
    assert.deepEqual(playbookProblems(text), problems)
    const check = () => validatePlaybook(text as string)
    if (message) assert.throws(check, { message })
    else assert.doesNotThrow(check)
  }
  // The bounds are bytes, not characters.
  const multibyte = short + '\u2013'.repeat(500)
  assert.ok(multibyte.length < 1500 && Buffer.byteLength(multibyte) >= 1500)
  assert.deepEqual(playbookProblems(multibyte), [])
})

test('every failed research check leaves a debug record of the rejected output; the error is today\'s', async t => {
  const missing = generated.replace('## Hunting Discipline', '## Discipline')
  const short = 'Playbook for Worker Epoch Confusion\n=====\nScope: x\n## OWASP Categories Covered\n## Sink Patterns to Hunt For\n' +
    '## Distinguishing Real Findings from False Positives\n## Hunting Discipline\n'
  const long = generated + '\n' + 'Padding line for size.\n'.repeat(300)
  const absent = 'https://example.test/not-retrieved'
  const sections = ['Scope:', '## OWASP Categories Covered', '## Sink Patterns to Hunt For',
    '## Distinguishing Real Findings from False Positives', '## Hunting Discipline']
  const cases: { name: string; reply: Response; check: string; error: RegExp | { message: string }; text: string;
    missing?: string[]; absent?: string[]; searches?: number }[] = [
    // Cited URLs absent from the search are recorded as information on a failure for another reason.
    { name: 'too short', reply: response({ playbook: short, source_urls: [source, absent] }, true), check: 'size',
      error: { message: 'Generated playbook must be roughly 2–6 KB' }, text: short, absent: [absent] },
    { name: 'too long', reply: response({ playbook: long, source_urls: [source] }, true), check: 'size',
      error: { message: 'Generated playbook must be roughly 2–6 KB' }, text: long },
    { name: 'missing section', reply: response({ playbook: missing, source_urls: [source] }, true), check: 'sections',
      error: { message: 'Generated playbook does not match the built-in section format' }, text: missing, missing: ['## Hunting Discipline'] },
    { name: 'no search', reply: response({ playbook: generated, source_urls: [source] }), check: 'no_search',
      error: { message: `No web search performed for ${proposed.id}` }, text: generated, absent: [source], searches: 0 },
  ]
  for (const c of cases) {
    // A playbook check fails only after two revisions that return the same output; the record is the last attempt's.
    const revised = c.check !== 'no_search'
    const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])), ...Array(revised ? 3 : 1).fill(c.reply)])
    await assert.rejects(runPlaybookAgent(h.options), c.error, c.name)
    assert.equal(h.failures.length, 1, c.name)
    const f = h.failures[0]
    assert.deepEqual(Object.keys(f), ['class_id', 'purpose', 'error', 'check', 'byte_size', 'char_size', 'size_bounds',
      'missing_sections', 'cited_urls_absent_from_search', 'web_search_calls', 'queries', 'search_source_urls',
      'cited_source_urls', 'response_status', 'output_tokens', 'reasoning_tokens', 'playbook_text', ...(revised ? ['attempts'] : [])])
    assert.equal(f.class_id, proposed.id)
    assert.equal(f.purpose, revised ? `research:${proposed.id}:revise2` : `research:${proposed.id}`)
    assert.equal(f.check, c.check, c.name)
    assert.equal(f.playbook_text, c.text, 'the rejected text, verbatim')
    assert.equal(f.byte_size, Buffer.byteLength(c.text))
    assert.equal(f.char_size, c.text.length)
    assert.deepEqual(f.size_bounds, [1500, 8000])
    assert.deepEqual(f.missing_sections, c.missing ?? [], c.name)
    assert.deepEqual(f.cited_urls_absent_from_search, c.absent ?? [], c.name)
    assert.equal(f.web_search_calls, c.searches ?? 1)
    assert.deepEqual(f.search_source_urls, c.searches === 0 ? [] : [source])
    assert.deepEqual(f.queries, c.searches === 0 ? [] : ['worker epoch security'])
    assert.equal(f.response_status, 'completed')
    assert.equal(f.output_tokens, 50)
    assert.equal(f.reasoning_tokens, 15)
    assert.equal(h.decisions.length, 1, 'the decision was recorded before research')
    assert.equal(readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model'), null)
  }
  assert.ok(Buffer.byteLength(cases[0].text) < 1500 && Buffer.byteLength(cases[1].text) > 8000)
  // A response that is not JSON: the raw output is kept and no size is claimed.
  const raw = '{"playbook": "Playbook for Worker Epoch Confusion\\n===\\nScope: x\\n## OWASP Categories Covered'
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])), { ...research(), output_text: raw } as Response])
  await assert.rejects(runPlaybookAgent(h.options), SyntaxError)
  assert.equal(h.failures.length, 1)
  const f = h.failures[0]
  assert.equal(f.check, 'json')
  assert.match(f.error, /JSON/)
  assert.equal(f.playbook_text, raw)
  assert.equal(f.byte_size, null)
  assert.equal(f.char_size, null)
  assert.deepEqual(f.missing_sections, sections.slice(2), 'headings are looked for in the raw output')
  assert.deepEqual(f.cited_source_urls, [])
  assert.deepEqual(f.search_source_urls, [source])
})

test('one progress line per completed model call; the research line carries the playbook size', async t => {
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [pick('injection')], [proposed])), research()])
  await runPlaybookAgent(h.options)
  const line = (purpose: string, searches: number, tail: string) => `[playbook-agent] ${purpose} completed in=120 out=50 searches=${searches} ${tail}`
  assert.deepEqual(h.logs, [
    line('coverage', 0, `added=injection,${proposed.id}`), line('turn1', 0, 'added=-'), line('turn2:pass1', 0, 'added=-'),
    line('turn3', 0, 'added=- removed=-'), line(`research:${proposed.id}`, 1, `bytes=${Buffer.byteLength(generated)} unverified=0`),
  ])
  const grown = harness(t, 'covered', [response(decision('Start.')), turn(decision('Grown.', [pick('injection'), pick('ssrf')])), turn(decision('Same.')), rethought(decision('Same.'))])
  await runPlaybookAgent(grown.options)
  assert.equal(grown.logs[1], line('turn1', 0, 'added=injection,ssrf'))
  assert.equal(grown.logs[0], line('coverage', 0, 'added=-'))
  const bad = harness(t, 'covered', [{ ...response({}), status: 'incomplete' } as Response])
  await assert.rejects(runPlaybookAgent(bad.options), /response incomplete/)
  assert.deepEqual(bad.logs, ['[playbook-agent] coverage incomplete in=120 out=50 searches=0 added=-'])
  const start = decision('Start.', [pick('injection')])
  const badTurn3 = harness(t, 'covered', [response(start), turn(start), turn(start), { ...turn(start), status: 'incomplete' } as Response])
  await assert.rejects(runPlaybookAgent(badTurn3.options), /turn3 response incomplete/)
  assert.equal(badTurn3.logs.at(-1), '[playbook-agent] turn3 incomplete in=120 out=50 searches=0 added=- removed=-')
})

// The revision template from the spec, character for character; the clauses are added only for those problems.
const revisionHead = (bytes: number) => `Your playbook is ${bytes} bytes; it must be between 1500 and 8000 bytes`
const revisionTail = '. Revise it to fit: keep the same class, the same five sections in the same order and the most important sink patterns and checks; shorten or merge the least important points. Do not add new content beyond what a missing or incomplete section needs. If a section is missing or incomplete, use web search to look up the information it needs, only if needed. Return the full revised playbook in the same schema.'
const titleClause = ', and does not start with the required "Playbook for <Class name> (<codes>)" title line followed by a line of = characters'
// A well-formed playbook padded to exactly `bytes`.
const sized = (bytes: number) => generated + '\n' + 'x'.repeat(bytes - Buffer.byteLength(generated) - 1)
const revise = (n: number) => `research:${proposed.id}:revise${n}`

test('an oversized first playbook is revised once: the revision is cached and both sizes recorded', async t => {
  const first = sized(9029), second = sized(6000)
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])),
    response({ playbook: first, source_urls: [source] }, true), response({ playbook: second, source_urls: [source] })])
  const { plan, overlay } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.failures, [])
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`, revise(1)])
  assert.equal(h.input(`research:${proposed.id}`).task, researchTask)
  const r = h.request(revise(1)), research = h.request(`research:${proposed.id}`)
  assert.equal(r.tool_choice, 'auto')
  for (const key of ['instructions', 'tools', 'include', 'text', 'reasoning', 'max_output_tokens'] as const) assert.deepEqual(r[key], research[key], key)
  const input = h.input(revise(1)), researchInput = h.input(`research:${proposed.id}`)
  assert.deepEqual(Object.keys(input), ['task', 'class', 'stack', 'example_format', 'previous_playbook', 'previous_source_urls', 'problems'])
  assert.equal(input.task, revisionHead(9029) + revisionTail)
  for (const key of ['class', 'stack', 'example_format']) assert.deepEqual(input[key], researchInput[key], key)
  assert.equal(input.previous_playbook, first)
  assert.deepEqual(input.previous_source_urls, [source])
  assert.deepEqual(input.problems, { bytes: 9029, size_bounds: [1500, 8000], missing_sections: [], title_line_ok: true })
  const cached = readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!
  assert.equal(cached.text, second)
  assert.equal(overlay[proposed.id].sha256, textHash(second))
  assert.deepEqual((cached.meta as any).revisions, { attempts: 2, sizes: [9029, 6000] })
  assert.deepEqual(plan.playbooks.at(-1)!.revisions, { attempts: 2, sizes: [9029, 6000] })
  // A revision is not required to search; its cited URL stays verified by the first call's search.
  assert.equal(h.usage.at(-1)!.web_search_calls, 0)
  assert.deepEqual(cached.meta.verified_source_urls, [source])
  assert.equal(h.logs.at(-1), `[playbook-agent] ${revise(1)} completed in=120 out=50 searches=0 bytes=9029->6000 problems=-`)
})

test('the revision task carries the missing-sections and title clauses only for those problems', async t => {
  const missing = generated.replace('## Hunting Discipline', '## Discipline')
  const untitled = generated.replace('Playbook for', 'Guide for')
  const cases: [string, string, string[], boolean][] = [
    [missing, `, and is missing these sections: ## Hunting Discipline`, ['## Hunting Discipline'], true],
    [untitled, titleClause, [], false],
    ['Guide\n', ', and is missing these sections: Scope:, ## OWASP Categories Covered, ## Sink Patterns to Hunt For, ' +
      '## Distinguishing Real Findings from False Positives, ## Hunting Discipline' + titleClause,
      ['Scope:', '## OWASP Categories Covered', '## Sink Patterns to Hunt For', '## Distinguishing Real Findings from False Positives',
        '## Hunting Discipline'], false],
  ]
  for (const [text, clauses, missingSections, titleOk] of cases) {
    const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])),
      response({ playbook: text, source_urls: [] }, true), response({ playbook: generated, source_urls: [] })])
    await runPlaybookAgent(h.options)
    const bytes = Buffer.byteLength(text), input = h.input(revise(1))
    assert.equal(input.task, revisionHead(bytes) + clauses + revisionTail)
    assert.deepEqual(input.problems, { bytes, size_bounds: [1500, 8000], missing_sections: missingSections, title_line_ok: titleOk })
    assert.equal(readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!.text, generated)
  }
})

test('a revision that searches: its sources verify cited URLs and its queries join the cached queries', async t => {
  const other = { query: 'worker replay revision', url: 'https://example.test/replay' }
  const absent = 'https://example.test/not-retrieved'
  const cited = [source, other.url, absent]
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])),
    response({ playbook: sized(9029), source_urls: [source] }, true), response({ playbook: generated, source_urls: cited }, [other])])
  const { plan } = await runPlaybookAgent(h.options)
  const { meta } = readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!
  assert.deepEqual(meta.source_urls, cited)
  assert.deepEqual(meta.verified_source_urls, [source, other.url])
  assert.deepEqual(meta.unverified_source_urls, [absent])
  assert.deepEqual(meta.queries, ['worker epoch security', other.query])
  const record = plan.playbooks.at(-1)!
  assert.deepEqual([record.verified_source_urls, record.queries], [[source, other.url], ['worker epoch security', other.query]])
  assert.match(h.logs.at(-1)!, / searches=1 bytes=9029->\d+ problems=-$/)
})

test('still failing after two revisions: three research-type calls, every attempt recorded, today\'s error', async t => {
  const long = sized(9029), missing = generated.replace('## Hunting Discipline', '## Discipline')
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])),
    response({ playbook: long, source_urls: [source] }, true), response({ playbook: sized(8500), source_urls: [source] }),
    response({ playbook: missing, source_urls: [source] })])
  await assert.rejects(runPlaybookAgent(h.options), { message: 'Generated playbook does not match the built-in section format' })
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`, revise(1), revise(2)])
  assert.equal(h.failures.length, 1)
  const f = h.failures[0]
  assert.equal(f.purpose, revise(2))
  assert.equal(f.check, 'sections')
  assert.equal(f.playbook_text, missing)
  assert.deepEqual(f.missing_sections, ['## Hunting Discipline'])
  assert.deepEqual(f.attempts, [
    { purpose: `research:${proposed.id}`, bytes: 9029, problems: ['size'] },
    { purpose: revise(1), bytes: 8500, problems: ['size'] },
    { purpose: revise(2), bytes: Buffer.byteLength(missing), problems: ['sections'] },
  ])
  // The second revision is told the first revision's size.
  assert.equal(h.input(revise(2)).task, revisionHead(8500) + revisionTail)
  assert.equal(h.input(revise(2)).previous_playbook, sized(8500))
  assert.equal(readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model'), null)
  assert.equal(h.logs.at(-1), `[playbook-agent] ${revise(2)} completed in=120 out=50 searches=0 bytes=8500->${Buffer.byteLength(missing)} problems=sections`)
})

test('a first playbook that passes makes no revision call and records a single attempt', async t => {
  const h = harness(t, 'uncovered', [...unchanged(decision('Uncovered.', [], [proposed])), research()])
  const { plan } = await runPlaybookAgent(h.options)
  assert.deepEqual(h.purposes, [...loopPurposes, `research:${proposed.id}`])
  const revisions = { attempts: 1, sizes: [Buffer.byteLength(generated)] }
  assert.deepEqual((readCachedPlaybook(h.root, proposed.id, proposed.framework, 'test-model')!.meta as any).revisions, revisions)
  assert.deepEqual(plan.playbooks.at(-1)!.revisions, revisions)
})
