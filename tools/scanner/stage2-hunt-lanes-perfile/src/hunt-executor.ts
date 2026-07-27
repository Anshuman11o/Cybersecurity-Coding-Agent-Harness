/**
 * Stage 2 — Hunt Lanes (Per-File v2) executor.
 *
 * Iterates lane assignments from the new Stage 0.5. For each entry,
 * spawns one lane bound to exactly ONE target file, instructed to hunt
 * ONLY the categories that the assignment names for that file.
 *
 * Key differences from v1:
 * - One lane per file, not one lane per category theme
 * - Only assigned category playbooks included (not the whole library)
 * - Full file coverage via chunking; no silent truncation
 * - Line numbers are REAL file line numbers in every chunk
 * - Per-finding categories: model names the class actually found
 * - Budget tracking is measurement-only (no enforcement, no cutoff)
 * - **Bounded concurrency**: lanes run in parallel up to a configurable
 *   ceiling (default 8, env HUNT_CONCURRENCY). Each lane is isolated
 *   with its own error boundary so one failure does not abort the pool.
 *
 * Outputs: output/candidate-findings.json, output/budget-consumption.json
 *
 * Checkpointing: after EACH lane completes, results are written to disk
 * immediately. On startup, existing partial results are detected and the
 * run RESUMES from where it stopped, skipping already-completed lanes.
 * Partial files are always valid, parseable JSON.
 */
import OpenAI from 'openai'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient, extractJson } from './llm-client.js'
import type {
  LaneAssignmentEntry,
  LaneAssignments,
  CategoryRef,
  ChunkSpec,
  CandidateFinding,
  LaneHuntResponse,
  BudgetConsumption,
  VulnClassRegistry,
  FindingClassRef,
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../..')

// ── Constant: single-pass line budget ─────────────────────────────────────
export const SINGLE_PASS_LINE_BUDGET = 2000

// ── Bounded concurrency ───────────────────────────────────────────────────
// Cap on how many lanes run concurrently.  Default 8; override via env var
// HUNT_CONCURRENCY.  Running too many simultaneous calls against the same
// upstream endpoint increases 429 risk — keep this modest.
const DEFAULT_MAX_CONCURRENT_LANES = 8
const MAX_CONCURRENT_LANES = (() => {
  const env = process.env.HUNT_CONCURRENCY
  if (env) {
    const n = parseInt(env, 10)
    if (Number.isFinite(n) && n > 0) return n
    console.warn(`  [WARN] HUNT_CONCURRENCY=${env} not a positive integer, using default ${DEFAULT_MAX_CONCURRENT_LANES}`)
  }
  return DEFAULT_MAX_CONCURRENT_LANES
})()

class Semaphore {
  private permits: number
  private queue: (() => void)[] = []

  constructor(max: number) {
    this.permits = max
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    return new Promise(resolve => this.queue.push(resolve))
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    } else {
      this.permits++
    }
  }
}

// ── Vulnerability class registry ─────────────────────────────────────────

const SHARED_DIR = join(REPO_ROOT, 'tools/scanner/shared')

let registry: VulnClassRegistry | null = null
let codeToClass: Record<string, string> = {}

function loadRegistry(): VulnClassRegistry {
  if (registry) return registry
  const raw = readFileSync(join(SHARED_DIR, 'vuln-classes.json'), 'utf-8')
  registry = JSON.parse(raw) as VulnClassRegistry

  // Build reverse index: code → classId
  for (const [classId, entry] of Object.entries(registry)) {
    for (const code of entry.codes) {
      codeToClass[code] = classId
    }
  }

  return registry
}

/** Given a list of CategoryRef codes, return the deduplicated set of class ids. */
function codesToClasses(codes: string[]): string[] {
  const classSet = new Set<string>()
  for (const code of codes) {
    const classId = codeToClass[code]
    if (classId) classSet.add(classId)
  }
  return [...classSet]
}

// ── Structured output schema (per-lane, built dynamically) ──────────────

function buildHuntSchema(classIds: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            finding_classes: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  class: { type: 'string', enum: classIds },
                  justified_by_step: { type: 'integer' },
                },
                required: ['class', 'justified_by_step'],
              },
            },
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
          required: ['finding_classes', 'title', 'description', 'trace', 'severity_estimate', 'confidence'],
        },
      },
    },
    required: ['findings'],
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

