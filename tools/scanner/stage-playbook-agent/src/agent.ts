import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { readFileSync } from 'node:fs'
import {
  agentPlaybookRecord, builtinPlaybookRecord, listCachedPlaybooks, readCachedPlaybook,
  writeCachedPlaybook, type PlaybookRecord,
} from '../../shared/playbook-cache.js'
import {
  validateOverlay, type ClassRegistry, type ClassesOverlay, type OverlayEntry, type SignalClassMap,
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
export interface CoverageDecision { reason: string; classes: ProposedClass[] }
export interface UsageCall {
  purpose: string
  model: string
  response_id: string | null
  started_at: string
  ended_at: string
  status: string
  usage: {
    input_tokens: number
    input_tokens_details: { cached_tokens: number; cache_write_tokens: number }
    output_tokens: number
    output_tokens_details: { reasoning_tokens: number }
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
const decisionSchema = (signals: SignalClassMap) => object({
  reason: { type: 'string' },
  classes: { type: 'array', items: object({
    id: { type: 'string' }, framework: { type: 'string' }, codes: strings,
    signals: { type: 'array', minItems: 1, items: { type: 'string', enum: Object.keys(signals.signals) } },
    reason: { type: 'string' },
  }) },
})
const playbookSchema = object({ playbook: { type: 'string' }, source_urls: strings })

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

export async function runPlaybookAgent(o: AgentOptions): Promise<{ plan: PlaybookPlan; overlay: ClassesOverlay }> {
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
    try { response = await o.create(request) } catch (error) {
      o.recordUsage({ purpose, model: o.model, response_id: null, started_at: started,
        ended_at: new Date().toISOString(), status: 'request_failed', usage: null,
        queries: [], source_urls: [], web_search_calls: 0 })
      throw error
    }
    const usage = response.usage
    const inputDetails = usage?.input_tokens_details as { cached_tokens?: number; cache_write_tokens?: number } | undefined
    const record: UsageCall = {
      purpose, model: response.model ?? o.model, response_id: response.id,
      started_at: started, ended_at: new Date().toISOString(), status: response.status ?? 'unknown',
      usage: usage ? {
        input_tokens: usage.input_tokens,
        input_tokens_details: { cached_tokens: inputDetails?.cached_tokens ?? 0, cache_write_tokens: inputDetails?.cache_write_tokens ?? 0 },
        output_tokens: usage.output_tokens,
        output_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 },
      } : null,
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
    task: 'Decide coverage against the built-ins. Return all additional classes needed for this run, including applicable cached classes; no web search on this call. Reuse cached identifiers.',
    recon: o.recon, signal_counts: signalCounts, signal_classes: o.signals,
    builtins: builtinGuidance, cached_classes: cached,
  }), decisionSchema(o.signals), false) as { value: CoverageDecision }
  if (typeof decision.reason !== 'string' || !decision.reason.trim() || !Array.isArray(decision.classes)) throw new Error('Invalid coverage decision')

  const overlay: ClassesOverlay = {}
  const plan: PlaybookPlan = {
    schema: 'secscan.playbook-plan/1', created_at: new Date().toISOString(), model: o.model,
    searched: false, reason: decision.reason, decision, allowed_domains: allowedDomains,
    classes: [], playbooks: builtinRecords,
  }
  // Validate the entire decision before performing any searches or cache writes.
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
  return { plan, overlay }
}
