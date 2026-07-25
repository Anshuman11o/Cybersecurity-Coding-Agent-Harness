/**
 * Stage 3 — Validate.
 *
 * Task A: Pre-validation consolidation — group candidate findings by
 *   sink-location overlap (same file, line within ±15 slack).
 *
 * Task B: Independent blind validator — one LLM call per consolidated
 *   candidate, receives ONLY the claim (title, description, trace), never
 *   lane_id/finding_id. Schema-constrained structured output. Retry once
 *   on UNCERTAIN verdict.
 *
 * Task C: Budget integration — validation uses its own BudgetTracker pool
 *   derived from per-lane ceilings (approach A: reuse the max ceiling
 *   across contributing lanes as a reasonable proxy, since validation
 *   re-reads the same cited files the hunter already analyzed, so the
 *   per-lane ceiling already accounts for that code's complexity).
 *
 * Output: validated-findings.json, budget-consumption.json
 */
import OpenAI from 'openai'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from './llm-client.js'
import { BudgetTracker } from '../../stage1-budget-governor/src/budget-governor.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../..')
const LINE_SLACK = 15  // same constant as tools/scan-benchmark/score.py

// ── Types ──────────────────────────────────────────────────────────────────

interface TraceStep {
  kind: 'entrypoint' | 'propagation' | 'sink'
  file: string
  line: number
  description: string
}

interface CandidateFinding {
  finding_id: string
  lane_id: string
  categories: string[]
  title: string
  description: string
  trace: TraceStep[]
  severity_estimate: string
  confidence: number
}

interface ConsolidatedCandidate {
  consolidated_id: string
  original_finding_ids: string[]
  original_lane_ids: string[]
  title: string
  description: string
  trace: TraceStep[]
  severity_estimate: string
  categories: string[]
  confidence: number
}

interface ValidatorVerdict {
  consolidated_id: string
  original_finding_ids: string[]
  original_lane_ids: string[]
  verdict: 'CONFIRMED' | 'REJECTED' | 'UNCERTAIN'
  validator_evidence: string
  title: string
  trace: TraceStep[]
  severity_estimate: string
  was_retry: boolean
}

interface BudgetConsumption {
  consolidated_id: string
  tokens_used: number
  seconds_elapsed: number
  ceiling_hit: boolean
  was_retry: boolean
}

// ── Schema for structured output ──────────────────────────────────────────

const VALIDATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REJECTED', 'UNCERTAIN'] },
    validator_evidence: { type: 'string' },
  },
  required: ['verdict', 'validator_evidence'],
}

const FORCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REJECTED'] },
    validator_evidence: { type: 'string' },
  },
  required: ['verdict', 'validator_evidence'],
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  p = p.trim().replace(/\\/g, '/')
  // strip common prefixes
  for (const root of ['file://', '/home/user/Cybersecurity-Coding-Agent-Harness/', './']) {
    if (p.startsWith(root)) p = p.slice(root.length)
  }
  return p.replace(/^\/+/, '')
}

function sinksOverlap(a: TraceStep[], b: TraceStep[]): boolean {
  const sinkA = a[a.length - 1]
  const sinkB = b[b.length - 1]
  if (!sinkA || !sinkB) return false
  if (sinkA.kind !== 'sink' || sinkB.kind !== 'sink') return false
  const fileA = normalizePath(sinkA.file)
  const fileB = normalizePath(sinkB.file)
  if (fileA !== fileB) return false
  return Math.abs(sinkA.line - sinkB.line) <= LINE_SLACK
}

/**
 * Task A: Group findings by sink-location overlap using union-find approach.
 */
