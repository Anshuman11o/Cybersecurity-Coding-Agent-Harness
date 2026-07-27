/**
 * Stage 2 — Hunt Lanes executor.
 *
 * Runs 18 hunt lanes sequentially (budget-governed), each with:
 *  - Playbook guidance (generic, per-category)
 *  - Seed file contents (line-numbered for accurate line citation)
 *  - Budget ceiling enforcement via BudgetTracker
 *  - Structured output (response_format json_schema) — no free-text JSON parsing
 *
 * After Phase 1: orchestrator reviews scope requests + escalation-flagged lanes,
 * decides on scope expansions and second passes. Phase 3 runs approved re-runs.
 *
 * Outputs: candidate-findings.json, budget-consumption.json
 */
import OpenAI from 'openai'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from './llm-client.js'
import { BudgetTracker } from '../../stage1-budget-governor/src/budget-governor.js'
import type {
  LaneManifestEntry,
  BudgetPlanEntry,
  CandidateFinding,
  LaneHuntResponse,
  ScopeRequest,
  BudgetConsumption,
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../..')

// ── Structured output schema (FIX 2) ───────────────────────────────────────

const HUNT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          trace: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['entrypoint', 'propagation', 'sink'] },
                file: { type: 'string' },
                line: { type: 'integer' },
                description: { type: 'string' },
              },
              required: ['kind', 'file', 'line', 'description'],
            },
          },
          severity_estimate: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['title', 'description', 'trace', 'severity_estimate', 'confidence'],
      },
    },
    scope_requests: {
      type: 'array',
      description: 'Files outside your seed set that are directly needed to complete a trace already in progress. If you hit a gap where a handler calls middleware, imports a model, or references a file you cannot see, request it here. An empty array is fine and expected when your seed files are sufficient -- do not request files speculatively.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['file', 'reason'],
      },
    },
  },
  required: ['findings', 'scope_requests'],
}

const ORCHESTRATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope_decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lane_id: { type: 'string' },
          file: { type: 'string' },
          approved: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['lane_id', 'file', 'approved', 'reason'],
      },
    },
    escalation_passes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lane_id: { type: 'string' },
          approved: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['lane_id', 'approved', 'reason'],
      },
    },
  },
  required: ['scope_decisions', 'escalation_passes'],
}

// ── Helpers ────────────────────────────────────────────────────────────────

let findingCounter = 0
function nextFindingId(): string {
  findingCounter++
  return `FIND-${String(findingCounter).padStart(4, '0')}`
}

function readSeedFiles(paths: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const p of paths) {
    const full = join(REPO_ROOT, p)
    if (existsSync(full)) {
      result[p] = readFileSync(full, 'utf-8')
    } else {
      console.warn(`  [WARN] seed file not found: ${full}`)
    }
  }
  return result
}

/**
 * Sanitize PEM-formatted private key material to avoid upstream content-safety
 * filters that flag long base64 blobs inside BEGIN/END PRIVATE KEY markers as
 * credential exfiltration. The structural markers are preserved so the LLM can
 * still identify hardcoded keys as misconfiguration findings.
 */
function sanitizePemPrivateKey(content: string): string {
  return content.replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    (_match, beginMarker, endMarker) => {
      return beginMarker + '\n[REDACTED: private key material]\n' + endMarker;
    }
  );
}

/**
 * FIX 1: Prefix every line with its real 1-indexed line number.
 * Format: "41: export const hash = ..." (same as cat -n or IDE gutter).
 */
function lineNumberFile(content: string): string {
  const lines = content.split('\n')
  const pad = String(lines.length).length
  return lines.map((line, i) => `${String(i + 1).padStart(pad)}: ${line}`).join('\n')
}

/**
 * FIX 1: Build seed file section with line-numbered content.
 */
function buildSeedFileSection(files: Record<string, string>): string {
  const entries = Object.entries(files)
  if (entries.length === 0) return '(no seed files available)'
  return entries.map(([relPath, content]) => {
    const MAX = 15000
    const sanitized = sanitizePemPrivateKey(content)
    const numbered = lineNumberFile(sanitized)
    const display = numbered.length > MAX
      ? numbered.slice(0, MAX) + '\n\n... [truncated, file is ' + content.length.toLocaleString() + ' bytes] ...'
      : numbered
    return `\`\`\`${relPath}\n${display}\n\`\`\``
  }).join('\n\n')
}

