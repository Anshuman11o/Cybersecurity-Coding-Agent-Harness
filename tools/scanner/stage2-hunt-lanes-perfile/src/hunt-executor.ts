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
 *
 * Outputs: output/candidate-findings.json, output/budget-consumption.json
 */
import OpenAI from 'openai'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
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
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../..')

// ── Constant: single-pass line budget ─────────────────────────────────────
// Files up to this many lines fit in one LLM pass. Beyond this, the Stage 0.5
// component splits them into overlapping chunks. This constant is here for
// validation; the actual chunk plan comes from the lane-assignments input.
export const SINGLE_PASS_LINE_BUDGET = 2000

// ── Category code → playbook module mapping ───────────────────────────────
// Maps each OWASP category code to the playbook module(s) that cover it.
// Multiple codes may map to the same module (e.g., A02 and A07 both use
// crypto-auth). When a lane has multiple categories, we deduplicate modules.
//
// IMPORTANT: This mapping must stay in sync with the playbooks/ directory.
// When adding a new playbook, register its codes here.
const CATEGORY_CODE_TO_PLAYBOOKS: Record<string, string[]> = {
  'A01': ['access-control'],
  'A02': ['crypto-auth'],
  'A03': ['injection'],
  'A04': ['insecure-design'],
  'A05': ['misconfiguration'],
  'A06': ['vulnerable-components'],
  'A07': ['crypto-auth'],
  'A08': ['integrity-failures'],
  'A09': ['logging-monitoring'],
  'A10': ['ssrf'],
  'API1': ['access-control'],
  'API2': ['crypto-auth'],
  'API3': ['api-property-auth'],
  'API4': ['resource-consumption'],
  'API5': ['access-control'],
  'API6': ['sensitive-business-flows'],
  'API7': ['ssrf-api'],
  'API8': ['misconfiguration'],
  'API9': ['misconfiguration'],
  'API10': ['general-catchall'],
  'LLM01': ['ai-llm-agency'],
  'LLM02': ['ai-llm-agency'],
  'LLM03': ['ai-llm-agency'],
  'LLM05': ['client-side'],
  'LLM06': ['ai-llm-agency'],
  'LLM10': ['ai-llm-agency'],
}

// ── Structured output schema ──────────────────────────────────────────────

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
          finding_category: {
            type: 'string',
            description: 'The specific vulnerability class code (e.g., A03, A05) from your assigned categories that this finding belongs to.',
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
        required: ['finding_category', 'title', 'description', 'trace', 'severity_estimate', 'confidence'],
      },
    },
  },
  required: ['findings'],
}

// ── Helpers ───────────────────────────────────────────────────────────────

let findingCounter = 0
function nextFindingId(): string {
  findingCounter++
  return `FIND-${String(findingCounter).padStart(4, '0')}`
}

/**
 * Sanitize PEM-formatted private-key material to avoid upstream content-safety
 * filters that flag long base64 blobs inside BEGIN/END PRIVATE KEY markers.
 * Structural markers are preserved so the model can still identify hardcoded
 * keys as misconfiguration findings.
 */
function sanitizePemPrivateKey(content: string): string {
  return content.replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    (_match, beginMarker, endMarker) => {
      return beginMarker + '\n[REDACTED: private key material]\n' + endMarker
    }
  )
}

/**
 * Prefix every line with its REAL 1-indexed line number.
 * The offset parameter lets us number lines that start at line N > 1,
 * so citations remain correct across chunks.
 */
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

/**
 * Load playbooks for the given category codes. Deduplicates so each module
 * is loaded at most once even if multiple categories reference it.
 * Assumes validateAllPlaybooks() has already confirmed all modules exist.
 */
