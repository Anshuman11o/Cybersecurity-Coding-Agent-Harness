/** Product-only human class edits; failed calls retain valid metadata and selection. */
import OpenAI from 'openai'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { runPath, REPO_ROOT } from '../../shared/run-paths.js'
import { getRunContext } from '../../shared/run-context.js'
import { assertUpstream, writeMeta } from '../../shared/meta.js'
import { resolveProvider, modelFor, clientConfigFor, outputTokenCap, samplingParams, transportFor, type Provider } from '../../shared/provider.js'
import { readLedgerTotals } from '../../shared/ledger.js'
import { API_PROFILE_FILE, readApiProfile } from '../../shared/api-profile.js'
import { isEntryPoint } from '../../shared/entry.js'
import { cacheRoot, listCachedPlaybooks, readCachedPlaybook, type PlaybookMeta } from '../../shared/playbook-cache.js'
import { appendOverlayEntry, writeClassSelection, writeOverlayJson, validateClassSelection, validateOverlay,
  readClassSelection, readClassesOverlay, PLAYBOOK_STAGE, type ClassSelection, type ClassesOverlay, type ClassRegistry, type SignalClassMap } from '../../shared/playbook-overlay.js'
import { researchPlaybook, recordedUsage, searchTrace, type AgentOptions, type ProposedClass, type UsageCall } from './agent.js'
import { loadRecon } from './main.js'
import { PlaybookMeter } from './meter.js'

