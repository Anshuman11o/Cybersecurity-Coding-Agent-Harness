/** Smoke tests for the read guard and run-path helpers. Run: npx tsx shared/guard.test.ts */
import { readCorpusFile, isCorpusReadable, guardStats } from './read-guard.js'
import { runPath, RUNS_ROOT, STAGES } from './run-paths.js'
import {
  resolveProvider, modelFor, tokenLimitParam, samplingParams, outputTokenCap,
  listProviders, defaultProvider, targetFor, apiKeyEnvFor, clientConfigFor, costUsd,
} from './provider.js'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

console.log('\n-- read guard: must DENY --')
check('prior-run findings',      readCorpusFile('tools/scanner/runs/qwen/stage3-validate/validated-findings.json') === null)
check('scored results',          readCorpusFile('results/scan-benchmark-summary.md') === null)
check('scanner source',          readCorpusFile('tools/scanner/shared/read-guard.ts') === null)
check('docs',                    readCorpusFile('docs/BLIND_DEVELOPMENT.md') === null)
check('git internals',           readCorpusFile('.git/config') === null)
check('traversal escape',        readCorpusFile('target-apps/juice-shop/../../results/scan-benchmark-summary.md') === null)
check('absolute path escape',    readCorpusFile('/etc/passwd') === null)
check('denylisted challenge.ts', readCorpusFile('target-apps/juice-shop-blind/models/challenge.ts') === null)
check('denylisted antiCheat.ts', readCorpusFile('target-apps/juice-shop-blind/lib/antiCheat.ts') === null)

console.log('\n-- read guard: must ALLOW --')
const ok = readCorpusFile('target-apps/juice-shop-blind/server.ts')
check('corpus server.ts readable', ok !== null && ok.length > 0)
check('isCorpusReadable agrees',    isCorpusReadable('target-apps/juice-shop-blind/server.ts'))
check('isCorpusReadable denies runs', !isCorpusReadable('tools/scanner/runs/qwen/stage3-validate/validated-findings.json'))

console.log('\n-- blind-development boundary: denylisted files must never be hunt lanes --')
// This is the check that was missing. v2 assigns one lane per file, so a hunt
// disposition on a denylisted file pastes challenge identifiers straight into a
// prompt. models/challenge.ts is a literal array of every challenge key.
// Asserted against every lane-assignments.json on disk, v1 manifest and v2
// alike, so it fails on the artifact rather than on a reading of the code.
{
  const { readFileSync, existsSync, readdirSync } = await import('fs')
  const { join, relative } = await import('path')
  const { SEED_DENYLIST } = await import('./read-guard.js')
  const { REPO_ROOT, RUNS_ROOT } = await import('./run-paths.js')

  check('denylist is non-empty', SEED_DENYLIST.length > 0)

  let manifests = 0
  let violations: string[] = []
  if (existsSync(RUNS_ROOT)) {
    for (const provider of readdirSync(RUNS_ROOT)) {
      for (const stage of readdirSync(join(RUNS_ROOT, provider))) {
        const f = join(RUNS_ROOT, provider, stage, 'lane-assignments.json')
        if (!existsSync(f)) continue
        manifests++
        const a = JSON.parse(readFileSync(f, 'utf-8'))
        for (const lane of a.lanes ?? []) {
          if (lane.disposition !== 'hunt') continue
          const repoRel = relative(REPO_ROOT, join(a.target_dir, lane.target_file))
          if (SEED_DENYLIST.includes(repoRel)) {
            violations.push(`${provider}/${stage}: ${lane.lane_id} ${lane.target_file}`)
          }
        }
      }
    }
  }
  check(`no denylisted hunt lanes in ${manifests} manifest(s) on disk`, violations.length === 0)
  for (const v of violations) console.log(`        VIOLATION ${v}`)

  // The guard itself must refuse them regardless of what any manifest says.
  for (const p of SEED_DENYLIST) {
    check(`guard denies ${p.split('/').slice(-2).join('/')}`, readCorpusFile(p) === null)
  }
}

