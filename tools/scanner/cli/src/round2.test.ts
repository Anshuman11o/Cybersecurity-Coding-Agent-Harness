import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetMessage, buildSummary, renderSummary, type ConfirmationSummary, type SummaryInput } from './confirm.js'
import { roundTwo, type RoundTwoOptions } from './round2.js'
import { NO_LIMITS } from '../../stage1-budget-governor/src/limits.js'
import { computeScanPlan } from '../../stage1-budget-governor/src/scan-plan.js'
import type { ModelInfo } from './registry.js'

function summary(classes = ['injection'], cap = 10, change?: (input: SummaryInput) => void): ConfirmationSummary {
  const plan = computeScanPlan({ provider: 'm', model: 'm', assignmentsPath: '/fixture', assignmentsGeneratedAt: 't',
    lanes: [{ lane_id: 'a', target_file: 'src/a.ts', file_bytes: 10, projected_calls: 2, projected_input_tokens: 100, projected_output_tokens: 100 }],
    limits: { ...NO_LIMITS, max_cost_usd: cap }, vendorConcurrencyCeiling: null, price: { input: 1, output: 1 }, priceAsOf: null, cost: () => 1 })
  plan.reservation_unit_usd = 0.1
  plan.estimate = { scan_usd: 1, input_usd: 0.4, output_usd: 0.6, spent_before_usd: 0.1,
    total_usd: 1.1, band_pct: null, files: 1, tier_label: 'Standard', tier_multiplier: 1 } as any
  const input: SummaryInput = { targetDisplay: './app', targetRoot: '/app', commit: null, branch: null,
    lanes: [{ lane_id: 'a', target_file: 'src/a.ts', disposition: 'hunt', skip_reason: null, classes,
      chunk_plan: { total_chunks: 2, chunks: [{}, {}] } }], inventoryFiles: 1, byLanguage: {}, plan,
    model: { key: 'm', label: 'M', model: 'm', apiKeyEnv: 'TEST', keyPresent: true } as ModelInfo,
    resume: null, selection: { classes }, spentUsd: 0.1,
  }
  change?.(input)
  return buildSummary(input)
}

function session(answers: string[], overrides: Partial<RoundTwoOptions> = {}) {
  const output: string[] = []
  const events: string[] = []
  let current = summary()
  const opts: RoundTwoOptions = {
    io: { interactive: true, write: s => output.push(s), async read(prompt) {
      output.push(prompt)
      assert.ok(answers.length, `Unexpected prompt: ${prompt}`)
      return answers.shift()!
    } },
    yes: false, frozen: false, summary: () => current,
    async edit(action, input) {
      events.push(`${action}:${input}`)
      const ids = current.classes!.map(c => c.id)
      current = summary(action === 'drop' ? ids.filter(id => id !== input) : [...ids, input])
      return { ok: true, changed: true, message: `${action} ${input}` }
    },
    async replan() { events.push('replan') },
    async budget(value) { events.push(`budget:${value}`); current = summary(current.classes!.map(c => c.id), value) },
    async editLimits() { events.push('limits') }, async save() { events.push('save') },
    ...overrides,
  }
  return { opts, events, output, setSummary(s: ConfirmationSummary) { current = s } }
}

test('budget boundaries use ledger total, input threshold and exact first-file reservation', () => {
  const message = (cap: number) => budgetMessage({ cap, spent: 1, total: 10, inputThreshold: 5, firstStart: 2, files: 9, withinCap: 3 })
  assert.equal(message(10).kind, 'full')
  assert.equal(message(9.999).kind, 'partial')
  assert.equal(message(5).kind, 'partial')
  assert.equal(message(4.999).kind, 'low')
  assert.equal(message(2).kind, 'low')
  assert.equal(message(2).requires_confirmation, true)
  assert.equal(message(1.999).kind, 'blocked')
  assert.equal(message(1.999).can_start, false)
  assert.equal(message(10).text, 'Budget covers the estimated cost of all 9 files.')
  assert.equal(message(5).text, 'Budget will not cover all 9 files.\nEstimated coverage: 3 of 9 files, scanned by severity first.\nRaise the budget to $10.00 to cover the full estimated scan.\nThe report will be INCOMPLETE if the budget stops the scan.')
  assert.equal(message(2).text, 'Budget will not cover even the estimated input cost for all files.\nRaise the total budget to cover at least partial scan.\nStarting now will allow only a partial scan.')
  const blocked = 'Scan cannot start with this budget.\nRaise the total budget to at least complete partial scan.'
  assert.equal(message(1.999).text, blocked)
  assert.equal(message(1).text, blocked)
})

test('a plan with per-call holds starts a file once its first call hold fits, whatever its chunk count', () => {
  const s = summary(['injection'], 10, input => {
    input.plan.call_reservation_usd = 0.05
    input.plan.first_call_reservation_usd = 0.035
  })
  assert.equal(s.budget_message!.first_start_usd, 0.1 + 0.035)
  assert.equal(summary().budget_message!.first_start_usd, 0.1 + 2 * 0.1, 'an older plan keeps chunks × U')
})