let findingCounter = 0
function nextFindingId(): string {
  findingCounter++
  return `FIND-${String(findingCounter).padStart(4, '0')}`
}

function sanitizePemPrivateKey(content: string): string {
  return content.replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    (_match, beginMarker, endMarker) => {
      return beginMarker + '\n[REDACTED: private key material]\n' + endMarker
    }
  )
}

function lineNumberContent(content: string, startLine: number): string {
  const lines = content.split('\n')
  const totalLines = startLine + lines.length - 1
  const pad = String(totalLines).length
  return lines.map((line, i) => {
    const lineNum = startLine + i
    return `${String(lineNum).padStart(pad)}: ${line}`
  }).join('\n')
}

// ── Playbook loading and validation ───────────────────────────────────────

async function loadPlaybooksForClasses(classIds: string[]): Promise<Map<string, string>> {
  const loaded = new Map<string, string>()
  for (const classId of classIds) {
    const entry = registry![classId]
    if (!entry) continue
    const modName = entry.playbook
    if (loaded.has(modName)) continue
    const mod = await import(`./playbooks/${modName}.js`)
    loaded.set(modName, (mod as { playbook: string }).playbook)
  }
  return loaded
}

async function validateAllPlaybooks(): Promise<void> {
  loadRegistry()  // ensures registry and codeToClass are populated

  const reg = registry!

  // 1. Every class resolves to a loadable playbook module
  const loadErrors = new Map<string, string>()
  for (const [classId, entry] of Object.entries(reg)) {
    try {
      await import(`./playbooks/${entry.playbook}.js`)
    } catch (err: any) {
      loadErrors.set(classId, err.message)
    }
  }

  // 2. All 26 codes covered exactly once
  const allCodes = Object.values(reg).flatMap(e => e.codes)
  const codeCounts = new Map<string, number>()
  for (const code of allCodes) {
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1)
  }
  const duplicatedCodes = [...codeCounts.entries()].filter(([, c]) => c > 1).map(([c]) => c)
  const missingCodes = (() => {
    const expected = new Set([
      'A01','A02','A03','A04','A05','A06','A07','A08','A09','A10',
      'API1','API2','API3','API4','API5','API6','API7','API8','API9','API10',
      'LLM01','LLM02','LLM03','LLM05','LLM06','LLM10',
    ])
    return [...expected].filter(c => !codeCounts.has(c))
  })()

  // 3. No two classes share a playbook
  const playbookToClasses = new Map<string, string[]>()
  for (const [classId, entry] of Object.entries(reg)) {
    const existing = playbookToClasses.get(entry.playbook) ?? []
    existing.push(classId)
    playbookToClasses.set(entry.playbook, existing)
  }
  const sharedPlaybooks = [...playbookToClasses.entries()].filter(([, classes]) => classes.length > 1)

  if (loadErrors.size > 0 || duplicatedCodes.length > 0 || missingCodes.length > 0 || sharedPlaybooks.length > 0) {
    console.error('\n=== PLAYBOOK VALIDATION FAILED ===')
    if (loadErrors.size > 0) {
      console.error(`Unloadable playbook modules (${loadErrors.size}):`)
      for (const [classId, msg] of loadErrors) {
        console.error(`  - ${classId} → ${msg}`)
      }
    }
    if (duplicatedCodes.length > 0) {
      console.error(`Codes appearing in more than one class: ${duplicatedCodes.join(', ')}`)
    }
    if (missingCodes.length > 0) {
      console.error(`Codes not covered by any class: ${missingCodes.join(', ')}`)
    }
    if (sharedPlaybooks.length > 0) {
      console.error(`Playbook modules shared by multiple classes:`)
      for (const [mod, classes] of sharedPlaybooks) {
        console.error(`  - ${mod}: ${classes.join(', ')}`)
      }
    }
    console.error('\nFix the issues above before running.')
    console.error('=== END VALIDATION FAILURE ===\n')
    process.exit(1)
  }

  const numClasses = Object.keys(reg).length
  const numCodes = allCodes.length
  const numPlaybooks = new Set(Object.values(reg).map(e => e.playbook)).size
  console.log(`All ${numPlaybooks} playbook modules validated across ${numClasses} classes (covering all ${numCodes} category codes)`)
}

