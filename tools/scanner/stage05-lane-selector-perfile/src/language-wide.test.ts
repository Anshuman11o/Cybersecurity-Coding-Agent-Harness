// Agent mode: agent-added classes whose framework names a file language go on
// every hunt lane in that language (language-wide), and rescue lanes that would
// otherwise be skipped with no selected class. Synthetic fixtures only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FRAMEWORK_LANGUAGE_ALIASES, frameworkLanguages } from '../../shared/lane-languages.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const scanner = path.resolve(here, '../..')
const tsx = path.join(scanner, 'shared/node_modules/tsx/dist/cli.mjs')
const provider = JSON.parse(fs.readFileSync(path.join(scanner, 'shared/models.json'), 'utf8')).default_provider

type Files = Record<string, { language: string; signals: string[] }>
interface AddedClass { framework: string; signals: string[] }

const FILES: Files = {
  'src/alloc.c': { language: 'c', signals: [] },
  'src/parse.c': { language: 'c', signals: ['deserialize'] },
  'src/util.h': { language: 'c', signals: [] },
  'tools/build.py': { language: 'python', signals: [] },
  'tools/load.py': { language: 'python', signals: ['deserialize'] },
  'app/Main.kt': { language: 'kotlin', signals: [] },
  'app/Legacy.java': { language: 'java', signals: [] },
  'conf/settings.json': { language: 'json', signals: ['config_file'] },
}

