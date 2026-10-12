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
  decision: CoverageDecision
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
  create: (request: ResponseCreateParamsNonStreaming) => Promise<Response>
  recordUsage: (call: UsageCall) => void
}

const object = (properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
})
const strings = { type: 'array', items: { type: 'string' } }
const decisionSchema = (signals: SignalClassMap, builtins: ClassRegistry) => object({
  reason: { type: 'string' },
  builtin_classes: { type: 'array', items: object({
    id: { type: 'string', enum: Object.keys(builtins) }, reason: { type: 'string' },
  }) },
  classes: { type: 'array', items: object({
    id: { type: 'string' }, framework: { type: 'string' }, codes: strings,
    signals: { type: 'array', minItems: 1, items: { type: 'string', enum: Object.keys(signals.signals) } },
    reason: { type: 'string' },
  }) },
})
const playbookSchema = object({ playbook: { type: 'string' }, source_urls: strings })

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

export async function runPlaybookAgent(o: AgentOptions): Promise<{ plan: PlaybookPlan; overlay: ClassesOverlay; selection: ClassSelection }> {
  // Read on every invocation so changing guidance changes the next run.
  const guidance = readFileSync(new URL('../guidance.md', import.meta.url), 'utf8')
  const allowedDomains = o.allowedDomains ?? []
  const cached = listCachedPlaybooks(o.cacheRoot, o.model)
  const calls: UsageCall[] = []
  const call = async (purpose: string, input: string, schema: Record<string, unknown>, search: boolean) => {
    const started = new Date().toISOString()
    const { reasoning_effort, ...sampling } = o.sampling ?? {}
    const request: ResponseCreateParamsNonStreaming = {
      model: o.model, instructions: guidance, input, store: false,
      max_output_tokens: o.maxOutputTokens,
      ...sampling,
      ...(reasoning_effort ? { reasoning: { effort: reasoning_effort as any } } : {}),
      text: { format: { type: 'json_schema', name: search ? 'playbook' : 'coverage_decision', strict: true, schema } },
      tools: search ? [{ type: 'web_search', ...(allowedDomains.length ? { filters: { allowed_domains: allowedDomains } } : {}) }] : [],
      tool_choice: search ? 'required' : 'none',
      ...(search ? { include: ['web_search_call.action.sources'] } : {}),
    }
    let response: Response
    try { response = await o.create(request) } catch (error: any) {
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
  const { value: decision } = await call('coverage', JSON.stringify({
    task: 'Select the built-in classes that apply to this target and decide coverage against the built-ins. Return every applicable built-in class in builtin_classes and every additional class needed for this run in classes, including applicable cached classes; no web search on this call. Reuse cached identifiers.',
    recon: o.recon, signal_counts: signalCounts, signal_classes: o.signals,
    builtins: builtinGuidance, cached_classes: cached,
  }), decisionSchema(o.signals, o.builtins), false) as { value: CoverageDecision }
  if (typeof decision.reason !== 'string' || !decision.reason.trim() || !Array.isArray(decision.classes) ||
      !Array.isArray(decision.builtin_classes)) throw new Error('Invalid coverage decision')

  const overlay: ClassesOverlay = {}
  const plan: PlaybookPlan = {
    schema: 'secscan.playbook-plan/1', created_at: new Date().toISOString(), model: o.model,
    searched: false, reason: decision.reason, decision, allowed_domains: allowedDomains,
    builtin_classes: decision.builtin_classes,
    selected_classes: [...new Set([...decision.builtin_classes.map(b => b.id), ...decision.classes.map(c => c.id)])].sort(),
    classes: [], playbooks: builtinRecords,
  }
  // Validate the entire decision before performing any searches or cache writes.
  const selectedBuiltins = new Set<string>()
  for (const b of decision.builtin_classes) {
    if (!b || !Object.hasOwn(o.builtins, b.id) || selectedBuiltins.has(b.id) || typeof b.reason !== 'string' || !b.reason.trim()) {
      throw new Error('Invalid or duplicate selected built-in class')
    }
    selectedBuiltins.add(b.id)
  }
  const proposed: ClassesOverlay = {}
  for (const c of decision.classes) {
    if (!c || Object.hasOwn(proposed, c.id) || typeof c.reason !== 'string' || !c.reason.trim()) throw new Error('Invalid or duplicate proposed class')
    const entry: OverlayEntry = { playbook: c.id, codes: c.codes, signals: c.signals, framework: c.framework, model: o.model, sha256: '0'.repeat(64) }
    validateOverlay({ [c.id]: entry }, o.builtins, o.signals)
    proposed[c.id] = entry
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
        ...proposed[c.id], class_id: c.id, source_urls: value.source_urls,
        queries: trace.queries, created_at: new Date().toISOString(),
      })
    }
    // The cached class definition and text are a pair; never relabel old text
    // using a fresh decision's possibly different codes or mapping.
    const { playbook, codes, signals, framework, model, sha256 } = entry.meta
    overlay[c.id] = { playbook, codes, signals, framework, model, sha256 }
    validateOverlay(overlay, o.builtins, o.signals)
    plan.classes.push({ ...c, codes, signals, cache: hit ? 'hit' : 'created', sha256 })
    plan.playbooks.push(agentPlaybookRecord(entry.meta))
  }
  plan.searched = calls.some(c => c.web_search_calls > 0)
  const selection: ClassSelection = {
    schema: 'secscan.class-selection/1', created_at: plan.created_at, model: o.model,
    builtin: [...selectedBuiltins].sort(), added: Object.keys(overlay).sort(), classes: plan.selected_classes,
  }
  validateClassSelection(selection, o.builtins, overlay)
  return { plan, overlay, selection }
}
