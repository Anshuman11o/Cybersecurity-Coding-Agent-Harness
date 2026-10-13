import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { readFileSync } from 'node:fs'
import { normalizeUsage } from '../../shared/pricing.js'
import {
  agentPlaybookRecord, builtinPlaybookRecord, listCachedPlaybooks, readCachedPlaybook,
  writeCachedPlaybook, type PlaybookMeta, type PlaybookRecord,
} from '../../shared/playbook-cache.js'
import {
  validateClassSelection, validateOverlay, type ClassRegistry, type ClassesOverlay, type ClassSelection,
  type OverlayEntry, type SignalClassMap,
} from '../../shared/playbook-overlay.js'

export interface ReconInput {
  architecture: Record<string, any>
  category_applicability: unknown
  file_signals: { files: Record<string, string[]>; target_dir?: string }
  /** Stage 0's already bounded manifest section, not another target-file read. */
  dependency_manifests: string
}
export interface ProposedClass {
  id: string
  framework: string
  codes: string[]
  signals: string[]
  reason: string
}
export interface SelectedBuiltin { id: string; reason: string }
export interface CoverageDecision { reason: string; builtin_classes: SelectedBuiltin[]; classes: ProposedClass[] }
export interface DecisionChange { id: string; why: string }
/** One review turn after the initial decision: what the no-drop union added and restored, or what turn3's prune removed. */
export interface DecisionTurn {
  purpose: string
  added: string[]
  restored: string[]
  removed: string[]
  changes: DecisionChange[]
  web_search_calls: number
  queries: string[]
  source_urls: string[]
  /** turn3 only: ids it returned that were not selected before it, never added. */
  ignored?: string[]
  /** turn3 only: its prune would have left no class, so the set before it was kept. */
  prune_rejected?: 'empty'
}
export interface UsageCall {
  purpose: string
  model: string
  response_id: string | null
  started_at: string
  ended_at: string
  status: string
  served_tier: string | null
  usage: {
    input_tokens: number | null
    input_tokens_details: { cached_tokens: number | null; cache_write_tokens: number | null }
    output_tokens: number | null
    output_tokens_details: { reasoning_tokens: number | null }
  } | null
  queries: string[]
  source_urls: string[]
  web_search_calls: number
}
export interface PlaybookPlan {
  schema: 'secscan.playbook-plan/1'
  created_at: string
  model: string
  searched: boolean
  reason: string
  /** The final decision: the union of the initial decision and turn1/turn2, pruned by turn3. */
  decision: CoverageDecision
  turns: DecisionTurn[]
  loop: { enabled: boolean; max_passes: number; passes_run: number }
  allowed_domains: string[]
  builtin_classes: SelectedBuiltin[]
  /** The run's complete class set: selected built-ins plus additional classes, sorted. */
  selected_classes: string[]
  classes: (ProposedClass & { cache: 'hit' | 'created'; sha256: string })[]
  playbooks: (PlaybookRecord & { revisions?: PlaybookRevisions })[]
}
/** Research attempts behind a cached playbook: the first call plus its revisions, with each output's bytes. */
export interface PlaybookRevisions { attempts: number; sizes: (number | null)[] }
/** The final decision, recorded before any research call so a research failure cannot lose it. */
export interface ClassDecision {
  schema: 'secscan.class-decision/1'
  created_at: string
  model: string
  builtin: string[]
  added: ProposedClass[]
  classes: string[]
  turns: DecisionTurn[]
  loop: PlaybookPlan['loop']
}
export type PlaybookCheck = 'format' | 'sections' | 'size'
export type ResearchCheck = 'json' | PlaybookCheck | 'no_search'
/** Debug record for a research output that failed a check; the stage still fails. */
export interface ResearchFailure {
  class_id: string
  purpose: string
  error: string
  check: ResearchCheck
  byte_size: number | null
  char_size: number | null
  size_bounds: [number, number]
  missing_sections: string[]
  cited_urls_absent_from_search: string[]
  web_search_calls: number
  queries: string[]
  search_source_urls: string[]
  cited_source_urls: string[]
  response_status: string
  output_tokens: number | null
  reasoning_tokens: number | null
  /** The rejected playbook verbatim, or the raw output text when there is no playbook string. */
  playbook_text: string
  /** Present once the first output reached the playbook checks: every attempt, in order. */
  attempts?: ResearchAttempt[]
}
export interface ResearchAttempt { purpose: string; bytes: number | null; problems: PlaybookCheck[] }
export interface AgentOptions {
  recon: ReconInput
  builtins: ClassRegistry
  builtinTexts: Map<string, string>
  signals: SignalClassMap
  model: string
  cacheRoot: string
  allowedDomains?: string[]
  maxOutputTokens: number
  sampling?: Record<string, number | string>
  /** Review turns after the initial decision; main.ts reads the env. Default: on, 1 turn-2 pass. */
  loop?: { enabled: boolean; maxPasses: number }
  create: (request: ResponseCreateParamsNonStreaming, purpose: string) => Promise<Response>
  recordUsage: (call: UsageCall) => void
  recordDecision: (decision: ClassDecision) => void
  recordResearchFailure: (failure: ResearchFailure) => void
  /** One progress line per completed model call. */
  log?: (line: string) => void
}