console.log('\n-- run paths --')
// Registry-driven: every configured provider must get its own isolated tree
// for every stage. Adding a model to models.json extends this automatically.
const providers = listProviders()
check('at least two providers configured', providers.length >= 2)
for (const p of providers) {
  check(`${p} path`, runPath(p, 'stage3-validate').endsWith(`runs/${p}/stage3-validate`))
  check(`${p} under RUNS_ROOT`, runPath(p, 'stage0-recon').startsWith(RUNS_ROOT))
}
{
  const seen = new Set<string>()
  let collision = false
  for (const p of providers) for (const s of STAGES) {
    const path = runPath(p, s)
    if (seen.has(path)) collision = true
    seen.add(path)
  }
  check('no provider/stage path collisions', !collision)
  check('v2 stages are isolated from v1',
    runPath(providers[0], 'stage2-hunt-lanes') !== runPath(providers[0], 'stage2-hunt-lanes-perfile'))
}
try { runPath('not-a-model', 'stage0-recon'); check('runPath rejects unknown provider', false) }
catch { check('runPath rejects unknown provider', true) }

console.log('\n-- provider resolution --')
delete process.env.SCANNER_PROVIDER
delete process.env.SCANNER_MODEL
check('defaults to registry default', resolveProvider('stage2') === defaultProvider())
check('default is luna',              defaultProvider() === 'luna')
process.env.SCANNER_PROVIDER = 'qwen'
check('global override',  resolveProvider('stage2') === 'qwen')
process.env.SCANNER_PROVIDER_STAGE3 = 'luna'
check('per-stage wins',   resolveProvider('stage3') === 'luna')
delete process.env.SCANNER_PROVIDER_STAGE3
process.env.SCANNER_PROVIDER = 'openai'
check('alias openai -> luna', resolveProvider('stage2') === 'luna')
check('alias reaches the same run tree',
  runPath(resolveProvider('stage2'), 'stage3-validate') === runPath('luna', 'stage3-validate'))
delete process.env.SCANNER_PROVIDER

console.log('\n-- registry contract (holds for every configured model) --')
for (const p of providers) {
  const t = targetFor(p)
  check(`${p}: model id non-empty`, modelFor(p).length > 0)
  check(`${p}: exactly one token-limit param`,
    Object.keys(tokenLimitParam(p, 100)).length === 1 &&
    t.token_limit_param in tokenLimitParam(p, 100))
  check(`${p}: sampling matches registry`,
    JSON.stringify(samplingParams(p)) === JSON.stringify(t.sampling))
  check(`${p}: declares a credential env var`, apiKeyEnvFor(p).length > 0)
  // Mutating the returned object must not corrupt the registry for later calls.
  samplingParams(p).__scratch = 1
  check(`${p}: samplingParams returns a copy`, !('__scratch' in samplingParams(p)))
}

console.log('\n-- configured models (the two the repo ships with) --')
check('luna model id',            modelFor('luna') === 'gpt-5.6-luna')
check('qwen model id',            modelFor('qwen') === 'qwen-plus')
check('luna max_completion_tokens','max_completion_tokens' in tokenLimitParam('luna', 100))
check('qwen max_tokens',          'max_tokens' in tokenLimitParam('qwen', 100))
// luna declared no sampling at all until 2026-07-31. It now sets reasoning_effort,
// because runs 1-5 all ran at the endpoint's default effort and that was the
// single largest recoverable loss measured at a fixed model. The cap must move
// with it — see the output-token block below.
check('luna sets reasoning_effort', samplingParams('luna').reasoning_effort === 'high')
check('luna sets nothing else',    Object.keys(samplingParams('luna')).length === 1)
check('qwen has temperature',     'temperature' in samplingParams('qwen'))
check('luna uses SDK default URL', clientConfigFor('luna').baseURL === undefined)
check('qwen overrides baseURL',    typeof clientConfigFor('qwen').baseURL === 'string')

console.log('\n-- model override --')
process.env.SCANNER_MODEL = 'pinned-snapshot'
check('SCANNER_MODEL pins every target', modelFor('luna') === 'pinned-snapshot')
process.env.OPENAI_MODEL = 'target-specific'
check('target env beats SCANNER_MODEL',  modelFor('luna') === 'target-specific')
delete process.env.OPENAI_MODEL
delete process.env.SCANNER_MODEL

try { process.env.SCANNER_PROVIDER='bogus'; resolveProvider('x'); check('rejects unknown provider', false) }
catch { check('rejects unknown provider', true) }
delete process.env.SCANNER_PROVIDER