// ── Semgrep preflight (Task D) ─────────────────────────────────────────────

const SEMGREP_CATEGORIES = new Set([
  'injection-sql', 'injection-nosql', 'misconfiguration',
  'crypto-auth', 'vulnerable-components', 'injection-code',
  'client-side',
])

async function checkSemgrepAvailable(): Promise<boolean> {
  const { execSync } = await import('child_process')
  try {
    execSync('which semgrep', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function runSemgrep(seedFiles: string[], laneId: string): Promise<string> {
  const { execSync } = await import('child_process')
  const rules = getSemgrepRulesForLane(laneId)
  if (rules.length === 0) return ''

  let output = ''
  for (const sf of seedFiles) {
    const full = join(REPO_ROOT, sf)
    if (!existsSync(full)) continue
    for (const rule of rules) {
      try {
        const result = execSync(
          `semgrep --config ${rule} --json --quiet "${full}" 2>/dev/null || true`,
          { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        )
        if (result.trim()) {
          output += `=== semgrep ${rule} on ${sf} ===\n${result}\n\n`
        }
      } catch {
        // semgrep exited non-zero or timed out — skip silently
      }
    }
  }
  return output
}

function getSemgrepRulesForLane(laneId: string): string[] {
  const rules: Record<string, string[]> = {
    'injection-sql': ['p/sql-injection'],
    'injection-nosql': ['p/javascript'],
    'injection-code': ['p/audit'],
    'misconfiguration': ['p/security-not-strict'],
    'vulnerable-components': ['p/ci'],
    'client-side': ['p/xss'],
  }
  return rules[laneId] ?? []
}

// ── Playbook loader (Task A) ───────────────────────────────────────────────

async function loadPlaybook(reference: string): Promise<string> {
  const mod = await import(`./playbooks/${reference}.js`)
  return mod.playbook as string
}

// ── FIX 2: Structured output helpers ───────────────────────────────────────

interface StructuredOutputResult {
  text: string
  tokensUsed: number
}

async function callWithStructuredOutput(
  client: OpenAI,
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  maxTokens: number,
): Promise<StructuredOutputResult | null> {
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'hunt_output',
          schema,
          strict: true,
        },
      },
    })
    const text = response.choices[0]?.message?.content
    if (!text) return null
    return { text, tokensUsed: response.usage?.total_tokens ?? 0 }
  } catch (err: any) {
    // If json_schema is not supported by this endpoint, fall back to free-text
    if (err.message?.includes('json_schema') || err.message?.includes('strict') ||
        err.message?.includes('response_format')) {
      console.log('  [INFO] json_schema not supported, falling back to free-text response_format')
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
      } catch (err2: any) {
        console.error(`  [ERROR] Free-text fallback also failed: ${err2.message}`)
        return null
      }
    }
    throw err
  }
}

// ── Hunt a single lane ─────────────────────────────────────────────────────