const object = (properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
})
const strings = { type: 'array', items: { type: 'string' } }
const decisionSchema = (signals: SignalClassMap, builtins: ClassRegistry, turn: boolean) => object({
  reason: { type: 'string' },
  builtin_classes: { type: 'array', items: object({
    id: { type: 'string', enum: Object.keys(builtins) }, reason: { type: 'string' },
  }) },
  classes: { type: 'array', items: object({
    id: { type: 'string' }, framework: { type: 'string' }, codes: strings,
    signals: { type: 'array', minItems: 1, items: { type: 'string', enum: Object.keys(signals.signals) } },
    reason: { type: 'string' },
  }) },
  ...(turn ? { changes: { type: 'array', items: object({ id: { type: 'string' }, why: { type: 'string' } }) } } : {}),
})
const playbookSchema = object({ playbook: { type: 'string' }, source_urls: strings })
// Decision-call tasks. Each follows the shared input prefix built in runPlaybookAgent.
const tasks = {
  coverage: "Select the built-in classes that apply to this target and decide coverage against the built-ins. Return every applicable built-in class in builtin_classes and every additional class needed for this run in classes, including applicable cached classes. Use web search when you judge the built-in classes do not cover a surface recon shows. Reuse cached identifiers.",
  turn1: "Decide which vulnerability classes this target needs. For every built-in class excluded go over the recon evidence behind it: platform, languages, frameworks, dependencies, file signals and category verdicts to reconcile your decision if applicable. Use web tool if applicable to find classes beyond built-ins if applicable. Include a class when the target has the kind of surface it covers. Exclude it only when recon shows that surface is absent, and name what shows it. If the target has a surface no built-in class covers, propose an additional class for it using web tool. Do not drop any class already selected.",
  turn2: "Reconsider every class you did not select: each excluded built-in, and any vulnerability family relevant to this platform that is not yet covered that you can use web tooling to search for. For each one, check recon's data again (platform, languages, frameworks, dependencies, file signals, category verdicts and architecture) and decide whether the target has a surface it applies to. Add it if recon supports it or does not rule it out. Do not drop any class already selected. Return the full updated decision in the same schema. If nothing is added, return the decision unchanged.",
  turn3: "Review every selected class against recon's data. For each, name the recon evidence (signal, dependency, framework, category verdict or architecture element) that shows the target has a surface it applies to. Remove a class when you can name no such evidence. Return the final decision in the same schema, listing each removed class and why.",
}
const researchTask = 'Research this missing class using web_search and produce one generic playbook, using the built-in format. Cite the sources used. Keep the playbook under 8000 bytes.'
// Each bracketed clause of the revision template appears only when that problem exists.
const revisionTask = (bytes: number, missing: string[], titleOk: boolean) => `Your playbook is ${bytes} bytes; it must be between 1500 and 8000 bytes${missing.length ? `, and is missing these sections: ${missing.join(', ')}` : ''}${titleOk ? '' : ', and does not start with the required "Playbook for <Class name> (<codes>)" title line followed by a line of = characters'}. Revise it to fit: keep the same class, the same five sections in the same order and the most important sink patterns and checks; shorten or merge the least important points. Do not add new content beyond what a missing or incomplete section needs. If a section is missing or incomplete, use web search to look up the information it needs, only if needed. Return the full revised playbook in the same schema.`
/** Revision calls after a first research output that fails a playbook check. */
const MAX_REVISIONS = 2

