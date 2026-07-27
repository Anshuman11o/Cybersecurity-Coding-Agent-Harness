/** Smoke tests for the read guard and run-path helpers. Run: npx tsx shared/guard.test.ts */
import { readCorpusFile, isCorpusReadable, guardStats } from './read-guard.js'
import { runPath, RUNS_ROOT } from './run-paths.js'
import { resolveProvider, modelFor, tokenLimitParam, samplingParams } from './provider.js'

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

console.log('\n-- run paths --')
check('qwen path',   runPath('qwen', 'stage3-validate').endsWith('runs/qwen/stage3-validate'))
check('openai path', runPath('openai', 'stage3-validate').endsWith('runs/openai/stage3-validate'))
check('paths differ', runPath('qwen', 'stage2-hunt-lanes') !== runPath('openai', 'stage2-hunt-lanes'))
check('under RUNS_ROOT', runPath('openai', 'stage0-recon').startsWith(RUNS_ROOT))

console.log('\n-- provider resolution --')
delete process.env.SCANNER_PROVIDER
check('defaults to qwen', resolveProvider('stage2') === 'qwen')
process.env.SCANNER_PROVIDER = 'openai'
check('global override',  resolveProvider('stage2') === 'openai')
process.env.SCANNER_PROVIDER_STAGE3 = 'qwen'
check('per-stage wins',   resolveProvider('stage3') === 'qwen')
delete process.env.SCANNER_PROVIDER_STAGE3
check('model qwen',   modelFor('qwen') === 'qwen-plus')
check('model openai', modelFor('openai') === 'gpt-5.6-luna')
check('qwen max_tokens',            'max_tokens' in tokenLimitParam('qwen', 100))
check('openai max_completion_tokens','max_completion_tokens' in tokenLimitParam('openai', 100))
check('qwen has temperature',   'temperature' in samplingParams('qwen'))
check('openai omits sampling',  Object.keys(samplingParams('openai')).length === 0)
try { resolveProvider('x'); process.env.SCANNER_PROVIDER='bogus'; resolveProvider('x'); check('rejects unknown', false) }
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

console.log(`\n-- blocked attempts recorded: ${guardStats().blocked} --`)
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