async function loadPlaybooksForCategories(codes: string[]): Promise<Map<string, string>> {
  const moduleNames = new Set<string>()
  for (const code of codes) {
    const refs = CATEGORY_CODE_TO_PLAYBOOKS[code]
    if (refs) {
      for (const ref of refs) moduleNames.add(ref)
    }
  }

  const loaded = new Map<string, string>()
  for (const modName of moduleNames) {
    const mod = await import(`./playbooks/${modName}.js`)
    loaded.set(modName, (mod as { playbook: string }).playbook)
  }
  return loaded
}

/**
 * Hard startup validation: assert every category code in the mapping resolves
 * to a real module that loads successfully. Fails loudly with a list of all
 * unresolved codes — never degrades silently.
 */
async function validateAllPlaybooks(): Promise<void> {
  const allModuleNames = new Set<string>()
  const codeToModules = new Map<string, string[]>()

  for (const [code, refs] of Object.entries(CATEGORY_CODE_TO_PLAYBOOKS)) {
    codeToModules.set(code, refs)
    for (const ref of refs) allModuleNames.add(ref)
  }

  const loadErrors = new Map<string, string>()
  for (const modName of allModuleNames) {
    try {
      await import(`./playbooks/${modName}.js`)
    } catch (err: any) {
      loadErrors.set(modName, err.message)
    }
  }

  if (loadErrors.size > 0) {
    const unresolvedCodes = new Set<string>()
    for (const [code, refs] of codeToModules) {
      for (const ref of refs) {
        if (loadErrors.has(ref)) unresolvedCodes.add(code)
      }
    }
    console.error('\n=== PLAYBOOK VALIDATION FAILED ===')
    console.error(`Unresolved playbook modules (${loadErrors.size}):`)
    for (const [modName, msg] of loadErrors) {
      console.error(`  - ${modName}: ${msg}`)
    }
    console.error(`\nAffected category codes (${[...unresolvedCodes].sort().join(', ')}):`)
    for (const code of [...unresolvedCodes].sort()) {
      console.error(`  - ${code} → ${codeToModules.get(code)?.join(', ')}`)
    }
    console.error('\nA missing playbook means lanes for these categories will run with NO')
    console.error('technical guidance. Fix the missing module(s) before running.')
    console.error('=== END VALIDATION FAILURE ===\n')
    process.exit(1)
  }
}

// ── Prompt assembly ───────────────────────────────────────────────────────

function buildHuntPrompt(
  targetFile: string,
  lineNumberedContent: string,
  categories: CategoryRef[],
  playbooks: Map<string, string>,
  chunkInfo: { chunkIndex: number; totalChunks: number },
  archSummarySnippet?: string,
): string {
  // Use c.name directly (the name already contains the code, e.g. "A03: Injection")
  const categoryList = categories.map(c => c.name).join(', ')

  let prompt = `You are a security analyst hunting for vulnerabilities in a single source file.

## Target File
File: ${targetFile}
`

  if (chunkInfo.totalChunks > 1) {
    prompt += `Chunk ${chunkInfo.chunkIndex} of ${chunkInfo.totalChunks}. Analyze ALL lines shown below — do not skip any.
`
  }

  prompt += `
## Assigned Categories
You are hunting ONLY for these vulnerability classes in this file: ${categoryList}.
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

For each finding, you MUST specify "finding_category" as one of the category codes from your assigned categories list above (e.g., "A03", "A05"). Choose the code that best matches the vulnerability class you found. Do NOT assign a category that is not in your assigned list.

Each finding must have:
- "finding_category": the category CODE (e.g., "A03") that this finding belongs to — chosen from your assigned categories
- "title": concise vulnerability title
- "description": what the vulnerability is, how it works, and why it is exploitable
- "trace": array of {kind: "entrypoint"|"propagation"|"sink", file: "${targetFile}", line: NUMBER (use the line numbers shown above), description: string}. First step MUST be entrypoint, last MUST be sink.
- "severity_estimate": "low" | "medium" | "high" | "critical"
- "confidence": number 0-1`

  return prompt
}

// ── LLM call with token tracking ──────────────────────────────────────────

interface LlmCallResult {
  text: string
  tokensUsed: number
}

