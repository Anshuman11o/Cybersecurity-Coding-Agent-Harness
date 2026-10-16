import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { computeScanPlan, resolveEstimateRatios, type PlanInput } from './scan-plan.js'
import { deriveConcurrency, NO_LIMITS } from './limits.js'
import { API_PROFILE_SCHEMA, type ApiProfile } from '../../shared/api-profile.js'
import { recordCalibration } from '../../shared/calibration.js'
import { SpendLedger, ledgerPathFor } from '../../shared/ledger.js'
import { writeCachedPlaybook, cacheDirectory } from '../../shared/playbook-cache.js'
import {
  productDefaultProvider, defaultProvider, modelFor, pricingFor, targetFor, calibrationFor, outputTokenCap, apiKeyEnvFor,
} from '../../shared/provider.js'
import { FOLLOW_UP_INPUT_MULTIPLIER, reservationUnitUsd, planCallReservationsUsd, scanCostUsd } from '../../shared/pricing.js'
import {
  buildLanePrompts, followUpTemplateBytes, loadPlaybooksForClasses, loadArchSummarySnippet, DEFAULT_OUTPUT_TOKEN_CAP,
} from '../../stage2-hunt-lanes-perfile/src/hunt-executor.js'
import type { LaneAssignmentEntry } from '../../stage2-hunt-lanes-perfile/src/types.js'

const provider = productDefaultProvider()
const model = modelFor(provider)
const stageDir = dirname(dirname(fileURLToPath(import.meta.url)))

function profile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    schema: API_PROFILE_SCHEMA, observed_at: new Date(0).toISOString(), provider, model,
    served_tier: 'default', tier_label: 'Standard', tier_multiplier: 1,
    rate_limits: { tokens_per_minute: null, requests_per_minute: null },
    recon_calls: 2, chars_per_token: 5, ...overrides,
  }
}

function planInput(count = 10): PlanInput {
  const lanes = Array.from({ length: count }, (_, i) => ({
    lane_id: `file-${i}`, target_file: `src/file-${i}.ts`, file_bytes: 100,
    projected_calls: 2, projected_input_tokens: 10_000, projected_output_tokens: 3410,
  }))
  return {
    provider, model, assignmentsPath: '/synthetic/assignments.json', assignmentsGeneratedAt: 'test',
    lanes, limits: { ...NO_LIMITS }, vendorConcurrencyCeiling: null,
    price: pricingFor(provider), priceAsOf: null, cost: () => { throw new Error('legacy pricing used') },
    estimation: {
      ratios: resolveEstimateRatios(provider, null, null, model, 'high'),
      profile: profile(), spentBeforeUsd: 0.1, outputCap: 64_000,
      promptBounds: new Map(lanes.map(l => [l.lane_id, {
        maxPromptBytes: 30_000, followUpTemplateBytes: 1000, callsPerChunk: 2,
      }])),
    },
  }
}

test('estimate ratios prefer recon then same-model, same-effort calibration, then registry and defaults', () => {
  const reports = mkdtempSync(join(tmpdir(), 'estimate-ratios-'))
  try {
    const record = { run_id: 'prior', at: new Date(0).toISOString(), model, effort: 'high', files: 10,
      calls: 20, input_tokens: 1000, output_tokens: 250, chars_sent: 3000,
      prompt_tokens_for_chars: 1000, ratio_R: 0.25, chars_per_token: 3 }
    recordCalibration(reports, record)
    recordCalibration(reports, { ...record, run_id: 'other-effort', effort: 'low', output_tokens: 9000, chars_sent: 9000 })
    recordCalibration(reports, { ...record, run_id: 'other-model', model: 'synthetic-other-model', output_tokens: 9000 })
    assert.deepEqual(resolveEstimateRatios(provider, profile(), reports, model, 'high'), {
      ratio_R: 0.25, ratio_source: 'calibration', chars_per_token: 5, chars_per_token_source: 'recon',
    })
    assert.deepEqual(resolveEstimateRatios(provider, null, reports, model, 'high'), {
      ratio_R: 0.25, ratio_source: 'calibration', chars_per_token: 3, chars_per_token_source: 'calibration',
    })
    const seeded = resolveEstimateRatios(provider, null, null, model, 'high')
    assert.equal(seeded.ratio_R, calibrationFor(provider)!.output_per_input)
    assert.equal(seeded.chars_per_token, calibrationFor(provider)!.chars_per_token)
    assert.equal(seeded.ratio_source, 'registry')
    assert.equal(seeded.chars_per_token_source, 'registry')
    assert.deepEqual(resolveEstimateRatios(defaultProvider(), null, null, modelFor(defaultProvider()), 'high'), {
      ratio_R: 0.341, ratio_source: 'default', chars_per_token: 4, chars_per_token_source: 'default',
    })
  } finally { rmSync(reports, { recursive: true, force: true }) }
})

