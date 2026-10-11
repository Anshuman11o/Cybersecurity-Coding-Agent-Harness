/**
 * Report stage tests (plan §3.2, Report row): every file:line resolves to the
 * cited line, every finding carries the §4.2 fields, SARIF has the 2.1.0 shape
 * with stable fingerprints, permalinks are commit-pinned and only where the
 * file matches the commit — and older Stage 2 output without the explanation
 * fields still produces a full report.
 *
 * Builds a throwaway git repository outside this one, so nothing here reads
 * the benchmark corpus.
 *
 * Run: npx tsx src/report.test.ts
 */
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildReport, fingerprintOf, redactPem, skipCategory, EXPLANATION_FIELDS } from './build.js'
import { parseGithubRemote, permalink, repoInfo } from './git.js'
import { renderHtml } from './render-html.js'
import { renderMarkdown } from './render-md.js'
import { SARIF_FINGERPRINT_KEY, toSarif } from './sarif.js'
import { listRunIds, planPrune, refreshStore } from './runs-store.js'
import { main as runsMain } from './runs.js'
import type { BuildEnv, InFinding, ReportInputs } from './types.js'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = JSON.parse(readFileSync(join(PKG, '../shared/vuln-classes.json'), 'utf-8'))
const SIGNALS = JSON.parse(readFileSync(join(PKG, '../shared/signal-classes.json'), 'utf-8'))
const BENCH = JSON.parse(readFileSync(join(PKG, 'benchmark-reference.json'), 'utf-8'))

// ── Fixture repository ──────────────────────────────────────────────────────

const root = realpathSync(mkdtempSync(join(tmpdir(), 'report-test-')))
const target = join(root, 'app')
const git = (...a: string[]) => execFileSync('git', ['-C', target, ...a], { encoding: 'utf-8' }).trim()

const LOGIN = [
  "import { db } from './db'",                                   // 1
  '',                                                            // 2
  'export function login(req, res) {',                           // 3
  '  const email = req.body.email',                              // 4
  "  const q = `SELECT * FROM users WHERE email = '${email}'`",   // 5
  '  return db.query(q)',                                        // 6
  '}',                                                           // 7
  '',                                                            // 8
].join('\n')
const KEYS = [
  "const a = 'x'",
  "const k = '-----BEGIN RSA PRIVATE KEY-----",
  'MIIEowIBAAKCAQEAsecretsecretsecret',
  'moresecretmaterial==',
  "-----END RSA PRIVATE KEY-----'",
  'export const sign = (u) => jwt.sign(u, k)',
].join('\n')

mkdirSync(join(target, 'src'), { recursive: true })
mkdirSync(join(target, 'styles'), { recursive: true })
writeFileSync(join(target, 'src/login.js'), LOGIN)
writeFileSync(join(target, 'src/keys.js'), KEYS)
writeFileSync(join(target, 'src/util.py'), 'def f(x):\n    return eval(x)\n')
writeFileSync(join(target, 'styles/site.css'), 'body { color: red }\n')
execFileSync('git', ['init', '-q', target])
git('remote', 'add', 'origin', 'git@github.com:acme/shop.git')
git('add', '.')
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
const SHA = git('rev-parse', 'HEAD')
// A file changed after the commit: it must get no permalink.
writeFileSync(join(target, 'src/util.py'), 'def f(x):\n    return eval(x)\n# edited\n')

const lane = (id: string, file: string, disposition: 'hunt' | 'skip', lines: number, classes: string[] = [], skip: string | null = null) => ({
  lane_id: id, target_file: file, disposition, skip_reason: skip, classes, categories: [],
  file_bytes: 1, file_lines: lines,
})

