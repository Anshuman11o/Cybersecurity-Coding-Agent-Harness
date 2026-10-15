/**
 * Unit tests for the run limits, the spend gate and the scan plan
 * (productization plan §2.6). No model calls, no files.
 *
 *   npx tsx --test src/limits.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCost, parseSize, parseDuration, parsePositiveInt, normalizeScopePath, compileGlob,
  resolveLimits, limitsToEnv, admitLanes, admissionKey, deriveConcurrency, NO_LIMITS, DEFAULT_CONCURRENCY,
  type RunLimits,
} from './limits.js'
import { SpendGate, budgetConcurrency } from './spend-gate.js'
import { computeScanPlan } from './scan-plan.js'

const lim = (o: Partial<RunLimits>): RunLimits => ({ ...NO_LIMITS, ...o })

test('parsers are strict', () => {
  assert.equal(parseCost('5'), 5)
  assert.equal(parseCost('$2.50'), 2.5)
  assert.throws(() => parseCost('0'))
  assert.throws(() => parseCost('five'))
  assert.equal(parseSize('200000'), 200000)
  assert.equal(parseSize('200k'), 200 * 1024)
  assert.equal(parseSize('1.5m'), 1.5 * 1024 * 1024)
  assert.throws(() => parseSize('1e5'))
  assert.equal(parseDuration('600'), 600)
  assert.equal(parseDuration('90s'), 90)
  assert.equal(parseDuration('30m'), 1800)
  assert.equal(parseDuration('1.5h'), 5400)
  assert.throws(() => parseDuration('soon'))
  assert.equal(parsePositiveInt('8', 'n'), 8)
  // parseInt("1e5") is 1 — exactly the silent misparse these exist to refuse.
  assert.throws(() => parsePositiveInt('1e5', 'n'))
  assert.throws(() => parsePositiveInt('-3', 'n'))
})

test('scope paths are target-relative and cannot escape', () => {
  assert.equal(normalizeScopePath('./src/'), 'src')
  assert.equal(normalizeScopePath('src//api'), 'src/api')
  assert.equal(normalizeScopePath('.'), '')
  assert.throws(() => normalizeScopePath('/etc'))
  assert.throws(() => normalizeScopePath('../other'))
  assert.throws(() => normalizeScopePath('src/../../x'))
})

test('globs follow gitignore conventions', () => {
  const m = (g: string, p: string) => compileGlob(g).test(p)
  assert.ok(m('*.min.js', 'public/js/app.min.js'), 'no slash: any depth')
  assert.ok(!m('*.min.js', 'public/js/app.js'))
  assert.ok(m('vendor', 'vendor/lib/x.js'), 'a directory name covers its tree')
  assert.ok(m('vendor', 'a/vendor/x.js'))
  assert.ok(m('src/legacy/**', 'src/legacy/a/b.ts'), 'slash: anchored')
  assert.ok(!m('src/legacy/**', 'x/src/legacy/a.ts'))
  assert.ok(m('**/*.test.ts', 'a/b/c.test.ts'))
  assert.ok(m('**/*.test.ts', 'c.test.ts'))
  assert.ok(m('*.{ts,tsx}', 'a/b.tsx'))
  assert.ok(!m('*.{ts,tsx}', 'a/b.js'))
  assert.ok(m('file?.py', 'file1.py'))
  assert.ok(!m('src/*.ts', 'src/a/b.ts'), '* stays inside a segment')
  assert.ok(m('test/', 'test/x.py'), 'a trailing slash marks a directory')
  assert.throws(() => compileGlob('{a,b'))
})

test('limits round-trip through the environment', () => {
  const l = lim({
    max_cost_usd: 5, max_files: 10, max_file_size: 2048, timeout_seconds: 60, concurrency: 3,
    paths: ['src', 'api'], include: ['*.{ts,js}'], exclude: ['vendor', 'a b/*'],
  })
  assert.deepEqual(resolveLimits(limitsToEnv(l)), l)
  assert.deepEqual(resolveLimits({}), NO_LIMITS)
  assert.throws(() => resolveLimits({ SCANNER_MAX_FILES: 'lots' }))
})

const lanes = [
  { lane_id: 'a', target_file: 'src/a.ts', file_bytes: 100 },
  { lane_id: 'b', target_file: 'src/big.ts', file_bytes: 50_000 },
  { lane_id: 'c', target_file: 'vendor/c.js', file_bytes: 100 },
  { lane_id: 'd', target_file: 'api/d.py', file_bytes: 100 },
  { lane_id: 'e', target_file: 'src/e.ts', file_bytes: 100 },
]

