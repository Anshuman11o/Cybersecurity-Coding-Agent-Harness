/** Exercise scan itself with synthetic artifacts; no stage or model is launched. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { ScanDependencies } from './secscan.js'
import type { RunRecord } from './run-record.js'
import type { ClassSelection } from '../../shared/playbook-overlay.js'

type Scenario = 'add-success' | 'add-failure' | 'replan-failure' | 'resume-review-quit' | 'frozen-resume-add' | 'review-interrupt' | 'resume-replan-failure' | 'resume-selector-failure'
const childScenario = process.env.SECSCAN_ORCHESTRATION_CASE as Scenario | undefined

async function exerciseScan(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'secscan-orchestration-'))
  try {
    // A fresh process isolates registry and run-path module caches. Clear inherited
    // scanner options before importing the CLI, and supply only dummy credentials.
    for (const key of Object.keys(process.env)) if (key.startsWith('SCANNER_')) delete process.env[key]
    const registry = JSON.parse(readFileSync(new URL('../../shared/models.json', import.meta.url), 'utf8'))
    const model = registry.product_default_provider
    process.env[registry.targets[model].api_key_env] = 'synthetic-test-key'
    process.env.SCANNER_PLAYBOOK_AGENT = '0'
    globalThis.fetch = async () => { throw new Error('Network access forbidden in orchestration test') }
    const target = join(root, 'app')
    mkdirSync(target)
    writeFileSync(join(target, 'handler.ts'), 'export const handle = () => "ok"\n')

    const { scan, PRE_STAGES } = await import('./secscan.js')
    const { parseArgs } = await import('./args.js')
    const { computeScanPlan } = await import('../../stage1-budget-governor/src/scan-plan.js')
    const { NO_LIMITS } = await import('../../stage1-budget-governor/src/limits.js')
    const stages: string[] = []
    const events: string[] = []
    const output: string[] = []
    let interruptReview: (() => void) | undefined
    const requestedClass = scenario === 'resume-review-quit' ? 'prototype-pollution' : 'access-control'
    let planCount = 0
    let selectorCount = 0
    let runsRoot = ''
    let provider = ''
    let stagePaths: typeof import('../../shared/run-paths.js') | undefined
    let selection: ClassSelection = {
      schema: 'secscan.class-selection/1', created_at: new Date().toISOString(),
      model: registry.targets[model].model, builtin: ['injection'], added: [], classes: ['injection'],
    }
    let review: ReturnType<NonNullable<ScanDependencies['review']>['readClassReview']> = null
    const save = (path: string, value: unknown) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(value))
    }
    const stageFile = (stage: Parameters<NonNullable<typeof stagePaths>['runPath']>[1], file: string) => {
      assert.ok(stagePaths)
      const path = join(stagePaths.runPath(provider, stage), file)
      assert.ok(path.startsWith(runsRoot + '/'), 'every artifact belongs to this synthetic run')
      return path
    }
    const fakeLaunch: NonNullable<ScanDependencies['launchStage']> = options => {
      assert.equal(options.env.SCANNER_PLAYBOOK_AGENT, '1', 'the product agent is always on')
      assert.equal(options.env.SCANNER_PROFILE, 'product')
      assert.equal(options.target, target)
      runsRoot = options.env.SCANNER_RUNS_ROOT!
      provider = options.provider
      assert.ok(runsRoot.startsWith(root + '/'))
      stages.push(options.stage)
      events.push(options.stage)
      const started = new Date().toISOString()
      const done = (async () => {
        stagePaths = await import('../../shared/run-paths.js')
        let exitCode = 0
        switch (options.stage) {
          case 'stage0-recon':
            save(stageFile(options.stage, 'architecture-summary.json'), {
              file_inventory: { by_language: { typescript: { count: 1 } } },
            })
            break
          case 'stage-playbook-agent':
            save(stageFile(options.stage, 'class-selection.json'), selection)
            break
          case 'stage05-lane-selector-perfile':
            selectorCount++
            if (scenario === 'resume-selector-failure' && selectorCount === 2) {
              exitCode = 1
              writeFileSync(options.logPath, 'Synthetic selector replan failed\n')
              break
            }
            save(stageFile(options.stage, 'lane-assignments.json'), {
              lanes: [{ lane_id: 'handler', target_file: 'handler.ts', disposition: 'hunt',
                skip_reason: null, classes: selection.classes, chunking: { total_chunks: 1 } }],
              coverage_ledger: { total_files_in_inventory: 1 }, class_selection: { unrouted: [] },
            })
            break
          case 'stage1-budget-governor-perfile': {
            planCount++
            if (['replan-failure', 'resume-replan-failure'].includes(scenario) && planCount === 2) {
              exitCode = 1
              writeFileSync(options.logPath, 'Synthetic replan failed\n')
              break
            }
            save(stageFile(options.stage, 'scan-plan.json'), computeScanPlan({
              provider, model: registry.targets[model].model,
              assignmentsPath: stageFile('stage05-lane-selector-perfile', 'lane-assignments.json'),
              assignmentsGeneratedAt: started,
              lanes: [{ lane_id: 'handler', target_file: 'handler.ts', file_bytes: 36,
                projected_calls: 1, projected_input_tokens: 100, projected_output_tokens: 10 }],
              limits: { ...NO_LIMITS, max_cost_usd: 10 }, vendorConcurrencyCeiling: null,
              price: { input: 1, output: 1 }, priceAsOf: null, cost: (i, o) => (i + o) / 1e6,
            }))
            break
          }
          case 'stage2-hunt-lanes-perfile':
            assert.ok(['add-success', 'resume-replan-failure', 'resume-selector-failure'].includes(scenario), 'failed review or replan must not start a hunt')
            assert.equal(planCount, scenario === 'resume-replan-failure' ? 3 : 2)
            assert.deepEqual(selection.classes, ['access-control', 'injection'])
            save(stageFile(options.stage, 'run-status.json'), {
              schema: 'secscan.stage2-status/1', generated_at: new Date().toISOString(),
              started_at: started, ended_at: new Date().toISOString(), status: 'COMPLETE', reasons: [],
              lanes: { hunt: 1, admitted: 1, completed: 1, failed: 0, not_started: 0 },
              unscanned: [], scope_excluded: [], findings_total: 0, blocked_reads: 0,
              spend: { spent_usd: 0, estimate_usd: 0.00011, cap_usd: 10, calibration: 1 },
              limits: { ...NO_LIMITS, max_cost_usd: 10 }, resume_hint: null,
            })
            break
          default: assert.fail(`Unexpected real stage requested: ${options.stage}`)
        }
        if (exitCode === 0 && PRE_STAGES.includes(options.stage as typeof PRE_STAGES[number])) {
          save(stageFile(options.stage as typeof PRE_STAGES[number], 'meta.json'), { exit_code: 0 })
        }
        return { stage: options.stage, exit_code: exitCode, signal: null, started_at: started,
          ended_at: new Date().toISOString(), log: options.logPath }
      })()
      // No child process exists: every artifact is generated by the injected fake.
      return { stage: options.stage, child: {} as ReturnType<NonNullable<ScanDependencies['launchStage']>>['child'], done }
    }
    const fakeReview: NonNullable<ScanDependencies['review']> = {
      initializeClassReview() {
        if (review) return review
        review = {
          schema: 'secscan.class-review/1', agent_selection: structuredClone(selection),
          final: structuredClone(selection), edits: [], budget_changes: [],
        }
        return review
      },
      readClassReview() { return review },
      recordReviewBudget() { assert.fail('No budget change requested') },
      async reviewClass(request) {
        events.push('review:add')
        assert.equal(request.action, 'add')
        assert.equal(request.input, requestedClass)
        if (scenario === 'review-interrupt') {
          assert.ok(interruptReview, 'review subscribes to terminal interrupts')
          assert.equal(request.signal?.aborted, false)
          interruptReview()
          assert.equal(request.signal?.aborted, true, 'terminal Ctrl-C aborts the active review call')
          const { SpendLedger, ledgerPathFor } = await import('../../shared/ledger.js')
          new SpendLedger(ledgerPathFor(runsRoot, provider)).append({
            source: 'playbook', stage: 'stage-playbook-agent', label: 'review:resolve',
            lane_id: null, attempt: 1, model: selection.model, served_tier: null, usage: null,
            chars_sent: 0, cost_usd: 0.005, basis: 'reservation', note: 'Synthetic interrupted attempt',
          })
          review!.edits.push({ at: new Date().toISOString(), action: 'add', input: request.input,
            resolved: { kind: 'failed', id: null }, call_labels: ['review:resolve'],
            cost_usd: 0.005, message: 'Synthetic review interrupted' })
          return { ok: false, changed: false, message: 'Synthetic review interrupted', selection, review: review! }
        }
        if (scenario === 'add-failure') return {
          ok: false, changed: false, message: 'Synthetic class research failed', selection, review: review!,
        }
        if (scenario === 'resume-review-quit') {
          const { SpendLedger, ledgerPathFor } = await import('../../shared/ledger.js')
          new SpendLedger(ledgerPathFor(runsRoot, provider)).append({
            source: 'playbook', stage: 'stage-playbook-agent', label: `review:research:${requestedClass}`,
            lane_id: null, attempt: 1, model: selection.model, served_tier: null, usage: null,
            chars_sent: 0, cost_usd: 0.025, basis: 'reservation', note: 'Synthetic research; no model called',
          })
          selection = { ...selection, added: [requestedClass], classes: ['injection', requestedClass] }
        } else {
          selection = { ...selection, builtin: ['access-control', 'injection'], classes: ['access-control', 'injection'] }
        }
        save(stageFile('stage-playbook-agent', 'class-selection.json'), selection)
        review!.final = structuredClone(selection)
        review!.edits.push({ at: new Date().toISOString(), action: 'add', input: request.input,
          resolved: { kind: scenario === 'resume-review-quit' ? 'researched' : 'builtin', id: request.input },
          call_labels: scenario === 'resume-review-quit' ? [`review:research:${requestedClass}`] : [],
          cost_usd: scenario === 'resume-review-quit' ? 0.025 : 0, message: `Added ${requestedClass}` })
        return { ok: true, changed: true, message: 'Added access-control', selection, review: review! }
      },
    }
    const args = parseArgs(['scan', target, '--no-config', '--yes', '--budget', '10', '--add-class', requestedClass])
    assert.equal(args.command, 'scan')
    if (args.command !== 'scan') return
    if (scenario === 'resume-replan-failure' || scenario === 'resume-selector-failure') {
      const deps = { launchStage: fakeLaunch, review: fakeReview,
        io: () => ({ interactive: false, write: (text: string) => output.push(text),
          read: async () => assert.fail('--yes must never prompt') }) }
      assert.equal(await scan(args, deps), 1)
      const recordPath = join(runsRoot, 'run-record.json')
      const previous = JSON.parse(readFileSync(recordPath, 'utf8')) as RunRecord
      const failedStage = scenario === 'resume-replan-failure' ? 'stage1-budget-governor-perfile' : 'stage05-lane-selector-perfile'
      assert.equal(previous.stages.findLast(stage => stage.stage === failedStage)?.exit_code, 1)
      assert.equal(JSON.parse(readFileSync(stageFile(failedStage, 'meta.json'), 'utf8')).exit_code, 0,
        'old successful metadata survives the failed replan')
      assert.ok(JSON.parse(readFileSync(stageFile('stage1-budget-governor-perfile', 'scan-plan.json'), 'utf8')),
        'the stale plan remains on disk after failure')
      stages.length = 0
      events.length = 0
      assert.equal(await scan({ ...args, classes: undefined, resume: previous.run_id, out: join(target, '.secscan') }, deps), 0)
      assert.deepEqual(events, scenario === 'resume-replan-failure'
        ? ['stage1-budget-governor-perfile', 'stage2-hunt-lanes-perfile']
        : ['stage05-lane-selector-perfile', 'stage1-budget-governor-perfile', 'stage2-hunt-lanes-perfile'])
      const resumed = JSON.parse(readFileSync(recordPath, 'utf8')) as RunRecord
      assert.equal(resumed.status, 'COMPLETE')
      assert.deepEqual(resumed.class_review?.final.classes, ['access-control', 'injection'])
      return
    }
    if (scenario === 'review-interrupt') {
      const answers = ['a', requestedClass, 'q']
      const code = await scan({ ...args, yes: false, classes: undefined, out: join(target, '.secscan'),
        limits: { ...args.limits, exclude: [] } }, {
        launchStage: fakeLaunch, review: fakeReview,
        io: () => ({ interactive: true, write: text => output.push(text),
          async read() {
            assert.ok(answers.length, 'only add, class name, and quit prompts are expected')
            return answers.shift()!
          },
          onInterrupt(callback: () => void) {
            assert.equal(interruptReview, undefined)
            interruptReview = callback
            return () => { interruptReview = undefined }
          },
        }),
      })
      assert.equal(code, 0)
      assert.equal(answers.length, 0)
      assert.equal(interruptReview, undefined, 'terminal interrupt subscription is removed after review')
      assert.deepEqual(events, [...PRE_STAGES, 'review:add'])
      const failure = output.findIndex(text => text.includes('Synthetic review interrupted'))
      assert.ok(failure >= 0)
      assert.ok(output.slice(failure + 1).some(text => text.includes('Vulnerability classes')),
        'the class review screen redraws after an interrupted call')
      const record = JSON.parse(readFileSync(join(runsRoot, 'run-record.json'), 'utf8')) as RunRecord
      assert.deepEqual(record.class_review?.final.classes, ['injection'])
      assert.equal(record.class_review?.edits[0].resolved.kind, 'failed')
      assert.equal(record.spend.spent_usd, 0.005)
      assert.equal(record.spend.calls, 1)
      assert.equal(record.status, 'INCOMPLETE')
      assert.ok(!stages.includes('stage2-hunt-lanes-perfile'))
      return
    }
    if (scenario === 'resume-review-quit' || scenario === 'frozen-resume-add') {
      const reportsRoot = join(target, '.secscan')
      const io = () => ({ interactive: true, write: (text: string) => output.push(text),
        read: async (prompt: string) => {
          assert.equal(prompt, '> ', 'only round-two quit is expected')
          return 'q'
        } })
      const initialArgs = { ...args, yes: false, classes: undefined, out: reportsRoot,
        limits: { ...args.limits, exclude: [] } }
      assert.equal(await scan(initialArgs, { launchStage: fakeLaunch, review: fakeReview, io }), 0)
      const recordPath = join(runsRoot, 'run-record.json')
      const previous = JSON.parse(readFileSync(recordPath, 'utf8')) as RunRecord
      assert.ok(!existsSync(join(runsRoot, 'report.html')), 'quitting at confirmation writes no report')
      assert.ok(!existsSync(join(runsRoot, 'findings.json')))
      assert.equal(previous.status, 'INCOMPLETE')
      assert.equal(previous.spend.spent_usd, 0)
      assert.deepEqual(previous.class_review?.final.classes, ['injection'])
      if (scenario === 'frozen-resume-add') {
        // Seed a stopped hunt with findings and incomplete coverage. A rejected
        // resume edit must preserve those prior results in the durable record.
        previous.stages.push({ stage: 'stage2-hunt-lanes-perfile', exit_code: 0, signal: null,
          started_at: previous.created_at, ended_at: previous.updated_at, log: join(runsRoot, 'secscan.log') })
        previous.coverage = { inventory_files: 2, hunt_lanes: 2, admitted: 2,
          completed: 1, failed: 0, not_started: 1 }
        previous.findings_total = 7
        previous.unscanned = [{ lane_id: 'remaining', target_file: 'remaining.ts', reason: 'max_cost', detail: 'Synthetic cap' }]
        previous.incomplete_reasons = [{ reason: 'max_cost', detail: 'Synthetic cap' }]
        save(recordPath, previous)
        // The partial report from that stopped hunt must survive a cancelled resume.
        writeFileSync(join(runsRoot, 'report.html'), 'earlier partial report')
      }
      stages.length = 0
      events.length = 0
      const resumeArgs = { ...args, yes: false, resume: previous.run_id, out: reportsRoot }
      assert.equal(await scan(resumeArgs, { launchStage: fakeLaunch, review: fakeReview, io }),
        scenario === 'frozen-resume-add' ? 1 : 0)
      const resumed = JSON.parse(readFileSync(recordPath, 'utf8')) as RunRecord
      if (scenario === 'frozen-resume-add') {
        assert.deepEqual(events, [], 'frozen review refuses class changes before any edit or stage')
        assert.match(output.join('\n'), /Classes are frozen/)
        assert.equal(resumed.coverage.completed, 1)
        assert.equal(resumed.findings_total, 7)
        assert.deepEqual(resumed.coverage, previous.coverage)
        assert.deepEqual(resumed.unscanned, previous.unscanned)
        assert.deepEqual(resumed.incomplete_reasons, previous.incomplete_reasons)
        assert.equal(resumed.status, 'INCOMPLETE')
        assert.equal(readFileSync(join(runsRoot, 'report.html'), 'utf8'), 'earlier partial report',
          'a cancelled resume rewrites the record but leaves the report as it was')
        return
      }
      assert.deepEqual(events, ['review:add', 'stage05-lane-selector-perfile', 'stage1-budget-governor-perfile'])
      assert.ok(!stages.includes('stage2-hunt-lanes-perfile'))
      assert.deepEqual(resumed.class_review?.final.classes, ['injection', requestedClass])
      assert.equal(resumed.class_review?.edits[0].cost_usd, 0.025)
      assert.equal(resumed.spend.spent_usd, 0.025)
      assert.equal(resumed.spend.calls, 1)
      assert.equal(resumed.status, 'INCOMPLETE')
      assert.equal(resumed.passes, previous.passes + 1)
      return
    }
    const code = await scan(args, {
      launchStage: fakeLaunch, review: fakeReview,
      io: () => ({ interactive: false, write: text => output.push(text),
        read: async () => assert.fail('--yes must never prompt') }),
    })
    const record = JSON.parse(readFileSync(join(runsRoot, 'run-record.json'), 'utf8')) as RunRecord
    if (scenario === 'add-success') {
      assert.equal(code, 0)
      assert.deepEqual(events, [...PRE_STAGES, 'review:add', 'stage05-lane-selector-perfile',
        'stage1-budget-governor-perfile', 'stage2-hunt-lanes-perfile'])
      assert.equal(record.status, 'COMPLETE')
      assert.deepEqual(record.confirmation?.summary.classes?.map(row => [row.id, row.files]),
        [['access-control', 1], ['injection', 1]])
      assert.deepEqual(record.class_review?.final.classes, selection.classes)
      assert.equal(record.confirmation?.summary.classes?.[0].added_by_user, true)
      // finish() writes the report next to the record and lists it in the index.
      const findings = JSON.parse(readFileSync(join(runsRoot, 'findings.json'), 'utf8'))
      assert.equal(findings.schema, 'secscan.findings/1')
      assert.equal(findings.run.status, 'COMPLETE')
      assert.equal(findings.summary.coverage.scanned, 1)
      assert.match(readFileSync(join(runsRoot, 'report.html'), 'utf8'), /<h2>Scan Results<\/h2>/)
      assert.match(readFileSync(join(target, '.secscan', 'index.html'), 'utf8'), new RegExp(`runs/${record.run_id}/report\\.html`))
    } else {
      assert.equal(code, 1)
      assert.equal(record.status, 'INCOMPLETE')
      assert.equal(record.confirmation, null)
      assert.ok(!stages.includes('stage2-hunt-lanes-perfile'))
      assert.deepEqual(stages, scenario === 'add-failure' ? [...PRE_STAGES]
        : [...PRE_STAGES, 'stage05-lane-selector-perfile', 'stage1-budget-governor-perfile'])
      if (scenario === 'add-failure') assert.match(output.join('\n'), /Synthetic class research failed/)
      else assert.ok(record.incomplete_reasons.some(reason => reason.reason === 'stage_failed'))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

if (childScenario) {
  await exerciseScan(childScenario)
} else {
  const require = createRequire(import.meta.url)
  for (const scenario of ['add-success', 'add-failure', 'replan-failure', 'resume-review-quit', 'frozen-resume-add', 'review-interrupt', 'resume-replan-failure', 'resume-selector-failure'] as const) {
    test(`scan orchestration: ${scenario}`, () => {
      const env: NodeJS.ProcessEnv = { ...process.env, SECSCAN_ORCHESTRATION_CASE: scenario }
      delete env.NODE_TEST_CONTEXT
      const child = spawnSync(process.execPath,
        ['--import', require.resolve('tsx'), fileURLToPath(import.meta.url)],
        { env, encoding: 'utf8', timeout: 20_000 })
      assert.equal(child.error, undefined)
      assert.equal(child.status, 0, child.stdout + child.stderr)
    })
  }
}
