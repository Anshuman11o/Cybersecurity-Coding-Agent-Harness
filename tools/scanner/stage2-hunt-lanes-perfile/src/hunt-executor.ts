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
 * Provider-scoped: model, endpoint, credential and API parameter dialect all
 * come from the model registry via the resolved provider, and every artifact
 * lands under runs/<provider>/stage2-hunt-lanes-perfile/. No model id appears
 * anywhere in this file.
 *
 * Outputs: runs/<provider>/stage2-hunt-lanes-perfile/candidate-findings.json
 *          runs/<provider>/stage2-hunt-lanes-perfile/budget-consumption.json
 *
 * Checkpointing: after EACH lane completes, results are written to disk
 * immediately. On startup, existing partial results are detected and the
 * run RESUMES from where it stopped, skipping already-completed lanes.
 * Partial files are always valid, parseable JSON.
 */
import OpenAI from 'openai'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'
import { createClient, extractJson } from './llm-client.js'
import { resolveProvider, modelFor, tokenLimitParam, samplingParams } from '../../shared/provider.js'
import { runPath, type Provider } from '../../shared/run-paths.js'
import { writeMeta, assertUpstream } from '../../shared/meta.js'
import { readCorpusFile, guardStats } from '../../shared/read-guard.js'
import type {
  LaneAssignmentEntry,
  LaneAssignments,
  CategoryRef,
  ChunkSpec,
  CandidateFinding,
  LaneHuntResponse,
  BudgetConsumption,
  BudgetConsumptionV2,
  PromptBreakdown,
  PromptSegment,
  MeasuredTokens,
  DerivedSegmentAttribution,
  ChunkTokenRecord,
  LaneTokenRecordV2,
  RunLevelRollupV2,
  VulnClassRegistry,
  FindingClassRef,
  ClassSweepEntry,
  LaneClassSweep,
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../..')

const PROVIDER: Provider = resolveProvider('stage2perfile')
const MODEL = modelFor(PROVIDER)
const STARTED = new Date().toISOString()

// ── Constant: single-pass line budget ─────────────────────────────────────
export const SINGLE_PASS_LINE_BUDGET = 2000

// ── Bounded concurrency ───────────────────────────────────────────────────
// Cap on how many lanes run concurrently.  Default 8; override via env var
// HUNT_CONCURRENCY.  Running too many simultaneous calls against the same
// upstream endpoint increases 429 risk — keep this modest.
//
// Measured: 8 was too high for gpt-5.6-luna on 2026-07-28 — 52 of 541 lanes
// died on tokens-per-minute limits, and a retry pass at 3 completed all 52 with
// zero retries. Pass HUNT_CONCURRENCY explicitly for a full run rather than
// relying on this default.
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

/**
 * `class_sweep` is declared FIRST, and that order is load-bearing rather than
 * cosmetic.
 *
 * Generation is autoregressive: under `strict` structured output the model
 * emits keys in the order this schema declares them, so a sweep declared first
 * is written before any finding exists, and the findings are then generated
 * conditioned on those verdicts. Declared last, the model has already committed
 * to its findings and the sweep degrades into post-hoc narration — observable,
 * but with no effect on what gets hunted.
 *
 * `minItems: 1` only; there is deliberately no `maxItems` on either array. The
 * natural bound on both is the lane's own assigned class list, which the `enum`
 * already enforces.
 */
export function buildHuntSchema(classIds: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      class_sweep: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            class: { type: 'string', enum: classIds },
            verdict: { type: 'string', enum: ['found', 'absent'] },
            // 0 when verdict is "absent". `strict` mode requires every property
            // to be present and non-nullable, so this is a sentinel rather than
            // an optional field.
            evidence_line: { type: 'integer' },
            reason: { type: 'string' },
          },
          required: ['class', 'verdict', 'evidence_line', 'reason'],
        },
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            finding_classes: {
              type: 'array',
              minItems: 1,
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
    // Order matches `properties` — class_sweep before findings.
    required: ['class_sweep', 'findings'],
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

  // 2. All emittable codes covered exactly once.
  //
  // API10 is deliberately absent. It was reachable only through the
  // general-catchall class, which was assigned to all 541 lanes, produced 13.8%
  // of run output at 3% precision, and matched no ground-truth entry. Dropping
  // the class drops its only code with it. This is v2-only: v1 has no class
  // model and keeps its own general-catchall lane and playbook.
  const allCodes = Object.values(reg).flatMap(e => e.codes)
  const codeCounts = new Map<string, number>()
  for (const code of allCodes) {
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1)
  }
  const duplicatedCodes = [...codeCounts.entries()].filter(([, c]) => c > 1).map(([c]) => c)
  const missingCodes = (() => {
    const expected = new Set([
      'A01','A02','A03','A04','A05','A06','A07','A08','A09','A10',
      'API1','API2','API3','API4','API5','API6','API7','API8','API9',
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

interface HuntPromptResult {
  prompt: string;
  breakdown: PromptBreakdown;
}

export function buildHuntPrompt(
  targetFile: string,
  lineNumberedContent: string,
  classes: string[],
  playbooks: Map<string, string>,
  chunkInfo: { chunkIndex: number; totalChunks: number },
  archSummarySnippet?: string,
  routeContextSection?: string,
): HuntPromptResult {
  const segments: PromptSegment[] = []
  const parts: string[] = []
  const classList = classes.join(', ')

  // Segment 1: boilerplate (headings, assigned-classes list, output-format)
  let boilerplate = `You are a security analyst hunting for vulnerabilities in a single source file.

## Target File
File: ${targetFile}
`

  if (chunkInfo.totalChunks > 1) {
    boilerplate += `Chunk ${chunkInfo.chunkIndex} of ${chunkInfo.totalChunks}. Analyze ALL lines shown below — do not skip any.
`
  }

  boilerplate += `
## Assigned Classes
You are hunting ONLY for these vulnerability classes in this file: ${classList}.
Do NOT look for vulnerability classes outside this list.

## Playbook Guidance — How to detect each assigned class
Below is the technical guidance for the vulnerability classes you are hunting. This guidance explains what these vulnerability classes look like in general — what shapes of code create them, what to trace, what distinguishes a real instance from a false positive. It does NOT describe this particular codebase.
`
  segments.push({ segment_type: 'boilerplate', chars: boilerplate.length })
  parts.push(boilerplate)

  // Segments 2+: playbook:<class-id> — one per class
  for (const [modName, playbookText] of playbooks) {
    const playbookBlock = `\n### Playbook: ${modName}\n${playbookText}`
    segments.push({ segment_type: `playbook:${modName}`, chars: playbookBlock.length })
    parts.push(playbookBlock)
  }

  // Arch context segment (when present)
  if (archSummarySnippet) {
    const archBlock = `
## Architecture Context
The following is a summary of the target application's architecture. Use it to understand the application's structure, routing, and data flow — not to limit your search.
${archSummarySnippet}
`
    segments.push({ segment_type: 'arch_context', chars: archBlock.length })
    parts.push(archBlock)
  }

  // Route context segment (when present)
  if (routeContextSection) {
    const routeBlock = `
${routeContextSection}
`
    segments.push({ segment_type: 'route_context', chars: routeBlock.length })
    parts.push(routeBlock)
  }

  // File content segment
  const fileContentBlock = `
## Target File Content
Every line is prefixed with its REAL 1-indexed line number from the original source file. When citing a location in your trace, use these line numbers EXACTLY.

\`\`\`
${lineNumberedContent}
\`\`\`

## Output Format
Respond with a structured JSON object containing a "findings" array.

You are seeing one file. The attacker-facing entrypoint is often in a different file — a route handler, a caller, a framework hook — and you will not be able to see it. That does not make a defect in this file unreportable. When the entrypoint is outside this file, begin the trace where this file receives data from outside it: an exported function's parameter, a setter, a handler argument. Say in that step's description that the caller is outside this file.

Report a defect when the code in front of you is wrong on its own terms — a check that is absent, a weaker control chosen where a stronger one sits beside it, input reaching a dangerous operation without validation — even if you cannot see who calls it.

Set "confidence" to how sure you are, and use the whole range. It is a label on the finding, not a threshold for reporting it:
- 0.8-1.0 — you can see the defect and the path to it in this file.
- 0.4-0.7 — the defect is visible but something is unconfirmable from here: the caller, the reachability, whether a control exists elsewhere.
- 0.1-0.3 — the shape is suspicious and you would want a second opinion, but you cannot establish it from this file alone.

Report findings in all three bands. A 0.2 finding is useful output; a withheld one is not. Do not raise a number to make a finding look more solid, and do not suppress a finding because its number would be low.

Do not fabricate. Every finding must point at code that is actually present in the file in front of you, and every trace step must cite a real line.

Subject to that, report what you see.

## Class Sweep — do this before you write any finding

Work through your assigned class list **in the order given above**. For each class in turn, re-read the file against that class's playbook and emit one \`class_sweep\` entry:

- \`"verdict": "found"\` — this file contains at least one instance of the class. Set \`evidence_line\` to the line where it is clearest.
- \`"verdict": "absent"\` — it does not. Set \`evidence_line\` to 0, and in \`reason\` name the specific construct you examined in **this** file and why it does not qualify.

Every assigned class gets exactly one entry, in the order listed. Do not skip a class because it feels unlikely for this kind of file — an unlikely class is the one you are most likely to have missed, and deciding it is absent takes one line.

"absent" is a real and useful answer. But it is a claim that you looked, so the reason must be specific to the code in front of you. A reason that would be true of any file is not a reason.

Only when every assigned class has a verdict, write your findings. Any class you marked "found" must then appear in the \`finding_classes\` of at least one finding, and any class in a finding must have been swept "found".

An empty \`findings\` array is a strong claim — it says every assigned class came back "absent". That is a legitimate outcome for a file that genuinely has none, and your sweep is where you show it.

## Findings

List every class from your assigned classes list that this finding establishes. There is no limit on how many, and the classes are not mutually exclusive — naming one never rules out another.

Do not hold back. If you have some or enough evidence that more than one assigned class is involved, name them all. One statement is often several classes at once: a query that interpolates caller-controlled input while also comparing a password hashed with a broken algorithm is an injection finding and a crypto-auth finding, on the same line and the same trace. A render sink reached by attacker-controlled data is both an injection and a client-side finding. Choosing the single best label discards the others and gains nothing — a class you can see and do not name is a class you did not find.

For each class you list, give the index of the trace step that establishes it.

Each "class_sweep" entry must have:
- "class": one of the class ids from your assigned classes list above
- "verdict": "found" | "absent"
- "evidence_line": NUMBER — the line establishing it when "found", 0 when "absent"
- "reason": why, specific to this file

Each finding must have:
- "finding_classes": array of { "class": one of the class ids from your assigned classes list above, "justified_by_step": 0-based index into this finding's trace array }
- "title": concise vulnerability title
- "description": what the vulnerability is, how it works, and why it is exploitable
- "trace": array of {kind: "entrypoint"|"propagation"|"sink", file: "${targetFile}", line: NUMBER (use the line numbers shown above), description: string}. First step MUST be entrypoint, last MUST be sink.
- "severity_estimate": "low" | "medium" | "high" | "critical"
- "confidence": number 0-1`
  segments.push({ segment_type: 'file_content', chars: fileContentBlock.length })
  parts.push(fileContentBlock)

  const prompt = parts.join('')

  // Reconciliation assertion: segment chars MUST sum to prompt length
  const charsSum = segments.reduce((s, seg) => s + seg.chars, 0)
  if (charsSum !== prompt.length) {
    throw new Error(
      `Prompt breakdown does not reconcile: segments sum to ${charsSum} but prompt length is ${prompt.length}`
    )
  }

  return { prompt, breakdown: { segments, total_chars: prompt.length } }
}

// ── LLM call with token tracking and retry ────────────────────────────────

interface LlmCallResult {
  text: string
  measured: MeasuredTokens
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
  // Sized to outlast a tokens-per-minute window. The 2026-07-28 run lost 52 of
  // 541 lanes to TPM limits with maxRetries=3 and a 15s backoff cap: total wait
  // was ~14s, so all three retries were spent inside a single 60s window and the
  // lane failed while the limit was still in force. Five retries capped at 60s
  // wait 2+4+8+16+32 = 62s, which crosses the window.
  const maxRetries = 5
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        ...samplingParams(PROVIDER),
        ...tokenLimitParam(PROVIDER, 8000),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'hunt_output',
            schema: schema,
            strict: true,
          },
        },
      } as any)
      const text = response.choices[0]?.message?.content
      if (!text) return null
      return { text, measured: captureMeasuredTokens(response.usage) }
    } catch (err: any) {
      const isSchema = err.message?.includes('json_schema') || err.message?.includes('strict') || err.message?.includes('response_format')
      if (isSchema) {
        try {
          const response = await client.chat.completions.create({
            model: MODEL,
            messages: [{ role: 'user', content: prompt }],
            ...samplingParams(PROVIDER),
            ...tokenLimitParam(PROVIDER, 8000),
            response_format: { type: 'json_object' },
          } as any)
          const text = response.choices[0]?.message?.content
          if (!text) return null
          return { text, measured: captureMeasuredTokens(response.usage) }
        } catch (err2: any) {
          console.error(`  [${laneId}] [ERROR] json_schema + fallback both failed: ${err2.message}`)
          return null
        }
      }
      if (isTransientError(err) && attempt < maxRetries) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 60000)
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

