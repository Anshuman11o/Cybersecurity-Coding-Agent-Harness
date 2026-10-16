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
import { SpendLedger, ledgerPathFor } from '../../shared/ledger.js'
import { defaultProvider, productDefaultProvider, modelFor, targetFor } from '../../shared/provider.js'
import { loadRegistryModules } from '../../cli/src/registry.js'
import { readRunPlaybooks } from '../../cli/src/playbooks.js'
import { loadRecon, loopOptions } from './main.js'

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
// An added class whose codes match no OWASP/CWE pattern; every stage must carry them as written.
const freeId = 'mobile-platform-misuse', freeCodes = ['API10:2023', 'MASVS-PLATFORM'], freeText = 'Playbook text for a free-form-code fixture.\n'
function freeFormOverlay(cache: string): ClassesOverlay {
  const { playbook, codes, framework, model, sha256 } = writeCachedPlaybook(cache, freeText, {
    class_id: freeId, playbook: freeId, framework: 'generic', model: 'test/model', codes: freeCodes, signals: ['deserialize'],
    source_urls: ['https://example.test/mobile-platform'], queries: ['example query'], created_at: '2026-01-01T00:00:00Z',
  }).meta
  return { [freeId]: { playbook, codes, framework, model, sha256, signals: ['deserialize'] } }
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'playbook-hooks-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'target')
  mkdirSync(target)
  writeFileSync(join(target, 'worker.ts'), 'export const handle = (message: string) => JSON.parse(message)\n')
  // The loop switches are unset unless a test sets them: the default loop is under test.
  const env = { ...process.env, SCANNER_PLAYBOOK_LOOP: undefined, SCANNER_PLAYBOOK_LOOP_PASSES: undefined, SCANNER_PROFILE: 'product', SCANNER_TARGET: target,
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

test('playbook cache is run-scoped: each product run id has its own, a resume finds the same one', t => {
  const f = fixture(t)
  const base = { ...f.env, SCANNER_RUNS_ROOT: undefined }
  const first = resolveRunContext({ ...base, SCANNER_RUN_ID: 'first' }, [])
  const next = resolveRunContext({ ...base, SCANNER_RUN_ID: 'next' }, [])
  assert.equal(cacheRoot(first), join(f.target, '.secscan/runs/first/playbooks'))
  assert.equal(cacheRoot(next), join(f.target, '.secscan/runs/next/playbooks'))
  assert.notEqual(cacheRoot(first), cacheRoot(next))
  assert.notEqual(cacheRoot(next), join(f.target, '.secscan/playbooks'), 'never the reports folder shared by every run')
  const resumed = resolveRunContext({ ...base, SCANNER_RUN_ID: 'first', SCANNER_RESUME: '1' }, [])
  assert.equal(resumed.resume, true)
  assert.equal(cacheRoot(resumed), cacheRoot(first))
  // An artifact-root override carries the cache with it.
  assert.equal(f.cache, join(f.ctx.runsRoot, 'playbooks'))
  assert.ok(existsSync(join(f.cache, id, 'generic', 'test%2Fmodel', 'meta.json')))
})

test('custom reports root places the playbook cache under runs/<run-id>/playbooks', t => {
  const f = fixture(t)
  const reports = join(f.root, 'custom-reports')
  const first = resolveRunContext({ ...f.env, SCANNER_REPORTS_ROOT: reports, SCANNER_RUN_ID: 'first', SCANNER_RUNS_ROOT: undefined }, [])
  const next = resolveRunContext({ ...f.env, SCANNER_REPORTS_ROOT: reports, SCANNER_RUN_ID: 'next', SCANNER_RUNS_ROOT: undefined }, [])
  assert.equal(cacheRoot(first), join(reports, 'runs/first/playbooks'))
  assert.equal(cacheRoot(next), join(reports, 'runs/next/playbooks'))
  assert.notEqual(cacheRoot(first), cacheRoot(next))
  assert.equal(next.runsRoot, join(reports, 'runs/next'))
})

test('stage entrypoint clears a pre-existing playbook cache unless the run is resumed', t => {
  const f = fixture(t)
  const entry = join(f.cache, id, 'generic', 'test%2Fmodel', 'meta.json')
  const script = join(f.root, 'stage.mts')
  writeFileSync(script, `
    import { main } from ${JSON.stringify(join(scanner, 'stage-playbook-agent/src/main.ts'))};
    await main(async () => { throw new Error('mock request failure') });
  `)
  // Resumed: the run's own entries survive for the stages that read them back.
  assert.ok(existsSync(entry), 'the fixture wrote a synthetic cache entry')
  assert.throws(() => execFileSync(tsx, [script], { env: { ...f.env, SCANNER_RESUME: '1' }, stdio: 'pipe' }), /mock request failure/)
  assert.ok(existsSync(entry), 'a resumed run keeps its cache')
  assert.equal(readFileSync(join(f.cache, id, 'generic', 'test%2Fmodel', 'playbook.md'), 'utf8'), text)
  // New: the stage starts with an empty cache before any model call.
  assert.throws(() => execFileSync(tsx, [script], { env: { ...f.env, SCANNER_RESUME: undefined }, stdio: 'pipe' }), /mock request failure/)
  assert.ok(!existsSync(f.cache), 'a new run starts with an empty cache')
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
      output_text: JSON.stringify({ reason: 'Covered by the built-ins.', builtin_classes: [], classes: [], changes: [] }),
      usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 50, cache_write_tokens: 10 },
        output_tokens: 25, output_tokens_details: { reasoning_tokens: 5 } },
    }));
  `)
  execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' })
  const usage = JSON.parse(readFileSync(join(f.agentDir, 'usage.json'), 'utf8'))
  assert.deepEqual(usage.calls.map((c: any) => c.purpose), ['coverage', 'turn1', 'turn2:pass1', 'turn3'])
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
    await main(async (request, purpose) => purpose.startsWith('research:') ? {
      id: 'mock-research', model: request.model, status: 'completed', usage,
      output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['q'], sources: [{ type: 'url', url: source }] } }],
      output_text: JSON.stringify({ playbook: playbook.replace('Playbook for Access Control', 'Playbook for Worker Epoch Confusion'), source_urls: [source] }),
    } : {
      id: 'mock-coverage', model: request.model, status: 'completed', output: [], usage,
      output_text: JSON.stringify({ reason: 'Queue replay is uncovered.',
        builtin_classes: [{ id: 'injection', reason: 'Parsed input.' }, { id: 'integrity-failures', reason: 'Deserialization.' }],
        classes: [{ id: ${JSON.stringify(id)}, framework: 'generic', codes: ['CWE-362'], signals: ['deserialize'], reason: 'Replay.' }],
        changes: [] }),
    });
  `)
  const log = execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' }).toString()
  assert.match(log, /Playbook agent: 3 class\(es\) selected \(2 built-in, 1 additional\); turns=3; searches=1/)
  const labels = new SpendLedger(ledgerPathFor(f.ctx.runsRoot, provider)).list().map(e => e.label)
  assert.deepEqual(labels, ['coverage', 'turn1', 'turn2:pass1', 'turn3', `research:${id}`])
  const selection = JSON.parse(readFileSync(join(f.agentDir, CLASS_SELECTION_FILE), 'utf8'))
  const plan = JSON.parse(readFileSync(join(f.agentDir, 'playbook-plan.json'), 'utf8'))
  assert.deepEqual(selection.classes, ['injection', 'integrity-failures', id])
  assert.deepEqual(selection.builtin, ['injection', 'integrity-failures'])
  assert.deepEqual(selection.added, [id])
  assert.deepEqual(plan.selected_classes, selection.classes)
  const researched = plan.playbooks.find((p: any) => p.class_id === id)
  assert.deepEqual([researched.source_urls, researched.verified_source_urls, researched.unverified_source_urls],
    [['https://example.test/worker-security'], ['https://example.test/worker-security'], []])
  assert.deepEqual(plan.loop, { enabled: true, max_passes: 3, passes_run: 1 })
  assert.deepEqual(plan.turns.map((x: any) => x.purpose), ['turn1', 'turn2:pass1', 'turn3'])
  const decision = JSON.parse(readFileSync(join(f.agentDir, 'class-decision.json'), 'utf8'))
  assert.equal(decision.schema, 'secscan.class-decision/1')
  assert.deepEqual(decision.classes, selection.classes)
  assert.deepEqual(decision.builtin, selection.builtin)
  assert.deepEqual(decision.added.map((c: any) => c.id), selection.added)
  assert.deepEqual(decision.turns, plan.turns)
  assert.deepEqual(decision.loop, plan.loop)
  assert.match(log, /^\[playbook-agent\] decision saved: 3 classes \(2 built-in, 1 additional\)$/m)
  assert.match(log, new RegExp(`^\\[playbook-agent\\] research:${id} completed in=100 out=20 searches=1 bytes=\\d+ unverified=0$`, 'm'))
  assert.ok(log.indexOf('decision saved') < log.indexOf(`research:${id}`), 'the decision is saved before research')
  assert.ok(!existsSync(join(f.agentDir, 'research-failures')))
  const out = JSON.parse(f.runSelector())
  assert.deepEqual(out.lanes[0].classes, selection.classes)
  assert.deepEqual(out.class_selection.classes, selection.classes)
})

