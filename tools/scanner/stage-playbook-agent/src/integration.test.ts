import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLASS_SELECTION_FILE, mergeClassTables, validateClassSelection, type ClassesOverlay, type ClassSelection,
} from '../../shared/playbook-overlay.js'
import { writeCachedPlaybook, cacheRoot, textHash, addOverlayPlaybookSizes } from '../../shared/playbook-cache.js'
import { resolveRunContext } from '../../shared/run-context.js'
import { defaultProvider, productDefaultProvider, modelFor, targetFor } from '../../shared/provider.js'
import { loadRegistryModules } from '../../cli/src/registry.js'
import { readRunPlaybooks } from '../../cli/src/playbooks.js'
import { loadRecon } from './main.js'

const scanner = fileURLToPath(new URL('../..', import.meta.url))
const tsx = join(scanner, 'stage-playbook-agent/node_modules/.bin/tsx')
const builtins = JSON.parse(readFileSync(join(scanner, 'shared/vuln-classes.json'), 'utf8'))
const signals = JSON.parse(readFileSync(join(scanner, 'shared/signal-classes.json'), 'utf8'))
const provider = defaultProvider()
const id = 'worker-epoch-confusion'
const text = 'Playbook text for a synthetic integration fixture.\n'
const json = (file: string, data: unknown) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data)) }
const selectionOf = (builtin: string[], added: string[] = []): ClassSelection => ({
  schema: 'secscan.class-selection/1', created_at: '2026-01-01T00:00:00Z', model: 'test/model',
  builtin, added, classes: [...builtin, ...added].sort(),
})
const huntUnion = (out: any) => [...new Set(out.lanes.filter((l: any) => l.disposition === 'hunt').flatMap((l: any) => l.classes))].sort()

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'playbook-hooks-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'target')
  mkdirSync(target)
  writeFileSync(join(target, 'worker.ts'), 'export const handle = (message: string) => JSON.parse(message)\n')
  const env = { ...process.env, SCANNER_PROFILE: 'product', SCANNER_TARGET: target,
    SCANNER_RUN_ID: 'unit', SCANNER_RUNS_ROOT: join(root, 'runs'), SCANNER_PROVIDER: provider }
  const ctx = resolveRunContext(env, [])
  const stage0 = join(ctx.runsRoot, provider, 'stage0-recon')
  json(join(stage0, 'architecture-summary.json'), { file_inventory: { total_source_files: 1 } })
  json(join(stage0, 'category-applicability.json'), [{ name: 'A03: Injection', framework: 'owasp', verdict: 'present' }])
  json(join(stage0, 'file-signals.json'), { target_dir: target, files: { 'worker.ts': ['deserialize'] } })
  json(join(stage0, 'file-inventory.json'), {
    target_dir: target, files: [{ path: 'worker.ts', language: 'typescript', bytes: 80, empty: false, test: false, oversize: false }],
    totals: { test: 0, oversize: 0, empty: 0, excluded_files: 0, excluded_dirs: 0 }, options: { max_file_bytes: 200000 },
  })
  json(join(stage0, 'meta.json'), { provider, exit_code: 0 })
  const agentDir = join(ctx.runsRoot, provider, 'stage-playbook-agent')
  const freeze = join(root, 'freeze.mjs')
  writeFileSync(freeze, `const RealDate = Date; globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-01-01T00:00:00.000Z'])); }
    static now() { return new RealDate('2026-01-01T00:00:00.000Z').getTime(); }
  }`)
  const runSelector = () => {
    execFileSync(tsx, ['--import', freeze, join(scanner, 'stage05-lane-selector-perfile/src/lane-selector-perfile.ts')], { env, stdio: 'pipe' })
    return readFileSync(join(ctx.runsRoot, provider, 'stage05-lane-selector-perfile/lane-assignments.json'), 'utf8')
  }
  const cache = cacheRoot(ctx)
  const cached = writeCachedPlaybook(cache, text, {
    class_id: id, playbook: id, framework: 'generic', model: 'test/model',
    codes: ['CWE-362', 'A03'], signals: ['deserialize'], source_urls: ['https://example.test/docs'],
    queries: ['example query'], created_at: '2026-01-01T00:00:00Z',
  })
  const { playbook, codes, framework, model, sha256 } = cached.meta
  const overlay: ClassesOverlay = { [id]: { playbook, codes, framework, model, sha256, signals: ['deserialize'] } }
  const publish = (value: ClassesOverlay) => {
    json(join(agentDir, 'classes-overlay.json'), value)
    json(join(agentDir, 'meta.json'), { provider, exit_code: 0 })
  }
  // Agent mode: an overlay plus the agent's complete class set.
  const publishSelection = (builtin: string[], added: ClassesOverlay = {}) => {
    publish(added)
    json(join(agentDir, CLASS_SELECTION_FILE), selectionOf(builtin, Object.keys(added)))
  }
  // Replace Stage 0's one-file artifacts with several files and their signals.
  const retarget = (files: Record<string, { language: string; signals: string[] }>) => {
    const paths = Object.keys(files).sort()
    for (const p of paths) writeFileSync(join(target, p), 'export const x = 1\n')
    json(join(stage0, 'architecture-summary.json'), { file_inventory: { total_source_files: paths.length } })
    json(join(stage0, 'file-signals.json'), { target_dir: target, files: Object.fromEntries(paths.map(p => [p, files[p].signals])) })
    json(join(stage0, 'file-inventory.json'), {
      target_dir: target, files: paths.map(p => ({ path: p, language: files[p].language, bytes: 19, empty: false, test: false, oversize: false })),
      totals: { test: 0, oversize: 0, empty: 0, excluded_files: 0, excluded_dirs: 0 }, options: { max_file_bytes: 200000 },
    })
  }
  return { root, ctx, env, agentDir, stage0, target, cache, overlay, publish, publishSelection, retarget, runSelector }
}

