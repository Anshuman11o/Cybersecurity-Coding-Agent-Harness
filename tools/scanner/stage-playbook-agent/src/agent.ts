import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { readFileSync } from 'node:fs'
import { normalizeUsage } from '../../shared/pricing.js'
import {
  agentPlaybookRecord, builtinPlaybookRecord, listCachedPlaybooks, readCachedPlaybook,
  writeCachedPlaybook, type PlaybookRecord,
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
/** One review turn after the initial decision: what the no-drop union added and restored. */
export interface DecisionTurn {
  purpose: string
  added: string[]
  restored: string[]
  changes: DecisionChange[]
  web_search_calls: number
  queries: string[]
  source_urls: string[]
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
  /** The final union of the initial decision and every review turn. */
  decision: CoverageDecision
  turns: DecisionTurn[]
  loop: { enabled: boolean; max_passes: number; passes_run: number }
  allowed_domains: string[]
  builtin_classes: SelectedBuiltin[]
  /** The run's complete class set: selected built-ins plus additional classes, sorted. */
  selected_classes: string[]
  classes: (ProposedClass & { cache: 'hit' | 'created'; sha256: string })[]
  playbooks: PlaybookRecord[]
}
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
  /** Review turns after the initial decision; main.ts reads the env. Default: on, 3 turn-2 passes. */
  loop?: { enabled: boolean; maxPasses: number }
  create: (request: ResponseCreateParamsNonStreaming, purpose: string) => Promise<Response>
  recordUsage: (call: UsageCall) => void
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
  turn3: "Do a final check of the complete class set against recon's data. Confirm that every surface recon describes is covered by at least one selected class, and that each additional class you proposed names a distinct vulnerability family that the built-ins do not already cover. Add any class still missing whether from remaining in built-ins or from the web. Do not drop any class already selected. Return the final decision in the same schema, with a list of anything added and why.",
}

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

export function validatePlaybook(text: string, sources: string[]): void {
  if (typeof text !== 'string' || !/^\s*Playbook for .+\n=+/m.test(text) ||
      !['Scope:', '## OWASP Categories Covered', '## Sink Patterns to Hunt For',
        '## Distinguishing Real Findings from False Positives', '## Hunting Discipline'].every(h => text.includes(h))) {
    throw new Error('Generated playbook does not match the built-in section format')
  }
  // Guidance asks for roughly 2–6 KB; tolerate modest variation around it.
  const size = Buffer.byteLength(text)
  if (size < 1500 || size > 8000) throw new Error('Generated playbook must be roughly 2–6 KB')
  if (!Array.isArray(sources) || !sources.length || sources.some(s => {
    try { return !['https:', 'http:'].includes(new URL(s).protocol) } catch { return true }
  })) throw new Error('Generated playbook needs web source URLs')
}

const overlayEntry = (c: ProposedClass, model: string): OverlayEntry =>
  ({ playbook: c.id, codes: c.codes, signals: c.signals, framework: c.framework, model, sha256: '0'.repeat(64) })
const classIds = (d: CoverageDecision) => [...d.builtin_classes.map(b => b.id), ...d.classes.map(c => c.id)]

/** Every decision call is checked alike, before it joins the union and before any research or cache write. */
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
    validateOverlay({ [c.id]: overlayEntry(c, o.model) }, o.builtins, o.signals, { codeFormat: 'free' })
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