test('admission: scope, then size, then file count, in lane order', () => {
  const none = admitLanes(lanes, NO_LIMITS)
  assert.deepEqual(none.admitted.map(l => l.lane_id), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(none.excluded.length, 0)

  const r = admitLanes(lanes, lim({ exclude: ['vendor'], max_file_size: 1000, max_files: 2 }))
  assert.deepEqual(r.admitted.map(l => l.lane_id), ['a', 'd'])
  assert.deepEqual(r.excluded.map(e => [e.lane.lane_id, e.reason]), [
    ['b', 'too-large'], ['c', 'user-excluded'], ['e', 'over-max-files'],
  ])
  // --max-files counts only files the scope would otherwise scan.
  const p = admitLanes(lanes, lim({ paths: ['src'], max_files: 2 }))
  assert.deepEqual(p.admitted.map(l => l.lane_id), ['a', 'b'])
  assert.equal(p.excluded.find(e => e.lane.lane_id === 'e')!.reason, 'over-max-files')
  assert.equal(p.excluded.find(e => e.lane.lane_id === 'd')!.reason, 'user-excluded')
  // A path names a directory or a file, never a prefix of a name.
  assert.deepEqual(admitLanes(lanes, lim({ paths: ['sr'] })).admitted, [])
  assert.deepEqual(admitLanes(lanes, lim({ paths: ['api/d.py'] })).admitted.map(l => l.lane_id), ['d'])
  // Deterministic.
  assert.deepEqual(admitLanes(lanes, lim({ max_files: 3 })), admitLanes(lanes, lim({ max_files: 3 })))
})

test('admission key covers scope limits only', () => {
  assert.equal(admissionKey(lim({ max_cost_usd: 1 })), admissionKey(lim({ max_cost_usd: 99, timeout_seconds: 5, concurrency: 2 })))
  assert.notEqual(admissionKey(lim({ max_files: 1 })), admissionKey(NO_LIMITS))
  assert.notEqual(admissionKey(lim({ exclude: ['x'] })), admissionKey(NO_LIMITS))
})

test('concurrency is derived under the vendor ceiling', () => {
  assert.equal(deriveConcurrency(null, null, 500).value, DEFAULT_CONCURRENCY)
  assert.equal(deriveConcurrency(null, 4, 500).value, 4)
  assert.equal(deriveConcurrency(null, 10, 500).value, DEFAULT_CONCURRENCY)
  assert.equal(deriveConcurrency(null, null, 3).value, 3)
  assert.equal(deriveConcurrency(32, 10, 500).value, 32)
  assert.match(deriveConcurrency(32, 10, 500).basis, /ABOVE/)
  assert.equal(deriveConcurrency(null, null, 0).value, DEFAULT_CONCURRENCY)
})

test('gate: no cap and no deadline always starts, and every call hold is granted at once', async () => {
  const g = new SpendGate({ capUsd: null, deadlineMs: null })
  assert.deepEqual(g.decide(1e9), { action: 'start' })
  assert.deepEqual(g.decide(null), { action: 'start' })
  g.begin('a', null)
  const held = await g.acquire('a', null)
  assert.equal(held.ok, true)
  assert.equal(g.effectiveConcurrency(32, 1e9), 32, 'no cap: the configured slot limit')
})

test('gate: a file is admitted when its first call hold fits, waits while anything is in flight, then stops', () => {
  const g = new SpendGate({ capUsd: 1.0, deadlineMs: null })
  assert.equal(g.decide(0.4).action, 'start'); g.begin('a', 0.4)
  assert.equal(g.decide(0.4).action, 'start'); g.begin('b', 0.4)
  // 0.8 held for two first calls: a third 0.4 would pass 1.0, but files are in flight.
  assert.equal(g.decide(0.4).action, 'wait')
  assert.equal(g.snapshot().in_flight_projected_usd, 0.8)
  g.finish('a') // never called: its seed is released
  assert.equal(g.decide(0.4).action, 'start')
  g.finish('b')
  const resumed = new SpendGate({ capUsd: 1, deadlineMs: null }, 0.9)
  const d = resumed.decide(0.2)
  assert.equal(d.action === 'stop' && d.reason, 'max_cost')
  assert.equal(resumed.decide(0.05).action, 'start')
})

test("gate: the admission seed becomes the file's first call hold, so an admitted file never stalls on it", async () => {
  let total = 0
  const g = new SpendGate({ capUsd: 1, deadlineMs: null, ledgerTotal: () => total })
  g.begin('a', 0.5); g.begin('b', 0.5)
  assert.equal(g.decide(0.5).action, 'wait', 'the cap is fully held by two seeds')
  const a = await g.acquire('a', 0.45)
  assert.ok(a.ok)
  assert.equal(g.snapshot().in_flight_projected_usd, 0.95)
  assert.equal(g.snapshot().calls_in_flight, 1)
})

test('gate: a call that cannot get its hold while others are in flight waits, then gets it on release', async () => {
  let total = 0.1
  const g = new SpendGate({ capUsd: 1, deadlineMs: null, ledgerTotal: () => total })
  g.begin('a', 0.6); g.begin('b', 0.25)
  const a = await g.acquire('a', 0.6)
  const b1 = await g.acquire('b', 0.25)
  assert.ok(a.ok && b1.ok)
  // b's retry: 0.1 spent + 0.85 held + 0.3 > 1, but a's call is in flight.
  let granted = false
  const retry = g.acquire('b', 0.3).then(r => { granted = r.ok; return r })
  g.release(b1.hold, null, () => { total += 0.05 })
  await new Promise(r => setImmediate(r))
  assert.equal(granted, false, '0.15 spent + 0.6 held + 0.3 still does not fit under 1 — keep waiting')
  assert.equal(g.decide(0.01).action, 'wait', 'new files wait behind a queued call')
  g.release(a.hold, null, () => { total += 0.05 })
  const r = await retry
  assert.ok(r.ok, 'granted once a released')
  assert.ok(total + g.snapshot().in_flight_projected_usd <= 1)
})

test('gate: a call is refused for max_cost only when nothing else is held', async () => {
  let total = 0.8
  const g = new SpendGate({ capUsd: 1, deadlineMs: null, ledgerTotal: () => total })
  g.begin('a', 0.1)
  const a = await g.acquire('a', 0.1)
  assert.ok(a.ok)
  const pending = g.acquire('a', 0.3)
  g.release(a.hold, null, () => { total += 0.05 })
  const r = await pending
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.reason, 'max_cost')
  assert.equal(g.snapshot().in_flight_projected_usd, 0)
  const u = await new SpendGate({ capUsd: 1, deadlineMs: null }).acquire('x', null)
  assert.equal(u.ok, false, 'an unpriced hold under a cap is refused')
})

