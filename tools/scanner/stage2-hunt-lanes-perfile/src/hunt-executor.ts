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
import { resolveProvider, modelFor, tokenLimitParam, samplingParams, outputTokenCap } from '../../shared/provider.js'
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
  TraceStep,
  FindingClassRef,
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../..')

const PROVIDER: Provider = resolveProvider('stage2perfile')
const MODEL = modelFor(PROVIDER)

/**
 * Output-token cap for a hunt call when the registry does not set one.
 *
 * 8000 was ample for every run to date, all of which sent no reasoning_effort
 * and so ran at the endpoint's default. It is not ample at a higher effort:
 * reasoning tokens are billed as output AND counted against this cap, so the
 * body gets truncated once reasoning grows into it — and a truncated body is
 * unparseable JSON, which this stage records as a lane that found nothing
 * rather than as a failure. A target that raises the effort raises the cap in
 * the same registry entry; see max_output_tokens in models.json.
 */
export const DEFAULT_OUTPUT_TOKEN_CAP = 8000
const OUTPUT_TOKEN_CAP = outputTokenCap(PROVIDER, DEFAULT_OUTPUT_TOKEN_CAP)
const STARTED = new Date().toISOString()

// ── Per-lane agent loop ───────────────────────────────────────────────────
/**
 * A lane may answer in more than one turn. `none` is the historic behaviour —
 * one structured completion per chunk — and is what every scored run to date
 * used; it is the default and its code path is unchanged.
 *
 * The other modes continue the SAME conversation rather than building a fresh
 * prompt. That is deliberate on two counts. It is what an agent loop actually
 * is: the model can see what it already said and revise it. And it is the cheap
 * option — the file, the playbooks and the architecture context are already in
 * the transcript, so a follow-up turn adds only its own instruction plus the
 * assistant message, instead of re-sending an ~8k-token prompt.
 *
 *   none     one turn (baseline)
 *   trace    + one turn asking for the intermediate lines of each trace
 *   gap      + one turn asking only for defects the first turn did not report
 *   reflect  + one turn asking for both, in that order
 *   sweep    re-hunts the lane in class groups, one conversation per group
 *
 * `HUNT_LOOP_PASSES` bounds the follow-up turns for the conversational modes
 * (default 1). With more than one, the loop stops early as soon as a turn adds
 * nothing new — an unproductive turn is the natural termination signal, and
 * paying for a second one has no upside.
 *
 * `HUNT_SWEEP_GROUP` is the number of classes per group in `sweep` mode.
 *
 * Findings are UNIONED across turns, never replaced: a later turn can add a
 * finding or add lines to one, and cannot delete either. Recall is the metric
 * this loop exists to move, and union is the only merge rule that cannot lose
 * a hit the first turn already had. The cost is precision, which v2 has no
 * validator to recover — see docs/protocols/eval-howto.md §3.
 */
export type LoopMode = 'none' | 'trace' | 'gap' | 'reflect' | 'sweep'
const LOOP_MODES: LoopMode[] = ['none', 'trace', 'gap', 'reflect', 'sweep']

const LOOP_MODE: LoopMode = (() => {
  const raw = process.env.HUNT_LOOP
  if (!raw) return 'none'
  if ((LOOP_MODES as string[]).includes(raw)) return raw as LoopMode
  throw new Error(`HUNT_LOOP="${raw}" is not one of: ${LOOP_MODES.join(', ')}`)
})()

/**
 * A positive integer from the environment, or the fallback when unset.
 *
 * Deliberately stricter than parseInt: `parseInt("1e5")` is 1, which as an
 * output-token cap silently truncates every response and reads downstream as
 * "the model found nothing" rather than as a misconfiguration. An empty string
 * is a typo, not a request for the default, and is rejected too.
 */
function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^[0-9]+$/.test(raw.trim()) || Number(raw.trim()) <= 0) {
    throw new Error(`${name}="${raw}" is not a positive integer`)
  }
  return Number(raw.trim())
}

const LOOP_PASSES = positiveEnvInt('HUNT_LOOP_PASSES', 1)
const SWEEP_GROUP_SIZE = positiveEnvInt('HUNT_SWEEP_GROUP', 3)

/**
 * Use the stricter wording of the trace-completion instruction, which requires
 * each added line to be justified in its description and blesses re-emitting an
 * already-complete trace unchanged.
 *
 * Off by default because it was measured and it costs more than it saves — see
 * the comment at the wording itself in buildFollowUpTurn().
 */
const LOOP_STRICT_TRACE = process.env.HUNT_LOOP_STRICT_TRACE === '1'

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