test('estimate applies upper input pricing, tier, region, spent-before and the remaining cap', () => {
  const input = planInput()
  const estimation = input.estimation!
  estimation.profile = profile({ served_tier: 'flex' })
  // Get the regional host suffix from registry data; this is arithmetic only.
  const suffix = targetFor(provider).regional_endpoint_pattern!.split('\\.').slice(1).join('.').replace(/\$$/, '')
  estimation.baseURL = `https://region.${suffix}/v1`
  const laneCost = scanCostUsd(provider, {
    inputTokens: 10_000, ratioR: 0.341, servedTier: 'flex', baseURL: estimation.baseURL,
  })!
  input.limits.max_cost_usd = estimation.spentBeforeUsd + laneCost.scan_usd * 2.5
  const plan = computeScanPlan(input)
  const estimate = plan.estimate!
  assert.equal(estimate.input_tokens, 100_000)
  assert.equal(estimate.output_tokens, 34_100)
  const price = pricingFor(provider)!
  const multiplier = 0.5 * targetFor(provider).regional_uplift!
  assert.equal(estimate.input_usd, 100_000 * Math.max(price.input, price.cache_write!) / 1e6 * multiplier)
  assert.equal(estimate.output_usd, 34_100 * price.output / 1e6 * multiplier)
  assert.equal(estimate.total_usd, estimate.scan_usd + 0.1)
  assert.equal(estimate.tier_label, 'Flex')
  assert.equal(estimate.tier_multiplier, 0.5)
  assert.equal(estimate.region_multiplier, targetFor(provider).regional_uplift)
  assert.equal(plan.cap.lanes_within_cap, 2)
  assert.equal(plan.cap.estimate_exceeds_cap, true)
  assert.equal(plan.admitted[0].projected_cost_usd, laneCost.scan_usd)
})

test('one U uses the largest admitted prompt in bytes and long-context per-call bounds', () => {
  const input = planInput(3)
  input.limits.exclude = ['src/file-2.ts']
  const estimation = input.estimation!
  const largest = targetFor(provider).long_context!.threshold_tokens + 500
  estimation.promptBounds.set('file-1', { maxPromptBytes: largest, followUpTemplateBytes: 1500, callsPerChunk: 2 })
  estimation.promptBounds.set('file-2', { maxPromptBytes: largest * 10, followUpTemplateBytes: 9000, callsPerChunk: 9 })
  const plan = computeScanPlan(input)
  assert.equal(plan.reservation_unit_usd, reservationUnitUsd(provider, {
    callsPerUnit: 2, maxPromptBytes: largest, followUpTemplateBytes: 1500, outputCap: estimation.outputCap,
    servedTier: 'default',
  }))
  assert.equal(plan.estimate!.files, 2)
  assert.equal(plan.estimate!.input_tokens, 20_000)
  assert.equal(plan.excluded[0].reason, 'user-excluded')
})

test('estimate bands use admitted files, including no band below ten', () => {
  for (const [files, band] of [[9, null], [10, 78], [40, 27], [100, 15], [300, 7]] as const) {
    const input = planInput(files + 1)
    input.limits.max_files = files
    const plan = computeScanPlan(input)
    assert.equal(plan.estimate!.files, files)
    assert.equal(plan.estimate!.band_pct, band)
  }
})