function consolidateFindings(
  findings: CandidateFinding[]
): ConsolidatedCandidate[] {
  // Union-Find data structure
  const parent = findings.map((_, i) => i)
  const find = (i: number): number => {
    if (parent[i] === i) return i
    parent[i] = find(parent[i])
    return parent[i]
  }
  const union = (i: number, j: number) => {
    const rootI = find(i)
    const rootJ = find(j)
    if (rootI !== rootJ) parent[rootI] = rootJ
  }

  // Compare all pairs
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      if (sinksOverlap(findings[i].trace, findings[j].trace)) {
        union(i, j)
      }
    }
  }

  // Group by root
  const groups = new Map<number, CandidateFinding[]>()
  for (let i = 0; i < findings.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(findings[i])
  }

  // Build consolidated candidates
  const consolidated: ConsolidatedCandidate[] = []
  let counter = 0
  for (const [, group] of groups) {
    counter++
    const cid = `CONS-${String(counter).padStart(4, '0')}`

    // Pick the highest-confidence finding as the canonical one
    group.sort((a, b) => b.confidence - a.confidence)
    const canonical = group[0]

    // Collect unique categories across merged findings
    const allCategories = [...new Set(group.flatMap(f => f.categories))]

    consolidated.push({
      consolidated_id: cid,
      original_finding_ids: group.map(f => f.finding_id),
      original_lane_ids: [...new Set(group.map(f => f.lane_id))],
      title: canonical.title,
      description: canonical.description,
      trace: canonical.trace,
      severity_estimate: canonical.severity_estimate,
      categories: allCategories,
      confidence: canonical.confidence,
    })
  }

  return consolidated
}

// ── File reader for validator ──────────────────────────────────────────────

function readCitedFiles(trace: TraceStep[]): Record<string, string> {
  const result: Record<string, string> = {}
  const seen = new Set<string>()
  for (const step of trace) {
    const norm = normalizePath(step.file)
    if (seen.has(norm)) continue
    seen.add(norm)
    const fullPath = join(REPO_ROOT, norm)
    if (existsSync(fullPath)) {
      result[norm] = readFileSync(fullPath, 'utf-8')
    } else {
      console.warn(`  [WARN] cited file not found: ${fullPath}`)
    }
  }
  return result
}

function lineNumberFile(content: string): string {
  const lines = content.split('\n')
  const pad = String(lines.length).length
  return lines.map((line, i) => `${String(i + 1).padStart(pad)}: ${line}`).join('\n')
}

function buildSeedFileSection(files: Record<string, string>): string {
  const entries = Object.entries(files)
  if (entries.length === 0) return '(no cited files available)'
  return entries.map(([relPath, content]) => {
    const MAX = 15000
    const numbered = lineNumberFile(content)
    const display = numbered.length > MAX
      ? numbered.slice(0, MAX) + `\n\n... [truncated, file is ${content.length.toLocaleString()} bytes] ...`
      : numbered
    return `\`\`\`${relPath}\n${display}\n\`\`\``
  }).join('\n\n')
}

// ── Structured output call ─────────────────────────────────────────────────

interface StructuredResult {
  text: string
  tokensUsed: number
}

async function callWithSchema(
  client: OpenAI,
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  maxTokens: number,
): Promise<StructuredResult | null> {
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'validator_output',
          schema,
          strict: true,
        },
      },
    })
    const text = response.choices[0]?.message?.content
    if (!text) return null
    return { text, tokensUsed: response.usage?.total_tokens ?? 0 }
  } catch (err: any) {
    if (err.message?.includes('json_schema') || err.message?.includes('strict') ||
        err.message?.includes('response_format')) {
      try {
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        })
        const text = response.choices[0]?.message?.content
        if (!text) return null
        return { text, tokensUsed: response.usage?.total_tokens ?? 0 }
      } catch {
        return null
      }
    }
    throw err
  }
}

// ── Validator prompt builder (BLIND — no lane_id/finding_id) ──────────────

