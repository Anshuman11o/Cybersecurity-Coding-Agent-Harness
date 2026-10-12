import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs, usage, UsageError, type ScanArgs } from './args.js'
import { roundOneInputs, findResume, askNewBudget, budgetRemainder, tierNotice, reconRefusal, assertSameReadScope, type InputIO } from './inputs.js'
import { loadRegistryModules, type ModelInfo } from './registry.js'
import { NO_LIMITS } from '../../stage1-budget-governor/src/limits.js'
import { computeScanPlan, type ScanPlan } from '../../stage1-budget-governor/src/scan-plan.js'
import { buildSummary, renderSummary } from './confirm.js'
import { progressLine } from './progress.js'
import type { LedgerTotals } from '../../shared/ledger.js'
import type { ApiProfile } from '../../shared/api-profile.js'
import type { RunRecord } from './run-record.js'

function scripted(answers: string[], interactive = true) {
  const output: string[] = []
  const questions: { prompt: string; hidden: boolean }[] = []
  const io: InputIO = {
    interactive,
    write: text => { output.push(text) },
    async read(prompt, opts) {
      questions.push({ prompt, hidden: Boolean(opts?.hidden) })
      assert.ok(answers.length, `unexpected question: ${prompt}`)
      return answers.shift()!
    },
  }
  return { io, output, questions }
}

const model: ModelInfo = {
  key: 'm', label: 'Model M', model: 'm1', origin: 'registry', transport: 'openai',
  apiKeyEnv: 'TEST_SECRET', keyPresent: true, baseUrl: null, price: { input: 1, output: 2 },
  priceAsOf: null, measured: false, benchmark: null, maxConcurrency: null, isDefault: true,
}

function args(target: string, extra: string[] = []): ScanArgs {
  return { ...parseArgs(['scan', ...extra]) as ScanArgs, target }
}

function fixture(run: (target: string) => Promise<void> | void) {
  return async () => {
    const target = mkdtempSync(join(tmpdir(), 'secscan-inputs-'))
    try { await run(target) } finally { rmSync(target, { recursive: true, force: true }) }
  }
}

test('round 1 defaults preserve exact prompts and prepare a gitignored reports folder', fixture(async target => {
  const s = scripted(['', '', '', '5'])
  const result = await roundOneInputs({ args: args(target), model, limits: NO_LIMITS, io: s.io, env: { TEST_SECRET: 'present' } })
  assert.equal(result?.target, target)
  assert.equal(result?.reportsRoot, join(target, '.secscan'))
  assert.equal(result?.limits.max_cost_usd, 5)
  assert.equal(readFileSync(join(target, '.secscan', '.gitignore'), 'utf8'), '*\n')
  assert.equal(s.output[0], 'secscan · model Model M · TEST_SECRET found')
  assert.match(s.output.join('\n'), /Scan this repository\?  /)
  assert.ok(s.output.includes('                       [Enter] yes   [c] change   [q] quit'))
  assert.ok(s.output.includes('                       [Enter] yes   [c] change'))
  assert.ok(s.output.includes('Exclude anything?      none  (.secscanignore not found)'))
  assert.ok(s.output.includes('                       [Enter] no    [c] add files or folders'))
  assert.equal(s.questions.at(-1)?.prompt, 'Budget in USD?         > ')
}))

test('target change re-asks after a non-directory and q quits before reports exist', fixture(async target => {
  const next = join(target, 'next')
  mkdirSync(next)
  const file = join(target, 'file')
  writeFileSync(file, '')
  const s = scripted(['c', file, next, '', '', '', '2'])
  const result = await roundOneInputs({ args: args(target), model, limits: NO_LIMITS, io: s.io, env: { TEST_SECRET: 'present' } })
  assert.equal(result?.target, next)
  assert.equal(result?.reportsRoot, join(next, '.secscan'))
  assert.ok(s.output.includes(`not a directory: ${file}`))
  const quit = scripted(['q'])
  assert.equal(await roundOneInputs({ args: args(target), model, limits: NO_LIMITS, io: quit.io, env: { TEST_SECRET: 'present' } }), null)
  assert.deepEqual(readdirSync(target).sort(), ['file', 'next'])
}))