test('stage entrypoint: a failed research call keeps the decision and a debug record, and the stage still fails', t => {
  const f = fixture(t)
  const script = join(f.root, 'stage.mts')
  writeFileSync(script, `
    import { main } from ${JSON.stringify(join(scanner, 'stage-playbook-agent/src/main.ts'))};
    import { playbook } from ${JSON.stringify(join(scanner, 'stage2-hunt-lanes-perfile/src/playbooks/access-control.ts'))};
    const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } };
    const source = 'https://example.test/worker-security';
    const long = playbook.replace('Playbook for Access Control', 'Playbook for Worker Epoch Confusion') + 'Padding line for size.\\n'.repeat(300);
    await main(async (request, purpose) => purpose.startsWith('research:') ? {
      id: 'mock-research', model: request.model, status: 'completed', usage,
      output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['q'], sources: [{ type: 'url', url: source }] } }],
      output_text: JSON.stringify({ playbook: long, source_urls: [source] }),
    } : {
      id: 'mock-coverage', model: request.model, status: 'completed', output: [], usage,
      output_text: JSON.stringify({ reason: 'Queue replay is uncovered.',
        builtin_classes: [{ id: 'injection', reason: 'Parsed input.' }],
        classes: [{ id: ${JSON.stringify(id)}, framework: 'example-queue', codes: ['CWE-362'], signals: ['deserialize'], reason: 'Replay.' }],
        changes: [] }),
    });
  `)
  let failure: any
  try { execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' }) } catch (error) { failure = error }
  assert.ok(failure, 'the stage fails')
  assert.equal(failure.status, 1)
  assert.match(failure.stderr.toString(), /Generated playbook must be roughly 2–6 KB/)
  const log = failure.stdout.toString()
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, 'meta.json'), 'utf8')).exit_code, 1)
  const decision = JSON.parse(readFileSync(join(f.agentDir, 'class-decision.json'), 'utf8'))
  assert.deepEqual(decision.classes, ['injection', id])
  assert.deepEqual(decision.builtin, ['injection'])
  assert.deepEqual(decision.added, [{ id, framework: 'example-queue', codes: ['CWE-362'], signals: ['deserialize'], reason: 'Replay.' }])
  assert.deepEqual(decision.loop, { enabled: true, max_passes: 3, passes_run: 1 })
  for (const file of ['playbook-plan.json', 'classes-overlay.json', CLASS_SELECTION_FILE]) assert.ok(!existsSync(join(f.agentDir, file)), file)
  const record = JSON.parse(readFileSync(join(f.agentDir, 'research-failures', `${id}.json`), 'utf8'))
  assert.equal(record.check, 'size')
  assert.equal(record.error, 'Generated playbook must be roughly 2–6 KB')
  assert.ok(record.byte_size > 8000)
  assert.equal(record.byte_size, Buffer.byteLength(record.playbook_text))
  assert.match(record.playbook_text, /^\s*Playbook for Worker Epoch Confusion/)
  assert.match(record.playbook_text, /(Padding line for size\.\n){300}$/)
  assert.deepEqual(record.missing_sections, [])
  assert.deepEqual(record.size_bounds, [1500, 8000])
  assert.deepEqual(record.search_source_urls, ['https://example.test/worker-security'])
  assert.equal(record.reasoning_tokens, 7)
  assert.match(log, /^\[playbook-agent\] decision saved: 2 classes \(1 built-in, 1 additional\)$/m)
  assert.match(log, new RegExp(`^\\[playbook-agent\\] research:${id} completed in=100 out=20 searches=1 bytes=${record.byte_size} unverified=0$`, 'm'))
  // Both revisions return the same oversized playbook; the record is the last attempt's and lists every attempt.
  for (const n of [1, 2]) {
    assert.match(log, new RegExp(`^\\[playbook-agent\\] research:${id}:revise${n} completed in=100 out=20 searches=1 bytes=${record.byte_size}->${record.byte_size} problems=size$`, 'm'))
  }
  assert.equal(record.purpose, `research:${id}:revise2`)
  assert.deepEqual(record.attempts, ['', ':revise1', ':revise2'].map(s => ({ purpose: `research:${id}${s}`, bytes: record.byte_size, problems: ['size'] })))
  assert.match(log, new RegExp(`^\\[playbook-agent\\] research:${id}:revise2 FAILED check=size bytes=${record.byte_size} \\(bounds 1500-8000\\) missing=-$`, 'm'))
  const usage = JSON.parse(readFileSync(join(f.agentDir, 'usage.json'), 'utf8'))
  assert.deepEqual(usage.calls.map((c: any) => c.purpose), ['coverage', 'turn1', 'turn2:pass1', 'turn3', `research:${id}`,
    `research:${id}:revise1`, `research:${id}:revise2`])
})

