/**
 * Tests for the per-lane agent loop's pure parts: the union merge, the class
 * grouping, and the follow-up instruction.
 *
 * The merge is the piece that decides what a loop is allowed to do to a
 * finding, so it is the piece whose failure would be invisible: a merge that
 * quietly dropped a trace step would look like a loop that did not help. Every
 * property the loop's claim rests on is asserted here.
 *
 * Run: npx tsx src/loop.test.ts
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mergeFindings, classGroups, buildFollowUpTurn } from './hunt-executor.js'
import type { CandidateFinding, TraceStep } from './types.js'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

function step(line: number, kind: TraceStep['kind'] = 'propagation'): TraceStep {
  return { kind, file: 'a.ts', line, description: `line ${line}` }
}

function finding(
  id: string, lines: number[], classes: string[], extra: Partial<CandidateFinding> = {},
): CandidateFinding {
  const trace = lines.map((l, i) =>
    step(l, i === 0 ? 'entrypoint' : i === lines.length - 1 ? 'sink' : 'propagation'))
  return {
    finding_id: id,
    lane_id: 'file-0001',
    finding_classes: classes.map(c => ({ class: c, justified_by_step: 0 })),
    categories: ['A03'],
    title: `finding ${id}`,
    description: 'd',
    trace,
    severity_estimate: 'high',
    confidence: 0.5,
    ...extra,
  }
}

function lines(f: CandidateFinding): number[] {
  return f.trace.map(s => s.line)
}

console.log('\n-- merge: a revision extends a trace and never replaces it --')
{
  const prior = [finding('a', [10, 40], ['injection'])]
  const incoming = [finding('a2', [10, 20, 30, 40], ['injection'])]
  const { merged, added, revised } = mergeFindings(prior, incoming)
  check('no new finding created', merged.length === 1 && added === 0)
  check('revision counted', revised === 1)
  check('intermediate lines adopted', JSON.stringify(lines(merged[0])) === JSON.stringify([10, 20, 30, 40]))
  check('entrypoint still first', merged[0].trace[0].kind === 'entrypoint')
  check('sink still last', merged[0].trace[merged[0].trace.length - 1].kind === 'sink')
}

console.log('\n-- merge: nothing the earlier turn cited is ever lost --')
{
  const prior = [finding('a', [10, 25, 40], ['injection'])]
  // A turn that "revises" by dropping a step and moving another must not win.
  // Same title, so this is unambiguously a re-emission rather than a new defect.
  const incoming = [{ ...finding('a2', [10, 41], ['injection']), title: 'finding a' } as CandidateFinding]
  const { merged } = mergeFindings(prior, incoming)
  const got = new Set(lines(merged[0]))
  check('every prior line survives', [10, 25, 40].every(l => got.has(l)))
  check('the new line is added too', got.has(41))
}

console.log('\n-- merge: an unrelated finding is appended, not merged --')
{
  const prior = [finding('a', [10, 20], ['injection'])]
  const incoming = [finding('b', [90, 95], ['access-control'])]
  const { merged, added } = mergeFindings(prior, incoming)
  check('appended as a new finding', merged.length === 2 && added === 1)
  check('prior finding untouched', JSON.stringify(lines(merged[0])) === JSON.stringify([10, 20]))
}

console.log('\n-- merge: a distinct defect sharing ONE line is not absorbed --')
{
  // The `gap` turn returns only new findings. A new defect that enters at the
  // same line as an existing one must stay its own finding, keeping its own
  // sink and title, or the turn's whole output is silently swallowed.
  const prior = [finding('a', [10, 30], ['injection'])]
  const incoming = [finding('b', [10, 500], ['injection'])]
  const { merged, added } = mergeFindings(prior, incoming)
  check('kept as a separate finding', merged.length === 2 && added === 1)
  check('its own sink survives', lines(merged[1]).includes(500))
  check('its own title survives', merged[1].title === 'finding b')
  check('the existing finding is unchanged',
    JSON.stringify(lines(merged[0])) === JSON.stringify([10, 30]))
}

console.log('\n-- merge: two shared lines, or a kept title, is a revision --')
{
  const prior = [finding('a', [10, 30], ['injection'])]
  const twoLines = mergeFindings(prior, [finding('x', [10, 20, 30], ['injection'])])
  check('two shared lines merges', twoLines.merged.length === 1 && twoLines.revised === 1)

  const kept = [finding('a', [10, 30], ['injection'])]
  const sameTitle = mergeFindings(kept, [
    { ...finding('y', [10, 15], ['injection']), title: 'finding a' } as CandidateFinding])
  check('one shared line plus the kept title merges',
    sameTitle.merged.length === 1 && sameTitle.merged[0].trace.some(s => s.line === 15))
}

console.log('\n-- merge: repeated and out-of-order lines are preserved --')
{
  // Real traces do both: a value can pass through one line twice, and a helper
  // defined below its call site makes a trace run backwards. An earlier merge
  // deduplicated and line-sorted the whole trace, which deleted cited evidence
  // on the ~14% of findings that repeat a line.
  const prior = [finding('a', [10, 10, 20, 20, 30], ['injection'])]
  const before = lines(prior[0]).slice()
  const { merged } = mergeFindings(prior, [finding('a2', [10, 30], ['injection'])])
  check('no cited line is dropped',
    JSON.stringify(lines(merged[0])) === JSON.stringify(before))

  const backwards = [finding('b', [50, 100, 20, 80], ['injection'])]
  const order = lines(backwards[0]).slice()
  const r = mergeFindings(backwards, [finding('b2', [50, 60, 80], ['injection'])])
  check('existing causal order is preserved',
    JSON.stringify(lines(r.merged[0]).filter(l => order.includes(l))) === JSON.stringify(order))
  check('the new line is still added', lines(r.merged[0]).includes(60))
  check('trace still ends on its sink', r.merged[0].trace[r.merged[0].trace.length - 1].kind === 'sink')
}

console.log('\n-- merge: justified_by_step stays anchored to the sink --')
{
  const prior = [finding('a', [10, 30], ['injection'])]
  prior[0].finding_classes[0].justified_by_step = 1   // the sink
  const { merged } = mergeFindings(prior, [finding('a2', [10, 15, 20, 30], ['injection'])])
  const fc = merged[0].finding_classes[0]
  check('index still in range', fc.justified_by_step < merged[0].trace.length)
  check('index still points at the sink',
    merged[0].trace[fc.justified_by_step].kind === 'sink')
}

console.log('\n-- merge: overlap alone is not enough; a class must match too --')
{
  const prior = [finding('a', [10, 20], ['injection'])]
  const incoming = [finding('b', [10, 20], ['crypto-auth'])]
  const { merged, added } = mergeFindings(prior, incoming)
  check('different class on the same lines stays separate', merged.length === 2 && added === 1)
}

console.log('\n-- merge: a revision unions classes AND their OWASP codes --')
{
  // The codes are what category-aware scoring reads. A class the merge adds
  // whose codes do not follow it is a class the scorer cannot see, which is
  // exactly half of what the gap/reflect turns exist to produce.
  const prior = [finding('a', [10, 20], ['injection'])]
  const incoming = [finding('a2', [10, 15, 20], ['injection', 'crypto-auth'])]
  const { merged } = mergeFindings(prior, incoming)
  const cls = merged[0].finding_classes.map(c => c.class).sort()
  check('both classes carried', JSON.stringify(cls) === JSON.stringify(['crypto-auth', 'injection']))
  check('justified_by_step stays in range',
    merged[0].finding_classes.every(c => c.justified_by_step < merged[0].trace.length))

  const reg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../shared/vuln-classes.json'), 'utf-8'))
  const want = new Set<string>([...reg['injection'].codes, ...reg['crypto-auth'].codes])
  check('categories cover every class on the merged finding',
    [...want].every(c => merged[0].categories.includes(c)))
  check('categories gained the added class\'s codes',
    reg['crypto-auth'].codes.some((c: string) => merged[0].categories.includes(c)))
}

console.log('\n-- merge: the input arrays are not mutated --')
{
  const prior = [finding('a', [10, 20], ['injection'])]
  const snapshot = JSON.stringify(prior)
  mergeFindings(prior, [finding('a2', [10, 15, 20], ['injection'])])
  check('caller\'s findings unchanged', JSON.stringify(prior) === snapshot)
}

console.log('\n-- merge: degenerate shapes --')
{
  const { merged, added } = mergeFindings([], [finding('a', [1, 2], ['injection'])])
  check('empty accumulator takes everything', merged.length === 1 && added === 1)

  // A one-step trace cannot reach the merge (validation requires the first step
  // to be an entrypoint and the last a sink), but the invariant is asserted
  // anyway so the defensive branch cannot rot into emitting a sink-less trace.
  const single = [finding('a', [10], ['injection'])]
  const r = mergeFindings(single, [
    { ...finding('a2', [10, 12], ['injection']), title: 'finding a' } as CandidateFinding])
  check('single-step trace extends without losing its step',
    JSON.stringify(lines(r.merged[0])) === JSON.stringify([10, 12]))
  check('single-step trace still ends on a sink',
    r.merged[0].trace[r.merged[0].trace.length - 1].kind === 'sink')

  const noop = mergeFindings(single, [])
  check('an empty turn changes nothing', noop.added === 0 && noop.revised === 0 &&
    JSON.stringify(lines(noop.merged[0])) === JSON.stringify([10]))
}

console.log('\n-- merge: a duplicate turn is idempotent --')
{
  const prior = [finding('a', [10, 20, 30], ['injection'])]
  const again = mergeFindings(prior, [finding('a', [10, 20, 30], ['injection'])])
  check('no finding added', again.merged.length === 1 && again.added === 0)
  check('no line added', JSON.stringify(lines(again.merged[0])) === JSON.stringify([10, 20, 30]))
  check('reported as unproductive so the loop can stop',
    again.added === 0 && again.revised === 0)
}

console.log('\n-- class grouping --')
{
  const cs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  check('groups of 3 cover every class exactly once',
    JSON.stringify(classGroups(cs, 3).flat()) === JSON.stringify(cs))
  check('last group may be short', classGroups(cs, 3).length === 3 && classGroups(cs, 3)[2].length === 2)
  check('group size 1 is one group per class', classGroups(cs, 1).length === 8)
  check('empty class list yields no groups', classGroups([], 3).length === 0)
}

console.log('\n-- follow-up instruction --')
{
  const reported = [finding('a', [10, 20], ['injection'])]
  const t = buildFollowUpTurn('trace', ['injection', 'crypto-auth'], reported)
  const g = buildFollowUpTurn('gap', ['injection', 'crypto-auth'], reported)
  const r = buildFollowUpTurn('reflect', ['injection', 'crypto-auth'], reported)

  const pathAsk = 'Complete the path'
  check('trace turn asks only for the path', t.includes(pathAsk) && !t.includes('did not report'))
  check('gap turn asks only for what was missed', g.includes('did not report') && !g.includes(pathAsk))
  check('reflect turn asks for both', r.includes(pathAsk) && r.includes('did not report'))
  check('trace turn forbids relocation', t.includes('not a relocation'))
  check('gap turn asks for new findings only', g.includes('only the new findings'))
  check('every turn restates what was reported', [t, g, r].every(x => x.includes('trace lines 10, 20')))
  check('every turn names the assigned classes',
    [g, r].every(x => x.includes('injection, crypto-auth')))
  check('empty prior findings render safely',
    buildFollowUpTurn('gap', ['injection'], []).includes('(nothing yet)'))

  // Degeneracy guards. Every ground-truth-denominated metric is monotone in
  // trace length, so the ONLY thing standing between this instruction and a
  // trace that enumerates the file is its own wording. The strict wording is
  // where those guards live; it is off by default because it measured worse
  // than the default, so the assertions are against the strict variant.
  const ts = buildFollowUpTurn('trace', ['injection'], reported, true)
  const rs = buildFollowUpTurn('reflect', ['injection'], reported, true)
  check('strict: added steps must be justified in their description',
    [ts, rs].every(x => x.includes('cannot say what a line does to the value, it is not a step')))
  check('strict: a complete trace has a blessed exit',
    [ts, rs].every(x => x.includes('already complete')))
  check('strict: no turn demands that every trace grow',
    [ts, rs].every(x => x.includes('not being asked to lengthen')))
  check('default wording carries none of those guards, by measurement not oversight',
    !t.includes('not being asked to lengthen') && !t.includes('already complete'))
  check('both wordings forbid relocation',
    [t, ts].every(x => x.includes('not a relocation')))
  check('steps are pinned to the numbered content',
    [t, g, r].every(x => x.includes('cite a line of the numbered content above')))

  // Suppression guards, from the run-4 lesson: a later turn must never be able
  // to retract what an earlier one found.
  check('the non-binding clause is present',
    [g, r].every(x => x.includes('Nothing here overrides the first pass')))
  check('the gap turn restates the required trace shape',
    [g, r].every(x => x.includes('`entrypoint` step and end with a\n`sink` step')))
  check('the gap turn keeps the low confidence band open',
    [g, r].every(x => x.includes('0.1-0.3 finding')))
  check('the gap turn distinguishes a repeat from a same-line sibling',
    [g, r].every(x => x.includes('Two\ndistinct defects on the same lines are two findings')))

  // The unreported-class hint is computed, so it must reflect what was reported.
  const hinted = buildFollowUpTurn('gap', ['injection', 'crypto-auth', 'ssrf'], reported)
  check('classes with no finding yet are named', hinted.includes('crypto-auth, ssrf'))
  check('a class already carried is not named as missing',
    !/No finding yet carries any of these assigned classes: [^\n]*injection/.test(hinted))
  check('the hint is omitted when every class is carried',
    !buildFollowUpTurn('gap', ['injection'], reported).includes('No finding yet carries'))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