/**
 * Extract measured token counts from the API usage object.
 * Missing fields are recorded as null — never substituted.
 */
function captureMeasuredTokens(usage: OpenAI.Completions.CompletionUsage | undefined): MeasuredTokens {
  return {
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
  }
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
  archSummary?: { route_table: { hand_written_routes: any[]; auto_crud_routes: any[] } },
): Promise<{
  findings: CandidateFinding[];
  tokensUsed: number;
  chunkRecords: ChunkTokenRecord[];
  sweep: LaneClassSweep;
}> {
  // An empty sweep, for the paths that return before any LLM call. Recorded
  // rather than omitted so class-sweep.json has one entry per hunt lane and a
  // missing lane is distinguishable from a lane that swept nothing.
  const emptySweep = (): LaneClassSweep => ({
    lane_id: lane.lane_id,
    target_file: lane.target_file,
    assigned_classes: [...classIds],
    sweep: [],
    missing_classes: [...classIds],
    offlist_classes: [],
    duplicate_classes: [],
    inconsistent_classes: [],
    found_without_finding: [],
  })

  // Second line of defence behind Stage 0.5's denylist. The lane manifest is
  // machine-generated, but it is still the thing that decides what gets pasted
  // into a prompt — so the read goes through the corpus allowlist, which fails
  // closed on denylisted files and on anything outside target-apps/. Stage 0.5
  // skipping these and this returning null are independent; either alone is
  // enough. readCorpusFile() also covers the existence check.
  const repoRelative = relative(REPO_ROOT, join(targetDir, lane.target_file))
  const rawContent = readCorpusFile(repoRelative)
  if (rawContent === null) {
    console.error(
      `  [${lane.lane_id}] [BLOCKED] Guard refused ${lane.target_file} — lane produces no findings`,
    )
    return { findings: [], tokensUsed: 0, chunkRecords: [], sweep: emptySweep() }
  }
  const sanitized = sanitizePemPrivateKey(rawContent)

  // Compute per-lane route context (once, not per-chunk)
  const routeContext = archSummary
    ? matchRoutesForFile(lane.target_file, rawContent, archSummary)
    : { handWritten: [], autoCrud: [] }
  const routeContextSection = renderRouteContext(routeContext)

  const allFindings: CandidateFinding[] = []
  const sweepEntries: ClassSweepEntry[] = []
  let totalTokens = 0
  const chunkRecords: ChunkTokenRecord[] = []

  const chunks = lane.chunk_plan.chunks
  if (chunks.length === 0 && lane.disposition === 'hunt') {
    console.warn(`  [${lane.lane_id}] [WARN] No chunks but disposition is "hunt"`)
    return { findings: [], tokensUsed: 0, chunkRecords: [], sweep: emptySweep() }
  }

  const schema = buildHuntSchema(classIds)

  for (const chunk of chunks) {
    const allLines = sanitized.split('\n')
    const chunkLines = allLines.slice(chunk.start_line - 1, chunk.end_line)
    const chunkContent = chunkLines.join('\n')

    const lineNumbered = lineNumberContent(chunkContent, chunk.start_line)

    const huntResult = buildHuntPrompt(
      lane.target_file,
      lineNumbered,
      classIds,
      playbooks,
      { chunkIndex: chunk.index, totalChunks: lane.chunk_plan.total_chunks },
      archSummarySnippet,
      routeContextSection,
    )

    const t0 = Date.now()
    const result = await callLlm(client, huntResult.prompt, schema, lane.lane_id)
    const elapsed = (Date.now() - t0) / 1000

    if (!result) {
      console.error(`  [${lane.lane_id}] [ERROR] chunk ${chunk.index} LLM call failed`)
      // Still record the chunk with null measurements
      chunkRecords.push({
        chunk_index: chunk.index,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        prompt_breakdown: huntResult.breakdown,
        segment_attribution: deriveSegmentAttribution(huntResult.breakdown, { prompt_tokens: null, completion_tokens: null, total_tokens: null }),
        measured: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
      })
      continue
    }

    totalTokens += result.measured.total_tokens ?? 0
    const totalLabel = result.measured.total_tokens != null
      ? result.measured.total_tokens.toLocaleString()
      : 'null'
    console.log(`  [${lane.lane_id}] chunk ${chunk.index}: ${totalLabel} tokens, ${elapsed.toFixed(1)}s`)

    // Derive per-segment attribution for this chunk
    const segmentAttribution = deriveSegmentAttribution(huntResult.breakdown, result.measured)
    chunkRecords.push({
      chunk_index: chunk.index,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      prompt_breakdown: huntResult.breakdown,
      segment_attribution: segmentAttribution,
      measured: result.measured,
    })

    let parsed: LaneHuntResponse
    try {
      const jsonStr = extractJson(result.text)
      parsed = JSON.parse(jsonStr) as LaneHuntResponse
    } catch {
      console.log(`  [${lane.lane_id}] [WARN] chunk ${chunk.index} returned unparseable content`)
      continue
    }

    // Collect the sweep before the findings, mirroring the schema order. A
    // chunked lane sweeps once per chunk; entries are concatenated and the
    // per-lane reconciliation below dedupes on class.
    if (Array.isArray((parsed as any).class_sweep)) {
      for (const e of (parsed as any).class_sweep as ClassSweepEntry[]) {
        if (!e || typeof e.class !== 'string') continue
        sweepEntries.push({
          class: e.class,
          verdict: e.verdict === 'found' ? 'found' : 'absent',
          evidence_line: typeof e.evidence_line === 'number' ? e.evidence_line : 0,
          reason: typeof e.reason === 'string' ? e.reason : '',
        })
      }
    } else {
      console.log(`  [${lane.lane_id}] [WARN] chunk ${chunk.index} returned no class_sweep`)
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

  // ── Sweep reconciliation ────────────────────────────────────────────────
  // Four invariants, all checked mechanically and none requiring the model to
  // cooperate. They are RECORDED, not enforced: dropping a finding on an
  // inconsistent sweep would change recall for a reason unrelated to the
  // hypothesis under test, and the first run with the sweep needs a clean
  // comparison against run 3. Enforce later, once the base rates are known.
  const assignedSet = new Set(classIds)
  const seen = new Map<string, ClassSweepEntry>()
  const duplicateClasses: string[] = []
  const offlistClasses: string[] = []
  for (const e of sweepEntries) {
    if (!assignedSet.has(e.class)) {
      if (!offlistClasses.includes(e.class)) offlistClasses.push(e.class)
      continue
    }
    if (seen.has(e.class)) {
      if (!duplicateClasses.includes(e.class)) duplicateClasses.push(e.class)
      // A chunked lane legitimately sweeps per chunk; "found" anywhere wins.
      if (e.verdict === 'found' && seen.get(e.class)!.verdict !== 'found') seen.set(e.class, e)
      continue
    }
    seen.set(e.class, e)
  }

  const missingClasses = classIds.filter(c => !seen.has(c))
  const classesInFindings = new Set(
    allFindings.flatMap(f => f.finding_classes.map(fc => fc.class)),
  )
  const inconsistentClasses = [...classesInFindings].filter(
    c => seen.get(c)?.verdict !== 'found',
  )
  const foundWithoutFinding = [...seen.values()]
    .filter(e => e.verdict === 'found' && !classesInFindings.has(e.class))
    .map(e => e.class)

  const sweptFound = [...seen.values()].filter(e => e.verdict === 'found').length
  console.log(
    `  [${lane.lane_id}] sweep: ${seen.size}/${classIds.length} classes, ` +
    `${sweptFound} found, ${seen.size - sweptFound} absent` +
    (missingClasses.length ? ` | MISSING ${missingClasses.join(',')}` : '') +
    (inconsistentClasses.length ? ` | INCONSISTENT ${inconsistentClasses.join(',')}` : ''),
  )

  const sweep: LaneClassSweep = {
    lane_id: lane.lane_id,
    target_file: lane.target_file,
    assigned_classes: [...classIds],
    sweep: classIds.filter(c => seen.has(c)).map(c => seen.get(c)!),
    missing_classes: missingClasses,
    offlist_classes: offlistClasses,
    duplicate_classes: duplicateClasses,
    inconsistent_classes: inconsistentClasses,
    found_without_finding: foundWithoutFinding,
  }

  return { findings: allFindings, tokensUsed: totalTokens, chunkRecords, sweep }
}

/**
 * Derive per-segment token attribution by distributing prompt_tokens
 * across segments in proportion to their character share.
 * Returns null for each segment when prompt_tokens was not measured.
 */
function deriveSegmentAttribution(
  breakdown: PromptBreakdown,
  measured: MeasuredTokens,
): DerivedSegmentAttribution[] {
  const { segments } = breakdown
  const promptTokens = measured.prompt_tokens

  if (promptTokens == null || promptTokens === 0) {
    return segments.map(seg => ({
      segment_type: seg.segment_type,
      chars: seg.chars,
      derived_prompt_tokens: null,
    }))
  }

  const totalChars = segments.reduce((s, seg) => s + seg.chars, 0)
  if (totalChars === 0) {
    return segments.map(seg => ({
      segment_type: seg.segment_type,
      chars: seg.chars,
      derived_prompt_tokens: null,
    }))
  }

  // Distribute proportionally by character share
  let distributed = 0
  const attributions: DerivedSegmentAttribution[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const share = seg.chars / totalChars
    // For the last segment, use remainder to avoid rounding drift
    if (i === segments.length - 1) {
      const remainder = promptTokens - distributed
      attributions.push({
        segment_type: seg.segment_type,
        chars: seg.chars,
        derived_prompt_tokens: Math.round(remainder),
      })
    } else {
      const tokens = Math.round(promptTokens * share)
      distributed += tokens
      attributions.push({
        segment_type: seg.segment_type,
        chars: seg.chars,
        derived_prompt_tokens: tokens,
      })
    }
  }

  return attributions
}

// ── Exported-symbol extraction (regex-based, no parser dep) ─────────────

/**
 * Extract exported symbol names from a TypeScript/JavaScript source file.
 * Matches:
 *   export function X
 *   export const X
 *   export class X
 *   export async function X
 *   export { X, Y, Z }
 *   export { X as A, Y as B }
 * Returns a deduplicated Set of symbol names.
 */
export function extractExportedSymbols(source: string): Set<string> {
  const symbols = new Set<string>()

  // export function X, export async function X, export const X, export class X
  const reDecl = /\bexport\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
  let m: RegExpExecArray | null
  while ((m = reDecl.exec(source)) !== null) {
    symbols.add(m[1])
  }

  // export { X, Y, Z }  — handles multi-line
  const reNamed = /\bexport\s*\{([^}]*)\}/g
  while ((m = reNamed.exec(source)) !== null) {
    const items = m[1].split(',')
    for (const item of items) {
      const trimmed = item.trim()
      // "X as A" → export name is A; bare "X" → export name is X
      const asMatch = trimmed.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (asMatch) {
        symbols.add(asMatch[2])
      } else {
        const bareMatch = trimmed.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)/)
        if (bareMatch) {
          symbols.add(bareMatch[1])
        }
      }
    }
  }

  return symbols
}