test('change reports, add exclusions, and invalid budget answers re-ask', fixture(async target => {
  const reports = join(target, 'reports')
  const s = scripted(['', 'c', reports, '', 'c', 'vendor, **/*.generated.ts', 'bad', '-2', '0', '3.25'])
  const result = await roundOneInputs({ args: args(target), model, limits: NO_LIMITS, io: s.io, env: { TEST_SECRET: 'present' } })
  assert.equal(result?.reportsRoot, reports)
  assert.deepEqual(result?.limits.exclude, ['vendor', '**/*.generated.ts'])
  assert.equal(result?.limits.max_cost_usd, 3.25)
  assert.equal(s.questions.filter(q => q.prompt.startsWith('Budget in USD')).length, 4)
  assert.equal(readFileSync(join(reports, '.gitignore'), 'utf8'), '*\n')
}))

test('changing targets replaces the first target model and scope before asking for the key', fixture(async target => {
  const next = join(target, 'next')
  mkdirSync(next)
  const s = scripted(['c', next, '', 'replacement-secret', '', '', '2'])
  const env: NodeJS.ProcessEnv = {}
  const result = await roundOneInputs({
    args: args(target), model, limits: { ...NO_LIMITS, exclude: ['old'] }, io: s.io, env,
    async targetSelected(selected) {
      assert.equal(selected, next)
      return { model: { ...model, key: 'different', label: 'Replacement', apiKeyEnv: 'OTHER_TEST_SECRET' },
        limits: { ...NO_LIMITS, paths: ['new'], exclude: ['new-vendor'] } }
    },
  })
  assert.equal(env.TEST_SECRET, undefined)
  assert.equal(env.OTHER_TEST_SECRET, 'replacement-secret')
  assert.equal(s.questions.filter(q => q.hidden).length, 1)
  assert.deepEqual(result?.limits.paths, ['new'])
  assert.deepEqual(result?.limits.exclude, ['new-vendor'])
  assert.match(s.output.join('\n'), /model Replacement/)
}))

test('same-run reading scope changes are refused; budget and admission limits can change', () => {
  const old = { ...NO_LIMITS, paths: ['src'], exclude: ['vendor'], max_cost_usd: 4 }
  assert.doesNotThrow(() => assertSameReadScope(old, { ...old, max_cost_usd: 8, max_files: 100 }))
  assert.throws(() => assertSameReadScope(old, { ...old, paths: [] }), /start a new scan/)
  assert.throws(() => assertSameReadScope(old, { ...old, exclude: [] }), /start a new scan/)
})

test('flags are shown as decided and skip their corresponding questions', fixture(async target => {
  const a = parseArgs(['scan', target, '--out', join(target, 'out'), '--exclude', 'vendor', '--budget', '7']) as ScanArgs
  const s = scripted([])
  const result = await roundOneInputs({ args: a, model, limits: { ...NO_LIMITS, ...a.limits }, io: s.io, env: { TEST_SECRET: 'present' } })
  assert.equal(s.questions.length, 0)
  assert.equal(result?.limits.max_cost_usd, 7)
  assert.ok(s.output.includes('Budget in USD?         7'))
  assert.ok(s.output.includes('Exclude anything?      vendor'))
}))

test('missing key is asked exactly once, hidden, inherited in memory, and never saved', fixture(async target => {
  const secret = 'fake-sensitive-value-for-hidden-input'
  const env: NodeJS.ProcessEnv = {}
  const s = scripted(['', secret, '', '', '1'])
  await roundOneInputs({ args: args(target), model: { ...model, keyPresent: false }, limits: NO_LIMITS, io: s.io, env })
  assert.equal(env[model.apiKeyEnv], secret)
  assert.equal(s.questions.filter(q => q.hidden).length, 1)
  assert.equal(s.questions.find(q => q.hidden)?.prompt, `${model.apiKeyEnv}: `)
  assert.ok(!s.output.join('\n').includes(secret))
  const inspect = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) inspect(path)
      else assert.ok(!readFileSync(path, 'utf8').includes(secret), path)
    }
  }
  inspect(target)
  const empty = scripted(['', ''])
  await assert.rejects(() => roundOneInputs({ args: args(target), model, limits: NO_LIMITS, io: empty.io, env: {} }), /was empty/)
  assert.equal(empty.questions.filter(q => q.hidden).length, 1)
}))

