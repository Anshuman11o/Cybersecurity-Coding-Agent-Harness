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
import { SpendGate } from './spend-gate.js'
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

test('gate: no cap and no deadline always starts', () => {
  const g = new SpendGate({ capUsd: null, deadlineMs: null })
  assert.deepEqual(g.decide(1e9), { action: 'start' })
  assert.deepEqual(g.decide(null), { action: 'start' })
})

test('gate: holds in-flight projections against the cap, waits, then stops', () => {
  const g = new SpendGate({ capUsd: 1.0, deadlineMs: null })
  assert.equal(g.decide(0.4).action, 'start'); g.begin('a', 0.4)
  assert.equal(g.decide(0.4).action, 'start'); g.begin('b', 0.4)
  // 0.8 committed in flight: a third 0.4 would pass 1.0, but lanes are in flight.
  assert.equal(g.decide(0.4).action, 'wait')
  g.finish('a', 0.1) // came in cheap — makes room
  assert.equal(g.decide(0.4).action, 'start'); g.begin('c', 0.4)
  g.finish('b', 0.4)
  g.finish('c', 0.4)
  assert.ok(Math.abs(g.spentUsd() - 0.9) < 1e-9)
  const d = g.decide(0.4)
  assert.equal(d.action, 'stop')
  assert.equal(d.action === 'stop' && d.reason, 'max_cost')
})

test('gate: an unmeasured lane is booked at its projection', () => {
  const g = new SpendGate({ capUsd: 1, deadlineMs: null })
  g.begin('a', 0.3)
  g.finish('a', null)
  assert.equal(g.spentUsd(), 0.3)
})

test('gate: calibration scales projections up, never down', () => {
  const g = new SpendGate({ capUsd: 100, deadlineMs: null, calibrationMinLanes: 3 })
  for (const id of ['a', 'b']) { g.begin(id, 1); g.finish(id, 2) }
  assert.equal(g.calibration(), 1, 'not before the minimum lane count')
  g.begin('c', 1); g.finish('c', 2)
  assert.equal(g.calibration(), 2)
  const cheap = new SpendGate({ capUsd: 100, deadlineMs: null })
  for (const id of ['a', 'b', 'c']) { cheap.begin(id, 1); cheap.finish(id, 0.5) }
  assert.equal(cheap.calibration(), 1)
})

test('gate: deadline stops, unpriced under a cap stops, carried spend counts', () => {
  let now = 1000
  const g = new SpendGate({ capUsd: null, deadlineMs: 2000, now: () => now })
  assert.equal(g.decide(1).action, 'start')
  now = 2000
  const d = g.decide(1)
  assert.equal(d.action === 'stop' && d.reason, 'timeout')

  const u = new SpendGate({ capUsd: 5, deadlineMs: null })
  const ud = u.decide(null)
  assert.equal(ud.action === 'stop' && ud.reason, 'max_cost')

  const resumed = new SpendGate({ capUsd: 1, deadlineMs: null }, 0.9)
  assert.equal(resumed.decide(0.2).action, 'stop')
  assert.equal(resumed.decide(0.05).action, 'start')
  assert.throws(() => new SpendGate({ capUsd: 0, deadlineMs: null }))
})

/** Drive the gate the way Stage 2 does: start in order, finish the oldest when blocked. */
function simulate(projected: number[], actualOf: (p: number, i: number) => number, cap: number, concurrency: number) {
  const g = new SpendGate({ capUsd: cap, deadlineMs: null })
  const inFlight: { id: string; i: number }[] = []
  let started = 0
  let maxLane = 0
  const finishOldest = () => {
    const f = inFlight.shift()!
    g.finish(f.id, actualOf(projected[f.i], f.i))
  }
  for (let i = 0; i < projected.length; i++) {
    while (inFlight.length >= concurrency) finishOldest()
    let d = g.decide(projected[i])
    while (d.action === 'wait') { finishOldest(); d = g.decide(projected[i]) }
    if (d.action === 'stop') break
    g.begin(`l${i}`, projected[i]); inFlight.push({ id: `l${i}`, i }); started++
    maxLane = Math.max(maxLane, actualOf(projected[i], i))
  }
  while (inFlight.length) finishOldest()
  return { spent: g.spentUsd(), started, maxLane }
}

test('gate: spend stays under the cap when projections hold, and overshoots by at most the lanes in flight when they run low', () => {
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let trial = 0; trial < 200; trial++) {
    const projected = Array.from({ length: 60 }, () => 0.01 + rand() * 0.2)
    const cap = 0.5 + rand() * 3
    const c = 1 + Math.floor(rand() * 8)
    const exact = simulate(projected, p => p, cap, c)
    assert.ok(exact.spent <= cap + 1e-9, `exact projections: spent ${exact.spent} > cap ${cap}`)
    // Actuals up to 1.5x the projection: the bound is the plan's — no more than
    // the lanes that can be in flight at once.
    const low = simulate(projected, p => p * (1 + rand() * 0.5), cap, c)
    assert.ok(low.spent <= cap + c * low.maxLane + 1e-9,
      `under-projected: spent ${low.spent} > cap ${cap} + ${c} x ${low.maxLane}`)
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