console.log('\n-- degraded tracking --')
{
  const { markDegraded, isDegraded, degradedReasons, resetDegraded } = await import('./degraded.js')
  const { isProviderExplicit } = await import('./provider.js')
  resetDegraded()
  check('clean run is not degraded', !isDegraded())
  markDegraded('unit-test reason')
  check('markDegraded sets the flag', isDegraded())
  check('reason is recorded', degradedReasons().includes('unit-test reason'))
  // globalThis backing: survives a second import of the same module
  const again = await import('./degraded.js')
  check('state shared across module instances', again.isDegraded())
  resetDegraded()
  check('reset clears state', !isDegraded())

  delete process.env.SCANNER_PROVIDER
  delete process.env.SCANNER_PROVIDER_STAGE0
  check('defaulted provider is not explicit', !isProviderExplicit('stage0'))
  process.env.SCANNER_PROVIDER = 'openai'
  check('SCANNER_PROVIDER makes it explicit', isProviderExplicit('stage0'))
  delete process.env.SCANNER_PROVIDER
  process.env.SCANNER_PROVIDER_STAGE0 = 'openai'
  check('per-stage var makes it explicit', isProviderExplicit('stage0'))
  delete process.env.SCANNER_PROVIDER_STAGE0
}

console.log('\n-- line-number fidelity: what the model is told must be what the scorer reads --')
// Every line number shown to the model, and every chunk boundary in a lane's
// chunk plan, is derived from the UNREDACTED file: Stage 0.5 counts lines before
// Stage 2 ever redacts. So any content transform in Stage 2 must preserve the
// line count exactly. sanitizePemPrivateKey once did not — it turned the
// corpus's single-line key declaration into three lines, which displayed every
// subsequent line in lib/insecurity.ts 2 higher than its true number and made
// the manifest's end_line truncate the file's tail. Findings in that file were
// mis-scored by +2 in every run up to and including run 5.
{
  const { sanitizePemPrivateKey } = await import('../stage2-hunt-lanes-perfile/src/hunt-executor.js')
  const lines = (s: string) => s.split('\n').length

  const oneLine = "const k = '-----BEGIN RSA PRIVATE KEY-----\\r\\nAAAABBBB\\r\\n-----END RSA PRIVATE KEY-----'"
  check('single-line PEM keeps its line count',
    lines(sanitizePemPrivateKey(oneLine)) === lines(oneLine))

  const multi = 'before\n-----BEGIN PRIVATE KEY-----\nAAA\nBBB\nCCC\n-----END PRIVATE KEY-----\nafter'
  check('multi-line PEM keeps its line count',
    lines(sanitizePemPrivateKey(multi)) === lines(multi))

  check('key bytes are gone', !sanitizePemPrivateKey(multi).includes('AAA'))
  check('markers survive redaction',
    sanitizePemPrivateKey(multi).includes('-----BEGIN PRIVATE KEY-----') &&
    sanitizePemPrivateKey(multi).includes('-----END PRIVATE KEY-----'))
  check('redaction notice present',
    sanitizePemPrivateKey(multi).includes('[REDACTED: private key material]'))

  // Text at line N must still be at line N after redaction, for every line.
  const corpusFile = readCorpusFile('target-apps/juice-shop-blind/lib/insecurity.ts')
  if (corpusFile === null) {
    check('insecurity.ts readable for fidelity check', false)
  } else {
    const before = corpusFile.split('\n')
    const after = sanitizePemPrivateKey(corpusFile).split('\n')
    check('real corpus file keeps its line count', before.length === after.length)
    // every line except the redacted declaration itself is byte-identical
    let drift = 0
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i] && !before[i].includes('PRIVATE KEY')) drift++
    }
    check('no line other than the key declaration moved', drift === 0)
  }
}