// ── Prompt assembly ───────────────────────────────────────────────────────

function buildHuntPrompt(
  targetFile: string,
  lineNumberedContent: string,
  classes: string[],
  playbooks: Map<string, string>,
  chunkInfo: { chunkIndex: number; totalChunks: number },
  archSummarySnippet?: string,
): string {
  const classList = classes.join(', ')

  let prompt = `You are a security analyst hunting for vulnerabilities in a single source file.

## Target File
File: ${targetFile}
`

  if (chunkInfo.totalChunks > 1) {
    prompt += `Chunk ${chunkInfo.chunkIndex} of ${chunkInfo.totalChunks}. Analyze ALL lines shown below — do not skip any.
`
  }

  prompt += `
## Assigned Classes
You are hunting ONLY for these vulnerability classes in this file: ${classList}.
Do NOT look for vulnerability classes outside this list.

## Playbook Guidance — How to detect each assigned class
Below is the technical guidance for the vulnerability classes you are hunting. This guidance explains what these vulnerability classes look like in general — what shapes of code create them, what to trace, what distinguishes a real instance from a false positive. It does NOT describe this particular codebase.
`

  for (const [modName, playbookText] of playbooks) {
    prompt += `\n### Playbook: ${modName}\n${playbookText}`
  }

  if (archSummarySnippet) {
    prompt += `
## Architecture Context
The following is a summary of the target application's architecture. Use it to understand the application's structure, routing, and data flow — not to limit your search.
${archSummarySnippet}
`
  }

  prompt += `
## Target File Content
Every line is prefixed with its REAL 1-indexed line number from the original source file. When citing a location in your trace, use these line numbers EXACTLY.

\`\`\`
${lineNumberedContent}
\`\`\`

## Output Format
Respond with a structured JSON object containing a "findings" array. Only include findings where you can construct a complete entrypoint-to-sink trace. If you find nothing exploitable, return an empty array — being conservative is correct.

List every class this finding genuinely belongs to. A single line can legitimately be more than one class — a render sink reached by attacker-controlled data is both an injection and a client-side finding. Only list a second class if the **same trace** establishes it; if a second class would need a different entrypoint or a different sink, it is a separate finding, not a second label. For each class you list, give the index of the trace step that establishes it.

Each finding must have:
- "finding_classes": array of { "class": one of the class ids from your assigned classes list above, "justified_by_step": 0-based index into this finding's trace array }
- "title": concise vulnerability title
- "description": what the vulnerability is, how it works, and why it is exploitable
- "trace": array of {kind: "entrypoint"|"propagation"|"sink", file: "${targetFile}", line: NUMBER (use the line numbers shown above), description: string}. First step MUST be entrypoint, last MUST be sink.
- "severity_estimate": "low" | "medium" | "high" | "critical"
- "confidence": number 0-1`

  return prompt
}

// ── LLM call with token tracking and retry ────────────────────────────────

interface LlmCallResult {
  text: string
  tokensUsed: number
}

/**
 * Return true if the error looks transient and worth retrying:
 * rate-limit (429), gateway timeouts (502/503/504), network ECONNRESET, etc.
 */
function isTransientError(err: any): boolean {
  const msg = String(err.message ?? '').toLowerCase()
  const status = err.status ?? err.statusCode ?? err.response?.status
  if (status === 429 || status === 502 || status === 503 || status === 504) return true
  if (msg.includes('rate limit')) return true
  if (msg.includes('econnreset')) return true
  if (msg.includes('etimedout')) return true
  if (msg.includes('timeout')) return true
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callLlm(
  client: OpenAI,
  prompt: string,
  schema: Record<string, unknown>,
  laneId: string,
): Promise<LlmCallResult | null> {
  const maxRetries = 3
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: 'qwen-plus',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 8000,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'hunt_output',
            schema: schema,
            strict: true,
          },
        },
      })
      const text = response.choices[0]?.message?.content
      if (!text) return null
      return { text, tokensUsed: response.usage?.total_tokens ?? 0 }
    } catch (err: any) {
      const isSchema = err.message?.includes('json_schema') || err.message?.includes('strict') || err.message?.includes('response_format')
      if (isSchema) {
        try {
          const response = await client.chat.completions.create({
            model: 'qwen-plus',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 8000,
            response_format: { type: 'json_object' },
          })
          const text = response.choices[0]?.message?.content
          if (!text) return null
          return { text, tokensUsed: response.usage?.total_tokens ?? 0 }
        } catch (err2: any) {
          console.error(`  [${laneId}] [ERROR] json_schema + fallback both failed: ${err2.message}`)
          return null
        }
      }
      if (isTransientError(err) && attempt < maxRetries) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 15000)
        const jitter = Math.random() * 1000
        const wait = Math.round(backoff + jitter)
        console.log(`  [${laneId}] [RETRY] Transient error (attempt ${attempt + 1}/${maxRetries}), backing off ${wait}ms: ${err.message ?? err}`)
        await sleep(wait)
        continue
      }
      throw err
    }
  }
  return null
}