test('unpriced tiers cannot yield an estimate, lane price or reservation', () => {
  const input = planInput()
  input.estimation!.profile = profile({ served_tier: 'unlisted-tier', tier_multiplier: null })
  input.limits.max_cost_usd = 5
  const plan = computeScanPlan(input)
  assert.equal(plan.estimate, null)
  assert.equal(plan.reservation_unit_usd, null)
  assert.equal(plan.totals.projected_cost_usd, null)
  assert.equal(plan.cap.lanes_within_cap, null)
  assert.ok(plan.admitted.every(l => l.projected_cost_usd === null))
})

test('the plan retains call settings priced into its fixed U; older callers remain supported', () => {
  const input = planInput(1)
  assert.equal(computeScanPlan(input).call_config, undefined)
  input.callConfig = {
    model, max_output_tokens: 32_000, sampling: { reasoning_effort: 'medium' },
    loop: { mode: 'trace', passes: 1, sweepGroupSize: 3, strictTrace: false }, base_url: null,
  }
  assert.deepEqual(computeScanPlan(input).call_config, input.callConfig)
})

test('rate-limit concurrency uses expected tokens and respects all derived ceilings; explicit wins', () => {
  const rates = { tokensPerMinute: 100_000, requestsPerMinute: 100,
    promptTokensPerCall: 1000, outputTokensPerCall: 500, secondsPerCall: 30 }
  assert.equal(deriveConcurrency(null, null, 100, rates).value, 23)
  assert.equal(deriveConcurrency(null, null, 100, { ...rates, tokensPerMinute: null }).value, 32)
  assert.equal(deriveConcurrency(null, 10, 100, rates).value, 10)
  assert.equal(deriveConcurrency(null, null, 3, rates).value, 3)
  assert.equal(deriveConcurrency(null, null, 100, { ...rates, requestsPerMinute: 2 }).value, 1)
  assert.equal(deriveConcurrency(50, 10, 3, rates).value, 50)
  assert.equal(deriveConcurrency(50, 10, 3, rates).source, 'explicit')
  assert.equal(deriveConcurrency(null, null, 100, rates).source, 'rate-limits')
  assert.equal(deriveConcurrency(null, null, 100, { ...rates, tokensPerMinute: null, requestsPerMinute: null }).value, 8)
  const input = planInput(100)
  input.estimation!.secondsPerCall = 30
  input.estimation!.profile = profile({ rate_limits: { tokens_per_minute: 100_000, requests_per_minute: 100 } })
  const plan = computeScanPlan(input)
  assert.equal(plan.concurrency.value, Math.floor(0.7 * 100_000 / ((5000 + 5000 * 0.341) * 60 / 30)))
  assert.equal(plan.concurrency.source, 'rate-limits')
  assert.equal(plan.concurrency.tokens_per_minute, 100_000)
  assert.equal(plan.concurrency.requests_per_minute, 100)
})