test('--yes requires an explicit budget; non-interactive missing keys never prompt', fixture(async target => {
  assert.throws(() => parseArgs(['--yes']), /requires --budget/)
  assert.equal((parseArgs(['--yes', '--budget', '4']) as ScanArgs).limits.max_cost_usd, 4)
  assert.equal((parseArgs(['--yes', '--resume']) as ScanArgs).resume, true)
  assert.equal((parseArgs(['--max-cost', '4']) as ScanArgs).limits.max_cost_usd, 4)
  const s = scripted([], false)
  await assert.rejects(() => roundOneInputs({
    args: args(target, ['--yes', '--budget', '4']), model, limits: { ...NO_LIMITS, max_cost_usd: 4 }, io: s.io, env: {},
  }), /not set/)
  assert.equal(s.questions.length, 0)
}))

test('--resume finds latest INCOMPLETE, keeps --yes budget, and interactive resume asks a new one', fixture(async target => {
  const reports = join(target, '.secscan')
  const write = (id: string, status: 'COMPLETE' | 'INCOMPLETE', at: string): RunRecord => {
    const record = { schema: 'secscan.run-record/1', run_id: id, status, updated_at: at,
      target: { root: target }, limits: { ...NO_LIMITS, max_cost_usd: 9 } } as RunRecord
    mkdirSync(join(reports, 'runs', id), { recursive: true })
    writeFileSync(join(reports, 'runs', id, 'run-record.json'), JSON.stringify(record))
    return record
  }
  write('older', 'INCOMPLETE', '2026-01-01T00:00:00Z')
  const previous = write('recent', 'INCOMPLETE', '2026-01-02T00:00:00Z')
  write('finished', 'COMPLETE', '2026-01-03T00:00:00Z')
  assert.equal(findResume(reports, true).run_id, 'recent')
  assert.equal(findResume(reports, 'older').run_id, 'older')
  assert.throws(() => findResume(reports, '../escape'), UsageError)
  assert.throws(() => findResume(reports, 'finished'), /no INCOMPLETE/)
  const yes = scripted([], false)
  const resumed = await roundOneInputs({ args: args(target, ['--yes', '--resume']), model, limits: previous.limits, resumed: previous, io: yes.io, env: { TEST_SECRET: 'present' } })
  assert.equal(resumed?.limits.max_cost_usd, 9)
  const interactive = scripted(['12'])
  const raised = await roundOneInputs({ args: args(target, ['--resume']), model, limits: previous.limits, resumed: previous, io: interactive.io, env: { TEST_SECRET: 'present' } })
  assert.equal(raised?.limits.max_cost_usd, 12)
  assert.deepEqual(interactive.questions.map(q => q.prompt), ['Budget in USD?         > '])
}))

const totals: LedgerTotals = {
  total_usd: 7, by_source: { recon: 1, hunt: 6 }, calls: 10, reserved_calls: 0,
  prompt_tokens: 100, completion_tokens: 30, chars_sent: 400, prompt_tokens_with_chars: 100, chars_with_prompt_tokens: 400,
}

function plan(): ScanPlan {
  return computeScanPlan({
    provider: 'm', model: 'm1', assignmentsPath: '/unused', assignmentsGeneratedAt: '',
    lanes: Array.from({ length: 10 }, (_, i) => ({ lane_id: `l${i}`, target_file: `f${i}.ts`, file_bytes: 100,
      projected_calls: 2, projected_input_tokens: 100, projected_output_tokens: 30 })),
    limits: NO_LIMITS, vendorConcurrencyCeiling: null, price: model.price, priceAsOf: null, cost: () => 3,
  })
}

test('at-cap arithmetic uses hunt spend, total ledger spend, and estimate when N=0', () => {
  assert.deepEqual(budgetRemainder(totals, 3, 10, plan()), { spent: 7, done: 3, total: 10, left: 7, average: 2, more: 14 })
  assert.deepEqual(budgetRemainder({ ...totals, by_source: { recon: 1 } }, 0, 10, plan()), { spent: 7, done: 0, total: 10, left: 10, average: 3, more: 30 })
})