function recordedUsage(raw: unknown): UsageCall['usage'] {
  const usage = normalizeUsage(raw)
  return usage ? {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: { cached_tokens: usage.cached_tokens, cache_write_tokens: usage.cache_write_tokens },
    output_tokens: usage.completion_tokens,
    output_tokens_details: { reasoning_tokens: usage.reasoning_tokens },
  } : null
}

/** Responses-native search trace; do not infer queries from the assistant text. */
export function searchTrace(response: Response): { queries: string[]; source_urls: string[]; web_search_calls: number } {
  const queries = new Set<string>(), sources = new Set<string>()
  let calls = 0
  for (const item of response.output ?? []) {
    if (item.type === 'web_search_call') {
      calls++
      const action = item.action as { queries?: string[]; sources?: { url: string }[] }
      for (const q of action.queries ?? []) queries.add(q)
      for (const s of action.sources ?? []) if (s.url) sources.add(s.url)
    } else if (item.type === 'message') {
      for (const content of item.content) if (content.type === 'output_text') {
        for (const a of content.annotations ?? []) if (a.type === 'url_citation') sources.add(a.url)
      }
    }
  }
  return { queries: [...queries], source_urls: [...sources], web_search_calls: calls }
}

const PLAYBOOK_SECTIONS = ['Scope:', '## OWASP Categories Covered', '## Sink Patterns to Hunt For',
  '## Distinguishing Real Findings from False Positives', '## Hunting Discipline']
// Guidance asks for roughly 2–6 KB; tolerate modest variation around it.
const PLAYBOOK_BYTES: [number, number] = [1500, 8000]
const playbookErrors: Record<PlaybookCheck, string> = {
  format: 'Generated playbook does not match the built-in section format',
  sections: 'Generated playbook does not match the built-in section format',
  size: 'Generated playbook must be roughly 2–6 KB',
}
export const missingSections = (text: unknown): string[] =>
  PLAYBOOK_SECTIONS.filter(h => typeof text !== 'string' || !text.includes(h))

/** Every failed playbook check, in validation order. A non-string has no size to check. Cited URLs are never checked. */
export function playbookProblems(text: unknown): PlaybookCheck[] {
  const problems: PlaybookCheck[] = []
  if (typeof text !== 'string' || !/^\s*Playbook for .+\n=+/m.test(text)) problems.push('format')
  if (missingSections(text).length) problems.push('sections')
  if (typeof text === 'string') {
    const size = Buffer.byteLength(text)
    if (size < PLAYBOOK_BYTES[0] || size > PLAYBOOK_BYTES[1]) problems.push('size')
  }
  return problems
}

export function validatePlaybook(text: string): void {
  const [problem] = playbookProblems(text)
  if (problem) throw new Error(playbookErrors[problem])
}

/** Citing is optional and every cited URL is kept. A label, never a check: a URL is verified only when
 *  it is a well-formed http(s) URL among the call's own search sources; otherwise it is unverified. */
export function labelSourceUrls(cited: string[], searched: string[]): { verified_source_urls: string[]; unverified_source_urls: string[] } {
  const verified = (url: string) => {
    try { return ['https:', 'http:'].includes(new URL(url).protocol) && searched.includes(url) } catch { return false }
  }
  return { verified_source_urls: cited.filter(verified), unverified_source_urls: cited.filter(url => !verified(url)) }
}

const bytesOf = (playbook: unknown) => typeof playbook === 'string' ? Buffer.byteLength(playbook) : null