test('gate: release books the call in the same step, so spent + holds never passes the cap', async () => {
  let total = 0
  const cap = 1
  const g = new SpendGate({ capUsd: cap, deadlineMs: null, ledgerTotal: () => total })
  const check = () => assert.ok(total + g.snapshot().in_flight_projected_usd <= cap + 1e-12)
  g.begin('a', 0.4); g.begin('b', 0.4)
  const a = await g.acquire('a', 0.4); const b = await g.acquire('b', 0.4)
  assert.ok(a.ok && b.ok)
  const c = g.acquire('a', 0.4)
  g.release(a.hold, null, () => { total += 0.4; check() })
  check()
  g.release(b.hold, null, () => { total += 0.4; check() })
  const r = await c
  assert.equal(r.ok, false, 'worst-case spend leaves no room: refused, never granted past the cap')
  check()
})

test('gate: without a ledger, release books the actual cost (the hold when unmeasured)', async () => {
  const g = new SpendGate({ capUsd: 1, deadlineMs: null })
  g.begin('a', 0.3)
  const a = await g.acquire('a', 0.3)
  assert.ok(a.ok)
  g.release(a.hold, null)
  assert.equal(g.spentUsd(), 0.3)
  const b = await g.acquire('a', 0.3)
  assert.ok(b.ok)
  g.release(b.hold, 0.1)
  assert.ok(Math.abs(g.spentUsd() - 0.4) < 1e-12)
})

test('gate: effective concurrency shrinks with the remaining budget and never goes below 1', () => {
  assert.equal(budgetConcurrency(32, null, 0, 0.035), 32)
  assert.equal(budgetConcurrency(32, 5, 0, null), 32, 'unpriced: the configured value')
  assert.equal(budgetConcurrency(32, 5, 0, 0.035), 32, '0.5 x 5 / 0.035 = 71 slots: the configured 32 bind')
  assert.equal(budgetConcurrency(32, 5, 4, 0.035), 14)
  assert.equal(budgetConcurrency(32, 5, 4.9, 0.035), 1)
  assert.equal(budgetConcurrency(32, 5, 5, 0.035), 1)
  assert.equal(budgetConcurrency(32, 5, 6, 0.035), 1, 'never below 1')
  let total = 0
  const g = new SpendGate({ capUsd: 5, deadlineMs: null, ledgerTotal: () => total })
  let previous = Infinity
  for (; total <= 5; total += 0.05) {
    const e = g.effectiveConcurrency(32, 0.035)
    assert.ok(e <= previous && e >= 1)
    previous = e
  }
  assert.equal(previous, 1)
})