test('stage entrypoint removes a stale class decision before anything else', t => {
  const f = fixture(t)
  json(join(f.agentDir, 'class-decision.json'), { schema: 'secscan.class-decision/1', classes: ['stale'] })
  const script = join(f.root, 'stage.mts')
  writeFileSync(script, `
    import { main } from ${JSON.stringify(join(scanner, 'stage-playbook-agent/src/main.ts'))};
    await main(async () => { throw new Error('mock request failure') });
  `)
  assert.throws(() => execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' }), /mock request failure/)
  assert.ok(!existsSync(join(f.agentDir, 'class-decision.json')), 'a stale decision never survives into a new attempt')
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, 'meta.json'), 'utf8')).exit_code, 1)
})

test('stage entrypoint: additional-class codes outside the strict format complete the run and are stored verbatim', t => {
  const f = fixture(t)
  const added = 'mobile-platform-misuse', codes = ['API10:2023', 'MASVS-PLATFORM']
  const script = join(f.root, 'stage.mts')
  writeFileSync(script, `
    import { main } from ${JSON.stringify(join(scanner, 'stage-playbook-agent/src/main.ts'))};
    import { playbook } from ${JSON.stringify(join(scanner, 'stage2-hunt-lanes-perfile/src/playbooks/access-control.ts'))};
    const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } };
    const source = 'https://example.test/mobile-platform';
    await main(async (request, purpose) => purpose.startsWith('research:') ? {
      id: 'mock-research', model: request.model, status: 'completed', usage,
      output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['q'], sources: [{ type: 'url', url: source }] } }],
      output_text: JSON.stringify({ playbook: playbook.replace('Playbook for Access Control', 'Playbook for Mobile Platform Misuse'), source_urls: [source] }),
    } : {
      id: 'mock-coverage', model: request.model, status: 'completed', output: [], usage,
      output_text: JSON.stringify({ reason: 'Platform API misuse is uncovered.',
        builtin_classes: [{ id: 'injection', reason: 'Parsed input.' }],
        classes: [{ id: ${JSON.stringify(added)}, framework: 'generic', codes: ${JSON.stringify(codes)}, signals: ['deserialize'], reason: 'Platform.' }],
        changes: [] }),
    });
  `)
  const log = execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' }).toString()
  assert.match(log, /Playbook agent: 2 class\(es\) selected \(1 built-in, 1 additional\)/)
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, 'meta.json'), 'utf8')).exit_code, 0)
  const overlay = JSON.parse(readFileSync(join(f.agentDir, 'classes-overlay.json'), 'utf8'))
  const selection = JSON.parse(readFileSync(join(f.agentDir, CLASS_SELECTION_FILE), 'utf8'))
  assert.deepEqual(Object.keys(overlay), [added])
  assert.deepEqual(overlay[added].codes, codes)
  assert.deepEqual(selection.added, [added])
  assert.deepEqual(selection.classes, ['injection', added])
  const meta = JSON.parse(readFileSync(join(f.cache, added, 'generic', encodeURIComponent(overlay[added].model), 'meta.json'), 'utf8'))
  assert.deepEqual(meta.codes, codes)
})