async function huntLane(
  client: OpenAI,
  lane: LaneManifestEntry,
  budgetEntry: BudgetPlanEntry,
  tracker: BudgetTracker,
  semgrepHints: string,
  seedOverride?: Record<string, string>,
  secondPass?: boolean,
): Promise<{ findings: CandidateFinding[]; scope_requests: ScopeRequest[] }> {
  if (tracker.isRunStopped() || tracker.isLaneStopped(lane.lane_id)) {
    console.log(`  [SKIP] Lane ${lane.lane_id} is already stopped.`)
    return { findings: [], scope_requests: [] }
  }

  const playbook = await loadPlaybook(lane.playbook_reference)
  const seeds = seedOverride ?? readSeedFiles(lane.seed_files)
  const seedContent = buildSeedFileSection(seeds)

  let prompt: string
  if (secondPass) {
    prompt = buildSecondPassPrompt(lane, playbook, seedContent, semgrepHints)
  } else {
    prompt = buildHuntPrompt(lane, playbook, seedContent, semgrepHints)
  }

  const t0 = Date.now()
  try {
    // FIX 2: Use structured output instead of free-text JSON parsing
    const result = await callWithStructuredOutput(client, 'qwen-plus', prompt, HUNT_RESPONSE_SCHEMA, 8000)
    const elapsed = (Date.now() - t0) / 1000

    if (!result) {
      console.error(`  [ERROR] Lane ${lane.lane_id} structured output call failed`)
      tracker.reportConsumption({
        lane_id: lane.lane_id,
        tokens_used: 0,
        seconds_elapsed: elapsed,
      })
      return { findings: [], scope_requests: [] }
    }

    // Report REAL consumption to BudgetTracker
    tracker.reportConsumption({
      lane_id: lane.lane_id,
      tokens_used: result.tokensUsed,
      seconds_elapsed: elapsed,
    })

    let parsed: LaneHuntResponse
    try {
      parsed = JSON.parse(result.text) as LaneHuntResponse
    } catch {
      console.log(`  [WARN] Lane ${lane.lane_id} structured output returned unparseable content, skipping`)
      return { findings: [], scope_requests: [] }
    }

    // Validate and assign finding IDs
    const validFindings: CandidateFinding[] = []
    if (parsed.findings && Array.isArray(parsed.findings)) {
      for (const f of parsed.findings) {
        if (!f.trace || !Array.isArray(f.trace) || f.trace.length === 0) {
          console.log(`  [WARN] Finding "${f.title}" has empty trace — dropping`)
          continue
        }
        if (f.trace[0].kind !== 'entrypoint') {
          console.log(`  [WARN] Finding "${f.title}" trace doesn't start with entrypoint — dropping`)
          continue
        }
        if (f.trace[f.trace.length - 1].kind !== 'sink') {
          console.log(`  [WARN] Finding "${f.title}" trace doesn't end with sink — dropping`)
          continue
        }
        f.finding_id = nextFindingId()
        f.lane_id = lane.lane_id
        f.categories = lane.categories
        validFindings.push(f)
      }
    }

    return {
      findings: validFindings,
      scope_requests: parsed.scope_requests ?? [],
    }
  } catch (err: any) {
    const elapsed = (Date.now() - t0) / 1000
    console.error(`  [ERROR] Lane ${lane.lane_id} LLM call failed: ${err.message}`)
    tracker.reportConsumption({
      lane_id: lane.lane_id,
      tokens_used: 0,
      seconds_elapsed: elapsed,
    })
    return { findings: [], scope_requests: [] }
  }
}

function buildHuntPrompt(
  lane: LaneManifestEntry,
  playbook: string,
  seedContent: string,
  semgrepHints: string,
): string {
  let prompt = `You are a security analyst hunting for vulnerabilities in a specific category within a TypeScript web application.

## Lane Assignment
- **Lane ID:** ${lane.lane_id}
- **Categories:** ${lane.categories.join(', ')}
- **Subsystem scope:** ${lane.subsystem_scope}

## Playbook — How to hunt this category
${playbook}

## Seed Files
Below are the source files you must analyze. Each line is prefixed with its REAL 1-indexed line number (as shown in the actual source file). When citing a location in your trace, use these line numbers EXACTLY — do NOT recount or estimate.

${seedContent}
`

  if (semgrepHints) {
    prompt += `
## Semgrep Hints (additive context only — do NOT limit your search to these hits)
${semgrepHints}
`
  }

  prompt += `
## Output Format
Respond with a structured JSON object containing:
- "findings": an array of candidate findings. Only include findings where you can construct a complete entrypoint-to-sink trace. If you find nothing exploitable, return an empty array — being conservative is correct.
- "scope_requests": an array of objects {file, reason} for files OUTSIDE your seed set that you believe are directly needed to complete a trace already in progress. Most lanes should have an empty array.

Each finding must have:
- "title": concise vulnerability title
- "description": what the vulnerability is, how it works, and why it is exploitable
- "trace": array of {kind: "entrypoint"|"propagation"|"sink", file: "relative/path.ts", line: NUMBER (use the line numbers shown in the seed files above), description: string}. First step MUST be entrypoint, last MUST be sink.
- "severity_estimate": "low" | "medium" | "high" | "critical"
- "confidence": number 0-1`

  return prompt
}