/**
 * Redact PEM private key material without changing the file's line count.
 *
 * The line count is load-bearing. Every line number shown to the model, and
 * every chunk boundary in the lane's chunk plan, is computed from the
 * *unredacted* file — Stage 0.5 counts lines before Stage 2 ever redacts. If
 * redaction changes the count, two things break at once: the numbers the model
 * is told to cite no longer correspond to the file the scorer reads, and the
 * chunk plan's end_line truncates or overruns the content.
 *
 * That is not hypothetical. The earlier version replaced the key body with
 * "\n[REDACTED…]\n", which turned the corpus's single-line key declaration into
 * three lines. In run 5 that made `lib/insecurity.ts` 196 -> 198 lines, so every
 * line from the key onward was displayed to the model **2 higher than its true
 * number**, and slicing to the manifest's end_line of 196 silently dropped the
 * file's last 2 lines. Every finding that file produced below the key was
 * mis-scored by +2.
 *
 * So: keep the markers, drop the key bytes, and re-emit exactly as many newlines
 * as the removed body contained.
 */
export function sanitizePemPrivateKey(content: string): string {
  return content.replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    (_match, beginMarker: string, body: string, endMarker: string) => {
      const newlines = (body.match(/\n/g) ?? []).length
      return beginMarker + '[REDACTED: private key material]' + '\n'.repeat(newlines) + endMarker
    }
  )
}

export function lineNumberContent(content: string, startLine: number): string {
  const lines = content.split('\n')
  const totalLines = startLine + lines.length - 1
  const pad = String(totalLines).length
  return lines.map((line, i) => {
    const lineNum = startLine + i
    return `${String(lineNum).padStart(pad)}: ${line}`
  }).join('\n')
}

// ── Playbook loading and validation ───────────────────────────────────────