test('gate: deadline stops, unpriced under a cap stops, a cap must be positive', () => {
  let now = 1000
  const g = new SpendGate({ capUsd: null, deadlineMs: 2000, now: () => now })
  assert.equal(g.decide(1).action, 'start')
  now = 2000
  const d = g.decide(1)
  assert.equal(d.action === 'stop' && d.reason, 'timeout')

  const u = new SpendGate({ capUsd: 5, deadlineMs: null })
  const ud = u.decide(null)
  assert.equal(ud.action === 'stop' && ud.reason, 'max_cost')
  assert.throws(() => new SpendGate({ capUsd: 0, deadlineMs: null }))
})

/**
 * Drive the gate the way Stage 2 does, calls and all: files start in order
 * behind the gate, every call holds its worst case and books its actual cost.
 */
async function simulate(o: {
  files: number; callsPerFile: number; hold: (file: number, call: number) => number
  actual: (hold: number) => number; cap: number; concurrency: number
}) {
  let total = 0
  const g = new SpendGate({ capUsd: o.cap, deadlineMs: null, ledgerTotal: () => total })
  const maxHold = Math.max(...Array.from({ length: o.callsPerFile }, (_, c) => o.hold(0, c)))
  let breach = false
  let completed = 0
  let refused = 0
  const running = new Set<Promise<void>>()
  const runFile = async (f: number) => {
    for (let c = 0; c < o.callsPerFile; c++) {
      const r = await g.acquire(`f${f}`, o.hold(f, c))
      if (!r.ok) { refused++; return }
      if (total + g.snapshot().in_flight_projected_usd > o.cap + 1e-9) breach = true
      await new Promise(res => setTimeout(res, (f * 7 + c * 3) % 5))
      g.release(r.hold, null, () => { total += o.actual(r.hold.usd) })
      if (total + g.snapshot().in_flight_projected_usd > o.cap + 1e-9) breach = true
    }
    completed++
  }
  let stopped = false
  for (let f = 0; f < o.files && !stopped; f++) {
    for (;;) {
      if (running.size >= g.effectiveConcurrency(o.concurrency, maxHold)) { await Promise.race(running); continue }
      const d = g.decide(o.hold(0, 0))
      if (d.action === 'start') {
        g.begin(`f${f}`, o.hold(0, 0))
        const p: Promise<void> = runFile(f).finally(() => { g.finish(`f${f}`); running.delete(p) })
        running.add(p)
        break
      }
      if (d.action === 'stop') { stopped = true; break }
      await Promise.race([...running, g.changed()])
    }
  }
  await Promise.all(running)
  return { spent: total, completed, refused, breach, stopped }
}

test('gate simulation: spend never passes the cap, whatever calls cost up to their holds', async () => {
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let trial = 0; trial < 40; trial++) {
    const cap = 0.5 + rand() * 3
    const holds = Array.from({ length: 3 }, () => 0.01 + rand() * 0.1)
    const fraction = rand()
    const r = await simulate({
      files: 40, callsPerFile: 3, hold: (_, c) => holds[c], actual: h => h * (trial % 2 ? 1 : fraction),
      cap, concurrency: 1 + Math.floor(rand() * 16),
    })
    assert.equal(r.breach, false)
    assert.ok(r.spent <= cap + 1e-9, `spent ${r.spent} > cap ${cap}`)
  }
})

test('scan plan prices admitted lanes and counts what fits under the cap', () => {
  const plan = computeScanPlan({
    provider: 'p', model: 'm', assignmentsPath: '/x', assignmentsGeneratedAt: 't',
    lanes: lanes.map(l => ({ ...l, projected_calls: 2, projected_input_tokens: 1_000_000, projected_output_tokens: 0 })),
    limits: lim({ max_cost_usd: 2.5, exclude: ['vendor'] }),
    vendorConcurrencyCeiling: null,
    price: { input: 1, output: 1 },
    priceAsOf: 'd',
    cost: (i, o) => (i + o) / 1e6,
    now: new Date(0),
  })
  assert.equal(plan.totals.admitted_lanes, 4)
  assert.equal(plan.totals.projected_cost_usd, 4)
  assert.equal(plan.cap.estimate_exceeds_cap, true)
  assert.equal(plan.cap.lanes_within_cap, 2)
  assert.deepEqual(plan.totals.excluded_by_reason, { 'user-excluded': 1 })
  assert.equal(plan.admission_key, admissionKey(plan.limits))
  assert.equal(plan.concurrency.value, 4)

  const unpriced = computeScanPlan({
    provider: 'p', model: 'm', assignmentsPath: '/x', assignmentsGeneratedAt: 't',
    lanes: lanes.map(l => ({ ...l, projected_calls: 1, projected_input_tokens: 1, projected_output_tokens: 1 })),
    limits: NO_LIMITS, vendorConcurrencyCeiling: null, price: null, priceAsOf: null, cost: () => null,
  })
  assert.equal(unpriced.totals.projected_cost_usd, null)
  assert.equal(unpriced.cap.estimate_exceeds_cap, null)
})
