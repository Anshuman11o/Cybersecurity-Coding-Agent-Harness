/**
 * Tests for the finding explanation fields (productization plan §2.9):
 * cwe[], severity_reason, confidence_reason, attack_scenario, remediation.
 *
 * Three properties matter. The schema and the prompt must ask for the same
 * fields, or strict mode rejects every response. A malformed field must never
 * cost the finding it is attached to. And the loop's merge must treat these
 * fields like everything else it touches: nothing is removed.
 *
 * Run: npx tsx src/fields.test.ts
 */
import { explanationFields, mergeFindings, buildHuntPrompt } from './hunt-executor.js'
import type { CandidateFinding, TraceStep } from './types.js'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

const step = (line: number, kind: TraceStep['kind']): TraceStep =>
  ({ kind, file: 'a.ts', line, description: `line ${line}` })

function finding(id: string, extra: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    finding_id: id, lane_id: 'file-0001',
    finding_classes: [{ class: 'injection', justified_by_step: 1 }], categories: ['A03'],
    title: 'SQL built from input', description: 'd',
    trace: [step(10, 'entrypoint'), step(20, 'sink')],
    severity_estimate: 'high', confidence: 0.6, ...extra,
  }
}

console.log('\n-- explanationFields: normalization --')
{
  const f = explanationFields({
    cwe: ['89', 'cwe-89', 'CWE-20: Improper Input Validation', 'SQL injection (CWE-564)', 'none', 7],
    severity_reason: '  Data exposure; reachable without login.  ',
    confidence_reason: { validation: 'looked_for_absent', assumptions: ['no WAF', '', 3], summary: 'Traced.' },
    attack_scenario: 'Anonymous POST to the search route.',
    remediation: 'Use bound parameters.',
  })
  check('CWE ids normalized, deduplicated, order kept',
    JSON.stringify(f.cwe) === JSON.stringify(['CWE-89', 'CWE-20', 'CWE-564']))
  check('prose trimmed', f.severity_reason === 'Data exposure; reachable without login.')
  check('blank and non-string assumptions dropped',
    JSON.stringify(f.confidence_reason?.assumptions) === JSON.stringify(['no WAF']))
  check('validation kept', f.confidence_reason?.validation === 'looked_for_absent')
  check('attack scenario and remediation kept',
    f.attack_scenario === 'Anonymous POST to the search route.' && f.remediation === 'Use bound parameters.')
}
{
  const f = explanationFields({
    cwe: 'CWE-89', severity_reason: '', confidence_reason: { validation: 'maybe', assumptions: [], summary: 's' },
    attack_scenario: 42,
  })
  check('malformed fields are left out, not guessed', Object.keys(f).length === 0)
  check('a finding with none of the fields yields none', Object.keys(explanationFields({ title: 't' })).length === 0)
  check('an empty cwe array is kept as an explicit "none fits"',
    JSON.stringify(explanationFields({ cwe: [] }).cwe) === '[]')
}

console.log('\n-- schema and prompt ask for the same fields --')
{
  const { prompt } = buildHuntPrompt('a.ts', '1: x', ['injection'], new Map(), { chunkIndex: 1, totalChunks: 1 })
  for (const field of ['cwe', 'severity_reason', 'confidence_reason', 'validation', 'assumptions',
    'attack_scenario', 'remediation']) {
    check(`prompt names "${field}"`, prompt.includes(`"${field}"`))
  }
  check('the six original fields are still listed first, unchanged',
    prompt.includes('- "severity_estimate": "low" | "medium" | "high" | "critical"\n- "confidence": number 0-1\n- "cwe"'))
  check('prompt says the fields do not gate reporting', prompt.includes('they are not a bar it has to clear'))
}
{
  // buildHuntSchema is not exported; read it out of the strict-mode contract by
  // parsing the source, so a property added without being made required fails.
  const { readFileSync } = await import('fs')
  const { join, dirname } = await import('path')
  const { fileURLToPath } = await import('url')
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hunt-executor.ts'), 'utf-8')
  const body = src.slice(src.indexOf('function buildHuntSchema'), src.indexOf('// ── Helpers'))
  for (const field of ['cwe', 'severity_reason', 'confidence_reason', 'attack_scenario', 'remediation']) {
    check(`schema declares and requires ${field}`,
      body.includes(`${field}: {`) && new RegExp(`required: \\[[^\\]]*'${field}'`, 's').test(body))
  }
  check('confidence_reason requires all three of its properties (strict mode)',
    body.includes("required: ['validation', 'assumptions', 'summary']"))
}

console.log('\n-- mergeFindings: explanation fields are never removed --')
{
  const a = finding('FIND-0001', {
    cwe: ['CWE-89'], severity_reason: 'first',
    confidence_reason: { validation: 'looked_for_absent', assumptions: ['a'], summary: 's' },
  })
  const revision = finding('FIND-0002', {
    cwe: ['CWE-89', 'CWE-20'], severity_reason: 'second',
    attack_scenario: 'attack', remediation: 'fix',
  })
  const { merged, added } = mergeFindings([a], [revision])
  check('same title is a revision, not a new finding', added === 0 && merged.length === 1)
  check('CWE ids unioned', JSON.stringify(merged[0].cwe) === JSON.stringify(['CWE-89', 'CWE-20']))
  check('existing prose kept', merged[0].severity_reason === 'first')
  check('missing prose filled from the revision',
    merged[0].attack_scenario === 'attack' && merged[0].remediation === 'fix')
  check('confidence_reason kept', merged[0].confidence_reason?.summary === 's')
  check('inputs not mutated', JSON.stringify(a.cwe) === JSON.stringify(['CWE-89']))
  merged[0].confidence_reason!.assumptions.push('x')
  check('merged confidence_reason is a copy', a.confidence_reason!.assumptions.length === 1)
}
{
  // A run made before the fields existed must merge to exactly what it did.
  const old = finding('FIND-0001')
  const { merged } = mergeFindings([old], [finding('FIND-0002')])
  check('a finding without the fields gains no keys',
    JSON.stringify(Object.keys(merged[0]).sort()) === JSON.stringify(Object.keys(old).sort()))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