function researchFailure(classId: string, purpose: string, check: ResearchCheck, error: unknown,
  raw: string, value: any, trace: UsageCall, attempts?: ResearchAttempt[]): ResearchFailure {
  const playbook = typeof value?.playbook === 'string' ? value.playbook as string : null
  const cited: string[] = Array.isArray(value?.source_urls) ? value.source_urls : []
  const text = playbook ?? raw
  return {
    class_id: classId, purpose, error: error instanceof Error ? error.message : String(error), check,
    byte_size: playbook === null ? null : Buffer.byteLength(playbook), char_size: playbook?.length ?? null,
    size_bounds: [...PLAYBOOK_BYTES], missing_sections: missingSections(text),
    cited_urls_absent_from_search: cited.filter(url => !trace.source_urls.includes(url)),
    web_search_calls: trace.web_search_calls, queries: trace.queries, search_source_urls: trace.source_urls,
    cited_source_urls: cited, response_status: trace.status,
    output_tokens: trace.usage?.output_tokens ?? null,
    reasoning_tokens: trace.usage?.output_tokens_details.reasoning_tokens ?? null,
    playbook_text: text,
    ...(attempts ? { attempts } : {}),
  }
}

const progress = (t: UsageCall, tail: string) => `[playbook-agent] ${t.purpose} ${t.status} ` +
  `in=${t.usage?.input_tokens ?? '-'} out=${t.usage?.output_tokens ?? '-'} searches=${t.web_search_calls} ${tail}`

const overlayEntry = (c: ProposedClass, model: string): OverlayEntry =>
  ({ playbook: c.id, codes: c.codes, signals: c.signals, framework: c.framework, model, sha256: '0'.repeat(64) })
const classIds = (d: CoverageDecision) => [...d.builtin_classes.map(b => b.id), ...d.classes.map(c => c.id)]

/** Every decision call is checked alike, before it is merged and before any research or cache write. */
function validateDecision(d: any, purpose: string, turn: boolean, o: AgentOptions): void {
  if (!d || typeof d.reason !== 'string' || !d.reason.trim() || !Array.isArray(d.classes) ||
      !Array.isArray(d.builtin_classes)) throw new Error(`Invalid ${purpose} decision`)
  const builtins = new Set<string>(), classes = new Set<string>()
  for (const b of d.builtin_classes) {
    if (!b || !Object.hasOwn(o.builtins, b.id) || builtins.has(b.id) || typeof b.reason !== 'string' || !b.reason.trim()) {
      throw new Error('Invalid or duplicate selected built-in class')
    }
    builtins.add(b.id)
  }
  for (const c of d.classes) {
    if (!c || classes.has(c.id) || typeof c.reason !== 'string' || !c.reason.trim()) throw new Error('Invalid or duplicate proposed class')
    validateOverlay({ [c.id]: overlayEntry(c, o.model) }, o.builtins, o.signals)
    classes.add(c.id)
  }
  if (turn && (!Array.isArray(d.changes) ||
      d.changes.some((c: any) => typeof c?.id !== 'string' || typeof c?.why !== 'string'))) throw new Error(`Invalid ${purpose} changes`)
}

/** Code-enforced no-drop: a turn can only add ids. The first definition and reason of an id stand. */
function unionDecision(before: CoverageDecision, turn: CoverageDecision): { decision: CoverageDecision; added: string[]; restored: string[] } {
  const builtins = new Map(before.builtin_classes.map(b => [b.id, b]))
  const classes = new Map(before.classes.map(c => [c.id, c]))
  for (const b of turn.builtin_classes) if (!builtins.has(b.id)) builtins.set(b.id, b)
  for (const c of turn.classes) if (!classes.has(c.id)) classes.set(c.id, c)
  const decision = { reason: turn.reason, builtin_classes: [...builtins.values()], classes: [...classes.values()] }
  const had = new Set(classIds(before)), own = new Set(classIds(turn))
  return { decision, added: classIds(decision).filter(id => !had.has(id)), restored: [...had].filter(id => !own.has(id)) }
}

/** Code-enforced prune for turn3: an intersection. A kept id keeps its first definition and reason; a new id is
 *  ignored, never added. A prune that would leave no class is rejected and the set before it kept. */
function pruneDecision(before: CoverageDecision, turn: CoverageDecision): { decision: CoverageDecision; removed: string[]; ignored: string[]; rejected: boolean } {
  const had = new Set(classIds(before)), own = new Set(classIds(turn))
  const ignored = classIds(turn).filter(id => !had.has(id))
  const decision = { reason: turn.reason, builtin_classes: before.builtin_classes.filter(b => own.has(b.id)),
    classes: before.classes.filter(c => own.has(c.id)) }
  if (!classIds(decision).length) return { decision: before, removed: [], ignored, rejected: true }
  return { decision, removed: classIds(before).filter(id => !own.has(id)), ignored, rejected: false }
}

