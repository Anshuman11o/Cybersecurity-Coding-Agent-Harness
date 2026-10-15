/** Generic C signals and a routeless Makefile-only repository; no model calls. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { selectFilesWithRunsRoot } from './file-selection.js'
import { detectAllSignalsFromList, detectSinkSignals } from './signal-detector.js'
import { extractSymbolTable } from './symbols.js'
import { buildRepoMap, selectEntryPoints, selectManifests } from './repo-map.js'
import { deterministicArchitecture, detectToolCallingDeterministic, probeDeterministic } from './llm-probe.js'
import { detectExpress } from './ast-extractor.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

test('C review surfaces are routed using generic C signals', () => {
  const fixtures: [string, string][] = [
    ['strcpy(dst, src); strcat(dst, tail); sprintf(dst, "%s", src); gets(dst);', 'deserialize'],
    ['scanf("%s", input);', 'deserialize'],
    ['memcpy(dst, src, count * sizeof(*src)); memmove(dst, src, n); memset(dst, 0, n);', 'deserialize'],
    ['for (int i = 0; i <= limit; ++i) { array[i] = value; }', 'deserialize'],
    ['p = malloc(count * sizeof(*p)); q = calloc(count, size); p = realloc(p, size);', 'deserialize'],
    ['free(p); p[0] = 1;', 'deserialize'],
    ['free(p); free(p);', 'deserialize'],
    ['printf(input); fprintf(stderr, input);', 'deserialize'],
    ['snprintf(dst, cap, input);', 'deserialize'],
    ['system(command); popen(command, "r"); execvp(path, argv);', 'dynamic_exec'],
    ['fopen(path, "r"); open(path, flags); getenv("CONFIG_PATH");', 'file_io'],
    ['sprintf(sql, "SELECT * FROM items WHERE name = %s", input);', 'db_query'],
    ['srand(seed); token = rand();', 'crypto_op'],
    ['syslog(LOG_ERR, "failed");', 'logging'],
    ['access(path, R_OK); pam_authenticate(handle, 0);', 'auth_check'],
  ]
  for (const [source, signal] of fixtures) assert.ok(detectSinkSignals('c', source).includes(signal as any), source)
  assert.deepEqual(detectSinkSignals('c', 'assert(valid); signal(SIGINT, handler); pthread_create(&t, 0, worker, &shared);'), [])
  assert.deepEqual(detectSinkSignals('c', 'int sum(int a, int b) { return a + b; }'), [])
  assert.ok(!detectSinkSignals('c', 'printf("%s", input); fprintf(stderr, "%s", input); snprintf(dst, cap, "%s", input);').includes('deserialize'))
  assert.ok(!detectSinkSignals('c', 'object.query(value);').includes('db_query'))
})

test('deterministic recon and the real per-file selector handle a routeless Makefile-only repo', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c-readiness-'))
  try {
    const target = path.join(tmp, 'target'), runs = path.join(tmp, 'reports')
    fs.mkdirSync(path.join(target, 'src'), { recursive: true })
    fs.writeFileSync(path.join(target, 'Makefile'), 'all:\n\tcc src/main.c -o app\n')
    fs.writeFileSync(path.join(target, 'src/main.c'), '#include <stdio.h>\nint main(void) { char b[16]; scanf("%s", b); return 0; }\n')
    fs.writeFileSync(path.join(target, 'src/worker.c'), 'int twice(int n) { return n * 2; }\n')
    const inventory = selectFilesWithRunsRoot(target, {}, runs, { env: {} })
    assert.deepEqual(inventory.files.map(f => f.path), ['src/main.c', 'src/worker.c'])
    assert.ok(inventory.files.every(f => f.language === 'c'))
    assert.equal(detectExpress(target).isExpress, false)
    const symbols = await extractSymbolTable(target, inventory.files, { isCorpusReadable: () => true })
    assert.ok(symbols.files['src/main.c'].symbols.some(s => s.name === 'main'))
    const guard = { isReadable: (p: string) => fs.existsSync(path.join(target, p)), read: (p: string) => fs.readFileSync(path.join(target, p), 'utf8') }
    const signals = detectAllSignalsFromList(target, inventory.files, new Set(), symbols, guard.read)
    const entryPoints = selectEntryPoints(inventory.files, symbols, null, guard)
    assert.ok(entryPoints.some(e => e.path === 'src/main.c'))
    assert.deepEqual(selectManifests(inventory.files, guard), [])
    const map = buildRepoMap({ targetDir: target, inventory: inventory.files, symbols, signals: signals.files, routes: [], autoCrud: [], routeSource: null, entryPoints, guard })
    assert.ok(map.text.includes('src/main.c'))
    const architecture = deterministicArchitecture({ manifests: [], symbols, eligiblePaths: new Set(inventory.files.map(f => f.path)), entryPoints, languages: { c: 2 }, fileCount: 2, routeCount: 0, routeSource: null })
    const arch = { target_dir: target, architecture, route_table: { hand_written_routes: [], middleware_routes: [], auto_crud_routes: [], total_routes: 0 }, file_inventory: { total_source_files: inventory.files.length } }
    const verdicts = probeDeterministic(JSON.stringify(arch), false, detectToolCallingDeterministic(map.text), [], '')
    const provider = JSON.parse(fs.readFileSync(path.join(repo, 'tools/scanner/shared/models.json'), 'utf8')).default_provider
    const stage = path.join(runs, provider, 'stage0-recon')
    fs.mkdirSync(stage, { recursive: true })
    for (const [name, data] of Object.entries({ 'file-inventory.json': inventory, 'file-signals.json': signals, 'architecture-summary.json': arch, 'category-applicability.json': verdicts, 'meta.json': { provider, exit_code: 0 } })) fs.writeFileSync(path.join(stage, name), JSON.stringify(data))
    const result = spawnSync(path.join(repo, 'tools/scanner/stage05-lane-selector-perfile/node_modules/.bin/tsx'), [path.join(repo, 'tools/scanner/stage05-lane-selector-perfile/src/lane-selector-perfile.ts')], { encoding: 'utf8', env: { ...process.env, SCANNER_PROVIDER: provider, SCANNER_PROFILE: 'product', SCANNER_TARGET: target, SCANNER_REPORTS_ROOT: runs, SCANNER_RUNS_ROOT: runs, SCANNER_PLAYBOOK_AGENT: '0' } })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const lanes = JSON.parse(fs.readFileSync(path.join(runs, provider, 'stage05-lane-selector-perfile/lane-assignments.json'), 'utf8'))
    assert.equal(lanes.coverage_ledger.assigned_hunt, 2)
    assert.equal(lanes.coverage_ledger.unaccounted, 0)
    assert.ok(lanes.lanes.every((l: any) => l.disposition === 'hunt' && l.classes.length > 0))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