function baseInputs(findings: InFinding[]): ReportInputs {
  return {
    findings,
    assignments: {
      target_dir: target,
      coverage_ledger: { total_files_in_inventory: 4, assigned_hunt: 3, assigned_skip: 1, unaccounted: 0 },
      category_universe: [{ code: 'A01', name: 'A01: Broken Access Control' }],
      lanes: [
        lane('file-0001', 'src/login.js', 'hunt', LOGIN.split('\n').length, ['injection', 'access-control']),
        lane('file-0002', 'src/keys.js', 'hunt', KEYS.split('\n').length, ['crypto-auth']),
        lane('file-0003', 'src/util.py', 'hunt', 3, ['injection']),
        lane('file-0004', 'styles/site.css', 'skip', 2, [], 'Styling file — no executable logic'),
      ],
    },
    consumption: {
      generated_at: '2026-10-10T10:00:00Z',
      lanes: ['file-0001', 'file-0002', 'file-0003'].map((id) => ({
        lane_id: id, target_file: '',
        chunks: [{ measured: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } }],
        lane_totals: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
      })),
      rollup: {},
      legacy_entries: [
        { lane_id: 'file-0001', tokens_used: 1200 },
        { lane_id: 'file-0002', tokens_used: 1200 },
        { lane_id: 'file-0003', tokens_used: 1200 },
        { lane_id: 'file-0004', tokens_used: 0 },
      ],
    },
    usage: null,
    plan: { total_projected_cost_usd: 0.01 },
    stage2Meta: { provider: 'luna', model: 'gpt-test', started: '2026-10-10T09:00:00Z', ended: '2026-10-10T09:10:00Z', exit_code: 0, loop_mode: 'trace', sampling: { reasoning_effort: 'high' } },
    stage0Meta: null,
    architecture: {
      route_table: { hand_written_routes: [{ method: 'POST', path: '/login', handler: 'login()', auth: null, file: 'server.js', line: 9 }] },
    },
    fileSignals: { files: { 'src/login.js': ['db_query', 'route_handler'], 'src/keys.js': ['crypto_op'] } },
    classRegistry: REGISTRY,
    signalClasses: SIGNALS,
    retries: 2,
    usageStale: false,
  }
}

function env(overrides: Partial<BuildEnv> = {}): BuildEnv & { repoRoot: string } {
  return {
    provider: 'luna',
    modelLabel: 'test',
    repo: repoInfo(target, {}),
    repoRoot: root,
    readTargetFile: (rel) => { try { return readFileSync(join(target, rel), 'utf-8') } catch { return null } },
    costUsd: (i, o) => (i * 0.2 + o * 1.2) / 1e6,
    priceAsOf: '2026-08-01',
    benchmark: BENCH,
    tool: { name: 'secscan', version: '0.1.0', scannerGitSha: 'abc1234' },
    profile: 'product',
    runId: 'r1',
    generatedAt: '2026-10-10T12:00:00.000Z',
    ...overrides,
  }
}

// An "old" finding: exactly the fields every Stage 2 run has written.
const OLD: InFinding = {
  finding_id: 'FIND-0001', lane_id: 'file-0001',
  finding_classes: [{ class: 'injection', justified_by_step: 2 }], categories: ['A03'],
  title: 'SQL built from <script>alert(1)</script> input', description: 'Email reaches a raw query.',
  trace: [
    { kind: 'entrypoint', file: 'src/login.js', line: 3, description: 'handler' },
    { kind: 'propagation', file: 'src/login.js', line: 5, description: 'interpolated' },
    { kind: 'sink', file: 'src/login.js', line: 6, description: 'executed' },
  ],
  severity_estimate: 'high', confidence: 0.9,
}
// A new finding, with every explanation field, and a model-cited file that is wrong.
const NEW: InFinding = {
  finding_id: 'FIND-0002', lane_id: 'file-0002',
  finding_classes: [{ class: 'crypto-auth', justified_by_step: 1 }], categories: ['A02', 'A07', 'API2'],
  title: 'Hardcoded signing key', description: 'Private key in source.',
  trace: [
    { kind: 'entrypoint', file: 'src/keys.js', line: 2, description: 'key literal' },
    { kind: 'sink', file: 'lib/other.js', line: 6, description: 'used to sign' },
  ],
  severity_estimate: 'critical', confidence: 0.95,
  cwe: ['CWE-798', 'CWE-321'], severity_reason: 'Token forgery; key readable by anyone with the source.',
  confidence_reason: { validation: 'not_applicable', assumptions: ['the key is used in production'], summary: 'The key is a literal.' },
  attack_scenario: 'Anyone with the repository signs a token for any user.',
  remediation: 'Load the key from a secret store and rotate it.',
}
const LOW: InFinding = {
  finding_id: 'FIND-0003', lane_id: 'file-0003',
  finding_classes: [{ class: 'injection', justified_by_step: 0 }], categories: ['A03'],
  title: 'eval of input', description: 'd',
  trace: [
    { kind: 'entrypoint', file: 'src/util.py', line: 1, description: 'param' },
    { kind: 'sink', file: 'src/util.py', line: 2, description: 'eval' },
  ],
  severity_estimate: 'medium', confidence: 0.3,
}
// A line past the end of the file: must be reported, unresolved, with no excerpt.
const BAD: InFinding = {
  ...LOW, finding_id: 'FIND-0004', title: 'cites a missing line',
  trace: [{ kind: 'entrypoint', file: 'src/util.py', line: 1, description: 'p' }, { kind: 'sink', file: 'src/util.py', line: 99, description: 's' }],
}