test('table merge is additive and absent overlay returns byte-identical shipped tables', () => {
  const original = JSON.stringify({ builtins, signals })
  const absent = mergeClassTables(builtins, signals, null)
  assert.equal(absent.registry, builtins)
  assert.equal(absent.signalMap, signals)
  const overlay = { [id]: { playbook: id, codes: ['CWE-362'], signals: ['deserialize'], framework: 'generic', model: 'test-model', sha256: 'a'.repeat(64) } }
  const merged = mergeClassTables(builtins, signals, overlay)
  assert.deepEqual(merged.signalMap.signals.deserialize, [...signals.signals.deserialize, id])
  assert.deepEqual(merged.signalMap.floor, signals.floor)
  assert.deepEqual(merged.registry[id].codes, ['CWE-362'])
  assert.equal(JSON.stringify({ builtins, signals }), original)
})

test('real Stage 0.5 on one-file fixture: absent overlay matches empty overlay byte for byte; added class follows signals', t => {
  const f = fixture(t)
  const original = f.runSelector()
  // Golden captured from the base main selector, with only runtime paths replaced.
  const parsed = JSON.parse(original)
  const normalized = original.replace(JSON.stringify(f.target), JSON.stringify('<target>'))
    .replace(JSON.stringify(parsed.source_stage0_run), JSON.stringify('<stage0>/architecture-summary.json'))
  assert.equal(normalized, readFileSync(new URL('./fixtures/lane-assignments-no-overlay.json', import.meta.url), 'utf8'))
  f.publish({})
  assert.equal(f.runSelector(), original)
  const baseline = JSON.parse(original)
  assert.deepEqual(baseline.lanes[0].classes, [...new Set([...signals.floor, ...signals.signals.deserialize])].sort())
  f.publish(f.overlay)
  const added = JSON.parse(f.runSelector())
  assert.deepEqual(added.lanes[0].classes, [...baseline.lanes[0].classes, id].sort())
  assert.deepEqual(added.lanes[0].class_basis.deserialize, [...signals.signals.deserialize, id])
  assert.deepEqual(added.coverage_ledger, baseline.coverage_ledger)
  assert.equal(added.lanes[0].disposition, 'hunt')
  json(join(f.stage0, 'file-signals.json'), { target_dir: f.target, files: { 'worker.ts': ['route_handler'] } })
  assert.ok(!JSON.parse(f.runSelector()).lanes[0].classes.includes(id))
})