test('Stage 1 sizes the hunt builders exact chunk prompts and uses ledger spend without reading excluded files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'estimate-prompts-'))
  try {
    const target = join(root, 'target')
    const reports = join(root, 'reports')
    const runs = join(reports, 'runs', 'test-run')
    const reconDir = join(runs, provider, 'stage0-recon')
    const assignmentsDir = join(runs, provider, 'stage05-lane-selector-perfile')
    mkdirSync(target, { recursive: true })
    mkdirSync(reconDir, { recursive: true })
    mkdirSync(assignmentsDir, { recursive: true })
    const content = "export function sample() {\n  return 'héllo 🌎'\n}\n"
    writeFileSync(join(target, 'sample.ts'), content)
    const lane: LaneAssignmentEntry = {
      lane_id: 'sample', target_file: 'sample.ts', disposition: 'hunt', skip_reason: null,
      categories: [], classes: ['injection'], category_basis: null, file_bytes: Buffer.byteLength(content),
      file_lines: 4, estimated_prompt_tokens: 0,
      chunk_plan: { required: true, total_chunks: 2, chunks: [
        { index: 1, start_line: 1, end_line: 2 }, { index: 2, start_line: 2, end_line: 4 },
      ] },
    }
    const archPath = join(reconDir, 'architecture-summary.json')
    const arch = { route_table: { hand_written_routes: [], auto_crud_routes: [] }, subsystems: { api: {} } }
    writeFileSync(archPath, JSON.stringify(arch))
    writeFileSync(join(reconDir, 'api-profile.json'), JSON.stringify(profile()))
    writeFileSync(join(assignmentsDir, 'lane-assignments.json'), JSON.stringify({
      generated_at: 'test', target_dir: target, source_stage0_run: archPath,
      lanes: [lane, { ...lane, lane_id: 'excluded', target_file: 'excluded.ts' }],
    }))
    writeFileSync(join(runs, 'read-allowlist.json'), JSON.stringify({
      schema: 'secscan.read-allowlist/1', target_root: target, files: ['sample.ts'],
    }))
    const ledger = new SpendLedger(ledgerPathFor(runs, provider))
    for (const source of ['recon', 'hunt'] as const) ledger.append({
      source, stage: source, label: 'synthetic prior call', lane_id: null, attempt: 1, model,
      served_tier: 'default', usage: null, chars_sent: 0, cost_usd: 0.01, basis: 'reservation',
    })
    const env = { ...process.env, SCANNER_PROFILE: 'product', SCANNER_TARGET: target,
      SCANNER_PROVIDER: provider, SCANNER_REPORTS_ROOT: reports, SCANNER_RUNS_ROOT: runs,
      SCANNER_EXCLUDE: 'excluded.ts', SCANNER_MAX_COST: '1', SCANNER_MAX_FILES: '',
      SCANNER_MAX_FILE_SIZE: '', SCANNER_PATHS: '', SCANNER_INCLUDE: '', HUNT_CONCURRENCY: '',
      HUNT_LOOP: 'trace', HUNT_LOOP_PASSES: '1', SCANNER_REASONING_EFFORT: 'high' }
    const output = execFileSync(join(stageDir, 'node_modules/.bin/tsx'), ['-e',
      "import { computeScanPlanV2 } from './src/budget-governor.ts'; computeScanPlanV2().then(p => console.log(JSON.stringify(p)))",
    ], { cwd: stageDir, env, encoding: 'utf8' })
    const plan = JSON.parse(output.trim())
    const playbooks = await loadPlaybooksForClasses(lane.classes!)
    const prompts = buildLanePrompts(lane, content, lane.classes!, playbooks, loadArchSummarySnippet(archPath), arch)
    const expectedInput = prompts.reduce((sum, p) => sum + p.prompt.length / 5, 0) * (1 + FOLLOW_UP_INPUT_MULTIPLIER)
    assert.equal(plan.estimate.input_tokens, expectedInput)
    assert.equal(plan.admitted[0].projected_calls, 4)
    assert.equal(plan.estimate.spent_before_usd, 0.02)
    assert.equal(plan.estimate.chars_per_token_source, 'recon')
    assert.equal(plan.estimate.total_usd, plan.estimate.scan_usd + 0.02)
    assert.equal(plan.call_config.model, model)
    assert.equal(plan.call_config.max_output_tokens, outputTokenCap(provider, DEFAULT_OUTPUT_TOKEN_CAP))
    assert.equal(plan.call_config.sampling.reasoning_effort, 'high')
    assert.deepEqual(plan.call_config.loop, { mode: 'trace', passes: 1, sweepGroupSize: 3, strictTrace: false })
    assert.equal(plan.excluded[0].reason, 'user-excluded')
    assert.equal(plan.reservation_unit_usd, reservationUnitUsd(provider, {
      callsPerUnit: 2, maxPromptBytes: Math.max(...prompts.map(p => Buffer.byteLength(p.prompt, 'utf8'))),
      followUpTemplateBytes: followUpTemplateBytes(lane.classes!),
      outputCap: outputTokenCap(provider, DEFAULT_OUTPUT_TOKEN_CAP), servedTier: 'default',
    }))
    const perCall = planCallReservationsUsd(provider, {
      callsPerUnit: 2, maxPromptBytes: Math.max(...prompts.map(p => Buffer.byteLength(p.prompt, 'utf8'))),
      followUpTemplateBytes: followUpTemplateBytes(lane.classes!),
      outputCap: outputTokenCap(provider, DEFAULT_OUTPUT_TOKEN_CAP), servedTier: 'default',
    })!
    assert.equal(plan.first_call_reservation_usd, perCall.first_usd)
    assert.equal(plan.call_reservation_usd, perCall.max_usd)
    assert.ok(plan.call_reservation_usd < plan.reservation_unit_usd, 'one call holds less than a whole chunk')
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('product risk order prioritizes routes, distinct signals and path; lab keeps inventory bytes', () => {
  const input = planInput(6)
  input.now = new Date(0)
  const signals = [[], ['db_query', 'file_io', 'auth_check'], ['route_handler'],
    ['route_handler', 'db_query'], ['route_handler', 'db_query'], ['db_query', 'db_query']]
  input.lanes[3].target_file = 'src/z-route.ts'
  input.lanes[4].target_file = 'src/a-route.ts'
  const baseline = JSON.stringify(computeScanPlan(input))
  input.laneRisk = new Map(input.lanes.map((l, i) => [l.lane_id, { signals: signals[i], chunks: i + 1 }]))
  input.profile = 'benchmark'
  assert.equal(JSON.stringify(computeScanPlan(input)), baseline)
  input.profile = 'product'
  const plan = computeScanPlan(input)
  assert.deepEqual(plan.admitted.map(l => l.lane_id), ['file-4', 'file-3', 'file-2', 'file-1', 'file-5', 'file-0'])
  assert.match(plan.order_basis!, /route_handler/)
  assert.equal(plan.input_threshold_usd, plan.estimate!.spent_before_usd + plan.estimate!.input_usd)
  // A file starts once its first call's hold fits, whatever its chunk count.
  assert.equal(plan.first_start_usd, plan.estimate!.spent_before_usd + plan.first_call_reservation_usd!)
  input.limits.max_cost_usd = input.estimation!.spentBeforeUsd + plan.admitted[0].projected_cost_usd! * 2.5
  assert.equal(computeScanPlan(input).cap.lanes_within_cap, 2)
})

test('product thresholds and estimate price remaining work on resume without removing admitted lanes', () => {
  const input = planInput(3)
  input.profile = 'product'
  input.laneRisk = new Map(input.lanes.map(l => [l.lane_id, { signals: [], chunks: 2 }]))
  input.completedLaneIds = new Set(['file-0'])
  const plan = computeScanPlan(input)
  assert.equal(plan.admitted.length, 3)
  assert.equal(plan.estimate!.files, 2)
  assert.equal(plan.estimate!.input_tokens, 20_000)
  assert.equal(plan.first_start_usd, 0.1 + plan.first_call_reservation_usd!)
  input.completedLaneIds = new Set(input.lanes.map(l => l.lane_id))
  const done = computeScanPlan(input)
  assert.equal(done.first_start_usd, null)
  assert.equal(done.estimate!.total_usd, 0.1)
  input.estimation!.profile = profile({ served_tier: 'unlisted-tier', tier_multiplier: null })
  const unpriced = computeScanPlan(input)
  assert.equal(unpriced.input_threshold_usd, null)
  assert.equal(unpriced.first_start_usd, null)
})


test('the actual executor starts in reviewed risk order and keeps that order on resume', () => {
  const root = mkdtempSync(join(tmpdir(), 'risk-executor-'))
  try {
    const target = join(root, 'target')
    const runs = join(root, 'runs')
    const assignmentsDir = join(runs, provider, 'stage05-lane-selector-perfile')
    const planDir = join(runs, provider, 'stage1-budget-governor-perfile')
    const outDir = join(runs, provider, 'stage2-hunt-lanes-perfile')
    for (const dir of [target, assignmentsDir, planDir]) mkdirSync(dir, { recursive: true })
    const lanes = ['plain', 'query', 'route'].map((id, i) => ({
      lane_id: id, target_file: `${id}.ts`, disposition: 'hunt', skip_reason: null,
      categories: [], classes: ['injection'], category_basis: null, file_bytes: 25,
      file_lines: 1, estimated_prompt_tokens: 0,
      signals: [[], ['db_query', 'file_io'], ['route_handler']][i],
      chunk_plan: { required: false, total_chunks: 1, chunks: [{ index: 1, start_line: 1, end_line: 1 }] },
    }))
    for (const lane of lanes) writeFileSync(join(target, lane.target_file), `export const ${lane.lane_id} = 1;`)
    const archPath = join(root, 'architecture.json')
    writeFileSync(archPath, JSON.stringify({ route_table: { hand_written_routes: [], auto_crud_routes: [] } }))
    writeFileSync(join(assignmentsDir, 'lane-assignments.json'), JSON.stringify({
      generated_at: 'test', target_dir: target, source_stage0_run: archPath, lanes,
      coverage_ledger: { total_files_in_inventory: 3, assigned_hunt: 3, assigned_skip: 0, unaccounted: 0 },
    }))
    writeFileSync(join(runs, 'read-allowlist.json'), JSON.stringify({
      schema: 'secscan.read-allowlist/1', target_root: target, files: lanes.map(l => l.target_file),
    }))
    const ledger = new SpendLedger(ledgerPathFor(runs, provider))
    ledger.append({ source: 'playbook', stage: 'playbook', label: 'synthetic research', lane_id: null,
      attempt: 1, model, served_tier: 'default', usage: null, chars_sent: 0, cost_usd: 0.5, basis: 'reservation' })
    const requests = join(root, 'requests.jsonl')
    const mock = join(root, 'mock-fetch.mjs')
    writeFileSync(mock, `import { appendFileSync } from 'node:fs';
      globalThis.fetch = async (url, init) => {
        appendFileSync(${JSON.stringify(requests)}, init.body + '\\n');
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      };`)
    const env = { ...process.env, SCANNER_PROFILE: 'product', SCANNER_TARGET: target,
      SCANNER_PROVIDER: provider, SCANNER_REPORTS_ROOT: root, SCANNER_RUNS_ROOT: runs,
      SCANNER_EXCLUDE: '', SCANNER_MAX_COST: '', SCANNER_MAX_FILES: '', SCANNER_MAX_FILE_SIZE: '',
      SCANNER_PATHS: '', SCANNER_INCLUDE: '', SCANNER_TIMEOUT: '', SCANNER_RESUME: '',
      HUNT_CONCURRENCY: '1', HUNT_LOOP: 'none', HUNT_MAX_LANES: '1',
      [apiKeyEnvFor(provider)]: 'fake-test-credential', NODE_OPTIONS: `--import=${mock}` }
    const tsx = join(stageDir, 'node_modules/.bin/tsx')
    const generate = () => {
      const output = execFileSync(tsx, ['-e',
        "import { computeScanPlanV2 } from './src/budget-governor.ts'; computeScanPlanV2().then(p => console.log(JSON.stringify(p)))",
      ], { cwd: stageDir, env, encoding: 'utf8' })
      const plan = JSON.parse(output.trim())
      writeFileSync(join(planDir, 'scan-plan.json'), JSON.stringify(plan))
      return plan
    }
    const execute = () => execFileSync(tsx, [join(stageDir, '../stage2-hunt-lanes-perfile/src/hunt-executor.ts')],
      { cwd: stageDir, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const plan = generate()
    assert.deepEqual(plan.admitted.map((l: any) => l.lane_id), ['route', 'query', 'plain'])
    execute()
    let recorded = JSON.parse(readFileSync(join(outDir, 'budget-consumption.json'), 'utf8')).legacy_entries
    assert.deepEqual(recorded.map((l: any) => l.lane_id), ['route'])
    let progress = JSON.parse(readFileSync(join(outDir, 'progress.json'), 'utf8'))
    assert.ok(Math.abs(progress.spend.estimate_usd - plan.estimate.total_usd) < 1e-10)
    assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1)
    env.SCANNER_RESUME = '1'
    const resumed = generate()
    assert.equal(resumed.estimate.files, 2)
    assert.equal(resumed.first_start_usd, new SpendLedger(ledger.path).total() + resumed.first_call_reservation_usd)
    execute()
    recorded = JSON.parse(readFileSync(join(outDir, 'budget-consumption.json'), 'utf8')).legacy_entries
    assert.deepEqual(recorded.map((l: any) => l.lane_id), ['route', 'query'])
    progress = JSON.parse(readFileSync(join(outDir, 'progress.json'), 'utf8'))
    assert.ok(Math.abs(progress.spend.estimate_usd - resumed.estimate.total_usd) < 1e-10)
    assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('product planning never loads deleted overlay playbooks but still validates selected cache text', () => {
  const root = mkdtempSync(join(tmpdir(), 'selected-playbooks-'))
  try {
    const target = join(root, 'target'), runs = join(root, 'runs')
    const assignmentsDir = join(runs, provider, 'stage05-lane-selector-perfile')
    const agentDir = join(runs, provider, 'stage-playbook-agent')
    for (const dir of [target, assignmentsDir, agentDir]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(target, 'sample.ts'), 'export const sample = 1;')
    const archPath = join(root, 'architecture.json')
    writeFileSync(archPath, JSON.stringify({ route_table: { hand_written_routes: [], auto_crud_routes: [] } }))
    writeFileSync(join(assignmentsDir, 'lane-assignments.json'), JSON.stringify({
      generated_at: 'test', target_dir: target, source_stage0_run: archPath,
      lanes: [{ lane_id: 'sample', target_file: 'sample.ts', disposition: 'hunt', skip_reason: null,
        categories: [], classes: ['injection', 'selected-custom'], category_basis: null, file_bytes: 24,
        file_lines: 1, estimated_prompt_tokens: 0, signals: ['db_query'],
        chunk_plan: { required: false, total_chunks: 1, chunks: [{ index: 1, start_line: 1, end_line: 1 }] } }],
    }))
    writeFileSync(join(runs, 'read-allowlist.json'), JSON.stringify({
      schema: 'secscan.read-allowlist/1', target_root: target, files: ['sample.ts'],
    }))
    const cache = join(runs, 'playbooks') // run-scoped: <runsRoot>/playbooks
    const selected = writeCachedPlaybook(cache, 'Synthetic selected playbook text.', {
      class_id: 'selected-custom', playbook: 'selected-custom', framework: 'synthetic', model,
      codes: ['SYNTHETIC'], signals: ['db_query'], source_urls: [], queries: [], created_at: new Date(0).toISOString(),
    })
    const { playbook, framework, codes, signals, sha256 } = selected.meta
    writeFileSync(join(agentDir, 'classes-overlay.json'), JSON.stringify({
      'selected-custom': { playbook, framework, model, codes, signals, sha256 },
      'deleted-custom': { playbook: 'deleted-custom', framework, model, codes, signals, sha256: '0'.repeat(64) },
    }))
    const env = { ...process.env, SCANNER_PROFILE: 'product', SCANNER_TARGET: target,
      SCANNER_PROVIDER: provider, SCANNER_REPORTS_ROOT: root, SCANNER_RUNS_ROOT: runs,
      SCANNER_EXCLUDE: '', SCANNER_MAX_COST: '', SCANNER_MAX_FILES: '', SCANNER_MAX_FILE_SIZE: '',
      SCANNER_PATHS: '', SCANNER_INCLUDE: '', SCANNER_TIMEOUT: '', SCANNER_RESUME: '', HUNT_CONCURRENCY: '1', HUNT_LOOP: 'none' }
    const run = () => execFileSync(join(stageDir, 'node_modules/.bin/tsx'), ['src/budget-governor.ts', '--v2', '--mode', 'estimate'],
      { cwd: stageDir, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    run()
    const planDir = join(runs, provider, 'stage1-budget-governor-perfile')
    assert.equal(JSON.parse(readFileSync(join(planDir, 'scan-plan.json'), 'utf8')).admitted.length, 1)
    const selectedPath = join(cacheDirectory(cache, 'selected-custom', framework, model), 'playbook.md')
    writeFileSync(selectedPath, 'tampered selected text')
    assert.throws(run, /Playbook cache identity or sha256 mismatch: selected-custom/)
    rmSync(dirname(selectedPath), { recursive: true })
    assert.throws(run, /Missing cached playbook for selected-custom/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
