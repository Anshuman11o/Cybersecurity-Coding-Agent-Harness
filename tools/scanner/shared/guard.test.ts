/** Smoke tests for the read guard and run-path helpers. Run: npx tsx shared/guard.test.ts */
import { readCorpusFile, isCorpusReadable, guardStats } from './read-guard.js'
import { runPath, RUNS_ROOT, STAGES } from './run-paths.js'
import {
  resolveProvider, modelFor, tokenLimitParam, samplingParams,
  listProviders, defaultProvider, targetFor, apiKeyEnvFor, clientConfigFor,
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
check('luna omits sampling',      Object.keys(samplingParams('luna')).length === 0)
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

console.log(`\n-- blocked attempts recorded: ${guardStats().blocked} --`)
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