test('Stage 0.5 agent mode, one file: an added class with free-form codes is accepted and reaches the hunt lane', t => {
  const f = fixture(t)
  f.publishSelection(['injection'], freeFormOverlay(f.cache))
  const out = JSON.parse(f.runSelector())
  assert.deepEqual(out.class_selection, { source: 'playbook-agent', classes: ['injection', freeId], unrouted: [] })
  assert.equal(out.lanes[0].disposition, 'hunt')
  assert.deepEqual(out.lanes[0].classes, ['injection', freeId])
  assert.deepEqual(out.lanes[0].class_basis, { deserialize: ['injection', freeId] })
})

test('Stage 1 and Stage 2 accept free-form codes and carry them verbatim; no model call', t => {
  const f = fixture(t)
  const overlay = freeFormOverlay(f.cache)
  const registry = { ...builtins }, sizes = new Map([['injection', 123]])
  addOverlayPlaybookSizes(registry, sizes, overlay, signals, f.cache)
  assert.deepEqual(registry[freeId].codes, freeCodes)
  assert.equal(sizes.get(freeId), freeText.length)
  // Stage 2 builds its registry with mergeClassTables over the shipped tables.
  const merged = mergeClassTables(builtins, signals, overlay)
  assert.deepEqual(merged.registry[freeId].codes, freeCodes)
  assert.deepEqual(merged.signalMap.signals.deserialize, [...signals.signals.deserialize, freeId])
  // The hunt executor's own load, import only: a finding of the class takes its codes from that registry.
  f.publish(overlay)
  const script = join(f.root, 'load.mts')
  const resultFile = join(f.root, 'loaded.json')
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs';
    import { loadPlaybooksForClasses, describePlaybooks, mergeFindings } from ${JSON.stringify(join(scanner, 'stage2-hunt-lanes-perfile/src/hunt-executor.ts'))};
    const ids = [${JSON.stringify(freeId)}];
    const loaded = await loadPlaybooksForClasses(ids);
    const finding = { finding_id: 'f1', lane_id: 'l1', finding_classes: [{ class: ids[0], justified_by_step: 1 }], categories: [],
      title: 'Finding', description: 'Finding.', severity_estimate: 'low', confidence: 0.5,
      trace: [{ kind: 'entrypoint', file: 'worker.ts', line: 1, description: 'In.' }, { kind: 'sink', file: 'worker.ts', line: 2, description: 'Out.' }] };
    const { merged } = mergeFindings([finding], [finding]);
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ loaded: [...loaded], records: describePlaybooks(ids, loaded), categories: merged[0].categories }));
  `)
  execFileSync(tsx, [script], { env: f.env, stdio: 'pipe' })
  const result = JSON.parse(readFileSync(resultFile, 'utf8'))
  assert.equal(new Map(result.loaded).get(freeId), freeText)
  assert.equal(result.records[0].sha256, textHash(freeText))
  assert.deepEqual(result.categories, freeCodes)
})

test('loop switches: SCANNER_PLAYBOOK_LOOP=0 disables the turns; passes must be a positive integer', () => {
  assert.deepEqual(loopOptions({}), { enabled: true, maxPasses: 3 })
  assert.deepEqual(loopOptions({ SCANNER_PLAYBOOK_LOOP: '0' }), { enabled: false, maxPasses: 3 })
  for (const on of ['1', 'false', 'off', '']) assert.equal(loopOptions({ SCANNER_PLAYBOOK_LOOP: on }).enabled, true)
  assert.deepEqual(loopOptions({ SCANNER_PLAYBOOK_LOOP_PASSES: '5' }), { enabled: true, maxPasses: 5 })
  for (const bad of ['0', '-1', '1.5', '2x', ' 2', 'abc', '', '99999999999999999999']) {
    assert.throws(() => loopOptions({ SCANNER_PLAYBOOK_LOOP_PASSES: bad }), /SCANNER_PLAYBOOK_LOOP_PASSES must be a positive integer/)
  }
})

test('stage entrypoint: loop off makes one decision call; an invalid pass count fails at startup with no model call', t => {
  const f = fixture(t)
  const script = join(f.root, 'stage.mts')
  writeFileSync(script, `
    import { main } from ${JSON.stringify(join(scanner, 'stage-playbook-agent/src/main.ts'))};
    await main(async request => ({
      id: 'mock-covered', model: request.model, status: 'completed', output: [],
      output_text: JSON.stringify({ reason: 'Covered by the built-ins.', builtin_classes: [{ id: 'injection', reason: 'Parsed input.' }], classes: [] }),
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } },
    }));
  `)
  const log = execFileSync(tsx, [script], { env: { ...f.env, SCANNER_PLAYBOOK_LOOP: '0' }, stdio: 'pipe' }).toString()
  assert.match(log, /Playbook agent: 1 class\(es\) selected \(1 built-in, 0 additional\); turns=0; searches=0/)
  const plan = JSON.parse(readFileSync(join(f.agentDir, 'playbook-plan.json'), 'utf8'))
  assert.deepEqual(plan.loop, { enabled: false, max_passes: 3, passes_run: 0 })
  assert.deepEqual(plan.turns, [])
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, 'usage.json'), 'utf8')).calls.length, 1)
  assert.throws(() => execFileSync(tsx, [script], { env: { ...f.env, SCANNER_PLAYBOOK_LOOP_PASSES: 'three' }, stdio: 'pipe' }),
    /SCANNER_PLAYBOOK_LOOP_PASSES must be a positive integer/)
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, 'meta.json'), 'utf8')).exit_code, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(f.agentDir, 'usage.json'), 'utf8')).calls, [], 'no model call was made')
})