// ── Hunt a single lane (one file, possibly multiple chunks) ───────────────

/**
 * Build the union of OWASP codes from a list of finding classes,
 * deduplicated and order-stable (sorted by first appearance).
 */
function unionCodesForClasses(classes: FindingClassRef[], reg: VulnClassRegistry): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const fc of classes) {
    const entry = reg[fc.class]
    if (!entry) continue
    for (const code of entry.codes) {
      if (!seen.has(code)) {
        seen.add(code)
        result.push(code)
      }
    }
  }
  return result
}

async function huntLane(
  client: OpenAI,
  lane: LaneAssignmentEntry,
  targetDir: string,
  classIds: string[],
  playbooks: Map<string, string>,
  archSummarySnippet?: string,
): Promise<{ findings: CandidateFinding[]; tokensUsed: number }> {
  const targetPath = join(targetDir, lane.target_file)
  if (!existsSync(targetPath)) {
    console.error(`  [${lane.lane_id}] [ERROR] Target file not found: ${targetPath}`)
    return { findings: [], tokensUsed: 0 }
  }

  const rawContent = readFileSync(targetPath, 'utf-8')
  const sanitized = sanitizePemPrivateKey(rawContent)

  const allFindings: CandidateFinding[] = []
  let totalTokens = 0

  const chunks = lane.chunk_plan.chunks
  if (chunks.length === 0 && lane.disposition === 'hunt') {
    console.warn(`  [${lane.lane_id}] [WARN] No chunks but disposition is "hunt"`)
    return { findings: [], tokensUsed: 0 }
  }

  const schema = buildHuntSchema(classIds)

  for (const chunk of chunks) {
    const allLines = sanitized.split('\n')
    const chunkLines = allLines.slice(chunk.start_line - 1, chunk.end_line)
    const chunkContent = chunkLines.join('\n')

    const lineNumbered = lineNumberContent(chunkContent, chunk.start_line)

    const prompt = buildHuntPrompt(
      lane.target_file,
      lineNumbered,
      classIds,
      playbooks,
      { chunkIndex: chunk.index, totalChunks: lane.chunk_plan.total_chunks },
      archSummarySnippet,
    )

    const t0 = Date.now()
    const result = await callLlm(client, prompt, schema, lane.lane_id)
    const elapsed = (Date.now() - t0) / 1000

    if (!result) {
      console.error(`  [${lane.lane_id}] [ERROR] chunk ${chunk.index} LLM call failed`)
      continue
    }

    totalTokens += result.tokensUsed
    console.log(`  [${lane.lane_id}] chunk ${chunk.index}: ${result.tokensUsed.toLocaleString()} tokens, ${elapsed.toFixed(1)}s`)

    let parsed: LaneHuntResponse
    try {
      const jsonStr = extractJson(result.text)
      parsed = JSON.parse(jsonStr) as LaneHuntResponse
    } catch {
      console.log(`  [${lane.lane_id}] [WARN] chunk ${chunk.index} returned unparseable content`)
      continue
    }

    if (parsed.findings && Array.isArray(parsed.findings)) {
      for (const f of parsed.findings) {
        if (!f.trace || !Array.isArray(f.trace) || f.trace.length === 0) {
          console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" has empty trace — dropping`)
          continue
        }
        if (f.trace[0].kind !== 'entrypoint') {
          console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" trace doesn't start with entrypoint — dropping`)
          continue
        }
        if (f.trace[f.trace.length - 1].kind !== 'sink') {
          console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" trace doesn't end with sink — dropping`)
          continue
        }

        // Validate and normalize finding_classes
        const rawClasses = (f as any).finding_classes
        if (!rawClasses || !Array.isArray(rawClasses) || rawClasses.length === 0) {
          console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" has empty or missing finding_classes — dropping`)
          continue
        }

        // Filter to only classes that are in this lane's assigned set
        const assignedClassSet = new Set(classIds)
        const validFindingClasses: FindingClassRef[] = []
        for (const fc of rawClasses) {
          if (!assignedClassSet.has(fc.class)) {
            console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" has off-list class "${fc.class}" — skipping that class`)
            continue
          }
          // Validate justified_by_step is within trace range
          const stepIdx = fc.justified_by_step
          if (typeof stepIdx !== 'number' || stepIdx < 0 || stepIdx >= f.trace.length) {
            console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" class "${fc.class}" justified_by_step=${stepIdx} out of range (trace length ${f.trace.length}) — clamping to 0`)
            validFindingClasses.push({ class: fc.class, justified_by_step: 0 })
          } else {
            validFindingClasses.push({ class: fc.class, justified_by_step: stepIdx })
          }
        }

        if (validFindingClasses.length === 0) {
          console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" has no valid finding_classes after filtering — dropping`)
          continue
        }

        // Expand to OWASP code strings
        const categories = unionCodesForClasses(validFindingClasses, registry!)

        // Runtime assertion: every emitted finding must have at least one code
        if (categories.length === 0) {
          console.error(`  [${lane.lane_id}] [FATAL] Finding "${f.title}" has empty categories after class expansion — this is a bug`)
          process.exit(1)
        }

        const finding: CandidateFinding = {
          finding_id: nextFindingId(),
          lane_id: lane.lane_id,
          finding_classes: validFindingClasses,
          categories: categories,
          title: f.title,
          description: f.description,
          trace: f.trace,
          severity_estimate: f.severity_estimate,
          confidence: f.confidence,
        }
        allFindings.push(finding)
      }
    }
  }

  return { findings: allFindings, tokensUsed: totalTokens }
}