function buildSecondPassPrompt(
  lane: LaneManifestEntry,
  playbook: string,
  seedContent: string,
  semgrepHints: string,
): string {
  let prompt = `You are a security analyst doing a SECOND PASS review of the same files. The orchestrator determined that this lane's seed footprint is large enough that a single pass may not have given every file equal attention.

## Lane Assignment
- **Lane ID:** ${lane.lane_id}
- **Categories:** ${lane.categories.join(', ')}
- **Subsystem scope:** ${lane.subsystem_scope}

## Playbook — How to hunt this category
${playbook}

## Seed Files
Below are the same seed files, again with REAL 1-indexed line numbers. When citing a location in your trace, use these line numbers EXACTLY — do NOT recount or estimate.

${seedContent}
`

  if (semgrepHints) {
    prompt += `
## Semgrep Hints (additive context only)
${semgrepHints}
`
  }

  prompt += `
## Second Pass Instructions
This time, follow a two-step process:
1. **File-by-file scan**: For each seed file above, give a one-line verdict on whether it contains any exploitable vulnerability in this lane's category. If yes, name it briefly. If no, say "clean".
2. **Deep trace**: For any file you flagged in step 1, construct a full entrypoint-to-sink trace as in the first pass.

Only report findings you can trace completely. If you found everything in the first pass, returning an empty findings array is correct.`

  return prompt
}

// ── Orchestrator scope + escalation review (FIX 3) ─────────────────────────

interface OrchestratorReviewResult {
  scopeDecisions: Map<string, boolean>
  escalationPasses: Map<string, boolean>
  escalationReasons: Map<string, string>
}

async function orchestratorCombinedReview(
  client: OpenAI,
  allScopeRequests: Map<string, ScopeRequest[]>,
  escalationLaneData: Array<{
    lane_id: string
    seed_files: string[]
    seed_file_count: number
    seed_bytes_total: number
    phase1_finding_count: number
    escalation_reason: string
  }>,
  archSummary: string,
): Promise<OrchestratorReviewResult> {
  const hasScopeRequests = allScopeRequests.size > 0
  const hasEscalationLanes = escalationLaneData.length > 0

  if (!hasScopeRequests && !hasEscalationLanes) {
    return { scopeDecisions: new Map(), escalationPasses: new Map(), escalationReasons: new Map() }
  }

  const requestsText = hasScopeRequests
    ? Array.from(allScopeRequests.entries())
        .map(([laneId, reqs]) => {
          return `Lane "${laneId}" requests:\n` + reqs.map(r => `  - File: ${r.file}\n    Reason: ${r.reason}`).join('\n')
        }).join('\n\n')
    : '(no scope requests)'

  const escalationText = hasEscalationLanes
    ? escalationLaneData.map(l => {
        return `Lane "${l.lane_id}": ${l.seed_file_count} seed files, ${l.seed_bytes_total.toLocaleString()} bytes, found ${l.phase1_finding_count} findings in Phase 1. Stage 1 escalation reason: ${l.escalation_reason}`
      }).join('\n')
    : '(no escalation lanes to review)'

  const prompt = `You are the scan orchestrator. You have two tasks:

**Task 1: Review scope requests** (files lanes want to look at outside their assigned seed scope)
Architecture summary of the target app:
${archSummary}

Scope requests from lanes:
${requestsText}

For each request, decide APPROVED or DENIED. APPROVE only if:
- The file is directly connected to a trace the lane has already started building
- The file plausibly contains a missing link (middleware, model, etc.)
- The request is narrow and specific

**Task 2: Review escalation-flagged lanes for a second pass**
Some lanes were flagged by the budget governor as having a large seed footprint. For each, decide whether a second full pass over the same seed files is warranted — e.g., because the file count/byte size is large enough that a single pass plausibly didn't give every file equal attention.

Escalation-flagged lanes:
${escalationText}

For each escalation lane, decide APPROVED or DENIED for a second pass. The second pass will explicitly review each file one-by-one.

Respond as a structured JSON object:
{"scope_decisions": [{"lane_id": "...", "file": "...", "approved": true/false, "reason": "..."}], "escalation_passes": [{"lane_id": "...", "approved": true/false, "reason": "..."}]}`

  try {
    const result = await callWithStructuredOutput(client, 'qwen-plus', prompt, ORCHESTRATOR_SCHEMA, 4000)
    if (!result) throw new Error('Structured output returned null')

    const parsed = JSON.parse(result.text)
    const scopeDecisions = new Map<string, boolean>()
    const escalationPasses = new Map<string, boolean>()
    const escalationReasons = new Map<string, string>()

    if (parsed.scope_decisions && Array.isArray(parsed.scope_decisions)) {
      for (const d of parsed.scope_decisions) {
        scopeDecisions.set(`${d.lane_id}::${d.file}`, d.approved === true)
      }
    }
    if (parsed.escalation_passes && Array.isArray(parsed.escalation_passes)) {
      for (const d of parsed.escalation_passes) {
        escalationPasses.set(d.lane_id, d.approved === true)
        escalationReasons.set(d.lane_id, d.reason ?? '')
      }
    }

    return { scopeDecisions, escalationPasses, escalationReasons }
  } catch (err: any) {
    console.error(`  [ERROR] Orchestrator review failed: ${err.message}`)
    const scopeDecisions = new Map<string, boolean>()
    const escalationPasses = new Map<string, boolean>()
    const escalationReasons = new Map<string, string>()
    for (const [laneId, reqs] of allScopeRequests) {
      for (const r of reqs) scopeDecisions.set(`${laneId}::${r.file}`, false)
    }
    return { scopeDecisions, escalationPasses, escalationReasons }
  }
}