console.log('\n-- output-token cap is registry data, and every shipped target keeps the stage default --')
// Reasoning tokens are billed as output AND counted against this cap. A target
// that raises reasoning_effort without raising the cap can spend the whole
// budget thinking and return a truncated body — which arrives downstream as an
// empty findings array, i.e. as a reasoning result rather than as a failure.
{
  for (const p of listProviders()) {
    const t = targetFor(p)
    if (t.max_output_tokens == null) {
      check(`${p}: no cap declared, stage default passes through`,
        outputTokenCap(p, 8000) === 8000)
    } else {
      check(`${p}: declared cap overrides the stage default`,
        outputTokenCap(p, 8000) === t.max_output_tokens && t.max_output_tokens > 8000)
    }
  }
  // Targets that have produced a scored run and are NOT raising effort must keep
  // the historical cap, or their artifacts stop being comparable to runs 1-5.
  for (const p of ['terra', 'sol', 'qwen']) {
    check(`${p}: output cap unchanged at the historical 8000`, outputTokenCap(p, 8000) === 8000)
  }
  check('a target raising reasoning_effort also raises the cap',
    listProviders().every(p =>
      !('reasoning_effort' in targetFor(p).sampling) || outputTokenCap(p, 8000) > 8000))
}

console.log('\n-- pricing: verified rates, with the date they were verified --')
// This exists because the registry once carried luna at $1.00/$6.00, copied
// from this repo's own prose. It was self-consistent, reconciled against every
// earlier run, and disagreed only with the bill — a full run was reported at
// $21.84 having cost $4.37. A wrong price has no symptom a test can see, so
// what is asserted here is the shape that makes staleness visible instead.
{
  for (const p of listProviders()) {
    const t = targetFor(p)
    if (t.price_per_mtok == null) {
      // An unpriced target is a legitimate state — it prints no cost rather
      // than a wrong one — but it must not silently produce a number.
      check(`${p}: unpriced target yields no cost`, costUsd(p, 1e6, 1e6) === null)
      continue
    }
    const price = t.price_per_mtok
    check(`${p}: records the date its rates were verified`, Boolean(t.price_asof))
    check(`${p}: records which price-list column it took`, Boolean(t.price_tier))
    check(`${p}: cached input is cheaper than fresh input`,
      price.cached_input == null || price.cached_input < price.input)
    check(`${p}: cache writes cost at least fresh input`,
      price.cache_write == null || price.cache_write >= price.input)
    check(`${p}: output costs more than input`, price.output > price.input)
    // Arithmetic, not a rate: 1M fresh input + 1M output must equal the sum of
    // the two rates, or costUsd has stopped meaning what the registry says.
    const expected = price.input + price.output
    check(`${p}: costUsd matches its own declared rates`,
      Math.abs((costUsd(p, 1e6, 1e6) ?? -1) - expected) < 1e-9)
    // A cached million must cost less than a fresh million.
    check(`${p}: cached input is priced through`,
      price.cached_input == null ||
      (costUsd(p, 1e6, 0, 1e6) ?? Infinity) < (costUsd(p, 1e6, 0) ?? 0))
  }
  // The default target is the one a plain run bills against; pin its rate so a
  // silent edit fails here rather than in a report.
  const luna = targetFor(defaultProvider())
  check('default target priced at the 2026-08-01 verified rate',
    luna.price_per_mtok?.input === 0.20 && luna.price_per_mtok?.output === 1.20)
}

// ── The benchmark results ledger is append-only ───────────────────────────
//
// docs/benchmarking-results.md is the permanent record of every scored model.
// Each row cost a full paid run to produce and cannot be reconstructed from
// anywhere else, so a deletion here is unrecoverable in a way a code deletion
// is not — and it would be invisible, because nothing else reads the file.
//
// This asserts only that the file exists and still contains each run recorded
// in it. It cannot stop a rewrite, and it is not meant to: it stops the silent
// cases — a file deleted in a cleanup, or a row dropped while editing the table
// around it. Adding a model means adding its key here in the same commit.
{
  const { REPO_ROOT } = await import('./run-paths.js')
  const { join } = await import('path')
  const { existsSync, readFileSync } = await import('fs')

  const LEDGER = join(REPO_ROOT, 'docs/benchmarking-results.md')
  const exists = existsSync(LEDGER)
  check('benchmarking-results.md exists', exists)
  if (exists) {
    const text = readFileSync(LEDGER, 'utf8')
    // Every model whose result has been recorded. Append, never remove.
    for (const recorded of ['luna', 'glm52']) {
      check(`benchmarking-results.md still records ${recorded}`,
        text.includes(`\`${recorded}\``))
    }
    check('benchmarking-results.md still states the append-only rule',
      /append-only/i.test(text))
    // A results table with no denominator is not comparable to anything.
    check('benchmarking-results.md states the 97-entry denominator',
      text.includes('97'))
  }
}