// ── Per-lane route matching ─────────────────────────────────────────────

interface HandWrittenRoute {
  method: string
  path: string
  handler: string
  auth: string | null | undefined
  middleware: string[]
  file: string
  line: number
}

interface AutoCrudRoute {
  pathPattern: string
  model: string
  excludeAttributes: string[]
  hasPagination: boolean
  hasCustomHooks: boolean
}

export interface RouteContext {
  handWritten: HandWrittenRoute[]
  autoCrud: AutoCrudRoute[]
}

/**
 * Match route-table entries to a lane's target file by exported symbols.
 * Returns { handWritten, autoCrud } — the subset of routes belonging to
 * this file.
 */
export function matchRoutesForFile(
  targetFileRel: string,
  fileContent: string,
  archSummary: {
    route_table: {
      hand_written_routes: any[]
      auto_crud_routes: any[]
    }
  },
): RouteContext {
  const symbols = extractExportedSymbols(fileContent)
  if (symbols.size === 0) return { handWritten: [], autoCrud: [] }

  // Build a basename map from the target file path (e.g. "basketItems.ts" → "basketItems")
  const basename = targetFileRel.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''

  // Match hand-written routes
  const matchedHW: HandWrittenRoute[] = []
  for (const route of archSummary.route_table.hand_written_routes ?? []) {
    // Check handler field: look for any symbol as whole word
    if (route.handler && symbolMatchesAny(route.handler, symbols)) {
      matchedHW.push(route)
      continue
    }
    // Check middleware list: any middleware string containing any symbol as whole word
    if (route.middleware && Array.isArray(route.middleware)) {
      const anyMatch = route.middleware.some((mw: string) => symbolMatchesAny(mw, symbols))
      if (anyMatch) {
        matchedHW.push(route)
      }
    }
  }

  // Match auto-CRUD routes: by model name matching an exported symbol OR
  // case-insensitive basename (model files export XModel not X, and use lowercase filenames)
  const matchedAC: AutoCrudRoute[] = []
  for (const route of archSummary.route_table.auto_crud_routes ?? []) {
    if (route.model && symbols.has(route.model)) {
      matchedAC.push(route)
    } else if (route.model && basename.toLowerCase() === route.model.toLowerCase()) {
      matchedAC.push(route)
    }
  }

  return { handWritten: matchedHW, autoCrud: matchedAC }
}