// ── Dedup ──────────────────────────────────────────────────────────────────

function deduplicateFindings(findings: CandidateFinding[]): CandidateFinding[] {
  if (findings.length === 0) return findings
  const LINE_SLACK = 15
  const result: CandidateFinding[] = []
  const seen = new Set<string>()
  for (const f of findings) {
    const sink = f.trace[f.trace.length - 1]
    const normalizedKey = `${sink.file}:${Math.floor(sink.line / LINE_SLACK) * LINE_SLACK}`
    if (seen.has(normalizedKey)) {
      const existing = result.find(r => {
        const rSink = r.trace[r.trace.length - 1]
        return rSink.file === sink.file && Math.abs(rSink.line - sink.line) <= LINE_SLACK
      })
      if (existing && f.confidence > existing.confidence) {
        Object.assign(existing, f)
      }
      continue
    }
    seen.add(normalizedKey)
    result.push(f)
  }
  return result
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Stage 2: Hunt Lanes ===')
  console.log()

  const laneManifest: LaneManifestEntry[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'tools/scanner/stage05-lane-selector/output/lane-manifest.json'), 'utf-8')
  )
  const budgetPlan: BudgetPlanEntry[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'tools/scanner/stage1-budget-governor/output/budget-plan.json'), 'utf-8')
  )

  console.log(`Loaded ${laneManifest.length} lanes from manifest`)
  console.log(`Loaded ${budgetPlan.length} budget entries`)

  const budgetMap = new Map(budgetPlan.map(e => [e.lane_id, e]))
  const tracker = new BudgetTracker(budgetPlan)
  const client = createClient()

  // Task D: Semgrep availability
  const semgrepAvailable = await checkSemgrepAvailable()
  console.log(`\nSemgrep available: ${semgrepAvailable}`)

  const semgrepCache = new Map<string, string>()
  if (semgrepAvailable) {
    console.log('\n--- Running Semgrep prefilter for eligible lanes ---')
    for (const lane of laneManifest) {
      if (SEMGREP_CATEGORIES.has(lane.lane_id)) {
        console.log(`  Semgrep on lane: ${lane.lane_id}`)
        const hints = await runSemgrep(lane.seed_files, lane.lane_id)
        semgrepCache.set(lane.lane_id, hints)
      }
    }
  }

  // Phase 1: Initial hunt pass
  console.log('\n--- Phase 1: Initial hunt pass ---')
  const allFindings: CandidateFinding[] = []
  const allScopeRequests = new Map<string, ScopeRequest[]>()
  const phase1FindingCounts = new Map<string, number>()

  for (const lane of laneManifest) {
    if (tracker.isRunStopped()) {
      console.log(`[STOP] Run stopped globally before lane ${lane.lane_id}`)
      break
    }
    const budgetEntry = budgetMap.get(lane.lane_id)
    if (!budgetEntry) {
      console.warn(`  [WARN] No budget entry for lane ${lane.lane_id}, skipping`)
      continue
    }

    console.log(`\n[HUNT] Lane: ${lane.lane_id} (${lane.categories.join(', ')})`)
    console.log(`  Seeds: ${lane.seed_files.length} files, ${budgetEntry.seed_bytes_total.toLocaleString()} bytes`)
    console.log(`  Budget: ${budgetEntry.token_ceiling.toLocaleString()} tokens, ${budgetEntry.wall_clock_ceiling_seconds}s`)
    console.log(`  Escalation flag: ${budgetEntry.escalation_flag ? 'YES' : 'no'}`)

    const hints = semgrepCache.get(lane.lane_id) ?? ''
    const result = await huntLane(client, lane, budgetEntry, tracker, hints)
    allFindings.push(...result.findings)
    phase1FindingCounts.set(lane.lane_id, result.findings.length)
    if (result.scope_requests.length > 0) {
      allScopeRequests.set(lane.lane_id, result.scope_requests)
    }
  }

  console.log(`\nPhase 1 complete: ${allFindings.length} findings`)

  // Phase 2: Combined orchestrator review (scope requests + escalation second passes)
  console.log('\n--- Phase 2: Orchestrator review (scope + escalation) ---')
  const totalScopeRequests = Array.from(allScopeRequests.values()).reduce((s, r) => s + r.length, 0)

  // Collect escalation-flagged lane data
  const escalationLanes = budgetPlan
    .filter(e => e.escalation_flag)
    .map(e => ({
      lane_id: e.lane_id,
      seed_files: laneManifest.find(l => l.lane_id === e.lane_id)?.seed_files ?? [],
      seed_file_count: e.seed_file_count,
      seed_bytes_total: e.seed_bytes_total,
      phase1_finding_count: phase1FindingCounts.get(e.lane_id) ?? 0,
      escalation_reason: e.escalation_reason,
    }))

  console.log(`Scope requests: ${totalScopeRequests} from ${allScopeRequests.size} lanes`)
  console.log(`Escalation-flagged lanes for review: ${escalationLanes.length}`)

  const archSummaryPath = join(REPO_ROOT, 'tools/scanner/stage0-recon/output/architecture-summary.json')
  const archSummary = existsSync(archSummaryPath)
    ? readFileSync(archSummaryPath, 'utf-8')
    : '(architecture summary not available)'

  const review = await orchestratorCombinedReview(client, allScopeRequests, escalationLanes, archSummary)

  // Process scope decisions
  const approvedRequests = new Map<string, string[]>()
  console.log('\nScope decisions:')
  for (const [laneId, reqs] of allScopeRequests) {
    const approved: string[] = []
    for (const r of reqs) {
      const key = `${laneId}::${r.file}`
      const isApproved = review.scopeDecisions.get(key) ?? false
      console.log(`  ${laneId} -> ${r.file}: ${isApproved ? 'APPROVED' : 'DENIED'}`)
      if (isApproved) approved.push(r.file)
    }
    if (approved.length > 0) approvedRequests.set(laneId, approved)
  }
  if (allScopeRequests.size === 0) console.log('  (no scope requests)')

  // Process escalation second-pass decisions
  const approvedEscalationPasses = new Set<string>()
  const escalationReasons = new Map<string, string>()
  console.log('\nEscalation second-pass decisions:')
  for (const lane of escalationLanes) {
    const approved = review.escalationPasses.get(lane.lane_id) ?? false
    const reason = review.escalationReasons.get(lane.lane_id) ?? ''
    console.log(`  ${lane.lane_id}: ${approved ? 'APPROVED' : 'DENIED'} — ${reason}`)
    if (approved) {
      approvedEscalationPasses.add(lane.lane_id)
      escalationReasons.set(lane.lane_id, reason)
    }
  }

  // Phase 3: Approved re-runs (scope expansions + escalation second passes)
  console.log('\n--- Phase 3: Approved re-runs ---')
  const phase3Findings: CandidateFinding[] = []

  // 3a: Scope expansion re-runs
  for (const [laneId, extraFiles] of approvedRequests) {
    if (tracker.isRunStopped()) {
      console.log(`[STOP] Run stopped before expanded hunt for ${laneId}`)
      break
    }
    const lane = laneManifest.find(l => l.lane_id === laneId)
    const budgetEntry = budgetMap.get(laneId)
    if (!lane || !budgetEntry) continue

    const snap = trackerGetLaneTotals(tracker, laneId)
    if (snap.tokens >= budgetEntry.token_ceiling) {
      console.log(`  [BUDGET] Lane ${laneId} already at ceiling — skipping expanded hunt`)
      continue
    }

    console.log(`  [EXPAND] Lane ${laneId}: adding ${extraFiles.length} files`)
    const expandedSeeds = readSeedFiles(lane.seed_files)
    for (const f of extraFiles) {
      const full = join(REPO_ROOT, f)
      if (existsSync(full)) expandedSeeds[f] = readFileSync(full, 'utf-8')
    }

    const hints = semgrepCache.get(laneId) ?? ''
    const result = await huntLane(client, lane, budgetEntry, tracker, hints, expandedSeeds)
    phase3Findings.push(...result.findings)
  }

  // 3b: Escalation second-pass re-runs (FIX 3)
  for (const laneId of approvedEscalationPasses) {
    if (tracker.isRunStopped()) {
      console.log(`[STOP] Run stopped before escalation second pass for ${laneId}`)
      break
    }
    const lane = laneManifest.find(l => l.lane_id === laneId)
    const budgetEntry = budgetMap.get(laneId)
    if (!lane || !budgetEntry) continue

    // FIX 3: Budget gate before second pass
    const snap = trackerGetLaneTotals(tracker, laneId)
    if (snap.tokens >= budgetEntry.token_ceiling) {
      console.log(`  [BUDGET] Lane ${laneId} already at ceiling (${snap.tokens.toLocaleString()}/${budgetEntry.token_ceiling.toLocaleString()}) — skipping second pass`)
      continue
    }

    console.log(`  [2ND PASS] Lane ${laneId}: re-reviewing ${lane.seed_files.length} seed files (${escalationReasons.get(laneId)})`)
    const hints = semgrepCache.get(laneId) ?? ''
    const result = await huntLane(client, lane, budgetEntry, tracker, hints, undefined, true)
    phase3Findings.push(...result.findings)
  }

  // Deduplicate and write outputs
  const allConsolidated = [...allFindings, ...phase3Findings]
  const deduplicated = deduplicateFindings(allConsolidated)

  const outDir = join(__dirname, '..', 'output')
  mkdirSync(outDir, { recursive: true })

  writeFileSync(join(outDir, 'candidate-findings.json'), JSON.stringify(deduplicated, null, 2) + '\n')

  const consumptionReport: BudgetConsumption[] = budgetPlan.map(entry => {
    const snap = trackerGetLaneTotals(tracker, entry.lane_id)
    return {
      lane_id: entry.lane_id,
      tokens_used: snap.tokens,
      seconds_elapsed: snap.seconds,
      ceiling_hit: snap.tokens >= entry.token_ceiling || snap.seconds >= entry.wall_clock_ceiling_seconds,
    }
  })
  writeFileSync(join(outDir, 'budget-consumption.json'), JSON.stringify(consumptionReport, null, 2) + '\n')

  console.log('\n=== Stage 2 Complete ===')
  console.log(`Total candidate findings: ${deduplicated.length}`)
  console.log(`  Phase 1: ${allFindings.length}`)
  console.log(`  Phase 3 (re-runs): ${phase3Findings.length}`)
  console.log(`  After dedup: ${deduplicated.length}`)
  console.log(`Scope requests: ${totalScopeRequests} total, ${approvedRequests.size} lanes with approved expansions`)
  console.log(`Escalation second passes: ${approvedEscalationPasses.size} approved of ${escalationLanes.length} reviewed`)
  console.log(`Output: ${join(outDir, 'candidate-findings.json')}`)
  console.log(`Output: ${join(outDir, 'budget-consumption.json')}`)
}

function trackerGetLaneTotals(
  tracker: BudgetTracker,
  laneId: string,
): { tokens: number; seconds: number } {
  const t = tracker as any
  const tokensMap: Map<string, number> | undefined = t.laneTokens
  const secondsMap: Map<string, number> | undefined = t.laneSeconds
  return {
    tokens: tokensMap?.get(laneId) ?? 0,
    seconds: secondsMap?.get(laneId) ?? 0,
  }
}

main().catch(err => {
  console.error('Stage 2 failed:', err)
  process.exit(1)
})