test('Stage 1 overlay sizes include dynamic guidance without changing built-in sizes', t => {
  const f = fixture(t)
  const registry = { ...builtins }, sizes = new Map([['injection', 123]])
  addOverlayPlaybookSizes(registry, sizes, f.overlay, signals, f.cache)
  assert.equal(sizes.get(id), text.length)
  assert.equal(sizes.get('injection'), 123)
  assert.deepEqual(registry[id].codes, ['CWE-362', 'A03'])
})

test('Stage 2 loads overlay text into the hunt prompt and records sources/hashes; no model call', t => {
  const f = fixture(t)
  f.publish(f.overlay)
  const script = join(f.root, 'load.mts')
  const resultFile = join(f.root, 'loaded.json')
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs';
    import { loadPlaybooksForClasses, describePlaybooks, buildHuntPrompt } from ${JSON.stringify(join(scanner, 'stage2-hunt-lanes-perfile/src/hunt-executor.ts'))};
    const ids = ['injection', ${JSON.stringify(id)}];
    const loaded = await loadPlaybooksForClasses(ids);
    const prompt = buildHuntPrompt('worker.ts', '1: placeholder', ids, loaded, { chunkIndex: 1, totalChunks: 1 });
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ loaded: [...loaded], records: describePlaybooks(ids, loaded), prompt }));
  `)
  execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' })
  const result = JSON.parse(readFileSync(resultFile, 'utf8'))
  assert.equal(new Map(result.loaded).get(id), text)
  assert.match(JSON.stringify(result.prompt), /Playbook text for a synthetic integration fixture/)
  const records = result.records
  assert.equal(records[0].kind, 'builtin')
  assert.equal(records[0].sha256, textHash(new Map<string, string>(result.loaded).get('injection')!))
  assert.equal(records[1].sha256, textHash(text))
  assert.deepEqual(records[1].source_urls, ['https://example.test/docs'])
  // The run-record hook prefers actual hunting guidance, including resume,
  // over the wider set consulted by the agent before class assignment.
  const huntDir = join(f.ctx.runsRoot, provider, 'stage2-hunt-lanes-perfile')
  json(join(f.agentDir, 'playbook-plan.json'), { playbooks: records })
  assert.deepEqual(readRunPlaybooks(huntDir, f.agentDir), records)
  json(join(huntDir, 'playbooks-used.json'), [records[1]])
  assert.deepEqual(readRunPlaybooks(huntDir, f.agentDir), [records[1]])
})

test('reports cache is shared across product runs, while artifacts stay run-scoped', t => {
  const f = fixture(t)
  const next = resolveRunContext({ ...f.env, SCANNER_RUN_ID: 'next', SCANNER_RUNS_ROOT: undefined }, [])
  assert.equal(cacheRoot(next), join(f.target, '.secscan/playbooks'))
  assert.equal(cacheRoot(next), f.cache)
  assert.notEqual(next.runsRoot, f.ctx.runsRoot)
  assert.ok(existsSync(join(f.cache, id, 'generic', 'test%2Fmodel', 'meta.json')))
})

test('custom reports root owns the playbook cache across runs and artifact-root overrides', t => {
  const f = fixture(t)
  const reports = join(f.root, 'custom-reports')
  const first = resolveRunContext({ ...f.env, SCANNER_REPORTS_ROOT: reports }, [])
  const next = resolveRunContext({ ...f.env, SCANNER_REPORTS_ROOT: reports, SCANNER_RUN_ID: 'next', SCANNER_RUNS_ROOT: undefined }, [])
  assert.equal(cacheRoot(first), join(reports, 'playbooks'))
  assert.equal(cacheRoot(next), cacheRoot(first))
  assert.equal(next.runsRoot, join(reports, 'runs/next'))
  assert.notEqual(first.runsRoot, next.runsRoot)
})

test('recon input uses only the dependency section of the existing repo map', t => {
  const f = fixture(t)
  writeFileSync(join(f.stage0, 'repo-map.md'), '# Repo map\n## Dependency manifests\n### package.json\n{"dependencies":{"example-lib":"1"}}\n## Entry points\nDO_NOT_INCLUDE\n')
  const recon = loadRecon(f.stage0)
  assert.match(recon.dependency_manifests, /example-lib/)
  assert.ok(!recon.dependency_manifests.includes('DO_NOT_INCLUDE'))
})

test('product default is registry-driven and carries no inherited benchmark', async () => {
  const raw = JSON.parse(readFileSync(join(scanner, 'shared/models.json'), 'utf8'))
  assert.equal(defaultProvider(), raw.default_provider)
  assert.equal(productDefaultProvider(), raw.product_default_provider)
  assert.equal(modelFor(productDefaultProvider()), raw.targets[raw.product_default_provider].model)
  assert.equal(targetFor(productDefaultProvider()).benchmark, undefined)
  const cli = await loadRegistryModules()
  assert.equal(cli.defaultKey(), raw.product_default_provider)
})

test('stage entrypoint saves plan, overlay and per-call usage; a failed retry invalidates upstream provenance', t => {
  const f = fixture(t)
  const script = join(f.root, 'stage.mts')
  writeFileSync(script, `
    import { main } from ${JSON.stringify(join(scanner, 'stage-playbook-agent/src/main.ts'))};
    await main(async request => ({
      id: 'mock-covered', model: request.model, status: 'completed', output: [],
      output_text: JSON.stringify({ reason: 'Covered by the built-ins.', builtin_classes: [], classes: [] }),
      usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 50, cache_write_tokens: 10 },
        output_tokens: 25, output_tokens_details: { reasoning_tokens: 5 } },
    }));
  `)
  execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' })
  const usage = JSON.parse(readFileSync(join(f.agentDir, 'usage.json'), 'utf8'))
  assert.equal(usage.calls.length, 1)
  assert.equal(usage.calls[0].usage.input_tokens_details.cache_write_tokens, 10)
  assert.deepEqual(JSON.parse(readFileSync(join(f.agentDir, 'classes-overlay.json'), 'utf8')), {})
  const records = readRunPlaybooks(join(f.root, 'no-hunt'), f.agentDir)
  assert.equal(records.length, 14)
  assert.ok(records.every(r => r.sha256.length === 64 && r.source_file))
  writeFileSync(script, `
    import { main } from ${JSON.stringify(join(scanner, 'stage-playbook-agent/src/main.ts'))};
    await main(async () => { throw new Error('mock request failure') });
  `)
  assert.throws(() => execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' }))
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, 'meta.json'), 'utf8')).exit_code, 1)
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, 'usage.json'), 'utf8')).calls[0].status, 'request_failed')
  assert.throws(f.runSelector, /UPSTREAM FAILED/)
})

test('Stage 0.5 agent mode, one file: only selected classes, no floor, unrouted selections still hunted', t => {
  const f = fixture(t)
  // deserialize reaches injection, integrity-failures and resource-consumption; only one is selected.
  f.publishSelection(['integrity-failures'])
  let out = JSON.parse(f.runSelector())
  assert.deepEqual(out.floor_classes, [])
  assert.deepEqual(out.class_selection, { source: 'playbook-agent', classes: ['integrity-failures'], unrouted: [] })
  assert.deepEqual(out.lanes[0].classes, ['integrity-failures'])
  assert.deepEqual(out.lanes[0].class_basis, { deserialize: ['integrity-failures'] })
  assert.ok(!out.lanes[0].classes.some((c: string) => signals.floor.includes(c)))
  assert.ok(!out.lanes[0].classes.includes('injection'), 'reached by signals but not selected')
  // A selected class no signal reaches (a former floor class) lands on the hunt lane.
  f.publishSelection(['injection', 'insecure-design'], f.overlay)
  out = JSON.parse(f.runSelector())
  assert.deepEqual(out.class_selection.unrouted, ['insecure-design'])
  assert.deepEqual(out.lanes[0].classes, ['injection', 'insecure-design', id])
  assert.deepEqual(out.lanes[0].class_basis, { deserialize: ['injection', id], 'selection-unrouted': ['insecure-design'] })
  assert.deepEqual(huntUnion(out), out.class_selection.classes)
  // An empty selection hunts nothing: the lane is skipped rather than left empty.
  f.publishSelection([])
  out = JSON.parse(f.runSelector())
  assert.equal(out.lanes[0].disposition, 'skip')
  assert.equal(out.lanes[0].skip_reason, 'No selected class applies to this file')
  assert.deepEqual(out.lanes[0].classes, [])
  assert.deepEqual(out.coverage_ledger, { total_files_in_inventory: 1, assigned_hunt: 0, assigned_skip: 1, unaccounted: 0 })
})

test('Stage 0.5 agent mode, several files: routing, skip lanes, unrouted classes on every hunt lane', t => {
  const f = fixture(t)
  f.retarget({
    'worker.ts': { language: 'typescript', signals: ['deserialize'] },
    'fetch.ts': { language: 'typescript', signals: ['http_outbound'] },
    'log.ts': { language: 'typescript', signals: ['logging'] },
    'plain.ts': { language: 'typescript', signals: [] },
    'settings.json': { language: 'json', signals: ['config_file'] },
  })
  const lane = (out: any, file: string) => out.lanes.find((l: any) => l.target_file === file)
  f.publishSelection(['injection', 'ssrf'])
  let out = JSON.parse(f.runSelector())
  assert.deepEqual(out.class_selection, { source: 'playbook-agent', classes: ['injection', 'ssrf'], unrouted: [] })
  assert.deepEqual(lane(out, 'worker.ts').classes, ['injection'])
  assert.deepEqual(lane(out, 'fetch.ts').classes, ['ssrf'], 'resource-consumption is reached but not selected')
  for (const file of ['log.ts', 'plain.ts']) {
    assert.equal(lane(out, file).disposition, 'skip')
    assert.equal(lane(out, file).skip_reason, 'No selected class applies to this file')
    assert.deepEqual(lane(out, file).classes, [])
  }
  assert.match(lane(out, 'settings.json').skip_reason, /Pure data/)
  assert.deepEqual(huntUnion(out), ['injection', 'ssrf'])
  assert.deepEqual(out.coverage_ledger, { total_files_in_inventory: 5, assigned_hunt: 2, assigned_skip: 3, unaccounted: 0 })
  f.publishSelection(['injection', 'sensitive-business-flows'])
  out = JSON.parse(f.runSelector())
  assert.deepEqual(out.class_selection.unrouted, ['sensitive-business-flows'])
  const hunted = out.lanes.filter((l: any) => l.disposition === 'hunt')
  assert.deepEqual(hunted.map((l: any) => l.target_file), ['fetch.ts', 'log.ts', 'plain.ts', 'worker.ts'])
  for (const l of hunted) {
    assert.ok(l.classes.includes('sensitive-business-flows'))
    assert.deepEqual(l.class_basis['selection-unrouted'], ['sensitive-business-flows'])
    assert.ok(!l.classes.some((c: string) => signals.floor.includes(c) || c === 'ssrf' || c === 'resource-consumption'))
  }
  assert.deepEqual(lane(out, 'worker.ts').classes, ['injection', 'sensitive-business-flows'])
  assert.deepEqual(huntUnion(out), out.class_selection.classes)
  assert.deepEqual(out.coverage_ledger, { total_files_in_inventory: 5, assigned_hunt: 4, assigned_skip: 1, unaccounted: 0 })
})

test('class selection is validated and refused when the agent stage recorded a failure', t => {
  const f = fixture(t)
  validateClassSelection(selectionOf(['injection'], [id]), builtins, f.overlay)
  for (const bad of [
    selectionOf(['not-a-builtin']), selectionOf(['injection'], [id]), selectionOf([], ['injection']),
    { ...selectionOf(['injection', 'ssrf']), classes: ['ssrf', 'injection'] },
    { ...selectionOf(['injection']), builtin: ['injection', 'injection'], classes: ['injection', 'injection'] },
    { ...selectionOf([]), schema: 'secscan.class-selection/0' },
  ]) assert.throws(() => validateClassSelection(bad as ClassSelection, builtins, {}))
  json(join(f.agentDir, CLASS_SELECTION_FILE), selectionOf(['injection']))
  json(join(f.agentDir, 'meta.json'), { provider, exit_code: 1 })
  assert.throws(f.runSelector, /UPSTREAM FAILED/)
  json(join(f.agentDir, 'meta.json'), { provider, exit_code: 0 })
  json(join(f.agentDir, CLASS_SELECTION_FILE), selectionOf(['not-a-builtin']))
  assert.throws(f.runSelector, /not a built-in/)
})

test('stage entrypoint writes the class selection: union of selected built-ins and researched additions', t => {
  const f = fixture(t)
  const script = join(f.root, 'stage.mts')
  writeFileSync(script, `
    import { main } from ${JSON.stringify(join(scanner, 'stage-playbook-agent/src/main.ts'))};
    import { playbook } from ${JSON.stringify(join(scanner, 'stage2-hunt-lanes-perfile/src/playbooks/access-control.ts'))};
    const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } };
    const source = 'https://example.test/worker-security';
    await main(async request => request.tools?.length ? {
      id: 'mock-research', model: request.model, status: 'completed', usage,
      output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['q'], sources: [{ type: 'url', url: source }] } }],
      output_text: JSON.stringify({ playbook: playbook.replace('Playbook for Access Control', 'Playbook for Worker Epoch Confusion'), source_urls: [source] }),
    } : {
      id: 'mock-coverage', model: request.model, status: 'completed', output: [], usage,
      output_text: JSON.stringify({ reason: 'Queue replay is uncovered.',
        builtin_classes: [{ id: 'injection', reason: 'Parsed input.' }, { id: 'integrity-failures', reason: 'Deserialization.' }],
        classes: [{ id: ${JSON.stringify(id)}, framework: 'generic', codes: ['CWE-362'], signals: ['deserialize'], reason: 'Replay.' }] }),
    });
  `)
  const log = execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' }).toString()
  assert.match(log, /Playbook agent: 3 class\(es\) selected \(2 built-in, 1 additional\); searched=true/)
  const selection = JSON.parse(readFileSync(join(f.agentDir, CLASS_SELECTION_FILE), 'utf8'))
  const plan = JSON.parse(readFileSync(join(f.agentDir, 'playbook-plan.json'), 'utf8'))
  assert.deepEqual(selection.classes, ['injection', 'integrity-failures', id])
  assert.deepEqual(selection.builtin, ['injection', 'integrity-failures'])
  assert.deepEqual(selection.added, [id])
  assert.deepEqual(plan.selected_classes, selection.classes)
  const out = JSON.parse(f.runSelector())
  assert.deepEqual(out.lanes[0].classes, selection.classes)
  assert.deepEqual(out.class_selection.classes, selection.classes)
})