export async function runPlaybookAgent(o: AgentOptions): Promise<{ plan: PlaybookPlan; overlay: ClassesOverlay; selection: ClassSelection }> {
  // Read on every invocation so changing guidance changes the next run.
  const guidance = readFileSync(new URL('../guidance.md', import.meta.url), 'utf8')
  const allowedDomains = o.allowedDomains ?? []
  const loop = o.loop ?? { enabled: true, maxPasses: 3 }
  if (!Number.isSafeInteger(loop.maxPasses) || loop.maxPasses < 1) throw new Error('Loop max passes must be a positive integer')
  const cached = listCachedPlaybooks(o.cacheRoot, o.model)
  const calls: UsageCall[] = []
  // Every call may search. Decision calls leave it to the model; research calls must search.
  const call = async (purpose: string, input: string, schema: Record<string, unknown>, research: boolean) => {
    const started = new Date().toISOString()
    const { reasoning_effort, ...sampling } = o.sampling ?? {}
    const request: ResponseCreateParamsNonStreaming = {
      model: o.model, instructions: guidance, input, store: false,
      max_output_tokens: o.maxOutputTokens,
      ...sampling,
      ...(reasoning_effort ? { reasoning: { effort: reasoning_effort as any } } : {}),
      text: { format: { type: 'json_schema', name: research ? 'playbook' : 'coverage_decision', strict: true, schema } },
      tools: [{ type: 'web_search', ...(allowedDomains.length ? { filters: { allowed_domains: allowedDomains } } : {}) }],
      tool_choice: research ? 'required' : 'auto',
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
    if (response.status !== 'completed') throw new Error(`Playbook ${purpose} response ${response.status}`)
    const text = response.output_text || (response.output ?? []).flatMap(item =>
      item.type === 'message' ? item.content.filter(c => c.type === 'output_text').map(c => c.text) : []).join('')
    return { value: JSON.parse(text), trace: record }
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
    const { value, trace } = await call(purpose, JSON.stringify({ ...base, task, ...extra }), turn ? schemas.turn : schemas.coverage, false)
    for (const key of ['queries', 'source_urls'] as const) for (const s of trace[key]) if (!searches[key].includes(s)) searches[key].push(s)
    validateDecision(value, purpose, turn, o)
    return { value, trace }
  }
  const turns: DecisionTurn[] = []
  const review = async (purpose: string, task: string) => {
    const { value, trace } = await decide(purpose, task, true)
    const next = unionDecision(decision, value)
    turns.push({ purpose, added: next.added, restored: next.restored, changes: value.changes,
      web_search_calls: trace.web_search_calls, queries: trace.queries, source_urls: trace.source_urls })
    return next
  }
  const { value: initial } = await decide('coverage', tasks.coverage, false)
  decision = { reason: initial.reason, builtin_classes: initial.builtin_classes, classes: initial.classes }
  let passes = 0
  if (loop.enabled) {
    decision = (await review('turn1', tasks.turn1)).decision
    while (passes < loop.maxPasses) {
      const next = await review(`turn2:pass${++passes}`, tasks.turn2)
      if (!next.added.length) break
      decision = next.decision
    }
    decision = (await review('turn3', tasks.turn3)).decision
  }

  const overlay: ClassesOverlay = {}
  const plan: PlaybookPlan = {
    schema: 'secscan.playbook-plan/1', created_at: new Date().toISOString(), model: o.model,
    searched: false, reason: decision.reason, decision, turns,
    loop: { enabled: loop.enabled, max_passes: loop.maxPasses, passes_run: passes },
    allowed_domains: allowedDomains,
    builtin_classes: decision.builtin_classes,
    selected_classes: [...new Set(classIds(decision))].sort(),
    classes: [], playbooks: builtinRecords,
  }
  for (const c of decision.classes) {
    let entry = readCachedPlaybook(o.cacheRoot, c.id, c.framework, o.model)
    const hit = entry !== null
    if (!entry) {
      const { value, trace } = await call(`research:${c.id}`, JSON.stringify({
        task: 'Research this missing class using web_search and produce one generic playbook, using the built-in format. Cite the sources used.',
        class: c, stack: {
          languages: o.recon.architecture.file_inventory?.by_language,
          frameworks: o.recon.architecture.architecture?.frameworks,
          dependencies: o.recon.architecture.dependencies,
        }, example_format: builtinGuidance[0].text,
      }), playbookSchema, true)
      if (trace.web_search_calls === 0) throw new Error(`No web search performed for ${c.id}`)
      validatePlaybook(value.playbook, value.source_urls)
      if (value.source_urls.some((url: string) => !trace.source_urls.includes(url))) {
        throw new Error(`Playbook ${c.id} cites a URL absent from the search sources/citations`)
      }
      entry = writeCachedPlaybook(o.cacheRoot, value.playbook, {
        ...overlayEntry(c, o.model), class_id: c.id, source_urls: value.source_urls,
        queries: trace.queries, created_at: new Date().toISOString(),
      })
    }
    // The cached class definition and text are a pair; never relabel old text
    // using a fresh decision's possibly different codes or mapping.
    const { playbook, codes, signals, framework, model, sha256 } = entry.meta
    overlay[c.id] = { playbook, codes, signals, framework, model, sha256 }
    validateOverlay(overlay, o.builtins, o.signals, { codeFormat: 'free' })
    plan.classes.push({ ...c, codes, signals, cache: hit ? 'hit' : 'created', sha256 })
    plan.playbooks.push(agentPlaybookRecord(entry.meta))
  }
  plan.searched = calls.some(c => c.web_search_calls > 0)
  const selection: ClassSelection = {
    schema: 'secscan.class-selection/1', created_at: plan.created_at, model: o.model,
    builtin: decision.builtin_classes.map(b => b.id).sort(), added: Object.keys(overlay).sort(), classes: plan.selected_classes,
  }
  validateClassSelection(selection, o.builtins, overlay)
  return { plan, overlay, selection }
}