async function callLlm(
  client: OpenAI,
  prompt: string,
): Promise<LlmCallResult | null> {
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
          schema: HUNT_RESPONSE_SCHEMA,
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
      console.log('  [INFO] json_schema not supported, falling back to json_object')
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
        console.error(`  [ERROR] Free-text fallback also failed: ${err2.message}`)
        return null
      }
    }
    throw err
  }
}

// ── Hunt a single lane (one file, possibly multiple chunks) ───────────────

async function huntLane(
  client: OpenAI,
  lane: LaneAssignmentEntry,
  targetDir: string,
  playbooks: Map<string, string>,
  archSummarySnippet?: string,
): Promise<{ findings: CandidateFinding[]; tokensUsed: number }> {
  const targetPath = join(targetDir, lane.target_file)
  if (!existsSync(targetPath)) {
    console.error(`  [ERROR] Target file not found: ${targetPath}`)
    return { findings: [], tokensUsed: 0 }
  }

  const rawContent = readFileSync(targetPath, 'utf-8')
  const sanitized = sanitizePemPrivateKey(rawContent)

  const allFindings: CandidateFinding[] = []
  let totalTokens = 0

  const chunks = lane.chunk_plan.chunks
  if (chunks.length === 0 && lane.disposition === 'hunt') {
    console.warn(`  [WARN] Lane ${lane.lane_id} has no chunks but disposition is "hunt"`)
    return { findings: [], tokensUsed: 0 }
  }

  for (const chunk of chunks) {
    // Extract lines for this chunk (1-indexed)
    const allLines = sanitized.split('\n')
    const chunkLines = allLines.slice(chunk.start_line - 1, chunk.end_line)
    const chunkContent = chunkLines.join('\n')

    // Line-number with REAL line numbers
    const lineNumbered = lineNumberContent(chunkContent, chunk.start_line)

    const prompt = buildHuntPrompt(
      lane.target_file,
      lineNumbered,
      lane.categories,
      playbooks,
      { chunkIndex: chunk.index, totalChunks: lane.chunk_plan.total_chunks },
      archSummarySnippet,
    )

    const t0 = Date.now()
    const result = await callLlm(client, prompt)
    const elapsed = (Date.now() - t0) / 1000

    if (!result) {
      console.error(`  [ERROR] Lane ${lane.lane_id} chunk ${chunk.index} LLM call failed`)
      continue
    }

    totalTokens += result.tokensUsed
    console.log(`  [${lane.lane_id}] chunk ${chunk.index}: ${result.tokensUsed.toLocaleString()} tokens, ${elapsed.toFixed(1)}s`)

    // Parse findings
    let parsed: LaneHuntResponse
    try {
      const jsonStr = extractJson(result.text)
      parsed = JSON.parse(jsonStr) as LaneHuntResponse
    } catch {
      console.log(`  [WARN] Lane ${lane.lane_id} chunk ${chunk.index} returned unparseable content`)
      continue
    }

    if (parsed.findings && Array.isArray(parsed.findings)) {
      for (const f of parsed.findings) {
        // Validity checks (carried forward from v1)
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

        // Use the model's reported category; fall back to first assigned if missing
        const findingCat = (f as any).finding_category
        const assignedCodes = lane.categories.map(c => c.code)
        const finalCategories: string[] = []
        if (findingCat && assignedCodes.includes(findingCat)) {
          finalCategories.push(findingCat)
        } else if (assignedCodes.length > 0) {
          finalCategories.push(assignedCodes[0])
        }

        const finding: CandidateFinding = {
          finding_id: nextFindingId(),
          lane_id: lane.lane_id,
          categories: finalCategories,
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

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Stage 2 (Per-File v2): Hunt Lanes ===')
  console.log()

  // FIX 2: Validate all playbooks before any lane runs
  await validateAllPlaybooks()
  console.log(`All 16 playbook modules validated (covering all 26 category codes)`)
  console.log()

  // Load lane assignments
  const assignmentsPath = join(REPO_ROOT, 'tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json')
  if (!existsSync(assignmentsPath)) {
    console.error(`ERROR: Lane assignments not found at ${assignmentsPath}`)
    console.error('Has Stage 0.5 (per-file) run yet?')
    process.exit(1)
  }

  const assignments: LaneAssignments = JSON.parse(readFileSync(assignmentsPath, 'utf-8'))
  console.log(`Loaded ${assignments.lanes.length} lane assignments`)
  console.log(`Target directory: ${assignments.target_dir}`)

  // Validate coverage ledger
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

  // Validate chunk plans
  for (const lane of assignments.lanes) {
    if (lane.disposition === 'skip') continue
    const chunks = lane.chunk_plan.chunks
    if (chunks.length === 0) {
      console.error(`ERROR: Lane ${lane.lane_id} is "hunt" but has no chunks`)
      process.exit(1)
    }
    // Verify tiling: first chunk starts at 1, last ends at file_lines
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

  // Count hunt vs skip
  const huntLanes = assignments.lanes.filter(l => l.disposition === 'hunt')
  const skipLanes = assignments.lanes.filter(l => l.disposition === 'skip')
  console.log(`Hunt lanes: ${huntLanes.length}, Skip lanes: ${skipLanes.length}`)

  // Log skip lanes
  for (const lane of skipLanes) {
    console.log(`  [SKIP] ${lane.lane_id}: ${lane.target_file} — ${lane.skip_reason}`)
  }

  // Load architecture summary snippet
  const archPath = join(REPO_ROOT, assignments.source_stage0_run)
  const archSnippet = loadArchSummarySnippet(archPath)
  if (archSnippet) {
    console.log('\nArchitecture summary loaded (context for lanes)')
  }

  // Initialize LLM client
  const client = createClient()

  // Hunt each lane
  const allFindings: CandidateFinding[] = []
  const consumptionReport: BudgetConsumption[] = []

  for (const lane of huntLanes) {
    console.log(`\n[HUNT] Lane: ${lane.lane_id} | File: ${lane.target_file} | Categories: ${lane.categories.map(c => c.code).join(', ')}`)
    console.log(`  ${lane.file_lines} lines, ${lane.file_bytes.toLocaleString()} bytes`)
    console.log(`  Chunk plan: ${lane.chunk_plan.required ? lane.chunk_plan.total_chunks + ' chunks' : 'single pass'}`)

    // Load only the playbooks for this lane's assigned categories
    const assignedCodes = lane.categories.map(c => c.code)
    const playbooks = await loadPlaybooksForCategories(assignedCodes)
    console.log(`  Loaded ${playbooks.size} playbook module(s): ${Array.from(playbooks.keys()).join(', ')}`)

    const t0 = Date.now()
    const result = await huntLane(client, lane, assignments.target_dir, playbooks, archSnippet)
    const elapsed = (Date.now() - t0) / 1000

    allFindings.push(...result.findings)

    consumptionReport.push({
      lane_id: lane.lane_id,
      tokens_used: result.tokensUsed,
      seconds_elapsed: elapsed,
      ceiling_hit: false,  // measurement only — no enforcement
    })

    console.log(`  → ${result.findings.length} finding(s), ${result.tokensUsed.toLocaleString()} tokens`)
  }

  // Also report skip lanes with zero consumption
  for (const lane of skipLanes) {
    consumptionReport.push({
      lane_id: lane.lane_id,
      tokens_used: 0,
      seconds_elapsed: 0,
      ceiling_hit: false,
    })
  }

  // Write outputs
  const outDir = join(__dirname, '..', 'output')
  mkdirSync(outDir, { recursive: true })

  writeFileSync(join(outDir, 'candidate-findings.json'), JSON.stringify(allFindings, null, 2) + '\n')
  writeFileSync(join(outDir, 'budget-consumption.json'), JSON.stringify(consumptionReport, null, 2) + '\n')

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