// ── Load architecture summary (optional context) ──────────────────────────

function loadArchSummarySnippet(archPath: string): string | undefined {
  if (!existsSync(archPath)) return undefined
  try {
    const summary = JSON.parse(readFileSync(archPath, 'utf-8'))
    const snippets: string[] = []
    if (summary.route_table) {
      const rt = summary.route_table
      const handWritten = rt.hand_written_routes?.length ?? 0
      const autoGenerated = rt.auto_generated_routes?.length ?? 0
      snippets.push(`Routes: ${handWritten} hand-written, ${autoGenerated} auto-generated`)
      if (rt.hand_written_routes) {
        const routeSummaries = rt.hand_written_routes.slice(0, 20).map((r: any) =>
          `  ${r.method} ${r.path} → ${r.handler} (${r.file})`
        ).join('\n')
        snippets.push(`Hand-written routes (sample):\n${routeSummaries}`)
      }
    }
    if (summary.subsystems) {
      snippets.push(`Subsystems: ${Object.keys(summary.subsystems).join(', ')}`)
    }
    if (summary.data_models) {
      snippets.push(`Data models: ${Object.keys(summary.data_models).join(', ')}`)
    }
    return snippets.join('\n')
  } catch {
    return undefined
  }
}

// ── Checkpoint helpers ────────────────────────────────────────────────────

/**
 * Write findings and consumption reports atomically.
 * Writes to a temp file first, then renames — so a reader (or a crash)
 * never sees a truncated JSON file.
 */
function writeCheckpoint(
  outDir: string,
  findings: CandidateFinding[],
  consumption: BudgetConsumption[],
): void {
  const findingsPath = join(outDir, 'candidate-findings.json')
  const consumptionPath = join(outDir, 'budget-consumption.json')

  const findingsTmp = findingsPath + '.tmp'
  writeFileSync(findingsTmp, JSON.stringify(findings, null, 2) + '\n')
  renameSync(findingsTmp, findingsPath)

  const consumptionTmp = consumptionPath + '.tmp'
  writeFileSync(consumptionTmp, JSON.stringify(consumption, null, 2) + '\n')
  renameSync(consumptionTmp, consumptionPath)
}

