import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { computeScanPlan, resolveEstimateRatios, type PlanInput } from './scan-plan.js'
import { deriveConcurrency, NO_LIMITS } from './limits.js'
import { API_PROFILE_SCHEMA, type ApiProfile } from '../../shared/api-profile.js'
import { recordCalibration } from '../../shared/calibration.js'
import { SpendLedger, ledgerPathFor } from '../../shared/ledger.js'
import {
  productDefaultProvider, defaultProvider, modelFor, pricingFor, targetFor, calibrationFor, outputTokenCap,
} from '../../shared/provider.js'
import { FOLLOW_UP_INPUT_MULTIPLIER, reservationUnitUsd, scanCostUsd } from '../../shared/pricing.js'
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
  } finally { rmSync(root, { recursive: true, force: true }) }
})