console.log('\n-- claude-cli transport: the sandbox IS the blind-development boundary --')
// A `claude -p` process is an agent harness, not a completion endpoint. Left at
// its defaults it carries the full Claude Code system prompt, every CLAUDE.md in
// scope, and the Read/Bash tool set — any of which reaches the answer key that
// sits one directory above the corpus.
//
// Measured 2026-08-02: a session created with `--tools ""` and then resumed
// WITHOUT re-passing it regains the full tool set and will read an arbitrary
// file off disk. The trace loop's second turn is a resume, so this is not a
// hypothetical path — it is every lane's turn 2. These assertions are over the
// transport source, so they fail if a future edit drops a flag from either
// branch rather than only from the one someone remembered to test.
{
  const { readFileSync, existsSync } = await import('fs')
  const { join } = await import('path')
  const SRC = join(import.meta.dirname ?? '.', 'claude-cli-client.ts')
  const exists = existsSync(SRC)
  check('claude-cli-client.ts exists', exists)
  if (exists) {
    const src = readFileSync(SRC, 'utf8')
    // Assert over code, not prose. The file documents at length which flags are
    // forbidden and why, so a naive substring search matches its own warnings
    // and reports a violation that is actually the explanation of the rule.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const { SANDBOX_FLAGS } = await import('./claude-cli-client.js')

    check('sandbox disables all tools', SANDBOX_FLAGS.includes('--tools') &&
      SANDBOX_FLAGS[SANDBOX_FLAGS.indexOf('--tools') + 1] === '')
    // Without this the scanner runs inside the repo with CLAUDE.md
    // auto-discovered: measured at 2,959 extra tokens per call describing the
    // denylisted files, the answer key's location and the blind-development
    // scheme the scanner is being scored under.
    check('sandbox disables CLAUDE.md and other customizations',
      SANDBOX_FLAGS.includes('--safe-mode'))
    check('sandbox ignores ambient MCP servers', SANDBOX_FLAGS.includes('--strict-mcp-config'))
    check('sandbox disables skills', SANDBOX_FLAGS.includes('--disable-slash-commands'))

    // One spread of SANDBOX_FLAGS into the argv that BOTH branches share. If a
    // refactor ever builds resume args separately, this stops matching.
    check('every invocation spreads the sandbox flags',
      /const args:\s*string\[\]\s*=\s*\[[^\]]*\.\.\.SANDBOX_FLAGS/.test(code))
    check('resume reuses the same argv (no second, unsandboxed builder)',
      (code.match(/\.\.\.SANDBOX_FLAGS/g) ?? []).length === 1 &&
      /args\.push\('--resume'/.test(code))

    // Nothing is inherited across a resume. Measured: dropping --system-prompt
    // on turn 2 restored the default Claude Code preamble (660 -> 10,428 prompt
    // tokens) and dropping --json-schema made turn 2 answer in prose, which the
    // trace loop records as a lane that found nothing. So every parameter must
    // be pushed BEFORE the create-or-resume branch, not inside the create arm.
    const branchAt = code.indexOf('if (isFollowUp)')
    check('resume path is reached (branch exists)', branchAt > 0)
    for (const flag of ["'--system-prompt'", "'--json-schema'", "'--model'", "'--effort'"]) {
      const at = code.indexOf(flag)
      check(`${flag} is set for resumes too (pushed before the branch)`,
        at > 0 && at < branchAt)
    }

    // --add-dir would hand back filesystem scope the tool ban removed.
    check('transport never widens directory scope', !code.includes('--add-dir'))
    // Replacing the system prompt is what keeps CLAUDE.md and the Claude Code
    // preamble out of the corpus prompt; --append- would add to it instead.
    check('transport replaces rather than appends the system prompt',
      code.includes("'--system-prompt'") && !code.includes('--append-system-prompt'))
    // The CLI prices Sonnet 5 at the post-2026-08-31 rate; the registry is the
    // authority. Reading costUSD here would silently overstate every run.
    check('transport does not consume the CLI cost field', !/\bcostUSD\b/.test(code))
  }
}

console.log(`\n-- blocked attempts recorded: ${guardStats().blocked} --`)
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