/**
 * Check if any symbol in the set appears as a whole-word token inside `text`.
 * Handles qualified names like `basketItems.addBasketItem(` by matching
 * the symbol against word boundaries.
 */
function symbolMatchesAny(text: string, symbols: Set<string>): boolean {
  for (const sym of symbols) {
    // Use a word-boundary regex — \b works for identifiers containing word chars
    const re = new RegExp('\\b' + escapeRegex(sym) + '\\b')
    if (re.test(text)) return true
  }
  return false
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Route context rendering ──────────────────────────────────────────────

/**
 * Render the "How This File Is Reached" section from matched routes.
 * Returns the complete section string, or undefined if no routes matched.
 */
export function renderRouteContext(context: RouteContext, cap = 15): string | undefined {
  if (context.handWritten.length === 0 && context.autoCrud.length === 0) {
    return undefined
  }

  const lines: string[] = []

  // Hand-written routes block — emit only when there are matches
  if (context.handWritten.length > 0) {
    lines.push('## How This File Is Reached')
    lines.push("This file's exported handlers are registered as the following routes. Auth middleware is listed")
    lines.push('exactly as the application declares it; "none" means no authentication or authorization middleware')
    lines.push('is applied to that route.')
    lines.push('')

    // Sort hand-written routes: auth:none first, then the rest
    const sortedHW = [...context.handWritten].sort((a, b) => {
      const aNone = isAuthNone(a.auth) ? 0 : 1
      const bNone = isAuthNone(b.auth) ? 0 : 1
      return aNone - bNone
    })

    // Apply cap across hand-written routes only
    const dropped = sortedHW.length > cap ? sortedHW.length - cap : 0
    const shown = sortedHW.slice(0, cap)

    for (const route of shown) {
      const method = (route.method ?? '?').padEnd(6)
      const path = (route.path ?? '?').padEnd(4)
      const handlerRaw = route.handler ?? '?'
      const handler = handlerRaw.replace(/\([^)]*\)$/, '').replace(/\($/, '') + '()'
      const authDisplay = isAuthNone(route.auth) ? 'none' : route.auth
      lines.push(`  ${method} ${path} ->  ${handler.padEnd(30)} auth: ${authDisplay}`)

      // Middleware sub-line: show only middleware beyond the handler call itself
      const extraMiddleware = getExtraMiddleware(route.middleware, handlerRaw)
      if (extraMiddleware.length > 0) {
        lines.push(`    middleware: ${extraMiddleware.join(', ')}`)
      }
    }

    if (dropped > 0) {
      lines.push('')
      lines.push(`(${dropped} further routes not shown)`)
    }
  }

  // Auto-CRUD block — emit only when there are matches
  if (context.autoCrud.length > 0) {
    if (context.handWritten.length === 0) {
      // No hand-written block above, so add the section heading here
      lines.push('## How This File Is Reached')
    }
    lines.push('')
    lines.push("Auto-generated CRUD surface for this file's model:")
    for (const ac of context.autoCrud) {
      const excludes = ac.excludeAttributes?.length > 0
        ? `excludes: ${ac.excludeAttributes.join(', ')}`
        : ''
      const pagination = ac.hasPagination ? 'pagination: yes' : 'pagination: no'
      const parts = [excludes, pagination].filter(Boolean)
      lines.push(`  ${ac.pathPattern}  ${parts.join('  ')}`)
    }
  }

  // Closing paragraph — appears whenever either block did
  lines.push('')
  lines.push('Consider whether each route\'s protection matches what the handler actually does and what it')
  lines.push('exposes. A handler that is correct in isolation can still be a finding if it is reachable without')
  lines.push('the authorization its behaviour requires.')

  return lines.join('\n')
}

function isAuthNone(auth: string | null | undefined): boolean {
  return auth == null || auth === '' || auth === 'null'
}

/**
 * Return middleware entries that are NOT just the handler call itself.
 * E.g. if middleware = ['security.appendUserId()', 'utils.asyncHandler(basketItems.addBasketItem())']
 * and handler = 'basketItems.addBasketItem(', the second middleware is the handler
 * wrapper, so only 'security.appendUserId()' is "extra".
 */
function getExtraMiddleware(middleware: string[] | undefined, handler: string): string[] {
  if (!middleware || middleware.length === 0) return []
  // Extract the bare handler name from the handler field
  const bareHandler = handler.replace(/\([^)]*\)$/, '').replace(/\($/, '').trim()
  if (!bareHandler) return middleware

  return middleware.filter(mw => {
    // If the middleware is just asyncHandler(handlerName()), it's the handler itself
    const cleanedMw = mw.replace(/^utils\.asyncHandler\(/, '').replace(/\)$/, '').trim()
    if (cleanedMw === bareHandler || mw.includes(bareHandler + '(')) return false
    // Also check if the middleware is just the handler name itself
    if (mw.trim() === bareHandler) return false
    // Check for qualified handler: e.g. "basketItems.addBasketItem(" inside the middleware
    const parts = bareHandler.split('.')
    const lastPart = parts[parts.length - 1]
    if (lastPart && (mw.includes(lastPart + '(') || mw === lastPart)) return false
    return true
  })
}

// ── Load architecture summary (optional context) ──────────────────────────

function loadArchSummarySnippet(archPath: string): string | undefined {
  if (!existsSync(archPath)) {
    console.warn(`  [loadArchSummarySnippet] File not found: ${archPath}`)
    return undefined
  }
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
  } catch (err: any) {
    console.warn(`  [loadArchSummarySnippet] Failed to parse: ${archPath} — ${err.message}`)
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
  sweeps: LaneClassSweep[],
): void {
  const findingsPath = join(outDir, 'candidate-findings.json')
  const consumptionPath = join(outDir, 'budget-consumption.json')
  const sweepPath = join(outDir, 'class-sweep.json')

  const findingsTmp = findingsPath + '.tmp'
  writeFileSync(findingsTmp, JSON.stringify(findings, null, 2) + '\n')
  renameSync(findingsTmp, findingsPath)

  const consumptionTmp = consumptionPath + '.tmp'
  writeFileSync(consumptionTmp, JSON.stringify(consumption, null, 2) + '\n')
  renameSync(consumptionTmp, consumptionPath)

  const sweepTmp = sweepPath + '.tmp'
  writeFileSync(sweepTmp, JSON.stringify(sweeps, null, 2) + '\n')
  renameSync(sweepTmp, sweepPath)
}

/**
 * Load an existing checkpoint from the output directory.
 * Returns { findings, consumption, completedLaneIds } if a valid checkpoint
 * exists, or null if there is nothing to resume from.
 */
function loadCheckpoint(outDir: string): {
  findings: CandidateFinding[]
  consumption: BudgetConsumption[]
  sweeps: LaneClassSweep[]
  completedLaneIds: Set<string>
} | null {
  const findingsPath = join(outDir, 'candidate-findings.json')
  const consumptionPath = join(outDir, 'budget-consumption.json')
  const sweepPath = join(outDir, 'class-sweep.json')

  if (!existsSync(findingsPath) || !existsSync(consumptionPath)) {
    return null
  }

  try {
    const findings: CandidateFinding[] = JSON.parse(readFileSync(findingsPath, 'utf-8'))
    const rawConsumption = JSON.parse(readFileSync(consumptionPath, 'utf-8'))

    // Two shapes on disk. writeCheckpoint() emits a bare array mid-run, but the
    // completion write replaces it with the v2 object. Reading only the array
    // meant that after any FINISHED run the checkpoint was unreadable, so a
    // re-run repeated every lane at full cost instead of resuming — the exact
    // situation checkpointing exists for.
    const consumption: BudgetConsumption[] = Array.isArray(rawConsumption)
      ? rawConsumption
      : Array.isArray(rawConsumption?.legacy_entries)
        ? rawConsumption.legacy_entries
        : []

    if (!Array.isArray(findings) || consumption.length === 0) {
      return null
    }

    // A failed lane is recorded but NOT complete. Deriving completedLaneIds
    // from every entry meant a rate-limited lane was skipped on resume and the
    // run reported success while missing it.
    const completedLaneIds = new Set(
      consumption.filter(c => !c.failed).map(c => c.lane_id),
    )
    const failedCount = consumption.filter(c => c.failed).length
    if (failedCount > 0) {
      console.log(`[RESUME] ${failedCount} lane(s) previously failed — they will be retried`)
    }
    // class-sweep.json is deliberately NOT part of the resume gate. It arrived
    // after the other two artifacts, so a checkpoint written by an earlier
    // build has none — treating that as unresumable would force a full re-run
    // at full cost. Sweeps for lanes already done are simply lost, which costs
    // observability on those lanes and nothing else.
    let sweeps: LaneClassSweep[] = []
    if (existsSync(sweepPath)) {
      try {
        const raw = JSON.parse(readFileSync(sweepPath, 'utf-8'))
        if (Array.isArray(raw)) sweeps = raw
      } catch {
        console.warn('[RESUME] class-sweep.json unreadable — sweeps for completed lanes are lost')
      }
    }

    return { findings, consumption, sweeps, completedLaneIds }
  } catch {
    return null
  }
}

// ── v2 budget consumption writer ─────────────────────────────────────────

/**
 * Build the run-level rollup from per-lane v2 records.
 */
function buildRunLevelRollup(
  lanes: LaneTokenRecordV2[],
  totalSourceBytes: number,
): RunLevelRollupV2 {
  // Aggregate totals across all lanes
  let sumPrompt = 0
  let sumCompletion = 0
  let sumTotal = 0
  let allMeasured = true

  const segmentKindTokens: Record<string, number> = {}
  const playbookClassTokens: Record<string, number> = {}

  for (const lane of lanes) {
    const lt = lane.lane_totals
    if (lt.prompt_tokens != null) sumPrompt += lt.prompt_tokens
    else allMeasured = false
    if (lt.completion_tokens != null) sumCompletion += lt.completion_tokens
    if (lt.total_tokens != null) sumTotal += lt.total_tokens

    for (const chunk of lane.chunks) {
      for (const attr of chunk.segment_attribution) {
        if (attr.derived_prompt_tokens != null) {
          segmentKindTokens[attr.segment_type] = (segmentKindTokens[attr.segment_type] || 0) + attr.derived_prompt_tokens
          // Extract playbook class from "playbook:<class-id>" segment type
          if (attr.segment_type.startsWith('playbook:')) {
            const classId = attr.segment_type.slice('playbook:'.length)
            playbookClassTokens[classId] = (playbookClassTokens[classId] || 0) + attr.derived_prompt_tokens
          }
        }
      }
    }
  }

  const totalInput = allMeasured ? sumPrompt : null

  // Input by segment kind
  const inputBySegmentKind: Record<string, { tokens: number | null; share_of_input: number | null }> = {}
  for (const [kind, tokens] of Object.entries(segmentKindTokens)) {
    inputBySegmentKind[kind] = {
      tokens,
      share_of_input: totalInput && totalInput > 0 ? tokens / totalInput : null,
    }
  }

  // Input by playbook class, ranked
  const inputByPlaybookClass = Object.entries(playbookClassTokens)
    .sort((a, b) => b[1] - a[1])
    .map(([classId, tokens]) => ({
      class_id: classId,
      tokens,
      share_of_input: totalInput && totalInput > 0 ? tokens / totalInput : null,
    }))

  // Top 20 expensive lanes by total input tokens
  const sortedLanes = [...lanes]
    .filter(l => l.lane_totals.prompt_tokens != null)
    .sort((a, b) => (b.lane_totals.prompt_tokens ?? 0) - (a.lane_totals.prompt_tokens ?? 0))
    .slice(0, 20)

  const top20 = sortedLanes.map(l => {
    const segBreakdown: Record<string, number | null> = {}
    for (const chunk of l.chunks) {
      for (const attr of chunk.segment_attribution) {
        segBreakdown[attr.segment_type] = (segBreakdown[attr.segment_type] ?? 0) + (attr.derived_prompt_tokens ?? 0)
      }
    }
    return {
      lane_id: l.lane_id,
      target_file: l.target_file,
      file_bytes: l.file_bytes,
      chunk_count: l.chunk_count,
      total_input_tokens: l.lane_totals.prompt_tokens,
      total_output_tokens: l.lane_totals.completion_tokens,
      total_tokens: l.lane_totals.total_tokens,
      segment_breakdown: segBreakdown,
    }
  })

  // Lane chunk distribution
  const chunkDistribution: Record<string, number> = {}
  for (const lane of lanes) {
    const key = String(lane.chunk_count)
    chunkDistribution[key] = (chunkDistribution[key] || 0) + 1
  }

  // Repeated boilerplate cost: for lanes with >1 chunk, boilerplate is sent multiple times
  let totalExtraPromptTokens = 0
  let measuredBoilerplate = true
  for (const lane of lanes) {
    if (lane.chunk_count <= 1) continue
    const extraChunks = lane.chunk_count - 1
    let boilerplateTokens = 0
    for (const chunk of lane.chunks) {
      for (const attr of chunk.segment_attribution) {
        if (attr.segment_type === 'boilerplate' && attr.derived_prompt_tokens != null) {
          boilerplateTokens = attr.derived_prompt_tokens
          break
        }
      }
      if (boilerplateTokens > 0) break
    }
    if (boilerplateTokens > 0) {
      totalExtraPromptTokens += boilerplateTokens * extraChunks
    } else {
      measuredBoilerplate = false
    }
  }

  // Currency cost (only if env vars set)
  const costInfo: { input_cost: number | null; output_cost: number | null; total_cost: number | null; currency: string } = {
    input_cost: null,
    output_cost: null,
    total_cost: null,
    currency: '',
  }
  const inputPrice = process.env.TOKEN_PRICE_INPUT_PER_MILLION
  const outputPrice = process.env.TOKEN_PRICE_OUTPUT_PER_MILLION
  if (inputPrice && outputPrice) {
    const inputRate = parseFloat(inputPrice)
    const outputRate = parseFloat(outputPrice)
    if (Number.isFinite(inputRate) && Number.isFinite(outputRate) && allMeasured) {
      costInfo.input_cost = (sumPrompt / 1_000_000) * inputRate
      costInfo.output_cost = (sumCompletion / 1_000_000) * outputRate
      costInfo.total_cost = costInfo.input_cost + costInfo.output_cost
      costInfo.currency = 'USD'
    }
  }

  return {
    total_input_tokens: totalInput,
    total_output_tokens: allMeasured ? sumCompletion : null,
    total_tokens: allMeasured ? sumTotal : null,
    input_by_segment_kind: inputBySegmentKind,
    input_by_playbook_class: inputByPlaybookClass,
    top_20_expensive_lanes: top20,
    tokens_per_byte: totalSourceBytes > 0 && totalInput != null ? totalInput / totalSourceBytes : null,
    lane_chunk_distribution: chunkDistribution,
    repeated_boilerplate_cost: {
      total_extra_prompt_tokens: measuredBoilerplate ? totalExtraPromptTokens : null,
      description: measuredBoilerplate
        ? `Total extra prompt tokens from re-sending boilerplate across multi-chunk lanes (${totalExtraPromptTokens.toLocaleString()})`
        : 'Could not compute: boilerplate tokens not measured in some lanes',
    },
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Stage 2 (Per-File v2): Hunt Lanes ===')
  console.log()

  await validateAllPlaybooks()
  console.log()

  console.log(`[PROVIDER] ${PROVIDER} / ${MODEL}`)
  assertUpstream(PROVIDER, 'stage05-lane-selector-perfile')

  const assignmentsPath = join(
    runPath(PROVIDER, 'stage05-lane-selector-perfile'),
    'lane-assignments.json',
  )
  if (!existsSync(assignmentsPath)) {
    console.error(`ERROR: Lane assignments not found at ${assignmentsPath}`)
    console.error(`Has Stage 0.5 (per-file) run yet under provider "${PROVIDER}"?`)
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

  const archPathRaw = assignments.source_stage0_run
  const archPath = archPathRaw.startsWith('/') ? archPathRaw : join(REPO_ROOT, archPathRaw)
  const archSnippet = loadArchSummarySnippet(archPath)
  if (archSnippet) {
    console.log('\nArchitecture summary context loaded from: ' + archPath)
  } else {
    console.warn('\n[WARN] Architecture summary not found or failed to parse: ' + archPath)
    console.warn('  All lanes will run without architecture context.')
  }

  // Load full architecture summary for per-lane route matching
  let archSummaryFull: { route_table: { hand_written_routes: any[]; auto_crud_routes: any[] } } | undefined
  try {
    if (existsSync(archPath)) {
      const full = JSON.parse(readFileSync(archPath, 'utf-8'))
      archSummaryFull = full.route_table ? { route_table: full.route_table } : undefined
    }
  } catch {
    // Non-fatal — per-lane route context will simply be omitted
  }

  const client = createClient(PROVIDER)

  const outDir = runPath(PROVIDER, 'stage2-hunt-lanes-perfile')
  mkdirSync(outDir, { recursive: true })

  // ── Checkpoint resume ───────────────────────────────────────────────────
  let allFindings: CandidateFinding[] = []
  const consumptionReport: BudgetConsumption[] = []
  const laneRecordsV2: LaneTokenRecordV2[] = []
  const classSweeps: LaneClassSweep[] = []

  const checkpoint = loadCheckpoint(outDir)
  if (checkpoint) {
    allFindings = checkpoint.findings
    classSweeps.push(...checkpoint.sweeps)
    // Drop the previous failure records: those lanes are about to be retried,
    // and carrying them forward would leave two entries with the same lane_id.
    // reconcileV2() keys its lane map by lane_id with Map.set(), so a stale
    // zero-token entry arriving last would silently zero out a lane that
    // actually ran.
    consumptionReport.push(...checkpoint.consumption.filter(c => !c.failed))
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

  // ── Class resolution path banner ────────────────────────────────────────
  let lanesWithClasses = 0
  let lanesWithCategories = 0
  for (const lane of huntLanes) {
    if (lane.classes && lane.classes.length > 0) lanesWithClasses++
    else lanesWithCategories++
  }
  console.log(`[CLASS RESOLUTION] ${lanesWithClasses} lanes use lane.classes (signal-based), ${lanesWithCategories} lanes fall back to lane.categories`)

  // ── Bounded concurrency executor ────────────────────────────────────────
  const sem = new Semaphore(MAX_CONCURRENT_LANES)
  const lanePromises: Promise<void>[] = []

  for (const lane of huntLanes) {
    const p = (async () => {
      await sem.acquire()
      try {
        // Class resolution: prefer lane.classes (signal-based) when present,
        // otherwise fall back to collapsing lane.categories through the code→class index
        let laneClasses: string[]
        if (lane.classes && lane.classes.length > 0) {
          laneClasses = lane.classes
        } else {
          const assignedCodes = lane.categories.map(c => c.code)
          laneClasses = codesToClasses(assignedCodes)
        }
        console.log(`\n[HUNT] Lane: ${lane.lane_id} | File: ${lane.target_file} | Classes: ${laneClasses.join(', ')}`)
        console.log(`  [${lane.lane_id}] ${lane.file_lines} lines, ${lane.file_bytes.toLocaleString()} bytes`)
        console.log(`  [${lane.lane_id}] Chunk plan: ${lane.chunk_plan.required ? lane.chunk_plan.total_chunks + ' chunks' : 'single pass'}`)

        const playbooks = await loadPlaybooksForClasses(laneClasses)
        console.log(`  [${lane.lane_id}] Loaded ${playbooks.size} playbook module(s): ${Array.from(playbooks.keys()).join(', ')}`)

        const t0 = Date.now()
        const result = await huntLane(client, lane, assignments.target_dir, laneClasses, playbooks, archSnippet, archSummaryFull)
        const elapsed = (Date.now() - t0) / 1000

        allFindings.push(...result.findings)
        classSweeps.push(result.sweep)

        consumptionReport.push({
          lane_id: lane.lane_id,
          tokens_used: result.tokensUsed,
          seconds_elapsed: elapsed,
          ceiling_hit: false,
        })

        // Build per-lane v2 record
        const laneTotalsPrompt = result.chunkRecords.reduce(
          (s, c) => s + (c.measured.prompt_tokens ?? 0), 0)
        const laneTotalsCompletion = result.chunkRecords.reduce(
          (s, c) => s + (c.measured.completion_tokens ?? 0), 0)
        const laneTotalsTotal = result.chunkRecords.reduce(
          (s, c) => s + (c.measured.total_tokens ?? 0), 0)
        const hasAllMeasured = result.chunkRecords.length > 0 &&
          result.chunkRecords.every(c => c.measured.prompt_tokens != null && c.measured.completion_tokens != null && c.measured.total_tokens != null)

        laneRecordsV2.push({
          lane_id: lane.lane_id,
          target_file: lane.target_file,
          file_bytes: lane.file_bytes,
          chunk_count: result.chunkRecords.length,
          chunks: result.chunkRecords,
          lane_totals: {
            prompt_tokens: hasAllMeasured ? laneTotalsPrompt : null,
            completion_tokens: hasAllMeasured ? laneTotalsCompletion : null,
            total_tokens: hasAllMeasured ? laneTotalsTotal : null,
          },
        })

        console.log(`  [${lane.lane_id}] → ${result.findings.length} finding(s), ${result.tokensUsed.toLocaleString()} tokens, ${elapsed.toFixed(1)}s total`)

        // ── Checkpoint: write results immediately after each lane ─────────
        writeCheckpoint(outDir, allFindings, consumptionReport, classSweeps)
      } catch (err: any) {
        console.error(`  [${lane.lane_id}] [FATAL] Lane failed: ${err.message ?? err}`)
        // Marked failed, not merely zero-token. Without the flag this entry is
        // indistinguishable from a skip lane, and loadCheckpoint would treat
        // the lane as done — so a resume would skip it for good and the run
        // would report success while missing it.
        consumptionReport.push({
          lane_id: lane.lane_id,
          tokens_used: 0,
          seconds_elapsed: 0,
          ceiling_hit: false,
          failed: true,
          failure_reason: String(err?.message ?? err).slice(0, 300),
        })
        writeCheckpoint(outDir, allFindings, consumptionReport, classSweeps)
      } finally {
        sem.release()
      }
    })()
    lanePromises.push(p)
  }

  await Promise.all(lanePromises)

  // Also report skip lanes with zero consumption — but only once. On a resume
  // the carried-forward checkpoint already holds them, and pushing again gave
  // every skip lane a duplicate entry. reconcileV2() builds its lane map with
  // Map.set(), so a duplicate silently overwrites rather than erroring.
  const alreadyReported = new Set(consumptionReport.map(c => c.lane_id))
  for (const lane of skipLanes) {
    if (alreadyReported.has(lane.lane_id)) continue
    consumptionReport.push({
      lane_id: lane.lane_id,
      tokens_used: 0,
      seconds_elapsed: 0,
      ceiling_hit: false,
    })
  }

  // Final legacy write (includes skip lanes in consumption)
  writeCheckpoint(outDir, allFindings, consumptionReport, classSweeps)

  // ── v2 budget consumption output ────────────────────────────────────────
  const totalSourceBytes = laneRecordsV2.reduce((s, l) => s + l.file_bytes, 0)
  const rollup = buildRunLevelRollup(laneRecordsV2, totalSourceBytes)

  const v2Output: BudgetConsumptionV2 = {
    generated_at: new Date().toISOString(),
    provider: PROVIDER,
    // The model that actually ran. createClient() throws when the credential is
    // missing, so reaching this line means every call went to MODEL.
    model: MODEL,
    lanes: laneRecordsV2,
    rollup,
    legacy_entries: consumptionReport,
  }

  const v2Path = join(outDir, 'budget-consumption.json')
  const v2Tmp = v2Path + '.tmp'
  writeFileSync(v2Tmp, JSON.stringify(v2Output, null, 2) + '\n')
  renameSync(v2Tmp, v2Path)

  writeMeta(PROVIDER, 'stage2-hunt-lanes-perfile', MODEL, STARTED, 0, guardStats().blocked)

  console.log('\n=== Stage 2 (Per-File v2) Complete ===')
  console.log(`Provider/model: ${PROVIDER} / ${MODEL}`)
  console.log(`Total candidate findings: ${allFindings.length}`)
  console.log(`Lanes processed: ${huntLanes.length} hunt, ${skipLanes.length} skip`)
  console.log(`Total tokens: ${consumptionReport.reduce((s, r) => s + r.tokens_used, 0).toLocaleString()}`)
  console.log(`Output: ${join(outDir, 'candidate-findings.json')}`)
  console.log(`Output: ${join(outDir, 'class-sweep.json')}`)

  // ── Sweep coverage banner ───────────────────────────────────────────────
  // The whole point of the sweep is that "checked and clean" becomes
  // distinguishable from "never looked". Print that distinction at the end of
  // the run so it does not have to be recovered from the artifact afterwards.
  const sweptLanes = classSweeps.filter(s2 => s2.sweep.length > 0).length
  const assignedPairs = classSweeps.reduce((n, s2) => n + s2.assigned_classes.length, 0)
  const sweptPairs = classSweeps.reduce((n, s2) => n + s2.sweep.length, 0)
  const foundPairs = classSweeps.reduce(
    (n, s2) => n + s2.sweep.filter(e => e.verdict === 'found').length, 0)
  const lanesMissing = classSweeps.filter(s2 => s2.missing_classes.length > 0).length
  const lanesInconsistent = classSweeps.filter(s2 => s2.inconsistent_classes.length > 0).length
  const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : 'n/a'
  console.log(`Class sweep: ${sweptLanes}/${classSweeps.length} lanes swept`)
  console.log(`  lane-class pairs assigned : ${assignedPairs}`)
  console.log(`  ... swept                 : ${sweptPairs} (${pct(sweptPairs, assignedPairs)})`)
  console.log(`  ... verdict "found"       : ${foundPairs} (${pct(foundPairs, assignedPairs)} of assigned)`)
  console.log(`  lanes with a missing class      : ${lanesMissing}`)
  console.log(`  lanes with an inconsistent class: ${lanesInconsistent}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Stage 2 (Per-File v2) failed:', err)
    process.exit(1)
  })
}