test('summary rows count admitted files and record all-files routing and live spend', () => {
  const s = summary()
  assert.equal(s.classes![0].files, 1)
  assert.equal(s.estimate.breakdown!.spent_usd, 0.1)
  assert.equal(s.budget_message!.first_start_usd, 0.1 + 2 * 0.1)
  s.classes![0].all_files = true
  s.classes![0].added_by_user = true
  s.classes![0].source = 'web'
  assert.match(renderSummary(s), /added by you \(web\).*all files/)
  const estimate = 'Total estimate: $1.10, ~1 min\n  $0.10 spent + input $0.40 + output $0.60.\n  Can vary widely (fewer than 10 files).'
  assert.ok(renderSummary(s).includes(`${estimate}\nCurrent budget: $10.00\n${s.budget_message!.text}`))
  s.estimate.cap_usd = null
  assert.ok(renderSummary(s).includes(`${estimate}\nCurrent budget: Unlimited\n${s.budget_message!.text}`))
})

test('delete last row disables Enter; catalog undo replans and restores start', async () => {
  const s = session(['d', '1', '', 'a', 'injection', ''])
  assert.equal(await roundTwo(s.opts), 'start')
  assert.deepEqual(s.events, ['drop:injection', 'replan', 'add:injection', 'replan'])
  assert.ok(s.output.some(v => v.includes('No classes selected')))
})

test('delete updates skipped count, and save persists reviewed edits via injected callback', async () => {
  const s = session(['d', 'injection', 's', 'q'])
  const base = s.opts.edit
  s.opts.edit = async (...args) => {
    const result = await base(...args)
    s.opts.summary().skip.by_reason['no selected class'] = 2
    return result
  }
  assert.equal(await roundTwo(s.opts), 'quit')
  assert.ok(s.output.some(v => v.includes('2 files no longer have a class')))
  assert.ok(s.events.includes('save'))
})

test('low budget requires y, first-start refusal blocks even --yes', async () => {
  const low = summary(['injection'], 0.4)
  const s = session(['', 'n', '', 'y'], { summary: () => low })
  assert.equal(await roundTwo(s.opts), 'start')
  const blocked = session([], { yes: true, summary: () => summary(['injection'], 0.2) })
  assert.equal(await roundTwo(blocked.opts), 'failed')
})

test('research confirms each call; failed requested add with --yes exits before start', async () => {
  const s = session(['a', 'novel class', '', '', ''], {
    async edit(_action, _input, confirm) {
      assert.equal(await confirm({ purpose: 'Resolve', reservation_usd: 0.005 }), true)
      assert.equal(await confirm({ purpose: 'Research', reservation_usd: 0.02 }), true)
      return { ok: true, changed: true, message: 'Playbook written' }
    },
  })
  assert.equal(await roundTwo(s.opts), 'start')
  assert.deepEqual(s.events, ['replan'])
  const failed = session([], { yes: true, requested: { add: ['bad class'] }, async edit() {
    return { ok: false, changed: false, message: 'Could not build playbook ($0.04 spent)' }
  } })
  assert.equal(await roundTwo(failed.opts), 'failed')
  assert.deepEqual(failed.events, [])
})

test('failed interactive edit retains rows and redraws booked spend without replan', async () => {
  const s = session(['a', 'bad class', 'q'])
  s.opts.edit = async () => {
    const state = summary()
    state.estimate.breakdown!.spent_usd = 0.14
    s.setSummary(state)
    return { ok: false, changed: false, message: 'Research failed twice ($0.04 spent)' }
  }
  assert.equal(await roundTwo(s.opts), 'quit')
  assert.equal(s.opts.summary().classes![0].id, 'injection')
  assert.ok(s.output.some(v => v.includes('$0.14')))
  assert.deepEqual(s.events, [])
})

test('resume freezes class edits, save and limits; permits higher budget only', async () => {
  const s = session(['a', 'd', 'e', 's', 'b', '0.1', '2', ''], { frozen: true })
  assert.equal(await roundTwo(s.opts), 'start')
  assert.deepEqual(s.events, ['budget:2'])
  assert.ok(s.output.some(v => v.includes('must exceed')))
  const failed = session([], { yes: true, frozen: true, requested: { drop: ['injection'] } })
  assert.equal(await roundTwo(failed.opts), 'failed')
})

test('failed replan propagates and prevents starting the hunt', async () => {
  const s = session(['d', '1'], { async replan() { throw new Error('fixture replan failure') } })
  await assert.rejects(() => roundTwo(s.opts), /fixture replan failure/)
})


test('summary preserves globally rounded remaining estimate on fresh and refreshed resume plans', () => {
  for (const resumed of [false, true]) {
    const s = summary(['injection'], 10, input => {
      input.plan.estimate!.input_tokens = 100
      input.plan.estimate!.scan_usd = 1.000001
      input.plan.estimate!.input_usd = 0.4
      input.plan.estimate!.output_usd = 0.600001
      if (resumed) {
        input.plan.admitted.unshift({ ...input.plan.admitted[0], lane_id: 'done' })
        input.resume = { runId: 'previous', doneLaneIds: new Set(['done']), spentUsd: 0.5 }
        input.spentUsd = 0.5
      }
    })
    assert.equal(s.estimate.usd, (resumed ? 0.5 : 0.1) + 1.000001)
    assert.equal(s.estimate.breakdown!.input_usd, 0.4)
    assert.equal(s.estimate.breakdown!.output_usd, 0.600001)
  }
})

test('delete row numbers preserve raw input alongside resolved class id', async () => {
  const s = session(['d', '1', 'q'])
  s.opts.edit = async (action, id, _confirm, raw) => {
    assert.equal(action, 'drop')
    assert.equal(id, 'injection')
    assert.equal(raw, '1')
    return { ok: true, changed: false, message: 'deleted' }
  }
  assert.equal(await roundTwo(s.opts), 'quit')
})