function runSelector(files: Files, agent: { builtin: string[]; added: Record<string, AddedClass>; recon_kept?: string[] } | null,
  overlayOnly: Record<string, AddedClass> | null = null): { raw: string; out: any; log: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'language-wide-'))
  try {
    const target = path.join(tmp, 'target'), runs = path.join(tmp, 'runs')
    const paths = Object.keys(files).sort()
    for (const p of paths) {
      fs.mkdirSync(path.dirname(path.join(target, p)), { recursive: true })
      fs.writeFileSync(path.join(target, p), 'synthetic fixture line\n')
    }
    const json = (file: string, data: unknown) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(data))
    }
    const stage0 = path.join(runs, provider, 'stage0-recon')
    json(path.join(stage0, 'architecture-summary.json'), { file_inventory: { total_source_files: paths.length } })
    json(path.join(stage0, 'category-applicability.json'), [{ name: 'A03: Injection', framework: 'owasp', verdict: 'present' }])
    json(path.join(stage0, 'file-signals.json'), { target_dir: target, files: Object.fromEntries(paths.map(p => [p, files[p].signals])) })
    json(path.join(stage0, 'file-inventory.json'), {
      target_dir: target,
      files: paths.map(p => ({ path: p, language: files[p].language, bytes: 23, empty: false, test: false, oversize: false })),
      totals: { test: 0, oversize: 0, empty: 0, excluded_files: 0, excluded_dirs: 0 }, options: { max_file_bytes: 200000 },
    })
    json(path.join(stage0, 'meta.json'), { provider, exit_code: 0 })
    const agentDir = path.join(runs, provider, 'stage-playbook-agent')
    const overlayOf = (added: Record<string, AddedClass>) => Object.fromEntries(Object.entries(added).map(([id, c]) => [id, {
      playbook: id, codes: ['CWE-000'], signals: c.signals, framework: c.framework, model: 'test/model', sha256: 'a'.repeat(64),
    }]))
    if (agent) {
      json(path.join(agentDir, 'classes-overlay.json'), overlayOf(agent.added))
      const added = Object.keys(agent.added)
      json(path.join(agentDir, 'class-selection.json'), {
        schema: 'secscan.class-selection/1', created_at: '2026-01-01T00:00:00Z', model: 'test/model',
        builtin: agent.builtin, added, classes: [...agent.builtin, ...added].sort(),
        ...(agent.recon_kept ? { recon_kept: agent.recon_kept } : {}),
      })
      json(path.join(agentDir, 'meta.json'), { provider, exit_code: 0 })
    } else if (overlayOnly) {
      json(path.join(agentDir, 'classes-overlay.json'), overlayOf(overlayOnly))
      json(path.join(agentDir, 'meta.json'), { provider, exit_code: 0 })
    }
    const freeze = path.join(tmp, 'freeze.mjs')
    fs.writeFileSync(freeze, `const RealDate = Date; globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-01-01T00:00:00.000Z'])); }
      static now() { return new RealDate('2026-01-01T00:00:00.000Z').getTime(); }
    }`)
    const env: NodeJS.ProcessEnv = { ...process.env, SCANNER_TARGET: target, SCANNER_PROFILE: 'product', SCANNER_RUNS_ROOT: runs, SCANNER_PROVIDER: provider, SCANNER_RUN_ID: 'unit' }
    delete env.SCANNER_PLAYBOOK_AGENT
    const log = execFileSync(process.execPath, [tsx, '--import', freeze, path.join(here, 'lane-selector-perfile.ts')], { env, stdio: 'pipe' }).toString()
    const raw = fs.readFileSync(path.join(runs, provider, 'stage05-lane-selector-perfile/lane-assignments.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const normalized = raw.split(JSON.stringify(target)).join(JSON.stringify('<target>'))
      .replace(JSON.stringify(parsed.source_stage0_run), JSON.stringify('<stage0>/architecture-summary.json'))
    return { raw: normalized, out: parsed, log }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

const lane = (out: any, file: string) => out.lanes.find((l: any) => l.target_file === file)
const huntUnion = (out: any) => [...new Set(out.lanes.filter((l: any) => l.disposition === 'hunt').flatMap((l: any) => l.classes))].sort()

test('framework table: languages map to themselves, aliases expand, unknown frameworks map to nothing', () => {
  assert.deepEqual(frameworkLanguages('c'), ['c'])
  assert.deepEqual(frameworkLanguages('cpp'), ['cpp'])
  assert.deepEqual(frameworkLanguages('solidity'), ['solidity'])
  assert.deepEqual(frameworkLanguages('Kotlin'), ['kotlin'])
  assert.deepEqual(frameworkLanguages('android'), ['kotlin', 'java'])
  assert.deepEqual(frameworkLanguages('c/c++'), ['c', 'cpp'])
  assert.deepEqual(frameworkLanguages('c++'), ['c', 'cpp'])
  assert.deepEqual(frameworkLanguages('evm'), ['solidity'])
  assert.deepEqual(frameworkLanguages('ethereum'), ['solidity'])
  for (const fw of ['django', 'generic', 'example-queue', '']) assert.deepEqual(frameworkLanguages(fw), [])
  assert.ok(Object.isFrozen(FRAMEWORK_LANGUAGE_ALIASES))
})

test('C framework: an added class reaches every C hunt lane, rescues signal-less files, never reaches Python', () => {
  const { out, log } = runSelector(FILES, {
    builtin: ['injection'], added: { 'memory-safety': { framework: 'c', signals: ['deserialize'] } },
  })
  for (const f of ['src/alloc.c', 'src/util.h']) {
    assert.equal(lane(out, f).disposition, 'hunt', f)
    assert.deepEqual(lane(out, f).classes, ['memory-safety'], f)
    assert.deepEqual(lane(out, f).class_basis, { 'language-wide': ['memory-safety'], 'language-base': ['memory-safety'] }, f)
  }
  assert.deepEqual(lane(out, 'src/parse.c').classes, ['injection', 'memory-safety'])
  assert.deepEqual(lane(out, 'src/parse.c').class_basis, { deserialize: ['injection', 'memory-safety'], 'language-wide': ['memory-safety'] })
  // A Python file reaches the C class only through its own signal, as before; never language-wide.
  assert.deepEqual(lane(out, 'tools/load.py').classes, ['injection', 'memory-safety'])
  assert.deepEqual(lane(out, 'tools/load.py').class_basis, { deserialize: ['injection', 'memory-safety'] })
  assert.equal(lane(out, 'tools/build.py').disposition, 'skip')
  assert.equal(lane(out, 'tools/build.py').skip_reason, 'No selected class applies to this file')
  for (const f of ['app/Main.kt', 'app/Legacy.java']) assert.equal(lane(out, f).disposition, 'skip', f)
  assert.deepEqual(out.class_selection.unrouted, [])
  assert.deepEqual(huntUnion(out), out.class_selection.classes)
  assert.match(log, /3 lane\(s\) received language-wide classes, 2 lane\(s\) rescued from skip by base classes/)
})

test('android alias: the class reaches Kotlin and Java lanes, not Python', () => {
  const { out, log } = runSelector(FILES, {
    builtin: [], added: { 'mobile-ipc': { framework: 'android', signals: ['file_io'] } },
  })
  for (const f of ['app/Main.kt', 'app/Legacy.java']) {
    assert.equal(lane(out, f).disposition, 'hunt', f)
    assert.deepEqual(lane(out, f).classes, ['mobile-ipc'], f)
    assert.deepEqual(lane(out, f).class_basis['language-wide'], ['mobile-ipc'], f)
  }
  for (const f of ['tools/build.py', 'tools/load.py', 'src/alloc.c', 'src/parse.c', 'src/util.h']) {
    assert.equal(lane(out, f).disposition, 'skip', f)
  }
  assert.deepEqual(huntUnion(out), ['mobile-ipc'])
  assert.match(log, /2 lane\(s\) received language-wide classes, 2 lane\(s\) rescued/)
})

test('unknown framework: routing is signal-only, exactly as before', () => {
  const { out, log } = runSelector(FILES, {
    builtin: ['injection'], added: { 'orm-misuse': { framework: 'django', signals: ['deserialize'] } },
  })
  for (const f of ['src/parse.c', 'tools/load.py']) {
    assert.deepEqual(lane(out, f).classes, ['injection', 'orm-misuse'], f)
    assert.deepEqual(lane(out, f).class_basis, { deserialize: ['injection', 'orm-misuse'] }, f)
  }
  for (const f of ['src/alloc.c', 'src/util.h', 'tools/build.py', 'app/Main.kt', 'app/Legacy.java']) {
    assert.equal(lane(out, f).disposition, 'skip', f)
    assert.equal(lane(out, f).skip_reason, 'No selected class applies to this file', f)
  }
  assert.ok(out.lanes.every((l: any) => !('language-wide' in l.class_basis) && !('language-base' in l.class_basis)))
  assert.match(log, /0 lane\(s\) received language-wide classes, 0 lane\(s\) rescued/)
})

test('a language-wide class still goes on every hunt lane when no file of its language hunts (unrouted rule)', () => {
  const files: Files = { 'tools/load.py': { language: 'python', signals: ['deserialize'] } }
  const { out } = runSelector(files, {
    builtin: ['injection'], added: { 'contract-reentrancy': { framework: 'evm', signals: ['file_io'] } },
  })
  assert.deepEqual(out.class_selection.unrouted, ['contract-reentrancy'])
  assert.deepEqual(lane(out, 'tools/load.py').classes, ['contract-reentrancy', 'injection'])
  assert.deepEqual(huntUnion(out), out.class_selection.classes)
})

test('no agent selection: lane manifest is byte-identical to the pre-change selector', () => {
  const golden = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8')
  assert.equal(runSelector(FILES, null).raw, golden('lane-assignments-no-selection.json'))
  // An overlay without a selection (fixed-class mode) routes by signals only, as before.
  const overlayOnly = { 'memory-safety': { framework: 'c', signals: ['deserialize'] } }
  assert.equal(runSelector(FILES, null, overlayOnly).raw, golden('lane-assignments-overlay-no-selection.json'))
})

test('a recon-kept built-in goes only where its signals reach a hunted file, never onto every lane', () => {
  // misconfiguration is routed only by config_file, which fires here only on a skipped JSON file.
  const control = runSelector(FILES, { builtin: ['injection', 'misconfiguration'], added: {} })
  assert.ok(lane(control.out, 'tools/load.py').classes.includes('misconfiguration'), 'agent-selected unrouted class spreads (unchanged rule)')
  const kept = runSelector(FILES, { builtin: ['injection', 'misconfiguration'], added: {}, recon_kept: ['misconfiguration'] })
  assert.ok(!huntUnion(kept.out).includes('misconfiguration'))
  assert.deepEqual(kept.out.class_selection.unrouted, [])
  assert.match(kept.log, /Recon-kept classes with no hunted file in signal reach \(not hunted\): misconfiguration/)
  // A recon-kept class whose signal does reach a hunted file is routed there as usual.
  const reached = runSelector(FILES, { builtin: ['injection'], added: {}, recon_kept: ['injection'] })
  assert.ok(lane(reached.out, 'tools/load.py').classes.includes('injection'))
})