try {
  const report = buildReport(baseInputs([OLD, NEW, LOW, BAD]), env())
  const byTitle = (t: string) => report.findings.find((f) => f.title.startsWith(t))!

  console.log('\n-- every location resolves to the cited line, read from disk --')
  {
    let checked = 0, wrong = 0
    for (const f of report.findings) {
      for (const s of f.evidence) {
        if (!s.resolves) continue
        checked++
        const disk = redactPem(readFileSync(join(target, s.path), 'utf-8')).split('\n')[s.line - 1]
        const cited = s.excerpt!.find((l) => l.cited)!
        if (cited.n !== s.line || cited.text !== disk) wrong++
      }
    }
    check(`${checked} resolvable steps, every cited excerpt line is the file's own line`, checked > 0 && wrong === 0)
    check('excerpts are 3 to 5 lines', report.findings.every((f) => f.evidence.every((s) => !s.excerpt || (s.excerpt.length >= 2 && s.excerpt.length <= 5))))
    const bad = byTitle('cites a missing line')
    check('a line past EOF is reported unresolved, without an excerpt',
      !bad.location.resolves && bad.evidence[1].excerpt === null && bad.location.permalink === null)
    check('...and listed as a limitation', report.limitations.some((l) => l.includes('cite a line that does not exist')))
  }

  console.log('\n-- locations come from the lane, not the model --')
  {
    const n = byTitle('Hardcoded signing key')
    check('the model-cited file is replaced by the lane file', n.evidence[1].path === 'src/keys.js')
    check('...and the disagreement is kept as a note', n.evidence[1].model_cited_file === 'lib/other.js')
    check('primary location is the sink step', n.location.display === 'src/keys.js:6')
    // A trace may name several sinks: the dangerous call, then what its result
    // reaches. The first is the line to change, and it is what the id keys on.
    const multi = { ...OLD, trace: [OLD.trace[0], OLD.trace[2], { kind: 'sink', file: 'src/login.js', line: 4, description: 'later use' }] }
    const rm = buildReport(baseInputs([multi]), env())
    check('with several sink steps, the first is the primary location', rm.findings[0].location.display === 'src/login.js:6')
    check('...and the fingerprint is keyed on it', rm.findings[0].id === byTitle('SQL built').id)
  }

  console.log('\n-- every finding has the Part 4.2 fields; old findings still report --')
  {
    for (const f of report.findings) {
      const ok = !!f.id && !!f.title && !!f.category_label && !!f.severity && typeof f.confidence === 'number' &&
        !!f.confidence_band && !!f.confidence_explanation.text && !!f.location.display && f.description !== undefined &&
        Array.isArray(f.evidence) && 'attack_scenario' in f && 'remediation' in f
      check(`${f.source_finding_id} carries every field`, ok)
    }
    const old = byTitle('SQL built')
    check('an old finding lists all five explanation fields as missing',
      JSON.stringify(old.fields_missing) === JSON.stringify([...EXPLANATION_FIELDS]))
    check('an old finding still gets scanner signals', old.confidence_explanation.scanner_signals.length === 4)
    check('...and says model reasoning was not recorded', old.confidence_explanation.text.includes('no model reasoning recorded'))
    const n = byTitle('Hardcoded signing key')
    check('a new finding carries its CWE ids', JSON.stringify(n.cwe) === JSON.stringify(['CWE-798', 'CWE-321']))
    check('a new finding has no missing fields', n.fields_missing.length === 0)
    check('confidence explanation includes the model assumptions', n.confidence_explanation.text.includes('assumes the key is used in production'))
    check('category label pairs OWASP code and CWE', n.category_label === 'A02, A07, API2 · CWE-798, CWE-321')
    check('an OWASP code missing from the universe still gets its name',
      old.owasp[0].name === 'A03: Injection')
  }

  console.log('\n-- scanner signals are computed, not taken from the model --')
  {
    const old = byTitle('SQL built')
    const sig = (k: string) => old.confidence_explanation.scanner_signals.find((s) => s.signal === k)!
    check('trace complete', sig('trace_complete').value === true)
    check('public route found through its handler defined in this file', sig('entry_exposed').value === true)
    check('db_query signal tied to injection', sig('known_sink').value === true)
    check('band thresholds: 0.9 High, 0.3 Low', old.confidence_band === 'High' && byTitle('eval of input').confidence_band === 'Low')
  }

  console.log('\n-- PEM key material never reaches the report --')
  {
    const all = JSON.stringify(report) + renderMarkdown(report) + renderHtml(report)
    check('key body absent from every output', !all.includes('secretsecret') && !all.includes('moresecretmaterial'))
    check('redaction keeps the line count', redactPem(KEYS).split('\n').length === KEYS.split('\n').length)
    check('the line after the key still lands', byTitle('Hardcoded signing key').evidence[1].excerpt!.find((l) => l.cited)!.text.includes('jwt.sign'))
  }

  console.log('\n-- ordering and summary --')
  {
    const scores = report.findings.map((f) => f.rank_score)
    check('sorted by severity × confidence', scores.every((s, i) => i === 0 || scores[i - 1] >= s))
    check('critical 0.95 ranks first', report.findings[0].title === 'Hardcoded signing key')
    check('review first lists the top findings', report.summary.review_first[0] === report.findings[0].id)
    check('severity counts add up', Object.values(report.summary.by_severity).reduce((a, b) => a + b, 0) === 4)
    check('CWE counted', report.summary.by_cwe.some((c) => c.cwe === 'CWE-798' && c.count === 1))
  }

  console.log('\n-- stable fingerprints --')
  {
    const a = fingerprintOf('src/login.js', '  return db.query(q)', 6, 'injection')
    check('same sink text on another line: same fingerprint', a === fingerprintOf('src/login.js', 'return   db.query(q)', 40, 'injection'))
    check('another primary class: another fingerprint', a !== fingerprintOf('src/login.js', 'return db.query(q)', 6, 'crypto-auth'))
    check('another file: another fingerprint', a !== fingerprintOf('src/other.js', 'return db.query(q)', 6, 'injection'))
    // Shift the file down by three lines and rebuild: the id must not move.
    const before = byTitle('SQL built').id
    const shifted = '// a\n// b\n// c\n' + LOGIN
    const moved = { ...OLD, trace: OLD.trace.map((s) => ({ ...s, line: s.line + 3 })) }
    const inputs = baseInputs([moved])
    inputs.assignments.lanes[0].file_lines = shifted.split('\n').length
    const r2 = buildReport(inputs, env({ readTargetFile: (rel) => (rel === 'src/login.js' ? shifted : null) }))
    check('an edit above the finding keeps its id', r2.findings[0].id === before && r2.findings[0].location.line === 9)
    // Two distinct findings on one sink line with one class keep distinct ids.
    const twin = { ...OLD, finding_id: 'FIND-0009', title: 'Another defect at the same sink' }
    const r3 = buildReport(baseInputs([OLD, twin]), env())
    check('colliding fingerprints are disambiguated, not merged',
      r3.findings.length === 2 && new Set(r3.findings.map((f) => f.id)).size === 2)
  }

  console.log('\n-- permalinks: commit-pinned, only where the file matches the commit --')
  {
    const old = byTitle('SQL built')
    check('clean file gets a commit-pinned permalink',
      old.location.permalink === `https://github.com/acme/shop/blob/${SHA}/src/login.js#L6`)
    check('a file changed since the commit gets none', byTitle('eval of input').location.permalink === null)
    check('...and the report says why', report.limitations.some((l) => l.includes('uncommitted changes')))
    check('local path:line is always present', old.location.display === 'src/login.js:6')
    for (const [u, ok] of [
      ['git@github.com:acme/shop.git', true], ['https://github.com/acme/shop', true],
      ['ssh://git@github.com/acme/shop.git', true], ['https://x:tok@github.com/acme/shop.git', true],
      ['git@gitlab.com:acme/shop.git', false], ['https://github.com.evil.io/acme/shop', false],
    ] as const) {
      check(`remote ${u} ${ok ? 'is' : 'is not'} GitHub`, (parseGithubRemote(u) !== null) === ok)
    }
    const actions = repoInfo(target, { GITHUB_REPOSITORY: 'acme/shop-fork', GITHUB_SERVER_URL: 'https://ghe.example.com' })
    check('GITHUB_REPOSITORY and GITHUB_SERVER_URL win in Actions',
      permalink(actions, 'src/login.js', 6) === `https://ghe.example.com/acme/shop-fork/blob/${SHA}/src/login.js#L6`)
    const nogit = buildReport(baseInputs([OLD]), env({ repo: { ...repoInfo(root, {}), github: null } }))
    check('no GitHub remote: no permalink, path:line only', nogit.findings[0].location.permalink === null)
  }

  console.log('\n-- coverage and status --')
  {
    check('COMPLETE when every hunt lane ran', report.status.state === 'COMPLETE')
    check('skip bucketed as non-code', report.coverage.skipped_by_reason['non-code'] === 1)
    check('code lines exclude CSS', report.coverage.code_lines_total === LOGIN.split('\n').length + KEYS.split('\n').length + 3)
    check('Python is unmeasured, JavaScript measured, for luna',
      report.coverage.languages.find((l) => l.language === 'Python')?.measured === false &&
      report.coverage.languages.find((l) => l.language === 'JavaScript')?.measured === true)
    check('unmeasured language is a limitation', report.limitations.some((l) => l.startsWith('Unmeasured language(s): Python')))
    check('cost computed from Stage 2 tokens when no usage record', report.run_stats.cost_usd !== null && report.run_stats.cost_source.startsWith('computed'))

    const failed = baseInputs([OLD])
    failed.consumption!.legacy_entries![1] = { lane_id: 'file-0002', tokens_used: 0, failed: true, failure_reason: '429 rate limit' }
    const notRun = baseInputs([OLD])
    notRun.consumption!.legacy_entries = notRun.consumption!.legacy_entries!.filter((e) => e.lane_id !== 'file-0003')
    notRun.consumption!.stop_reason = 'spend cap $0.01 reached'
    const blocked = baseInputs([OLD])
    blocked.consumption!.lanes![1].chunks = []
    blocked.consumption!.legacy_entries![1] = { lane_id: 'file-0002', tokens_used: 0 }
    const rf = buildReport(failed, env()), rn = buildReport(notRun, env()), rb = buildReport(blocked, env())
    check('a failed lane makes it INCOMPLETE', rf.status.state === 'INCOMPLETE' && rf.coverage.files_failed === 1)
    check('a lane that never ran makes it INCOMPLETE, with the stop reason',
      rn.status.state === 'INCOMPLETE' && rn.coverage.files_not_run === 1 && rn.status.reasons.some((r) => r.includes('spend cap')))
    check('a guard-blocked lane is failed, not scanned', rb.coverage.files_failed === 1 && rb.coverage.files_scanned === 2)
    const noUsage = baseInputs([OLD]); noUsage.consumption = null
    check('no usage record: INCOMPLETE, not a crash', buildReport(noUsage, env()).status.state === 'INCOMPLETE')
    for (const [reason, bucket] of [
      ['Pure data/config file — no executable logic or independent entrypoint-to-sink path', 'non-code'],
      ['Denylisted: references challenge identifiers — must never reach a hunting lane', 'excluded (benchmark denylist)'],
      ['exceeds --max-file-size (too large)', 'too large'],
      ['matched .gitignore', 'ignored'],
      ['excluded by user path filter', 'user-excluded'],
      ['not started: --max-cost budget reached', 'over budget'],
    ] as const) {
      check(`skip "${reason.slice(0, 32)}…" -> ${bucket}`, skipCategory({ skip_reason: reason }) === bucket)
    }
  }

  console.log('\n-- SARIF 2.1.0 --')
  {
    const sarif = toSarif(report) as any
    const run = sarif.runs[0]
    check('version 2.1.0 with the schema URI', sarif.version === '2.1.0' && sarif.$schema.includes('sarif-2.1.0'))
    check('one result per finding', run.results.length === report.findings.length)
    check('every result has a stable fingerprint',
      run.results.every((r: any, i: number) => r.partialFingerprints[SARIF_FINGERPRINT_KEY] === report.findings[i].fingerprint))
    check('every ruleIndex points at its rule', run.results.every((r: any) => run.tool.driver.rules[r.ruleIndex].id === r.ruleId))
    check('locations are relative to %SRCROOT%', run.results.every((r: any) =>
      r.locations[0].physicalLocation.artifactLocation.uriBaseId === '%SRCROOT%' &&
      !r.locations[0].physicalLocation.artifactLocation.uri.startsWith('/')))
    check('startLine is a positive integer', run.results.every((r: any) => Number.isInteger(r.locations[0].physicalLocation.region.startLine) && r.locations[0].physicalLocation.region.startLine >= 1))
    check('the trace is a codeFlow from source to sink',
      run.results[0].codeFlows[0].threadFlows[0].locations[0].kinds[0] === 'source')
    check('version control provenance names the commit',
      run.versionControlProvenance[0].revisionId === SHA && run.versionControlProvenance[0].repositoryUri === 'https://github.com/acme/shop')
    check('analysis category is stable across runs', run.automationDetails.id === 'secscan/full/r1')
    check('critical and high map to error, low to note',
      run.results[0].level === 'error' && run.results.find((r: any) => r.properties.severity === 'medium').level === 'warning')
  }

  console.log('\n-- renderers --')
  {
    const html = renderHtml(report)
    const md = renderMarkdown(report)
    check('HTML escapes finding text', !html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'))
    check('HTML is self-contained (no external script or stylesheet)', !/<script|<link|src="http/i.test(html))
    for (const h of ['Summary at a glance', 'Coverage', 'Limitations', 'Run stats', 'Findings', 'Appendix']) {
      check(`both outputs have "${h}"`, html.includes(h) && md.includes(`## ${h}`))
    }
    check('Markdown links a clean finding to its permalink', md.includes(`](https://github.com/acme/shop/blob/${SHA}/src/login.js#L6)`))
    check('Markdown says what an old finding lacks', md.includes('Not recorded for this finding'))
  }

  console.log('\n-- end to end: report.ts on a product run --')
  {
    // Lay the artifacts out exactly as run.sh does for a product run: stage
    // internals under <store>/runs/<id>/work/<provider>/<stage>/.
    const store = join(target, '.secscan')
    const runDir = join(store, 'runs/r1')
    const work = join(runDir, 'work')
    const put = (stage: string, file: string, data: unknown, base = work) => {
      mkdirSync(join(base, 'luna', stage), { recursive: true })
      writeFileSync(join(base, 'luna', stage, file), JSON.stringify(data))
    }
    const inputs = baseInputs([OLD, NEW, LOW])
    const meta = (stage: string) => ({ provider: 'luna', model: 'deterministic', stage, exit_code: 0, started: '2026-10-10T08:00:00Z', ended: '2026-10-10T08:01:00Z' })
    const layRun = (base: string) => {
      put('stage2-hunt-lanes-perfile', 'budget-consumption.json', inputs.consumption, base)
      put('stage2-hunt-lanes-perfile', 'meta.json', inputs.stage2Meta, base)
      put('stage05-lane-selector-perfile', 'meta.json', meta('stage05-lane-selector-perfile'), base)
      put('stage0-recon', 'architecture-summary.json', inputs.architecture, base)
      put('stage0-recon', 'file-signals.json', inputs.fileSignals, base)
    }
    layRun(work)
    writeFileSync(join(store, '.gitignore'), '*\n')
    // A lane naming a file inside .secscan/ must be refused by the guard.
    writeFileSync(join(runDir, 'secret.js'), 'leak\n')
    const sneaky = { ...LOW, finding_id: 'FIND-0005', lane_id: 'file-0005', title: 'reads run artifacts' }
    inputs.assignments.lanes.push(lane('file-0005', '.secscan/runs/r1/secret.js', 'hunt', 2, ['injection']))
    inputs.assignments.coverage_ledger = { total_files_in_inventory: 5, assigned_hunt: 4, assigned_skip: 1, unaccounted: 0 }
    put('stage05-lane-selector-perfile', 'lane-assignments.json', inputs.assignments)
    put('stage2-hunt-lanes-perfile', 'candidate-findings.json', [...inputs.findings, sneaky])
    // An older run with no report, and one from before work/ existed: the index lists both.
    mkdirSync(join(store, 'runs/r0-noreport/work/luna/stage0-recon'), { recursive: true })

    const runReport = () => spawnSync('npx', ['tsx', 'src/report.ts'], {
      cwd: PKG, encoding: 'utf-8',
      env: { ...process.env, SCANNER_TARGET: target, SCANNER_PROFILE: 'product', SCANNER_RUN_ID: 'r1', SCANNER_PROVIDER: 'luna', SCANNER_RUNS_ROOT: '', SCANNER_OUT: '', SOURCE_DATE_EPOCH: '1791633600' },
    })
    const res = runReport()
    check('report.ts exits 0', res.status === 0)
    if (res.status !== 0) console.log(res.stdout, res.stderr)
    for (const f of ['report.html', 'report.md', 'findings.json', 'findings.sarif', 'run.json']) {
      check(`writes ${f} at the top of the run directory`, existsSync(join(runDir, f)))
    }
    check('meta.json stays with the internals', existsSync(join(work, 'luna/report/meta.json')) && !existsSync(join(runDir, 'meta.json')))
    const fj = JSON.parse(readFileSync(join(runDir, 'findings.json'), 'utf-8'))
    check('SOURCE_DATE_EPOCH pins generated_at', fj.generated_at === '2026-10-10T12:00:00.000Z')
    check('terminal summary prints clickable path:line', res.stdout.includes('src/keys.js:6'))
    const leaked = fj.findings.find((f: any) => f.title === 'reads run artifacts')
    check('a file under .secscan/ is never excerpted', !!leaked && !leaked.location.resolves &&
      !readFileSync(join(runDir, 'report.md'), 'utf-8').includes('leak'))
    check('meta.json records the blocked read', JSON.parse(readFileSync(join(work, 'luna/report/meta.json'), 'utf-8')).blocked_reads >= 1)

    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'))
    check('run.json names the run, commit and status', run.run_id === 'r1' && run.repo.commit === SHA && run.status === fj.status.state)
    check('run.json lists the stages that ran, from their meta.json',
      run.stages.some((x: any) => x.stage === 'stage2-hunt-lanes-perfile') && !run.stages.some((x: any) => x.stage === 'report'))
    check('run.json hashes inputs and outputs by run-relative path',
      /^[0-9a-f]{64}$/.test(run.inputs['work/luna/stage2-hunt-lanes-perfile/candidate-findings.json']) &&
      /^[0-9a-f]{64}$/.test(run.outputs['findings.sarif']))
    check('run.json summary matches the report', run.summary.findings === fj.summary.total)

    const index = JSON.parse(readFileSync(join(store, 'index.json'), 'utf-8'))
    check('index lists every run, newest first', JSON.stringify(index.runs.map((r: any) => r.run_id)) === JSON.stringify(['r1', 'r0-noreport']))
    check('index row carries status, counts and the report path',
      index.runs[0].status === fj.status.state && index.runs[0].findings === fj.summary.total && index.runs[0].report === 'runs/r1/report.html')
    check('a run without a report is listed as such', index.runs[1].status === 'no report' && index.runs[1].report === null)
    check('latest points at the newest reported run', index.latest === 'r1' &&
      realpathSync(join(store, 'latest')) === realpathSync(runDir))
    check('nothing outside the store was written', !existsSync(join(target, 'index.json')) && !existsSync(join(target, 'report.html')))

    const again = runReport()
    check('deterministic: a second run writes byte-identical outputs and manifest',
      again.status === 0 && readFileSync(join(runDir, 'findings.json'), 'utf-8') === JSON.stringify(fj, null, 2) + '\n' &&
      readFileSync(join(runDir, 'run.json'), 'utf-8') === JSON.stringify(run, null, 2) + '\n')

    console.log('\n-- run store: list and prune --')
    {
      // Three more runs, older than r1, two with reports.
      for (const id of ['20261001-000000', '20261002-000000']) {
        mkdirSync(join(store, 'runs', id, 'work/luna/stage0-recon'), { recursive: true })
        writeFileSync(join(store, 'runs', id, 'work/luna/stage0-recon/big.json'), 'x'.repeat(5000))
        writeFileSync(join(store, 'runs', id, 'report.html'), '<html></html>')
        writeFileSync(join(store, 'runs', id, 'run.json'), JSON.stringify({ status: 'COMPLETE', summary: { findings: 1 } }))
      }
      mkdirSync(join(root, 'elsewhere'))
      symlinkSync(join(root, 'elsewhere'), join(store, 'runs', '20260101-000000'))
      const ids = listRunIds(store)
      check('run ids sort newest first, symlinked entries ignored',
        JSON.stringify(ids) === JSON.stringify(['r1', 'r0-noreport', '20261002-000000', '20261001-000000']))
      const plan = planPrune(store, { keep: 2, work: true })
      check('--keep 2 deletes everything beyond the newest two', JSON.stringify(plan.deleteRuns) === JSON.stringify(['20261002-000000', '20261001-000000']))
      check('--work never touches the newest run', !plan.dropWork.includes('r1') && plan.dropWork.includes('r0-noreport'))
      check('keep is at least 1', !planPrune(store, { keep: 0 }).deleteRuns.includes('r1'))
      const quiet = (f: () => number) => { const log = console.log; console.log = () => {}; try { return f() } finally { console.log = log } }
      check('prune without --yes is a dry run', quiet(() => runsMain(['--target', target, 'prune', '--keep', '2'])) === 0 &&
        existsSync(join(store, 'runs/20261001-000000')))
      check('prune with --yes removes, and refreshes the index',
        quiet(() => runsMain(['--target', target, 'prune', '--keep', '2', '--work', '--yes'])) === 0 &&
        !existsSync(join(store, 'runs/20261001-000000')) && !existsSync(join(store, 'runs/r0-noreport/work')) &&
        existsSync(join(store, 'runs/r1/work')) && existsSync(join(root, 'elsewhere')) &&
        JSON.parse(readFileSync(join(store, 'index.json'), 'utf-8')).runs.length === 2)
      check('list exits 0', quiet(() => runsMain(['--target', target, 'list'])) === 0)
      check('prune with no option is refused', (() => { const e = console.error; console.error = () => {}; try { return runsMain(['--target', target, 'prune']) } finally { console.error = e } })() === 2)
      const fresh = refreshStore(store, '2026-10-11T00:00:00Z')
      check('a run with work pruned is marked', fresh.runs.find((r) => r.run_id === 'r0-noreport')?.has_work === false)
    }

    console.log('\n-- run.sh: consent, --out, run store layout --')
    {
      const RUN_SH = join(PKG, '../run.sh')
      const sh = (args: string[], extra: Record<string, string> = {}) => spawnSync(RUN_SH, args, {
        encoding: 'utf-8', input: '',
        env: { ...process.env, SCANNER_RUNS_ROOT: '', SCANNER_OUT: '', SCANNER_RUN_ID: '', SCANNER_TARGET: '', SCANNER_PROFILE: '', SOURCE_DATE_EPOCH: '1791633600', ...extra },
      })
      const fresh = join(root, 'fresh-repo')
      mkdirSync(join(fresh, 'src'), { recursive: true })
      writeFileSync(join(fresh, 'src/a.js'), 'x\n')
      const noTty = sh(['--target', fresh, 'luna', 'stage0-recon'])
      check('first run with no terminal and no --yes is refused', noTty.status === 2 && /--yes/.test(noTty.stderr))
      check('...and writes nothing', !existsSync(join(fresh, '.secscan')))
      const inside = sh(['--target', fresh, '--out', join(fresh, 'reports'), '--yes', 'luna', 'stage0-recon'])
      check('--out inside the target is refused', inside.status === 2 && /outside the target/.test(inside.stderr) && !existsSync(join(fresh, 'reports')))
      const occupied = join(root, 'occupied')
      mkdirSync(occupied)
      writeFileSync(join(occupied, 'notes.txt'), 'mine\n')
      const taken = sh(['--target', fresh, '--out', occupied, '--yes', 'luna', 'stage0-recon'])
      check('--out on a directory holding other files is refused', taken.status === 2 && !existsSync(join(occupied, '.gitignore')))
      const missing = sh(['--target', fresh, '--yes', '--run-id', 'nope', 'luna', 'report'])
      check('a later stage of a run that does not exist is refused', missing.status === 2 && /no run 'nope'/.test(missing.stderr))

      // A complete run laid out in a store outside the target, with consent by --yes.
      const outside = join(root, 'scan-results')
      const w = join(outside, 'runs/r9/work')
      layRun(w)
      put('stage05-lane-selector-perfile', 'lane-assignments.json', { ...baseInputs([]).assignments, target_dir: target }, w)
      put('stage2-hunt-lanes-perfile', 'candidate-findings.json', [OLD], w)
      const refused = sh(['--target', target, '--out', outside, '--run-id', 'r9', 'luna', 'report'])
      check('a store missing its .gitignore needs consent again, with no terminal refused',
        refused.status === 2 && /--yes/.test(refused.stderr) && !existsSync(join(outside, '.gitignore')))
      const ok = sh(['--target', target, '--out', outside, '--run-id', 'r9', '--yes', 'luna', 'report'])
      check('run.sh report with --yes and --out exits 0', ok.status === 0)
      if (ok.status !== 0) console.log(ok.stdout, ok.stderr)
      check('the store gets its .gitignore of *', readFileSync(join(outside, '.gitignore'), 'utf-8') === '*\n')
      check('the report lands at the top of the run', existsSync(join(outside, 'runs/r9/report.html')) && existsSync(join(outside, 'runs/r9/run.json')))
      check('logs land with the internals', existsSync(join(w, 'luna/report/logs/report.stdout.log')))
      check('the store index and latest are written', existsSync(join(outside, 'index.json')) && existsSync(join(outside, 'latest')))
      check('nothing is written into the target', !existsSync(join(target, '.secscan/runs/r9')))
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