/**
 * Load an existing checkpoint from the output directory.
 * Returns { findings, consumption, completedLaneIds } if a valid checkpoint
 * exists, or null if there is nothing to resume from.
 */
function loadCheckpoint(outDir: string): {
  findings: CandidateFinding[]
  consumption: BudgetConsumption[]
  completedLaneIds: Set<string>
} | null {
  const findingsPath = join(outDir, 'candidate-findings.json')
  const consumptionPath = join(outDir, 'budget-consumption.json')

  if (!existsSync(findingsPath) || !existsSync(consumptionPath)) {
    return null
  }

  try {
    const findings: CandidateFinding[] = JSON.parse(readFileSync(findingsPath, 'utf-8'))
    const consumption: BudgetConsumption[] = JSON.parse(readFileSync(consumptionPath, 'utf-8'))

    if (!Array.isArray(findings) || !Array.isArray(consumption)) {
      return null
    }

    const completedLaneIds = new Set(consumption.map(c => c.lane_id))
    return { findings, consumption, completedLaneIds }
  } catch {
    return null
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Stage 2 (Per-File v2): Hunt Lanes ===')
  console.log()

  await validateAllPlaybooks()
  console.log()

  const assignmentsPath = join(REPO_ROOT, 'tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json')
  if (!existsSync(assignmentsPath)) {
    console.error(`ERROR: Lane assignments not found at ${assignmentsPath}`)
    console.error('Has Stage 0.5 (per-file) run yet?')
    process.exit(1)
  }

  const assignments: LaneAssignments = JSON.parse(readFileSync(assignmentsPath, 'utf-8'))
  console.log(`Loaded ${assignments.lanes.length} lane assignments`)
  console.log(`Target directory: ${assignments.target_dir}`)

  const ledger = assignments.coverage_ledger
  if (ledger.unaccounted !== 0) {
    console.error(`ERROR: Coverage ledger has ${ledger.unaccounted} unaccounted files — MUST be 0`)
    process.exit(1)
  }
  const expectedTotal = ledger.assigned_hunt + ledger.assigned_skip
  if (ledger.total_files_in_inventory !== expectedTotal) {
    console.error(`ERROR: Ledger mismatch: ${ledger.total_files_in_inventory} != ${ledger.assigned_hunt} + ${ledger.assigned_skip}`)
    process.exit(1)
  }

  for (const lane of assignments.lanes) {
    if (lane.disposition === 'skip') continue
    const chunks = lane.chunk_plan.chunks
    if (chunks.length === 0) {
      console.error(`ERROR: Lane ${lane.lane_id} is "hunt" but has no chunks`)
      process.exit(1)
    }
    if (chunks[0].start_line !== 1) {
      console.error(`ERROR: Lane ${lane.lane_id} first chunk starts at line ${chunks[0].start_line}, expected 1`)
      process.exit(1)
    }
    const lastChunk = chunks[chunks.length - 1]
    if (lastChunk.end_line !== lane.file_lines) {
      console.error(`ERROR: Lane ${lane.lane_id} last chunk ends at line ${lastChunk.end_line}, expected ${lane.file_lines}`)
      process.exit(1)
    }
  }

  let huntLanes = assignments.lanes.filter(l => l.disposition === 'hunt')
  const skipLanes = assignments.lanes.filter(l => l.disposition === 'skip')
  console.log(`Hunt lanes: ${huntLanes.length}, Skip lanes: ${skipLanes.length}`)

  for (const lane of skipLanes) {
    console.log(`  [SKIP] ${lane.lane_id}: ${lane.target_file} — ${lane.skip_reason}`)
  }

  const archPath = join(REPO_ROOT, assignments.source_stage0_run)
  const archSnippet = loadArchSummarySnippet(archPath)
  if (archSnippet) {
    console.log('\nArchitecture summary loaded (context for lanes)')
  }

  const client = createClient()

  const outDir = join(__dirname, '..', 'output')
  mkdirSync(outDir, { recursive: true })

  // ── Checkpoint resume ───────────────────────────────────────────────────
  let allFindings: CandidateFinding[] = []
  const consumptionReport: BudgetConsumption[] = []

  const checkpoint = loadCheckpoint(outDir)
  if (checkpoint) {
    allFindings = checkpoint.findings
    consumptionReport.push(...checkpoint.consumption)
    const maxId = allFindings.reduce((max, f) => {
      const num = parseInt(f.finding_id.split('-')[1], 10)
      return num > max ? num : max
    }, 0)
    findingCounter = maxId

    const beforeCount = huntLanes.length
    huntLanes = huntLanes.filter(l => !checkpoint.completedLaneIds.has(l.lane_id))
    console.log(`\n[RESUME] Found checkpoint: ${checkpoint.findings.length} findings, ${checkpoint.completedLaneIds.size} lanes done`)
    console.log(`[RESUME] Skipping ${beforeCount - huntLanes.length} completed lanes, ${huntLanes.length} lanes remaining`)
  }

  console.log(`\n[CONCURRENCY] Running up to ${MAX_CONCURRENT_LANES} lanes in parallel`)

  // ── Bounded concurrency executor ────────────────────────────────────────
  const sem = new Semaphore(MAX_CONCURRENT_LANES)
  const lanePromises: Promise<void>[] = []

  for (const lane of huntLanes) {
    const p = (async () => {
      await sem.acquire()
      try {
        const assignedCodes = lane.categories.map(c => c.code)
        const laneClasses = codesToClasses(assignedCodes)
        console.log(`\n[HUNT] Lane: ${lane.lane_id} | File: ${lane.target_file} | Classes: ${laneClasses.join(', ')}`)
        console.log(`  [${lane.lane_id}] ${lane.file_lines} lines, ${lane.file_bytes.toLocaleString()} bytes`)
        console.log(`  [${lane.lane_id}] Chunk plan: ${lane.chunk_plan.required ? lane.chunk_plan.total_chunks + ' chunks' : 'single pass'}`)

        const playbooks = await loadPlaybooksForClasses(laneClasses)
        console.log(`  [${lane.lane_id}] Loaded ${playbooks.size} playbook module(s): ${Array.from(playbooks.keys()).join(', ')}`)

        const t0 = Date.now()
        const result = await huntLane(client, lane, assignments.target_dir, laneClasses, playbooks, archSnippet)
        const elapsed = (Date.now() - t0) / 1000

        allFindings.push(...result.findings)

        consumptionReport.push({
          lane_id: lane.lane_id,
          tokens_used: result.tokensUsed,
          seconds_elapsed: elapsed,
          ceiling_hit: false,
        })

        console.log(`  [${lane.lane_id}] → ${result.findings.length} finding(s), ${result.tokensUsed.toLocaleString()} tokens, ${elapsed.toFixed(1)}s total`)

        // ── Checkpoint: write results immediately after each lane ─────────
        writeCheckpoint(outDir, allFindings, consumptionReport)
      } catch (err: any) {
        console.error(`  [${lane.lane_id}] [FATAL] Lane failed: ${err.message ?? err}`)
        consumptionReport.push({
          lane_id: lane.lane_id,
          tokens_used: 0,
          seconds_elapsed: 0,
          ceiling_hit: false,
        })
        writeCheckpoint(outDir, allFindings, consumptionReport)
      } finally {
        sem.release()
      }
    })()
    lanePromises.push(p)
  }

  await Promise.all(lanePromises)

  // Also report skip lanes with zero consumption
  for (const lane of skipLanes) {
    consumptionReport.push({
      lane_id: lane.lane_id,
      tokens_used: 0,
      seconds_elapsed: 0,
      ceiling_hit: false,
    })
  }

  // Final write (includes skip lanes in consumption)
  writeCheckpoint(outDir, allFindings, consumptionReport)

  console.log('\n=== Stage 2 (Per-File v2) Complete ===')
  console.log(`Total candidate findings: ${allFindings.length}`)
  console.log(`Lanes processed: ${huntLanes.length} hunt, ${skipLanes.length} skip`)
  console.log(`Total tokens: ${consumptionReport.reduce((s, r) => s + r.tokens_used, 0).toLocaleString()}`)
  console.log(`Output: ${join(outDir, 'candidate-findings.json')}`)
  console.log(`Output: ${join(outDir, 'budget-consumption.json')}`)
}

main().catch(err => {
  console.error('Stage 2 (Per-File v2) failed:', err)
  process.exit(1)
})