test('at-cap prompt validates higher budget; Enter, --yes and no terminal stop', async () => {
  const opts = { yes: false, totals, done: 3, total: 10, plan: plan() }
  const s = scripted(['bad', '7', '8'])
  assert.equal(await askNewBudget(s.io, opts), 8)
  assert.equal(s.output[0], 'Budget reached: $7.00 spent. 3 of 10 files done, 7 left.')
  assert.equal(s.output[1], "At this run's average ($2.00 per file), finishing needs about $14.00 more.")
  assert.equal(s.questions[0].prompt, 'New budget, or Enter to stop: > ')
  assert.equal(await askNewBudget(scripted(['']).io, opts), null)
  assert.equal(await askNewBudget(scripted([]).io, { ...opts, yes: true }), null)
  assert.equal(await askNewBudget(scripted([], false).io, opts), null)
})

test('tier note identifies priced non-standard tiers and refuses unknown prices', () => {
  const profile = { tier_label: 'Standard', tier_multiplier: 1, served_tier: null } as ApiProfile
  assert.deepEqual(tierNotice(profile), { message: null, refuse: false })
  assert.match(tierNotice({ ...profile, served_tier: 'flex', tier_label: 'Flex', tier_multiplier: .5 }).message!, /Flex \(0.5× Standard\)/)
  const unknown = tierNotice({ ...profile, served_tier: 'unpublished', tier_multiplier: null })
  assert.equal(unknown.refuse, true)
  assert.match(unknown.message!, /unpriced.*INCOMPLETE/)
  assert.equal(reconRefusal({ ...profile, served_tier: 'unpublished', tier_multiplier: null })?.reason, 'unpriced_service_tier')
  const quota = reconRefusal({ ...profile, stop_reason: 'provider_quota' })
  assert.equal(quota?.reason, 'provider_quota')
  assert.match(quota!.detail, /quota.*INCOMPLETE/)
})

test('product default model comes from registry and explicit lab model still resolves', async () => {
  const registry = await loadRegistryModules()
  assert.equal(registry.defaultKey(), 'luna6')
  assert.equal(registry.info(registry.defaultKey()).isDefault, true)
  const explicit = parseArgs(['--model', 'luna']) as ScanArgs
  assert.equal(registry.info(explicit.model!).key, 'luna')
  assert.match(usage('CUSTOM_VAR'), /Lab options:\n  --model/)
})

test('estimate screen includes total, input, output, and the calibrated band', () => {
  const p = plan()
  p.estimate = {
    input_tokens: 1000, output_tokens: 300, input_usd: 10, output_usd: 20, scan_usd: 30,
    spent_before_usd: 1, total_usd: 31, band_pct: 78, files: 10, ratio_R: .3, ratio_source: 'fixture',
    chars_per_token: 4, chars_per_token_source: 'fixture', served_tier: null, tier_label: 'Standard',
    tier_multiplier: 1, region_multiplier: 1,
  }
  const build = () => buildSummary({ targetDisplay: '.', targetRoot: '/fixture', commit: null, branch: null,
    lanes: [], inventoryFiles: 10, byLanguage: undefined, plan: p, model, resume: null })
  assert.equal(build().estimate.usd, 31)
  assert.match(renderSummary(build()), /Total \$31.00: \$1.00 spent \+ input \$10.00 \+ output \$20.00/)
  assert.match(renderSummary(build()), /Accuracy band: ±78% \(90%\)/)
  p.estimate.band_pct = null
  assert.match(renderSummary(build()), /[Cc]an vary widely/)
})

test('progress displays supplied ledger total ahead of legacy or snapshot spend', () => {
  const p = { started_at: new Date(0).toISOString(), status: 'running', lanes: { total: 10, done: 3, carried: 0, failed: 0, in_flight: 0 },
    spend: { spent_usd: 99, ledger_spent_usd: 8, estimate_usd: 10, cap_usd: 12 },
    findings: { total: 0, by_severity: { critical: 0, high: 0, medium: 0, low: 0 } } } as Parameters<typeof progressLine>[0]
  assert.match(progressLine(p, 1000, 50, 7), /\$7.00 spent/)
  assert.match(progressLine(p, 1000, 50), /\$8.00 spent/)
})