export async function loadPlaybooksForClasses(classIds: string[]): Promise<Map<string, string>> {
  const loaded = new Map<string, string>()
  for (const classId of classIds) {
    const entry = loadRegistry()[classId]
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

Subject to that, report what you see. An empty array is a strong claim — it says this file contains no weak control, no unvalidated input reaching a dangerous operation, and no defect of any assigned class. Most files in a real application do contain something. If you are about to return an empty array, re-read the file once against your assigned class list before you do.

List every class from your assigned classes list that this finding establishes. There is no limit on how many, and the classes are not mutually exclusive — naming one never rules out another.

Do not hold back. If you have some or enough evidence that more than one assigned class is involved, name them all. One statement is often several classes at once: a query that interpolates caller-controlled input while also comparing a password hashed with a broken algorithm is an injection finding and a crypto-auth finding, on the same line and the same trace. A render sink reached by attacker-controlled data is both an injection and a client-side finding. Choosing the single best label discards the others and gains nothing — a class you can see and do not name is a class you did not find.

For each class you list, give the index of the trace step that establishes it.

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

// ── Agent-loop follow-up turns ────────────────────────────────────────────

/**
 * Compact rendering of what the lane has reported so far.
 *
 * The findings are already in the transcript as the assistant's own JSON, so
 * this is not the model's only view of them. It is here because after two or
 * three turns that JSON is far up the context and interleaved with reasoning;
 * restating the current union as a short numbered list is what makes "do not
 * repeat these" and "complete these" unambiguous.
 */
function renderReportedSoFar(findings: CandidateFinding[]): string {
  if (findings.length === 0) return '(nothing yet)'
  return findings
    .map((f, i) => {
      const cls = f.finding_classes.map(c => c.class).join(', ')
      const lines = f.trace.map(s => s.line).join(', ')
      return `${i + 1}. [${cls}] ${f.title} — trace lines ${lines}`
    })
    .join('\n')
}

/**
 * The instruction for a follow-up turn.
 *
 * TRACE targets the largest measured residual pool. Run 5's cold near-miss
 * pool was 28 entries that already carried the right class and already sat
 * within the localization window, failing only the exact-line test — and in 16
 * of them the line the scorer wanted lay strictly INSIDE the span the finding
 * had already cited, uncited, because the trace named its endpoints and skipped
 * the path between them (median 3 lines named across a median span of 11).
 * Asking for the intermediate lines is therefore a completeness request about
 * a path the model has already drawn, not a relocation request. That
 * distinction matters: the one instruction that told the model to *move* a
 * step to a narrower line was measured and falsified — it broke four exact
 * hits to fix three.
 *
 * GAP targets emission. Across scored runs the model emits about a third of
 * the classes a lane is assigned, and no run has ever asked it a second time.
 * The turn is deliberately non-binding — it may not suppress an earlier
 * finding — because run 4 made a per-class sweep authoritative over labelling
 * and lost 20 hits to it.
 */
export function buildFollowUpTurn(
  mode: Exclude<LoopMode, 'none' | 'sweep'>,
  classes: string[],
  reported: CandidateFinding[],
  strictTrace: boolean = LOOP_STRICT_TRACE,
): string {
  const unreported = classes.filter(
    c => !reported.some(f => f.finding_classes.some(fc => fc.class === c)))

  const soFar = `## Index of what this lane has reported so far
This is an index, not the findings themselves — titles, classes and cited lines only.
Your own JSON above is the record; work from that.

${renderReportedSoFar(reported)}
`

  // Two wordings of the same request, and the difference between them is the
  // largest single effect measured in this investigation — larger than the
  // reasoning effort. The default is the one that was measured to work.
  //
  // STRICT adds what a review correctly identified as the missing guard: every
  // scored metric is monotone in trace length, so nothing in the default
  // wording stops the model padding a trace until it hits something. STRICT
  // attaches a justification cost to each added line and blesses re-emitting an
  // already-complete trace unchanged.
  //
  // It was measured, on the same 40 lanes, and it does not merely remove the
  // padding: recall 66.0% -> 52.6%, localization 84.5% -> 71.1%, below a
  // mechanical inflation of the loop-free control to the same line budget. So
  // the guard as written suppresses the completion the loop exists to produce.
  // It is kept, behind a flag, because the concern it addresses is real and the
  // right wording is probably between the two — but the default has to be the
  // one with a measurement behind it. See docs/architecture/stage2-lane-loop.md §5.
  const completeTraces = strictTrace
    ? `### 1. Name the lines each finding's path actually passes through
For each finding, the trace should name every line the value or the control decision
passes through between its entrypoint and its sink: each reassignment of it, each call
that forwards it, each conditional whose outcome decides whether it reaches the sink,
each transformation applied to it. A trace that names only its two endpoints asserts
that nothing happens to the value in between, and the line someone has to change is
often one of the ones skipped.

Two limits on that, and they matter as much as the request:

- **This is an addition, not a relocation.** Keep every finding and keep the line you
  already chose for each step. Do not move a step to a different line and do not drop
  one.
- **A line is a step only if the path goes through it.** Every line you add must be one
  the value or the control decision actually passes through, and its description must
  say what that line does to it — the assignment, the call, the branch it turns on. If
  you cannot say what a line does to the value, it is not a step; leave it out. A line
  that carries no part of the path makes the finding harder to act on, not stronger.

Some findings are genuinely two lines: a hardcoded constant, a weak algorithm chosen in
one place, a single missing check. When a trace is already complete, say so in the sink
step's description and re-emit it exactly as it is. You are not being asked to lengthen
every trace.`
    : `### 1. Complete the path of every finding above
For each finding, the trace must name **every** line the value or the control decision
actually passes through between its entrypoint and its sink: each reassignment, each
call that forwards it, each conditional that lets it continue, each transformation
applied to it. A trace that names only its two endpoints asserts that the defect is
those two lines alone, which is rarely true — the line someone has to change is
usually one of the ones in between.

Keep every finding and keep the line you already chose for each step. This is an
addition, not a relocation: do not move a step to a different line, and do not drop a
step. Add the lines you skipped.`

  const findMissed = `### ${mode === 'reflect' ? '2' : '1'}. Report what you did not report
Work through your assigned class list one class at a time: ${classes.join(', ')}.
For each class in turn, ask whether this file contains an instance of it that is not
already in the index above. A class you considered and rejected on the first pass is
worth reconsidering now — you have the whole file in front of you and you know what you
already claimed.${unreported.length ? `

No finding yet carries any of these assigned classes: ${unreported.join(', ')}. Start
there.` : ''}

"Not already in the index" means a different defect, not a different location. Two
distinct defects on the same lines are two findings; only the same defect found again
is a repeat.

You are not being asked to manufacture an instance — if a class has nothing in this
file, report nothing for it. But "I cannot confirm this from this file alone" is not
nothing: that is a 0.1-0.3 finding, and the confidence bands from the first pass still
apply. Report it low rather than not at all.

Every new finding's trace must still begin with an \`entrypoint\` step and end with a
\`sink\` step, exactly as on the first pass. If the real entrypoint is outside this
file, make the first step the line where this file receives the data, mark it
\`entrypoint\`, and say so in its description.

Nothing here overrides the first pass. You cannot withdraw a finding above by not
repeating it, and a class you now judge absent stays on any finding that already
carries it.`

  const header = `${soFar}\nThis is another pass over the same file. `

  const body =
    mode === 'trace' ? `${header}One job.\n\n${completeTraces}`
    : mode === 'gap' ? `${header}One job.\n\n${findMissed}`
    : `${header}Two jobs, in this order.\n\n${completeTraces}\n\n${findMissed}`

  const common = `Every trace step must cite a line of the numbered content above, in
that same file, using the line numbers exactly as shown.`

  const output = mode === 'gap'
    ? `\n\n## Output
Respond in the same JSON schema as before, containing **only the new findings**. Do not
restate the findings in the index. If there are none, return an empty "findings" array.
${common}`
    : `\n\n## Output
Respond in the same JSON schema as before: re-emit every finding above, followed by any
new one. When you re-emit a finding, keep its exact title and every line number it
already cites, so it is recognisable as the same finding rather than a new one. Set each
class's \`justified_by_step\` to that class's index in the trace you are emitting now.
${common}`

  return body + output
}

/**
 * Merge a follow-up turn's findings into the accumulated set.
 *
 * A returned finding is a REVISION of an existing one when it shares a class
 * and either kept the exact title it was told to keep or agrees on two cited
 * lines. Anything else is a new finding. The two-line floor matters: a shared
 * class and a single shared line is the ordinary shape of a *different* defect
 * entering at the same place, and `gap` mode returns nothing but new findings,
 * so a looser rule absorbs them — losing their sink and their title while
 * reporting that nothing was added.
 *
 * A revision adds the lines the accumulated finding did not have and changes
 * nothing else about it. Every existing step keeps its line, its kind and its
 * position, because a trace may legitimately repeat a line and may legitimately
 * run backwards — a helper defined below its call site — and deduplicating or
 * line-sorting the whole trace would delete and reorder cited evidence. New
 * steps go in line order between the existing entrypoint and sink, and the
 * sink's `justified_by_step` references are re-anchored to follow it.
 *
 * Nothing is ever removed: not a finding, not a class, not a cited line. See
 * the LoopMode comment for why that is the only safe rule here.
 */
export function mergeFindings(
  accumulated: CandidateFinding[],
  incoming: CandidateFinding[],
): { merged: CandidateFinding[]; added: number; revised: number } {
  // Deep enough that nothing the caller passed in is ever mutated: the merge
  // rewrites step kinds and re-anchors justified_by_step, both of which would
  // otherwise reach back into the previous turn's arrays.
  const clone = (f: CandidateFinding): CandidateFinding => ({
    ...f,
    trace: f.trace.map(s => ({ ...s })),
    finding_classes: f.finding_classes.map(c => ({ ...c })),
    categories: [...f.categories],
  })
  const out = accumulated.map(clone)
  let added = 0
  let revised = 0

  for (const f of incoming) {
    const fClasses = new Set(f.finding_classes.map(c => c.class))

    // Identity. A shared class plus a single shared line is far too loose: a
    // genuinely new defect that happens to enter at the same line — the common
    // shape in `gap` mode, which returns only new findings — would be absorbed
    // into an existing one, losing its own sink and its title while reporting
    // itself as nothing added. Require the turn to look like a re-emission:
    // either it kept the title it was told to keep, or it agrees on two lines.
    let bestIdx = -1
    let bestScore = 0
    for (let i = 0; i < out.length; i++) {
      const g = out[i]
      if (!g.finding_classes.some(c => fClasses.has(c.class))) continue
      const gLines = new Set(g.trace.map(s => s.line))
      const overlap = [...new Set(f.trace.map(s => s.line))].filter(l => gLines.has(l)).length
      if (overlap === 0) continue
      const sameTitle = g.title.trim() === f.title.trim()
      if (overlap < 2 && !sameTitle) continue
      const score = overlap * 2 + (sameTitle ? 1 : 0)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    if (bestIdx < 0) {
      out.push({ ...f, trace: [...f.trace], finding_classes: [...f.finding_classes] })
      added++
      continue
    }

    // Extension. Every step the accumulated finding already had is kept exactly
    // as it was — same line, same kind, same order. A trace may legitimately
    // repeat a line and may legitimately run backwards (a helper defined below
    // its call site), so deduplicating or line-sorting the whole trace would
    // silently delete and reorder cited evidence. Only genuinely new lines are
    // added, and they are inserted in line order between the existing
    // entrypoint and sink so the shape the schema validation enforced still
    // holds.
    const g = out[bestIdx]
    const present = new Set(g.trace.map(s => s.line))
    const fresh: TraceStep[] = []
    for (const s of f.trace) {
      if (present.has(s.line)) continue
      present.add(s.line)
      fresh.push({ ...s, kind: 'propagation' })
    }
    fresh.sort((a, b) => a.line - b.line)

    if (fresh.length > 0) {
      const oldLastIdx = g.trace.length - 1
      if (oldLastIdx === 0) {
        // Defensive: normalizeTurnFindings requires the first step to be an
        // entrypoint and the last a sink, which a one-step trace cannot satisfy,
        // so this is unreachable today. Keep the invariant anyway rather than
        // emitting a trace that ends on a propagation step.
        g.trace = [g.trace[0], ...fresh]
        g.trace[g.trace.length - 1] = { ...g.trace[g.trace.length - 1], kind: 'sink' }
      } else {
        g.trace = [...g.trace.slice(0, oldLastIdx), ...fresh, g.trace[oldLastIdx]]
      }
      const newLastIdx = g.trace.length - 1
      // Only the sink's index moved; every earlier step kept its position, so
      // this is the whole of the re-anchoring `justified_by_step` needs.
      for (const c of g.finding_classes) {
        if (c.justified_by_step === oldLastIdx) c.justified_by_step = newLastIdx
      }
      revised++
    }

    for (const c of f.finding_classes) {
      if (!g.finding_classes.some(e => e.class === c.class)) {
        // The step index the incoming turn cited indexes ITS trace, not the
        // merged one. Re-anchoring it correctly is not possible in general, and
        // an out-of-range index is clamped downstream anyway, so pin it to the
        // sink — the step every class in this finding is at least reachable from.
        g.finding_classes.push({ class: c.class, justified_by_step: Math.max(0, g.trace.length - 1) })
      }
    }

    // `categories` is the OWASP-code expansion of `finding_classes`, and it is
    // what category-aware scoring reads. It is computed once per turn in
    // normalizeTurnFindings, so a class the merge adds here would otherwise
    // carry no codes — the loop would correctly notice that a finding is also a
    // crypto-auth defect and the codes would not follow it. Re-expand.
    g.categories = unionCodesForClasses(g.finding_classes, loadRegistry())

    if (g.description.length < f.description.length) g.description = f.description
    g.confidence = Math.max(g.confidence, f.confidence)
  }

  return { merged: out, added, revised }
}

/** Split a lane's assigned classes into fixed-size groups for `sweep` mode. */
export function classGroups(classes: string[], size: number): string[][] {
  const groups: string[][] = []
  for (let i = 0; i < classes.length; i += size) groups.push(classes.slice(i, i + size))
  return groups
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

type ChatMessage = { role: 'user' | 'assistant'; content: string }

async function callLlm(
  client: OpenAI,
  messages: ChatMessage[],
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
        messages: messages,
        ...samplingParams(PROVIDER),
        ...tokenLimitParam(PROVIDER, OUTPUT_TOKEN_CAP),
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
            messages: messages,
            ...samplingParams(PROVIDER),
            ...tokenLimitParam(PROVIDER, OUTPUT_TOKEN_CAP),
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

export async function huntLane(
  client: OpenAI,
  lane: LaneAssignmentEntry,
  targetDir: string,
  classIds: string[],
  playbooks: Map<string, string>,
  archSummarySnippet?: string,
  archSummary?: { route_table: { hand_written_routes: any[]; auto_crud_routes: any[]; middleware_routes?: any[] } },
): Promise<{
  findings: CandidateFinding[];
  tokensUsed: number;
  chunkRecords: ChunkTokenRecord[];
}> {
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
    return { findings: [], tokensUsed: 0, chunkRecords: [] }
  }
  const sanitized = sanitizePemPrivateKey(rawContent)

  // Compute per-lane route context (once, not per-chunk)
  const routeContext = archSummary
    ? matchRoutesForFile(lane.target_file, rawContent, archSummary)
    : { handWritten: [], autoCrud: [] }
  let routeContextSection = renderRouteContext(routeContext)

  // A file can both declare registrations and export handlers. The registrar
  // block goes first because it is the one carrying line numbers.
  const registrarSection = archSummary
    ? renderRegistrarRouteContext(lane.target_file, archSummary.route_table)
    : undefined
  if (registrarSection) {
    routeContextSection = routeContextSection
      ? `${registrarSection}\n\n${routeContextSection}`
      : registrarSection
  }

  const allFindings: CandidateFinding[] = []
  let totalTokens = 0
  const chunkRecords: ChunkTokenRecord[] = []

  const chunks = lane.chunk_plan.chunks
  if (chunks.length === 0 && lane.disposition === 'hunt') {
    console.warn(`  [${lane.lane_id}] [WARN] No chunks but disposition is "hunt"`)
    return { findings: [], tokensUsed: 0, chunkRecords: [] }
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
    const result = await callLlm(
      client, [{ role: 'user', content: huntResult.prompt }], schema, lane.lane_id)
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

    const turnFindings = normalizeTurnFindings(result.text, lane, classIds, `chunk ${chunk.index}`)
    for (const f of turnFindings) allFindings.push(f)
    // Only under a loop mode. A `none` run must write the same six-key chunk
    // record it has always written, or every archived budget-consumption.json
    // stops being comparable to a fresh reproduction of the run that made it.
    if (LOOP_MODE !== 'none') {
      chunkRecords[chunkRecords.length - 1].findings_emitted = turnFindings.length
    }

    // ── Follow-up turns ───────────────────────────────────────────────────
    // The conversation carries the file, the playbooks and the context that
    // turn 1 already paid for, so a follow-up turn adds only the assistant
    // message and its own instruction.
    if (LOOP_MODE !== 'none' && LOOP_MODE !== 'sweep') {
      const messages: ChatMessage[] = [
        { role: 'user', content: huntResult.prompt },
        { role: 'assistant', content: result.text },
      ]
      let accumulated = turnFindings

      for (let pass = 1; pass <= LOOP_PASSES; pass++) {
        const instruction = buildFollowUpTurn(LOOP_MODE, classIds, accumulated)
        messages.push({ role: 'user', content: instruction })

        const tPass = Date.now()
        const followUp = await callLlm(client, messages, schema, lane.lane_id)
        const passElapsed = (Date.now() - tPass) / 1000
        if (!followUp) {
          console.error(`  [${lane.lane_id}] [ERROR] chunk ${chunk.index} pass ${pass} LLM call failed`)
          // The call was made and may have been billed. Record it with null
          // measurements, exactly as a failed turn-1 call is recorded, so the
          // consumption artifact has one entry per call attempted.
          const breakdown = followUpBreakdown(messages, instruction)
          chunkRecords.push({
            chunk_index: chunk.index,
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            loop_pass: pass,
            loop_mode: LOOP_MODE,
            prompt_breakdown: breakdown,
            segment_attribution: deriveSegmentAttribution(
              breakdown, { prompt_tokens: null, completion_tokens: null, total_tokens: null }),
            measured: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
          })
          break
        }

        totalTokens += followUp.measured.total_tokens ?? 0
        const breakdown = followUpBreakdown(messages, instruction)
        chunkRecords.push({
          chunk_index: chunk.index,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          loop_pass: pass,
          loop_mode: LOOP_MODE,
          prompt_breakdown: breakdown,
          segment_attribution: deriveSegmentAttribution(breakdown, followUp.measured),
          measured: followUp.measured,
        })

        const incoming = normalizeTurnFindings(
          followUp.text, lane, classIds, `chunk ${chunk.index} pass ${pass}`)
        const { merged, added, revised } = mergeFindings(accumulated, incoming)
        accumulated = merged
        messages.push({ role: 'assistant', content: followUp.text })
        Object.assign(chunkRecords[chunkRecords.length - 1], {
          findings_emitted: incoming.length, findings_added: added, traces_extended: revised,
        })

        console.log(
          `  [${lane.lane_id}] chunk ${chunk.index} pass ${pass} (${LOOP_MODE}): ` +
          `${(followUp.measured.total_tokens ?? 0).toLocaleString()} tokens, ` +
          `${passElapsed.toFixed(1)}s, +${added} new, ${revised} traces extended`)

        // An unproductive turn is the termination signal: the model has said it
        // has nothing further, and a further turn costs the same and returns the
        // same. Stop rather than spend the remaining passes.
        if (added === 0 && revised === 0) break
      }

      // Replace this chunk's turn-1 findings with the accumulated union.
      allFindings.length -= turnFindings.length
      for (const f of accumulated) allFindings.push(f)
    }

    // ── sweep mode ──────────────────────────────────────────────────────────
    // A separate conversation per class group, each carrying only that group's
    // playbooks. This is the one mode that is not a follow-up turn: it re-hunts
    // the same chunk with a narrower question, on the measured finding that a
    // lane assigned 8.22 classes answers about the two or three that dominate
    // the file.
    if (LOOP_MODE === 'sweep') {
      let accumulated = turnFindings
      for (const group of classGroups(classIds, SWEEP_GROUP_SIZE)) {
        const groupPlaybooks = new Map<string, string>()
        for (const [name, text] of playbooks) {
          if (group.some(c => loadRegistry()[c]?.playbook === name)) groupPlaybooks.set(name, text)
        }
        const built = buildHuntPrompt(
          lane.target_file, lineNumbered, group, groupPlaybooks,
          { chunkIndex: chunk.index, totalChunks: lane.chunk_plan.total_chunks },
          archSummarySnippet, routeContextSection,
        )
        const tGroup = Date.now()
        const res = await callLlm(
          client, [{ role: 'user', content: built.prompt }], buildHuntSchema(group), lane.lane_id)
        // The group is named in the record. Per-group cost and yield is the one
        // question sweep mode exists to answer, and it is unanswerable if every
        // group's record is indistinguishable from every other's.
        const groupMode = `sweep:${group.join('+')}`
        const nullMeasured = { prompt_tokens: null, completion_tokens: null, total_tokens: null }
        if (!res) {
          console.error(`  [${lane.lane_id}] [ERROR] sweep group ${group.join('+')} failed`)
          // The call was made and may have been billed — record it, as a failed
          // turn-1 call is recorded, so there is one entry per call attempted.
          chunkRecords.push({
            chunk_index: chunk.index,
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            loop_pass: 1,
            loop_mode: groupMode,
            prompt_breakdown: built.breakdown,
            segment_attribution: deriveSegmentAttribution(built.breakdown, nullMeasured),
            measured: nullMeasured,
          })
          continue
        }
        totalTokens += res.measured.total_tokens ?? 0
        chunkRecords.push({
          chunk_index: chunk.index,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          loop_pass: 1,
          loop_mode: groupMode,
          prompt_breakdown: built.breakdown,
          segment_attribution: deriveSegmentAttribution(built.breakdown, res.measured),
          measured: res.measured,
        })
        const incoming = normalizeTurnFindings(
          res.text, lane, group, `sweep ${group.join('+')}`)
        const { merged, added, revised } = mergeFindings(accumulated, incoming)
        accumulated = merged
        Object.assign(chunkRecords[chunkRecords.length - 1], {
          findings_emitted: incoming.length, findings_added: added, traces_extended: revised,
        })
        console.log(
          `  [${lane.lane_id}] sweep ${group.join('+')}: ` +
          `${(res.measured.total_tokens ?? 0).toLocaleString()} tokens, ` +
          `${((Date.now() - tGroup) / 1000).toFixed(1)}s, +${added} new, ${revised} extended`)
      }
      allFindings.length -= turnFindings.length
      for (const f of accumulated) allFindings.push(f)
    }
  }

  return { findings: allFindings, tokensUsed: totalTokens, chunkRecords }
}

/**
 * Character breakdown of a follow-up turn.
 *
 * The turn's own instruction is the only new text; everything else is the
 * transcript the conversation already carries, and the endpoint re-bills it as
 * input. Attributing it to a `conversation` segment rather than folding it into
 * `boilerplate` keeps the run-level rollup honest about where a loop's input
 * tokens actually go.
 */
function followUpBreakdown(messages: ChatMessage[], instruction: string): PromptBreakdown {
  const carried = messages.reduce((s, m) => s + m.content.length, 0) - instruction.length
  return {
    segments: [
      { segment_type: 'conversation', chars: carried },
      { segment_type: 'loop_instruction', chars: instruction.length },
    ],
    total_chars: carried + instruction.length,
  }
}

/**
 * Parse one turn's response and apply every validation the stage has always
 * applied: trace shape, assigned-class filtering, `justified_by_step` range,
 * and code expansion.
 *
 * Extracted from the turn-1 body unchanged when the agent loop was added, so
 * every turn of a loop is held to exactly the same contract as a single-turn
 * lane. An unparseable body yields no findings, which is what it did before.
 */
function normalizeTurnFindings(
  text: string,
  lane: LaneAssignmentEntry,
  classIds: string[],
  label: string,
): CandidateFinding[] {
  let parsed: LaneHuntResponse
  try {
    parsed = JSON.parse(extractJson(text)) as LaneHuntResponse
  } catch {
    console.log(`  [${lane.lane_id}] [WARN] ${label} returned unparseable content`)
    return []
  }
  if (!parsed.findings || !Array.isArray(parsed.findings)) return []

  const out: CandidateFinding[] = []
  const assignedClassSet = new Set(classIds)

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

    const rawClasses = (f as any).finding_classes
    if (!rawClasses || !Array.isArray(rawClasses) || rawClasses.length === 0) {
      console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" has empty or missing finding_classes — dropping`)
      continue
    }

    const validFindingClasses: FindingClassRef[] = []
    for (const fc of rawClasses) {
      if (!assignedClassSet.has(fc.class)) {
        console.log(`  [${lane.lane_id}] [WARN] Finding "${f.title}" has off-list class "${fc.class}" — skipping that class`)
        continue
      }
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

    const categories = unionCodesForClasses(validFindingClasses, loadRegistry())
    if (categories.length === 0) {
      console.error(`  [${lane.lane_id}] [FATAL] Finding "${f.title}" has empty categories after class expansion — this is a bug`)
      process.exit(1)
    }

    out.push({
      finding_id: nextFindingId(),
      lane_id: lane.lane_id,
      finding_classes: validFindingClasses,
      categories,
      title: f.title,
      description: f.description,
      trace: f.trace,
      severity_estimate: f.severity_estimate,
      confidence: f.confidence,
    })
  }
  return out
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
 * Render the route and middleware registrations a file DECLARES.
 *
 * `matchRoutesForFile()` below matches routes to a file by that file's exported
 * symbols, which serves handler files and starves the file that registers the
 * routes — it exports none of the handlers it mounts, so it matches nothing. In
 * run 5 the registrar file received zero characters of route context while
 * Stage 0 already held every registration it makes, each with a declaring file,
 * an exact line, and its auth middleware.
 *
 * This is a lookup, not a judgement: the model is told which line each
 * registration is on and whether a guard is attached, instead of being asked to
 * work it out from the file and then pick a line to blame.
 *
 * Deliberately additive — it does not change `matchRoutesForFile()` or
 * `renderRouteContext()`, so the lanes that already receive route context
 * receive byte-identical text and the change stays single-variable.
 */
export function renderRegistrarRouteContext(
  targetFileRel: string,
  routeTable: {
    hand_written_routes?: any[]
    middleware_routes?: any[]
  },
): string | undefined {
  // Stage 0 records the declaring file as a repo-relative corpus path
  // ("target-apps/<app>/server.ts"); the lane carries the corpus-relative one
  // ("server.ts"). Accept either, and require a path-segment boundary so
  // "server.ts" cannot match "vendor/fake-server.ts".
  const declaredHere = (routes: any[] | undefined) =>
    (routes ?? []).filter((r) => {
      if (typeof r.file !== 'string') return false
      return r.file === targetFileRel || r.file.endsWith(`/${targetFileRel}`)
    })

  const hw = declaredHere(routeTable.hand_written_routes)
  const mw = declaredHere(routeTable.middleware_routes)
  if (hw.length === 0 && mw.length === 0) return undefined

  const authOf = (r: any) =>
    r.auth === null || r.auth === undefined || r.auth === '' || r.auth === 'none' ? 'none' : String(r.auth)
  const isUnguarded = (r: any) => authOf(r) === 'none'

  const lines: string[] = []
  lines.push('## Routes And Middleware Declared In This File')
  lines.push('This file is where the application registers the routes below. Each entry is given with the')
  lines.push('exact line of its registration and the authentication or authorization middleware attached to')
  lines.push('it, exactly as the application declares it. "auth: none" means no authentication or')
  lines.push('authorization middleware is applied to that registration.')
  lines.push('')
  lines.push("When a finding concerns one of these registrations, cite that registration's own line.")
  lines.push('')

  const fmt = (r: any) => {
    const method = String(r.method ?? '?').padEnd(6)
    const path = String(r.path ?? '?').padEnd(38)
    const handler = r.handler ? `  -> ${String(r.handler).replace(/\([^)]*\)$/, '')}()` : ''
    return `  line ${String(r.line ?? '?').padStart(4)}  ${method} ${path} auth: ${authOf(r)}${handler}`
  }

  // Unguarded first: that ordering is the point of the block.
  const unguardedFirst = (a: any, b: any) =>
    (isUnguarded(a) ? 0 : 1) - (isUnguarded(b) ? 0 : 1) || (a.line ?? 0) - (b.line ?? 0)

  if (hw.length > 0) {
    lines.push(`### Route handlers registered here (${hw.length})`)
    for (const r of [...hw].sort(unguardedFirst)) lines.push(fmt(r))
    lines.push('')
  }
  if (mw.length > 0) {
    lines.push(`### Middleware mounted here (${mw.length})`)
    for (const r of [...mw].sort(unguardedFirst)) lines.push(fmt(r))
    lines.push('')
  }

  const unguarded = [...hw, ...mw].filter(isUnguarded).length
  lines.push(
    `${unguarded} of these ${hw.length + mw.length} registrations carry no authentication or authorization middleware.`,
  )
  return lines.join('\n')
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

export function loadArchSummarySnippet(archPath: string): string | undefined {
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
    return { findings, consumption, completedLaneIds }
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
  let archSummaryFull: { route_table: { hand_written_routes: any[]; auto_crud_routes: any[]; middleware_routes?: any[] } } | undefined
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

  const checkpoint = loadCheckpoint(outDir)
  if (checkpoint) {
    allFindings = checkpoint.findings
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
          // Chunks, not calls. A loop mode writes one record per TURN, so
          // counting records here would report every single-chunk lane as
          // multi-chunk and would make buildRunLevelRollup bill each extra turn
          // as "boilerplate re-sent across a multi-chunk lane" — which is
          // exactly what a conversational follow-up does NOT do.
          chunk_count: new Set(result.chunkRecords.map(c => c.chunk_index)).size,
          chunks: result.chunkRecords,
          lane_totals: {
            prompt_tokens: hasAllMeasured ? laneTotalsPrompt : null,
            completion_tokens: hasAllMeasured ? laneTotalsCompletion : null,
            total_tokens: hasAllMeasured ? laneTotalsTotal : null,
          },
        })

        console.log(`  [${lane.lane_id}] → ${result.findings.length} finding(s), ${result.tokensUsed.toLocaleString()} tokens, ${elapsed.toFixed(1)}s total`)

        // ── Checkpoint: write results immediately after each lane ─────────
        writeCheckpoint(outDir, allFindings, consumptionReport)
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
        writeCheckpoint(outDir, allFindings, consumptionReport)
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
  writeCheckpoint(outDir, allFindings, consumptionReport)

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

  // The loop is selected by env var, so `git_sha` cannot distinguish two runs
  // of the same tree under different modes. Record the arm in the artifact —
  // "verify the tree, not the intent" applies to runtime configuration too.
  writeMeta(PROVIDER, 'stage2-hunt-lanes-perfile', MODEL, STARTED, 0, guardStats().blocked, {
    sampling: samplingParams(PROVIDER),
    max_output_tokens: OUTPUT_TOKEN_CAP,
    loop_mode: LOOP_MODE,
    ...(LOOP_MODE !== 'none' ? { loop_passes: LOOP_PASSES } : {}),
    ...(LOOP_MODE === 'sweep' ? { sweep_group_size: SWEEP_GROUP_SIZE } : {}),
  })

  console.log('\n=== Stage 2 (Per-File v2) Complete ===')
  console.log(`Provider/model: ${PROVIDER} / ${MODEL}`)
  console.log(`Total candidate findings: ${allFindings.length}`)
  console.log(`Lanes processed: ${huntLanes.length} hunt, ${skipLanes.length} skip`)
  console.log(`Total tokens: ${consumptionReport.reduce((s, r) => s + r.tokens_used, 0).toLocaleString()}`)
  console.log(`Output: ${join(outDir, 'candidate-findings.json')}`)
  console.log(`Output: ${join(outDir, 'budget-consumption.json')}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Stage 2 (Per-File v2) failed:', err)
    process.exit(1)
  })
}