export interface ReviewEdit {
  at: string; action: 'add' | 'drop'; input: string
  resolved: { kind: 'builtin' | 'cached' | 'researched' | 'rejected' | 'failed'; id: string | null }
  call_labels: string[]; cost_usd: number; message: string
}
export interface ClassReview {
  schema: 'secscan.class-review/1'
  agent_selection: ClassSelection
  cost_usd: number
  edits: ReviewEdit[]
  final: Pick<ClassSelection, 'builtin' | 'added' | 'classes'>
  budget_changes: { at: string; budget_usd: number | null }[]
}
export interface ReviewResult { ok: boolean; changed: boolean; message: string; selection: ClassSelection; review: ClassReview }
export interface ReviewRequest {
  provider?: Provider; action: 'add' | 'drop'; input: string; rawInput?: string; budgetUsd?: number | null; signal?: AbortSignal
  confirmCall?: (info: { purpose: string; reservation_usd: number; class?: { id: string; codes: string[]; signals: string[] } }) => Promise<boolean>
}
export interface ReviewOptions extends ReviewRequest {
  provider: Provider; builtins: ClassRegistry; signals: SignalClassMap; model: string; cacheRoot: string
  meter: PlaybookMeter; recon: AgentOptions['recon']; exampleFormat: string; maxOutputTokens: number
  sampling?: AgentOptions['sampling']; allowedDomains?: string[]
}
const tables = () => ({
  builtins: JSON.parse(readFileSync(join(REPO_ROOT, 'tools/scanner/shared/vuln-classes.json'), 'utf8')) as ClassRegistry,
  signals: JSON.parse(readFileSync(join(REPO_ROOT, 'tools/scanner/shared/signal-classes.json'), 'utf8')) as SignalClassMap,
})
function productOnly() {
  if (getRunContext().profile !== 'product') throw new Error('Class review is available only in product runs')
}
const finalSet = (s: ClassSelection) => ({ builtin: [...s.builtin], added: [...s.added], classes: [...s.classes] })
export function initializeClassReview(provider: Provider = resolveProvider('playbook')): ClassReview {
  productOnly()
  const dir = runPath(provider, PLAYBOOK_STAGE)
  const selection = readClassSelection(provider)
  if (!selection) throw new Error('Class review requires a successful agent selection')
  const snapshot = join(dir, 'class-selection.agent.json')
  if (!existsSync(snapshot)) writeFileSync(snapshot, JSON.stringify(selection, null, 2) + '\n', { flag: 'wx' })
  const file = join(dir, 'class-review.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const review: ClassReview = { schema: 'secscan.class-review/1', agent_selection: JSON.parse(readFileSync(snapshot, 'utf8')),
    edits: [], cost_usd: 0, final: finalSet(selection), budget_changes: [] }
  writeOverlayJson(file, review)
  return review
}
export function readClassReview(provider: Provider = resolveProvider('playbook')): ClassReview | null {
  const file = join(runPath(provider, PLAYBOOK_STAGE), 'class-review.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
export function recordReviewBudget(provider: Provider, budgetUsd: number | null): ClassReview {
  if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) throw new Error('Invalid review budget')
  const review = initializeClassReview(provider)
  review.budget_changes.push({ at: new Date().toISOString(), budget_usd: budgetUsd })
  writeOverlayJson(join(runPath(provider, PLAYBOOK_STAGE), 'class-review.json'), review)
  return review
}
const normalize = (s: string) => s.trim().toLowerCase().replace(/[ _]+/g, '-').replace(/^owasp-/, '')
const aliases: Record<string, string> = {
  'broken-access-control': 'access-control', authorization: 'access-control',
  'cryptographic-failures': 'crypto-auth', authentication: 'crypto-auth', 'identification-and-authentication-failures': 'crypto-auth',
  'sql-injection': 'injection', 'command-injection': 'injection', 'security-misconfiguration': 'misconfiguration',
  'vulnerable-and-outdated-components': 'vulnerable-components', 'software-and-data-integrity-failures': 'integrity-failures',
  'security-logging-and-monitoring-failures': 'logging-monitoring', 'server-side-request-forgery': 'ssrf',
  'broken-object-property-level-authorization': 'api-property-auth', 'unrestricted-resource-consumption': 'resource-consumption',
  'unrestricted-access-to-sensitive-business-flows': 'sensitive-business-flows',
}
/** Add numbers follow catalog order; drops use displayed selected rows. */
export function resolveLocalClass(input: string, builtins: ClassRegistry, overlay: ClassesOverlay,
  cached: PlaybookMeta[] = [], selected?: string[]): string | null {
  const value = normalize(input)
  if (/^[1-9][0-9]*$/.test(value)) return (selected ?? Object.keys(builtins))[Number(value) - 1] ?? null
  const id = aliases[value] ?? value
  if (Object.hasOwn(builtins, id) || Object.hasOwn(overlay, id) || cached.some(c => c.class_id === id)) return id
  const code = value.toUpperCase().replace(/:20[0-9]{2}$/, '')
  return Object.entries(builtins).find(([, c]) => c.codes.some(c => c.toUpperCase() === code))?.[0]
    ?? Object.entries(overlay).find(([, c]) => c.codes.some(c => c.toUpperCase() === code))?.[0]
    ?? cached.find(c => c.codes.some(c => c.toUpperCase() === code))?.class_id ?? null
}
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
export const resolveSchema = (builtins: ClassRegistry, signals: SignalClassMap) => obj({ resolution: { anyOf: [
  obj({ kind: { const: 'builtin', type: 'string' }, id: { type: 'string', enum: Object.keys(builtins) } }),
  obj({ kind: { const: 'new', type: 'string' }, id: { type: 'string' }, framework: { type: 'string' },
    codes: { type: 'array', minItems: 1, items: { type: 'string' } },
    signals: { type: 'array', minItems: 1, items: { type: 'string', enum: Object.keys(signals.signals) } } }),
  obj({ kind: { const: 'not_a_class', type: 'string' }, why: { type: 'string' } }),
] } })
export type Resolution = { kind: 'builtin'; id: string } | { kind: 'new'; id: string; framework: string; codes: string[]; signals: string[] } | { kind: 'not_a_class'; why: string }
export function validateResolution(value: any, builtins: ClassRegistry, signals: SignalClassMap, model: string): Resolution {
  const keys = value?.kind === 'builtin' ? ['kind', 'id'] : value?.kind === 'new'
    ? ['kind', 'id', 'framework', 'codes', 'signals'] : value?.kind === 'not_a_class' ? ['kind', 'why'] : []
  if (!keys.length || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('Invalid class resolution')
  if (value.kind === 'builtin' && !Object.hasOwn(builtins, value.id)) throw new Error('Unknown resolved built-in')
  if (value.kind === 'not_a_class' && (typeof value.why !== 'string' || !value.why.trim())) throw new Error('Missing rejection reason')
  if (value.kind === 'new') validateOverlay({ [value.id]: { ...value, playbook: value.id, model, sha256: '0'.repeat(64) } }, builtins, signals)
  return value
}

/** Injectable engine: tests supply a metered mock transport. */
export async function runClassReview(o: ReviewOptions): Promise<ReviewResult> {
  productOnly()
  if (o.budgetUsd != null && (!Number.isFinite(o.budgetUsd) || o.budgetUsd < 0)) throw new Error('Invalid review budget')
  const dir = runPath(o.provider, PLAYBOOK_STAGE)
  const review = initializeClassReview(o.provider)
  const selection = readClassSelection(o.provider)!
  let overlay = readClassesOverlay(o.provider) ?? {}
  validateOverlay(overlay, o.builtins, o.signals)
  const priorEntries = o.meter.ledger.list().length
  const edit: ReviewEdit = { at: new Date().toISOString(), action: o.action, input: o.rawInput ?? o.input,
    resolved: { kind: 'failed', id: null }, call_labels: [], cost_usd: 0, message: '' }
  let selected = selection, changed = false, ok = false, attempt = 1
  let proposed: ProposedClass | undefined
  let playbookBytes: number | undefined, searches = 0
  let publishing = false
  const previousMeta = existsSync(join(dir, 'meta.json')) ? readFileSync(join(dir, 'meta.json'), 'utf8') : null
  const previousSelection = readFileSync(join(dir, 'class-selection.json'), 'utf8')
  const call = async (purpose: string, input: string, schema: Record<string, unknown>, kind: 'resolve' | 'research' | 'revision') => {
    o.signal?.throwIfAborted()
    const { reasoning_effort, ...sampling } = o.sampling ?? {}
    const request: ResponseCreateParamsNonStreaming = { model: o.model, store: false, input,
      instructions: kind === 'resolve' ? 'Resolve the requested vulnerability class. Prefer an existing built-in or cached class. Reject non-security-class requests. Return only the resolution object.'
        : readFileSync(new URL('../guidance.md', import.meta.url), 'utf8'),
      max_output_tokens: kind === 'resolve' ? Math.min(2000, o.maxOutputTokens) : o.maxOutputTokens,
      ...sampling, ...(reasoning_effort ? { reasoning: { effort: reasoning_effort as any } } : {}),
      text: { format: { type: 'json_schema', name: kind === 'resolve' ? 'class_resolution' : 'playbook', strict: true, schema } },
      ...(kind === 'resolve' ? {} : { tools: [{ type: 'web_search' as const, ...(o.allowedDomains?.length ? { filters: { allowed_domains: o.allowedDomains } } : {}) }],
        tool_choice: 'required' as const, max_tool_calls: 3, include: ['web_search_call.action.sources' as const] }),
    }
    const reservation = o.meter.reservation(request)
    if (reservation === null) throw new Error('Review call has no priced reservation')
    if (o.budgetUsd != null && readLedgerTotals(o.meter.ledger.path).total_usd + reservation > o.budgetUsd) throw new Error('Review call exceeds the budget; raise the budget first')
    if (o.confirmCall && (kind === 'resolve' || attempt === 1) && !await o.confirmCall({ purpose, reservation_usd: reservation, ...(kind !== 'resolve' && proposed ? { class: { id: proposed.id, codes: proposed.codes, signals: proposed.signals } } : {}) })) throw new Error('Review cancelled')
    o.signal?.throwIfAborted()
    const started = new Date().toISOString()
    const response = await o.meter.call(request, purpose, { attempt, budgetUsd: o.budgetUsd, signal: o.signal })
    o.signal?.throwIfAborted()
    const trace: UsageCall = { purpose, model: response.model ?? o.model, response_id: response.id,
      started_at: started, ended_at: new Date().toISOString(), status: response.status ?? 'unknown',
      usage: recordedUsage(response.usage), served_tier: response.service_tier ?? null, ...searchTrace(response) }
    searches += trace.web_search_calls
    if (response.status !== 'completed') throw new Error(`Review ${purpose} response ${response.status}`)
    const text = response.output_text || (response.output ?? []).flatMap(item => item.type === 'message'
      ? item.content.filter(c => c.type === 'output_text').map(c => c.text) : []).join('')
    return { text, trace }
  }
  try {
    o.signal?.throwIfAborted()
    let id = resolveLocalClass(o.input, o.builtins, overlay, [], o.action === 'drop' ? selection.classes : undefined)
    const cached = !id && o.action === 'add' ? listCachedPlaybooks(o.cacheRoot, o.model) : []
    if (!id && o.action === 'add') id = resolveLocalClass(o.input, o.builtins, overlay, cached)
    if (o.action === 'drop') {
      if (!id || !selection.classes.includes(id)) throw new Error('Class is not selected')
      edit.resolved = { kind: Object.hasOwn(o.builtins, id) ? 'builtin' : 'cached', id }
      selected = { ...selection, builtin: selection.builtin.filter(c => c !== id), added: selection.added.filter(c => c !== id), classes: selection.classes.filter(c => c !== id),
        ...(selection.recon_kept ? { recon_kept: selection.recon_kept.filter(c => c !== id) } : {}) }
      edit.message = `Deleted ${id}`
    } else {
      if (!id) {
        const result = await call('review:resolve', JSON.stringify({ input: o.input, builtins: o.builtins, signals: o.signals,
          cached_classes: cached, stack: o.recon.architecture }), resolveSchema(o.builtins, o.signals), 'resolve')
        const raw = JSON.parse(result.text)
        // Strict Responses schemas require an object root around the discriminated union.
        if (!raw || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'resolution')) throw new Error('Invalid class resolution wrapper')
        const resolution = validateResolution(raw.resolution, o.builtins, o.signals, o.model)
        if (resolution.kind === 'not_a_class') {
          edit.resolved = { kind: 'rejected', id: null }
          throw new Error(resolution.why)
        }
        id = resolution.id
        if (resolution.kind === 'new') proposed = { ...resolution, reason: 'Requested during class review' }
      }
      edit.resolved = { kind: Object.hasOwn(o.builtins, id) ? 'builtin' : 'cached', id }
      if (selection.classes.includes(id)) edit.message = `${id} is already selected`
      else {
        if (!Object.hasOwn(o.builtins, id) && !Object.hasOwn(overlay, id)) {
          const cachedMeta = proposed ? cached.find(c => c.class_id === id && c.framework === proposed!.framework) : cached.find(c => c.class_id === id)
          let entry = cachedMeta ? readCachedPlaybook(o.cacheRoot, id, cachedMeta.framework, o.model) : null
          if (!entry) {
            if (!proposed) throw new Error(`Missing class definition for ${id}`)
            for (attempt = 1; attempt <= 2; attempt++) {
              let recordedThisAttempt = false
              try {
                entry = await researchPlaybook({ ...o, recordResearchFailure: failure => {
                  writeOverlayJson(join(dir, 'research-failures', `${id}.json`), { ...failure, attempt, at: new Date().toISOString() })
                  recordedThisAttempt = true
                } }, proposed, call, o.exampleFormat, `review:research:${id}`, 0)
                break
              } catch (error) {
                const failureFile = join(dir, 'research-failures', `${id}.json`)
                if (!recordedThisAttempt) writeOverlayJson(failureFile, {
                  class_id: id, purpose: `review:research:${id}`, attempt, at: new Date().toISOString(),
                  error: error instanceof Error ? error.message : String(error), check: 'request',
                  byte_size: null, char_size: null, size_bounds: [1500, 8000], missing_sections: [],
                  cited_urls_absent_from_search: [], web_search_calls: 0, queries: [], search_source_urls: [],
                  cited_source_urls: [], response_status: 'request_failed', output_tokens: null,
                  reasoning_tokens: null, playbook_text: '',
                })
                if (o.signal?.aborted || /cancel|budget|reservation|unpriced/i.test(String(error)) || attempt === 2) throw error
              }
            }
            edit.resolved.kind = 'researched'
            playbookBytes = Buffer.byteLength(entry!.text)
          }
          o.signal?.throwIfAborted()
          const { playbook, codes, signals, framework, model, sha256 } = entry!.meta
          overlay = appendOverlayEntry(o.provider, id, { playbook, codes, signals, framework, model, sha256 }, o.builtins, o.signals)
        }
        selected = { ...selection, builtin: [...selection.builtin, ...(Object.hasOwn(o.builtins, id) ? [id] : [])].sort(),
          added: [...selection.added, ...(!Object.hasOwn(o.builtins, id) ? [id] : [])].sort(), classes: [...selection.classes, id].sort() }
        edit.message = `Added ${id}`
      }
    }
    o.signal?.throwIfAborted()
    validateClassSelection(selected, o.builtins, overlay)
    changed = JSON.stringify(selected.classes) !== JSON.stringify(selection.classes)
    if (changed) {
      publishing = true
      writeClassSelection(o.provider, selected, o.builtins, overlay)
      writeMeta(o.provider, PLAYBOOK_STAGE, o.model, new Date().toISOString())
    }
    ok = true
  } catch (error) {
    if (publishing) {
      writeFileSync(join(dir, 'class-selection.json'), previousSelection)
      if (previousMeta !== null) writeFileSync(join(dir, 'meta.json'), previousMeta)
      changed = false
    }
    if (edit.resolved.kind !== 'rejected') edit.resolved.kind = 'failed'
    edit.message = error instanceof Error ? error.message : String(error)
    selected = selection
  }
  const entries = o.meter.ledger.list().slice(priorEntries)
  edit.call_labels = entries.map(e => e.label)
  edit.cost_usd = entries.reduce((sum, e) => sum + (e.cost_usd ?? 0), 0)
  if (!ok) edit.message = `Could not ${o.action} ${edit.resolved.id ?? JSON.stringify(o.input)} ($${edit.cost_usd.toFixed(4)} spent): ${edit.message}`
  else if (playbookBytes !== undefined) edit.message += `: playbook written (${playbookBytes} bytes, ${searches} searches, $${edit.cost_usd.toFixed(4)})`
  else if (edit.cost_usd > 0) edit.message += ` ($${edit.cost_usd.toFixed(4)} spent)`
  review.edits.push(edit)
  review.cost_usd = review.edits.reduce((sum, e) => sum + e.cost_usd, 0)
  review.final = finalSet(selected)
  writeOverlayJson(join(dir, 'class-review.json'), review)
  return { ok, changed, message: edit.message, selection: selected, review }
}

export async function reviewClass(request: ReviewRequest): Promise<ReviewResult> {
  productOnly()
  const provider = request.provider ?? resolveProvider('playbook')
  assertUpstream(provider, PLAYBOOK_STAGE)
  const { builtins, signals } = tables()
  const config = clientConfigFor(provider)
  const profile = readApiProfile(join(runPath(provider, 'stage0-recon'), API_PROFILE_FILE))
  let client: OpenAI | undefined
  const meter = new PlaybookMeter(provider, getRunContext(), config.baseURL ?? null, profile?.served_tier ?? null, async body => {
    if (transportFor(provider) !== 'openai') throw new Error('Class review requires Responses API')
    if (!config.apiKey) throw new Error('No credential configured for the selected playbook model')
    client ??= new OpenAI({ ...config, apiKey: config.apiKey, maxRetries: 0 })
    return client.responses.create(body, { signal: request.signal })
  })
  const first = Object.values(builtins)[0]
  const mod = await import(`../../stage2-hunt-lanes-perfile/src/playbooks/${first.playbook}.js`)
  return runClassReview({ ...request, provider, builtins, signals, model: modelFor(provider), cacheRoot: cacheRoot(), meter,
    recon: loadRecon(runPath(provider, 'stage0-recon')), exampleFormat: mod.playbook,
    maxOutputTokens: outputTokenCap(provider, 16000), sampling: samplingParams(provider),
    allowedDomains: (process.env.SCANNER_PLAYBOOK_ALLOWED_DOMAINS ?? '').split(',').map(s => s.trim()).filter(Boolean) })
}

// Only as `npm run review`: the CLI imports this module for its review API.
if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const action = arg('--action'), input = arg('--input')
  if ((action !== 'add' && action !== 'drop') || !input) {
    console.error('Usage: npm run review -- --action add|drop --input <class> [--budget <usd>]')
    process.exitCode = 1
  } else reviewClass({ action, input, ...(arg('--budget') ? { budgetUsd: Number(arg('--budget')) } : {}) })
    .then(result => { console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1 })
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