export async function runPlaybookAgent(o: AgentOptions): Promise<{ plan: PlaybookPlan; overlay: ClassesOverlay; selection: ClassSelection }> {
  // Read on every invocation so changing guidance changes the next run.
  const guidance = readFileSync(new URL('../guidance.md', import.meta.url), 'utf8')
  const allowedDomains = o.allowedDomains ?? []
  const loop = o.loop ?? { enabled: true, maxPasses: 1 }
  if (!Number.isSafeInteger(loop.maxPasses) || loop.maxPasses < 1) throw new Error('Loop max passes must be a positive integer')
  const cached = listCachedPlaybooks(o.cacheRoot, o.model)
  const calls: UsageCall[] = []
  // Every call may search. Decision and revision calls leave it to the model; research calls must search.
  const call = async (purpose: string, input: string, schema: Record<string, unknown>, kind: 'decision' | 'research' | 'revision') => {
    const research = kind !== 'decision'
    const started = new Date().toISOString()
    const { reasoning_effort, ...sampling } = o.sampling ?? {}
    const request: ResponseCreateParamsNonStreaming = {
      model: o.model, instructions: guidance, input, store: false,
      max_output_tokens: o.maxOutputTokens,
      ...sampling,
      ...(reasoning_effort ? { reasoning: { effort: reasoning_effort as any } } : {}),
      text: { format: { type: 'json_schema', name: research ? 'playbook' : 'coverage_decision', strict: true, schema } },
      tools: [{ type: 'web_search', ...(allowedDomains.length ? { filters: { allowed_domains: allowedDomains } } : {}) }],
      tool_choice: kind === 'research' ? 'required' : 'auto',
      include: ['web_search_call.action.sources'],
    }
    let response: Response
    try { response = await o.create(request, purpose) } catch (error: any) {
      const raw = error?.usage ? error : error?.error
      o.recordUsage({ purpose, model: o.model, response_id: null, started_at: started,
        ended_at: new Date().toISOString(), status: 'request_failed', usage: recordedUsage(raw?.usage),
        served_tier: typeof raw?.service_tier === 'string' ? raw.service_tier : null,
        queries: [], source_urls: [], web_search_calls: 0 })
      throw error
    }
    const record: UsageCall = {
      purpose, model: response.model ?? o.model, response_id: response.id,
      started_at: started, ended_at: new Date().toISOString(), status: response.status ?? 'unknown',
      usage: recordedUsage(response.usage),
      served_tier: typeof response.service_tier === 'string' ? response.service_tier : null,
      ...searchTrace(response),
    }
    calls.push(record)
    o.recordUsage(record) // Persist paid usage even if parsing or validation fails next.
    if (response.status !== 'completed') {
      o.log?.(progress(record, { decision: purpose === 'turn3' ? 'removed=-' : 'added=-', research: 'bytes=- unverified=-', revision: 'bytes=- problems=-' }[kind]))
      throw new Error(`Playbook ${purpose} response ${response.status}`)
    }
    const text = response.output_text || (response.output ?? []).flatMap(item =>
      item.type === 'message' ? item.content.filter(c => c.type === 'output_text').map(c => c.text) : []).join('')
    return { text, trace: record }
  }

  const builtinRecords: PlaybookRecord[] = []
  const builtinGuidance = Object.entries(o.builtins).map(([id, entry]) => {
    const text = o.builtinTexts.get(entry.playbook)
    if (!text) throw new Error(`Missing built-in playbook ${id}`)
    builtinRecords.push(builtinPlaybookRecord(id, entry.playbook, text))
    return { id, ...entry, text }
  })
  const signalCounts: Record<string, number> = {}
  for (const signals of Object.values(o.recon.file_signals.files)) {
    for (const signal of new Set(signals)) signalCounts[signal] = (signalCounts[signal] ?? 0) + 1
  }

  // Every decision call's input starts with this same prefix, so it can be served from the prompt cache.
  const base = { recon: o.recon, signal_counts: signalCounts, signal_classes: o.signals, builtins: builtinGuidance, cached_classes: cached }
  const schemas = { coverage: decisionSchema(o.signals, o.builtins, false), turn: decisionSchema(o.signals, o.builtins, true) }
  const searches = { queries: [] as string[], source_urls: [] as string[] }
  let decision!: CoverageDecision
  const decide = async (purpose: string, task: string, turn: boolean) => {
    const extra = turn ? { current_decision: decision, searches_so_far: searches } : {}
    const { text, trace } = await call(purpose, JSON.stringify({ ...base, task, ...extra }), turn ? schemas.turn : schemas.coverage, 'decision')
    const value = JSON.parse(text)
    for (const key of ['queries', 'source_urls'] as const) for (const s of trace[key]) if (!searches[key].includes(s)) searches[key].push(s)
    validateDecision(value, purpose, turn, o)
    return { value, trace }
  }
  const turns: DecisionTurn[] = []
  const review = async (purpose: string, task: string) => {
    const { value, trace } = await decide(purpose, task, true)
    const next = unionDecision(decision, value)
    turns.push({ purpose, added: next.added, restored: next.restored, removed: [], changes: value.changes,
      web_search_calls: trace.web_search_calls, queries: trace.queries, source_urls: trace.source_urls })
    o.log?.(progress(trace, `added=${next.added.join(',') || '-'}`))
    return next
  }
  // turn3 is the only turn that can remove, and the only one that cannot add.
  const prune = async (purpose: string, task: string) => {
    const { value, trace } = await decide(purpose, task, true)
    const next = pruneDecision(decision, value)
    turns.push({ purpose, added: [], restored: [], removed: next.removed, changes: value.changes,
      web_search_calls: trace.web_search_calls, queries: trace.queries, source_urls: trace.source_urls,
      ignored: next.ignored, ...(next.rejected ? { prune_rejected: 'empty' as const } : {}) })
    o.log?.(progress(trace, `removed=${next.removed.join(',') || '-'}`))
    return next.decision
  }
  const { value: initial, trace: first } = await decide('coverage', tasks.coverage, false)
  decision = { reason: initial.reason, builtin_classes: initial.builtin_classes, classes: initial.classes }
  // Against an empty start, the initial decision adds every id it selects.
  o.log?.(progress(first, `added=${classIds(decision).join(',') || '-'}`))
  let passes = 0
  if (loop.enabled) {
    decision = (await review('turn1', tasks.turn1)).decision
    while (passes < loop.maxPasses) {
      const next = await review(`turn2:pass${++passes}`, tasks.turn2)
      if (!next.added.length) break
      decision = next.decision
    }
    decision = await prune('turn3', tasks.turn3)
  }

  const selected = [...new Set(classIds(decision))].sort()
  const loopRecord = { enabled: loop.enabled, max_passes: loop.maxPasses, passes_run: passes }
  // Persist the finished decision before any research call can fail the stage.
  o.recordDecision({
    schema: 'secscan.class-decision/1', created_at: new Date().toISOString(), model: o.model,
    builtin: decision.builtin_classes.map(b => b.id).sort(), added: decision.classes, classes: selected,
    turns, loop: loopRecord,
  })
  const overlay: ClassesOverlay = {}
  const plan: PlaybookPlan = {
    schema: 'secscan.playbook-plan/1', created_at: new Date().toISOString(), model: o.model,
    searched: false, reason: decision.reason, decision, turns,
    loop: loopRecord,
    allowed_domains: allowedDomains,
    builtin_classes: decision.builtin_classes,
    selected_classes: selected,
    classes: [], playbooks: builtinRecords,
  }
  for (const c of decision.classes) {
    let entry = readCachedPlaybook(o.cacheRoot, c.id, c.framework, o.model)
    const hit = entry !== null
    if (!entry) {
      const stack = {
        languages: o.recon.architecture.file_inventory?.by_language,
        frameworks: o.recon.architecture.architecture?.frameworks,
        dependencies: o.recon.architecture.dependencies,
      }, example_format = builtinGuidance[0].text
      // The attempt under check: the first research call, then each revision in turn.
      let purpose = `research:${c.id}`
      let { text, trace } = await call(purpose, JSON.stringify({ task: researchTask, class: c, stack, example_format }), playbookSchema, 'research')
      // Labels and cached queries use the searches of the first call and all its revisions.
      const queries = [...trace.queries], searched = [...trace.source_urls]
      // Every failed check leaves a debug record of the rejected output before the stage fails.
      let value: any = undefined, attempts: ResearchAttempt[] | undefined
      const failed = (check: ResearchCheck, error: unknown) => {
        o.recordResearchFailure(researchFailure(c.id, purpose, check, error, text, value, trace, attempts))
        return error
      }
      const parse = (tail: string) => {
        try { value = JSON.parse(text) } catch (error) {
          o.log?.(progress(trace, tail))
          throw failed('json', error)
        }
        // Kept as cited, in order; an empty or absent list is not a failure.
        return Array.isArray(value?.source_urls) ? value.source_urls.filter((s: unknown) => typeof s === 'string') as string[] : []
      }
      let cited = parse('bytes=- unverified=-')
      o.log?.(progress(trace, `bytes=${bytesOf(value?.playbook) ?? '-'} ` +
        `unverified=${labelSourceUrls(cited, trace.source_urls).unverified_source_urls.length}`))
      if (trace.web_search_calls === 0) throw failed('no_search', new Error(`No web search performed for ${c.id}`))
      let problems = playbookProblems(value?.playbook)
      attempts = [{ purpose, bytes: bytesOf(value?.playbook), problems }]
      for (let n = 1; n <= MAX_REVISIONS && problems.length; n++) {
        const before = bytesOf(value?.playbook), missing = missingSections(value?.playbook), titleOk = !problems.includes('format')
        purpose = `research:${c.id}:revise${n}`
        ;({ text, trace } = await call(purpose, JSON.stringify({
          task: revisionTask(before ?? 0, missing, titleOk), class: c, stack, example_format,
          previous_playbook: value?.playbook ?? null, previous_source_urls: cited,
          problems: { bytes: before ?? 0, size_bounds: [...PLAYBOOK_BYTES], missing_sections: missing, title_line_ok: titleOk },
        }), playbookSchema, 'revision'))
        for (const q of trace.queries) if (!queries.includes(q)) queries.push(q)
        for (const s of trace.source_urls) if (!searched.includes(s)) searched.push(s)
        value = undefined
        cited = parse(`bytes=${before ?? '-'}->- problems=-`)
        problems = playbookProblems(value?.playbook)
        attempts.push({ purpose, bytes: bytesOf(value?.playbook), problems })
        o.log?.(progress(trace, `bytes=${before ?? '-'}->${bytesOf(value?.playbook) ?? '-'} problems=${problems.join(',') || '-'}`))
      }
      try { validatePlaybook(value.playbook) } catch (error) {
        throw failed(problems[0] ?? 'format', error)
      }
      const meta = {
        ...overlayEntry(c, o.model), class_id: c.id, source_urls: cited, ...labelSourceUrls(cited, searched),
        queries, created_at: new Date().toISOString(),
        revisions: { attempts: attempts.length, sizes: attempts.map(a => a.bytes) } satisfies PlaybookRevisions,
      }
      entry = writeCachedPlaybook(o.cacheRoot, value.playbook, meta)
    }
    // The cached class definition and text are a pair; never relabel old text
    // using a fresh decision's possibly different codes or mapping.
    const { playbook, codes, signals, framework, model, sha256 } = entry.meta
    overlay[c.id] = { playbook, codes, signals, framework, model, sha256 }
    validateOverlay(overlay, o.builtins, o.signals)
    plan.classes.push({ ...c, codes, signals, cache: hit ? 'hit' : 'created', sha256 })
    // Entries cached before revisions were recorded carry none, and none is invented.
    const { revisions } = entry.meta as PlaybookMeta & { revisions?: PlaybookRevisions }
    plan.playbooks.push({ ...agentPlaybookRecord(entry.meta), ...(revisions ? { revisions } : {}) })
  }
  plan.searched = calls.some(c => c.web_search_calls > 0)
  const selection: ClassSelection = {
    schema: 'secscan.class-selection/1', created_at: plan.created_at, model: o.model,
    builtin: decision.builtin_classes.map(b => b.id).sort(), added: Object.keys(overlay).sort(), classes: plan.selected_classes,
  }
  validateClassSelection(selection, o.builtins, overlay)
  return { plan, overlay, selection }
}