function buildValidatorPrompt(
  candidate: ConsolidatedCandidate,
  citedFiles: Record<string, string>,
  isRetry: boolean,
): string {
  const seedContent = buildSeedFileSection(citedFiles)

  let prompt = `You are an independent security validator reviewing a claimed vulnerability in a TypeScript web application. Your job is to ACTIVELY TRY TO DISPROVE the claim by re-reading the actual cited source code.

## The Claim
- **Title:** ${candidate.title}
- **Description:** ${candidate.description}
- **Claimed severity:** ${candidate.severity_estimate}
- **Claimed trace:**
${candidate.trace.map(s => `  - ${s.kind.toUpperCase()} at ${s.file}:${s.line} — ${s.description}`).join('\n')}

## Cited Source Files
The following are the actual source files referenced in the claim, with REAL 1-indexed line numbers. Read them carefully.

${seedContent}

## Your Task
1. **Verify the trace:** Does the code at the cited lines actually contain what the claim says? Check each step (entrypoint → propagation → sink) individually.
2. **Check for neutralization:** Is there any upstream middleware, input validation, sanitization, parameterization, or other mechanism that actually neutralizes this attack path? A length cap is NOT a sanitizer. A type cast is NOT validation. An allowlist check IS neutralization.
3. **Check for factual errors:** Does the claim misstate what the code does? Are the line numbers correct? Is the described sink actually what's at that location?
4. **Reach a verdict:**
   - CONFIRMED: The trace is real, the cited code does what the claim says, and there is no upstream neutralization that closes the exploit path.
   - REJECTED: The claim is factually wrong, the trace is broken, or an upstream mechanism neutralizes the attack. Name the specific factual error or neutralizing mechanism.
   - UNCERTAIN: You genuinely cannot determine from the cited code alone (e.g., the cited files don't show enough context to confirm or deny). This should be rare — if you can make a reasonable call, do so.${isRetry ? `

## IMPORTANT: You previously returned UNCERTAIN. This time you MUST choose either CONFIRMED or REJECTED. Give your best definitive verdict based on what the cited code shows. If the trace is plausible and no neutralization is visible, lean CONFIRMED. If the trace is broken or neutralized, lean REJECTED. Do NOT return UNCERTAIN this time.` : ''}

## Output Format
Respond as a structured JSON object with:
- "verdict": "CONFIRMED" | "REJECTED" | "UNCERTAIN"
- "validator_evidence": A detailed explanation of your analysis and why you reached this verdict. For CONFIRMED: your own independent evidence confirming the exploit path. For REJECTED: the specific factual error or neutralizing mechanism that disproves the claim. For UNCERTAIN: what specifically prevents you from deciding.`

  return prompt
}

// ── Task B: Validate one consolidated candidate ────────────────────────────

async function validateCandidate(
  client: OpenAI,
  candidate: ConsolidatedCandidate,
  budgetTracker: BudgetTracker,
  budgetLaneId: string,
): Promise<ValidatorVerdict> {
  const citedFiles = readCitedFiles(candidate.trace)
  const citedFileCount = Object.keys(citedFiles).length

  if (citedFileCount === 0) {
    return {
      consolidated_id: candidate.consolidated_id,
      original_finding_ids: candidate.original_finding_ids,
      original_lane_ids: candidate.original_lane_ids,
      verdict: 'REJECTED',
      validator_evidence: 'None of the cited files in the trace could be located in the repository — the finding cannot be validated.',
      title: candidate.title,
      trace: candidate.trace,
      severity_estimate: candidate.severity_estimate,
      was_retry: false,
    }
  }

  // First attempt
  const prompt1 = buildValidatorPrompt(candidate, citedFiles, false)
  const t0 = Date.now()
  const result1 = await callWithSchema(client, 'qwen-plus', prompt1, VALIDATOR_SCHEMA, 4000)
  const elapsed1 = (Date.now() - t0) / 1000

  if (!result1) {
    // LLM call failed entirely — report 0 tokens but still track time
    budgetTracker.reportConsumption({
      lane_id: budgetLaneId,
      tokens_used: 0,
      seconds_elapsed: elapsed1,
    })
    return {
      consolidated_id: candidate.consolidated_id,
      original_finding_ids: candidate.original_finding_ids,
      original_lane_ids: candidate.original_lane_ids,
      verdict: 'UNCERTAIN',
      validator_evidence: 'Validator LLM call failed — could not reach a verdict.',
      title: candidate.title,
      trace: candidate.trace,
      severity_estimate: candidate.severity_estimate,
      was_retry: false,
    }
  }

  let parsed1: { verdict: string; validator_evidence: string }
  try {
    parsed1 = JSON.parse(result1.text)
  } catch {
    // Fallback: try to extract verdict from text
    parsed1 = { verdict: 'UNCERTAIN', validator_evidence: result1.text }
  }

  // Report budget for first attempt
  budgetTracker.reportConsumption({
    lane_id: budgetLaneId,
    tokens_used: result1.tokensUsed,
    seconds_elapsed: elapsed1,
  })

  const firstVerdict = parsed1.verdict as 'CONFIRMED' | 'REJECTED' | 'UNCERTAIN'

  if (firstVerdict !== 'UNCERTAIN') {
    return {
      consolidated_id: candidate.consolidated_id,
      original_finding_ids: candidate.original_finding_ids,
      original_lane_ids: candidate.original_lane_ids,
      verdict: firstVerdict,
      validator_evidence: parsed1.validator_evidence,
      title: candidate.title,
      trace: candidate.trace,
      severity_estimate: candidate.severity_estimate,
      was_retry: false,
    }
  }

  // UNCERTAIN — retry once with forced-binary instruction
  console.log(`  [RETRY] ${candidate.consolidated_id} was UNCERTAIN, retrying with forced binary`)
  const prompt2 = buildValidatorPrompt(candidate, citedFiles, true)
  const t1 = Date.now()
  const result2 = await callWithSchema(client, 'qwen-plus', prompt2, FORCE_SCHEMA, 4000)
  const elapsed2 = (Date.now() - t1) / 1000

  if (!result2) {
    budgetTracker.reportConsumption({
      lane_id: budgetLaneId,
      tokens_used: 0,
      seconds_elapsed: elapsed2,
    })
    return {
      consolidated_id: candidate.consolidated_id,
      original_finding_ids: candidate.original_finding_ids,
      original_lane_ids: candidate.original_lane_ids,
      verdict: 'UNCERTAIN',
      validator_evidence: parsed1.validator_evidence + ' [Retry also failed — LLM call returned no response]',
      title: candidate.title,
      trace: candidate.trace,
      severity_estimate: candidate.severity_estimate,
      was_retry: true,
    }
  }

  budgetTracker.reportConsumption({
    lane_id: budgetLaneId,
    tokens_used: result2.tokensUsed,
    seconds_elapsed: elapsed2,
  })

  let parsed2: { verdict: string; validator_evidence: string }
  try {
    parsed2 = JSON.parse(result2.text)
  } catch {
    parsed2 = { verdict: 'UNCERTAIN', validator_evidence: result2.text }
  }

  // Map any remaining UNCERTAIN on retry to REJECTED (we forced binary)
  const finalVerdict = (parsed2.verdict === 'CONFIRMED' || parsed2.verdict === 'REJECTED')
    ? (parsed2.verdict as 'CONFIRMED' | 'REJECTED')
    : 'REJECTED'  // forced: if still ambiguous after retry, reject

  return {
    consolidated_id: candidate.consolidated_id,
    original_finding_ids: candidate.original_finding_ids,
    original_lane_ids: candidate.original_lane_ids,
    verdict: finalVerdict,
    validator_evidence: parsed2.validator_evidence,
    title: candidate.title,
    trace: candidate.trace,
    severity_estimate: candidate.severity_estimate,
    was_retry: true,
  }
}

// ── Task C: Budget pool for validation ─────────────────────────────────────

/**
 * Budget approach: Each consolidated candidate's contributing lanes already
 * have token ceilings computed by Stage 1. Validation re-reads the same cited
 * files the hunter already analyzed — it doesn't scan new code, just confirms
 * or refutes a specific trace. So we use the MAX ceiling across all
 * contributing lanes as the validation ceiling for that candidate.
 *
 * Why max rather than sum or average: the cited files for validation are a
 * subset of what the hunter lane read (just the trace steps, not the full
 * seed set). The ceiling already accounts for the code's complexity. Using
 * the max ensures no single candidate's validation is starved just because
 * it was found by a lane with a small seed footprint. The total validation
 * budget across all candidates is bounded by N × max_ceiling, which is still
 * much smaller than the original hunt budget (validation doesn't iterate —
 * it's a single pass per candidate).
 */
function buildValidationBudgetTracker(
  consolidated: ConsolidatedCandidate[],
  budgetPlan: any[],
): { tracker: BudgetTracker; laneMap: Map<string, string> } {
  // For each consolidated candidate, determine its "validation lane id"
  // We'll use the consolidated_id itself and map it to the max ceiling
  const validationEntries: any[] = []

  for (const c of consolidated) {
    // Find the max token ceiling across contributing lanes
    let maxCeiling = 6000  // default floor (small validation call)
    let maxWallClock = 60   // default floor
    for (const laneId of c.original_lane_ids) {
      const planEntry = budgetPlan.find((e: any) => e.lane_id === laneId)
      if (planEntry) {
        maxCeiling = Math.max(maxCeiling, planEntry.token_ceiling)
        maxWallClock = Math.max(maxWallClock, planEntry.wall_clock_ceiling_seconds)
      }
    }

    validationEntries.push({
      lane_id: c.consolidated_id,
      seed_file_count: c.trace.length,
      seed_bytes_total: 0,  // not used for validation ceiling
      token_ceiling: maxCeiling,
      wall_clock_ceiling_seconds: maxWallClock,
      model_tier: 'mid' as const,
      escalation_flag: false,
      escalation_reason: '',
    })
  }

  const tracker = new BudgetTracker(validationEntries)
  return { tracker, laneMap: new Map(consolidated.map(c => [c.consolidated_id, c.original_lane_ids[0]])) }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Stage 3: Validate ===')
  console.log()

  // Load inputs
  const candidateFindings: CandidateFinding[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'tools/scanner/stage2-hunt-lanes/output/candidate-findings.json'), 'utf-8')
  )
  const budgetPlan = JSON.parse(
    readFileSync(join(REPO_ROOT, 'tools/scanner/stage1-budget-governor/output/budget-plan.json'), 'utf-8')
  )

  console.log(`Loaded ${candidateFindings.length} candidate findings from Stage 2`)
  console.log(`Loaded ${budgetPlan.length} budget plan entries`)

  // ── Task A: Consolidation ───────────────────────────────────────────────
  console.log('\n--- Task A: Pre-validation Consolidation ---')
  const consolidated = consolidateFindings(candidateFindings)
  console.log(`\nConsolidation: ${candidateFindings.length} candidates -> ${consolidated.length} consolidated candidates`)

  // Report merge details
  const mergeExamples: string[] = []
  for (const c of consolidated) {
    if (c.original_finding_ids.length > 1) {
      mergeExamples.push(
        `  ${c.consolidated_id}: merged [${c.original_finding_ids.join(', ')}] from lanes [${c.original_lane_ids.join(', ')}]` +
        ` — sink overlap at ${c.trace[c.trace.length - 1].file}:${c.trace[c.trace.length - 1].line}`
      )
    }
  }
  if (mergeExamples.length === 0) {
    console.log('  No merges — all findings have distinct sink locations.')
  } else {
    console.log(`  ${mergeExamples.length} consolidation group(s):`)
    for (const ex of mergeExamples) console.log(ex)
  }

  const singleCount = consolidated.filter(c => c.original_finding_ids.length === 1).length
  const multiCount = consolidated.filter(c => c.original_finding_ids.length > 1).length
  console.log(`  ${singleCount} candidates unchanged, ${multiCount} candidates formed by merging`)

  // ── Task C: Budget setup ────────────────────────────────────────────────
  const { tracker: budgetTracker } = buildValidationBudgetTracker(consolidated, budgetPlan)
  const client = createClient()

  // ── Task B: Validate ────────────────────────────────────────────────────
  console.log('\n--- Task B: Blind Validation ---')

  const verdicts: ValidatorVerdict[] = []
  const budgetConsumption: BudgetConsumption[] = []
  let confirmedCount = 0
  let rejectedCount = 0
  let uncertainCount = 0
  let retryCount = 0

  for (const candidate of consolidated) {
    if (budgetTracker.isRunStopped()) {
      console.log(`\n[STOP] Run stopped globally before validating ${candidate.consolidated_id}`)
      // Still emit remaining as UNCERTAIN
      for (const remaining of consolidated.slice(consolidated.indexOf(candidate))) {
        verdicts.push({
          consolidated_id: remaining.consolidated_id,
          original_finding_ids: remaining.original_finding_ids,
          original_lane_ids: remaining.original_lane_ids,
          verdict: 'UNCERTAIN',
          validator_evidence: 'Budget exhausted before validation could run.',
          title: remaining.title,
          trace: remaining.trace,
          severity_estimate: remaining.severity_estimate,
          was_retry: false,
        })
        uncertainCount++
      }
      break
    }

    console.log(`\n[VALIDATE] ${candidate.consolidated_id} (${candidate.original_finding_ids.length} original findings, ${candidate.original_lane_ids.length} lane(s))`)
    console.log(`  Claim: ${candidate.title}`)

    const verdict = await validateCandidate(client, candidate, budgetTracker, candidate.consolidated_id)
    verdicts.push(verdict)

    // Track budget per candidate
    const trackerLane = budgetTracker['laneTokens'].get(candidate.consolidated_id) ?? 0
    const trackerSeconds = budgetTracker['laneSeconds'].get(candidate.consolidated_id) ?? 0
    budgetConsumption.push({
      consolidated_id: candidate.consolidated_id,
      tokens_used: trackerLane,
      seconds_elapsed: trackerSeconds,
      ceiling_hit: budgetTracker.isLaneStopped(candidate.consolidated_id),
      was_retry: verdict.was_retry,
    })

    if (verdict.verdict === 'CONFIRMED') {
      confirmedCount++
      console.log(`  -> CONFIRMED`)
    } else if (verdict.verdict === 'REJECTED') {
      rejectedCount++
      console.log(`  -> REJECTED`)
    } else {
      uncertainCount++
      console.log(`  -> UNCERTAIN`)
    }
    if (verdict.was_retry) retryCount++
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n\n=== Validation Summary ===')
  console.log(`Total consolidated candidates: ${consolidated.length}`)
  console.log(`  CONFIRMED: ${confirmedCount}`)
  console.log(`  REJECTED:  ${rejectedCount}`)
  console.log(`  UNCERTAIN: ${uncertainCount}`)
  console.log(`  Retries on UNCERTAIN: ${retryCount}`)

  // ── Spot-check output: show 2-3 prompts that were blind ────────────────
  // (We can't reconstruct the exact prompts without saving them, but we
  // can verify the design by showing what WOULD have been sent for the
  // first 3 candidates.)
  console.log('\n--- Blind Design Proof (sample prompts for first 3 candidates) ---')
  for (let i = 0; i < Math.min(3, consolidated.length); i++) {
    const c = consolidated[i]
    const citedFiles = readCitedFiles(c.trace)
    const samplePrompt = buildValidatorPrompt(c, citedFiles, false)
    // Check the prompt does NOT contain lane_id or finding_id
    const hasLaneId = samplePrompt.includes('lane_id') || samplePrompt.includes('finding_id') ||
                      samplePrompt.includes(c.original_lane_ids[0]) ||
                      samplePrompt.includes(c.original_finding_ids[0])
    console.log(`\n[${c.consolidated_id}] Blind check: contains lane_id/finding_id? ${hasLaneId ? 'YES (BUG!)' : 'NO (correct)'}`)
    console.log(`  Prompt length: ${samplePrompt.length} chars`)
    // Show first 200 chars to prove it starts with the claim, not provenance
    console.log(`  Prompt start: "${samplePrompt.slice(0, 200).replace(/\n/g, ' ')}..."`)
  }

  // ── Write outputs ───────────────────────────────────────────────────────
  const outDir = join(__dirname, '..', 'output')
  mkdirSync(outDir, { recursive: true })

  const validatedOutput = verdicts.map(v => ({
    consolidated_id: v.consolidated_id,
    original_finding_ids: v.original_finding_ids,
    original_lane_ids: v.original_lane_ids,
    verdict: v.verdict,
    validator_evidence: v.validator_evidence,
    title: v.title,
    trace: v.trace,
    severity_estimate: v.severity_estimate,
  }))

  writeFileSync(join(outDir, 'validated-findings.json'), JSON.stringify(validatedOutput, null, 2) + '\n')
  console.log(`\nOutput written to ${join(outDir, 'validated-findings.json')}`)

  // Rebuild budget-consumption from tracker's internal state for accuracy
  const accurateBudgetConsumption: BudgetConsumption[] = []
  for (const c of consolidated) {
    const tok = (budgetTracker as any).laneTokens.get(c.consolidated_id) ?? 0
    const sec = (budgetTracker as any).laneSeconds.get(c.consolidated_id) ?? 0
    const verdict = verdicts.find(v => v.consolidated_id === c.consolidated_id)
    accurateBudgetConsumption.push({
      consolidated_id: c.consolidated_id,
      tokens_used: tok,
      seconds_elapsed: sec,
      ceiling_hit: budgetTracker.isLaneStopped(c.consolidated_id),
      was_retry: verdict?.was_retry ?? false,
    })
  }

  writeFileSync(join(outDir, 'budget-consumption.json'), JSON.stringify(accurateBudgetConsumption, null, 2) + '\n')
  console.log(`Budget consumption written to ${join(outDir, 'budget-consumption.json')}`)

  // Detailed per-candidate verdict table
  console.log('\n--- Per-Candidate Verdict Table ---')
  for (const v of verdicts) {
    console.log(`  ${v.consolidated_id} | ${v.verdict.padEnd(10)} | ${v.original_finding_ids.length.toString().padStart(2)} orig | ${v.title.slice(0, 80)}`)
    if (v.verdict === 'REJECTED') {
      console.log(`    Rejection reason: ${v.validator_evidence.slice(0, 200)}...`)
    }
  }
}

main().catch(console.error)
