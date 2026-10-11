/**
 * Build the report model from Stage 0 to 2 artifacts. Pure apart from the file
 * reads `env.readTargetFile` performs, so the tests drive it with fixtures.
 *
 * Two rules from plan §2.9 shape everything here:
 *
 *  - Locations come from the lane, not the model. Every finding's file is its
 *    lane's target_file; a trace step's own `file` field is the model's and is
 *    kept only as a note when it disagrees.
 *  - Excerpts are read from disk at report time, never quoted by the model.
 *    The line-fidelity lesson from the PEM desync: a number shown to a reader
 *    must point at the line it names in the file they will open.
 */
import { createHash } from 'crypto'
import { isAbsolute, relative, resolve } from 'path'
import { languageOf } from './languages.js'
import { permalink } from './git.js'
import type {
  BuildEnv, ConfidenceBand, EvidenceStep, ExcerptLine, FailedLane, InFinding, InLane, Report,
  ReportFinding, ReportInputs, ScannerSignal, Severity, SkippedFile,
} from './types.js'

// ── Small helpers ───────────────────────────────────────────────────────────

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']
const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 }

/** Explanation fields added in plan §2.9; a finding without them predates them. */
export const EXPLANATION_FIELDS = ['cwe', 'severity_reason', 'confidence_reason', 'attack_scenario', 'remediation'] as const

/** Stage 0 signals that name a dangerous API rather than a file's role. */
const SINK_SIGNALS = new Set([
  'db_query', 'model_write', 'http_outbound', 'crypto_op', 'html_sink',
  'dynamic_exec', 'deserialize', 'file_io', 'llm_call',
])

/** Fallback names for every code the class registry can emit. */
const OWASP_NAMES: Record<string, string> = {
  A01: 'A01: Broken Access Control', A02: 'A02: Cryptographic Failures', A03: 'A03: Injection',
  A04: 'A04: Insecure Design', A05: 'A05: Security Misconfiguration', A06: 'A06: Vulnerable and Outdated Components',
  A07: 'A07: Identification and Authentication Failures', A08: 'A08: Software and Data Integrity Failures',
  A09: 'A09: Security Logging and Monitoring Failures', A10: 'A10: Server-Side Request Forgery (SSRF)',
  API1: 'API1: Broken Object Level Authorization', API2: 'API2: Broken Authentication',
  API3: 'API3: Broken Object Property Level Authorization', API4: 'API4: Unrestricted Resource Consumption',
  API5: 'API5: Broken Function Level Authorization', API6: 'API6: Unrestricted Access to Sensitive Business Flows',
  API7: 'API7: Server Side Request Forgery', API8: 'API8: Security Misconfiguration',
  API9: 'API9: Improper Inventory Management', API10: 'API10: Unsafe Consumption of APIs',
  LLM01: 'LLM01: Prompt Injection', LLM02: 'LLM02: Sensitive Information Disclosure', LLM03: 'LLM03: Supply Chain',
  LLM05: 'LLM05: Improper Output Handling', LLM06: 'LLM06: Excessive Agency', LLM10: 'LLM10: Unbounded Consumption',
}

const EXCERPT_RADIUS = 2          // cited line ±2: five lines, three at a file edge
const EXCERPT_MAX_LINE_CHARS = 400

export function confidenceBand(c: number): ConfidenceBand {
  return c >= 0.8 ? 'High' : c >= 0.5 ? 'Medium' : 'Low'
}

function normSeverity(s: unknown): Severity {
  return typeof s === 'string' && (SEVERITIES as string[]).includes(s.toLowerCase())
    ? (s.toLowerCase() as Severity)
    : 'medium'
}

function normConfidence(c: unknown): number {
  return typeof c === 'number' && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0
}

/** JSON with object keys sorted at every depth, so equal configs hash equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * Redact PEM private key material without changing the line count — the same
 * rule Stage 2 applies before a file reaches the model (sanitizePemPrivateKey
 * in hunt-executor.ts), repeated here so a report never prints a key the model
 * was never shown. Line count is preserved so every cited line still lands.
 */
export function redactPem(content: string): string {
  return content.replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    (_m, begin: string, body: string, end: string) =>
      begin + '[REDACTED: private key material]' + '\n'.repeat((body.match(/\n/g) ?? []).length) + end,
  )
}

/**
 * Stable fingerprint (plan §2.8): hash of path, sink snippet and class.
 *
 * The sink snippet is the text of the sink line on disk, whitespace-collapsed,
 * not its line number — so an edit above the finding moves the line and keeps
 * the id. The class is the finding's primary one, the first it lists: one
 * statement is often several defects at once (an interpolated query that also
 * compares an MD5 hash), and those are told apart by what each is primarily
 * about. A class the model adds later does not change the id. A sink line that
 * does not resolve falls back to its number.
 */
export function fingerprintOf(path: string, sinkText: string | null, sinkLine: number, primaryClass: string | undefined): string {
  const snippet = sinkText !== null ? sinkText.trim().replace(/\s+/g, ' ') : `line:${sinkLine}`
  const cls = primaryClass ?? 'unclassified'
  return sha256(`secscan-fp-v1\0${path}\0${snippet}\0${cls}`)
}

// ── Disk access ─────────────────────────────────────────────────────────────

interface FileView { lines: string[] | null }

function makeFileCache(env: BuildEnv) {
  const cache = new Map<string, FileView>()
  return (path: string): FileView => {
    let v = cache.get(path)
    if (!v) {
      const raw = env.readTargetFile(path)
      // Same numbering Stage 0.5 and Stage 2 use: split on '\n', so a trailing
      // newline counts as a final empty line, exactly as the model was shown.
      v = { lines: raw === null ? null : redactPem(raw).split('\n') }
      cache.set(path, v)
    }
    return v
  }
}

function excerptAround(lines: string[], line: number): ExcerptLine[] {
  const from = Math.max(1, line - EXCERPT_RADIUS)
  const to = Math.min(lines.length, line + EXCERPT_RADIUS)
  const out: ExcerptLine[] = []
  for (let n = from; n <= to; n++) {
    const t = lines[n - 1].replace(/\r$/, '')
    out.push({ n, text: t.length > EXCERPT_MAX_LINE_CHARS ? t.slice(0, EXCERPT_MAX_LINE_CHARS) + ' …' : t, cited: n === line })
  }
  return out
}

/**
 * A path as recorded by Stage 0 (repo-relative in the benchmark, possibly
 * absolute elsewhere) made relative to the target root, or null if it lies
 * outside it.
 */
function toTargetRelative(p: string, root: string, repoRoot: string): string | null {
  const candidates = isAbsolute(p) ? [p] : [resolve(repoRoot, p), resolve(root, p)]
  for (const abs of candidates) {
    const rel = relative(root, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/')
  }
  return null
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function isAuthNone(auth: unknown): boolean {
  return auth === null || auth === undefined || (typeof auth === 'string' && /^(none|)$/i.test(auth.trim()))
}

// ── Skip reasons ────────────────────────────────────────────────────────────

/**
 * The plan's skip buckets (§4.1.3): user-excluded, ignored, non-code, too
 * large, over budget. Stage 0.5 writes free-text reasons, so they are bucketed
 * by wording. Files the user's scope left out come from the scan plan instead
 * (see SCOPE_BUCKET), with their reason as a code.
 */
export function skipCategory(lane: Pick<InLane, 'skip_reason'>): string {
  const r = (lane.skip_reason ?? '').toLowerCase()
  if (/denylist/.test(r)) return 'excluded (benchmark denylist)'
  if (/user|exclude|--paths|secscanignore/.test(r)) return 'user-excluded'
  if (/gitignore|ignored|vendor|generated|minified|lockfile/.test(r)) return 'ignored'
  if (/too large|byte cap|size cap|max-file-size|oversize/.test(r)) return 'too large'
  if (/budget|max-cost|cost cap|spend/.test(r)) return 'over budget'
  if (/no executable logic|data\/config|styling|markup|declarative|non-code|binary/.test(r)) return 'non-code'
  return 'other'
}

/** Task 1c's scope-exclusion codes, in the plan's bucket words. */
const SCOPE_BUCKET: Record<string, string> = { 'user-excluded': 'user-excluded', 'too-large': 'too large' }

/** Task 1c's stop reasons: a limit or an interrupt ended the run early. */
const STOP_REASONS = new Set(['max_cost', 'timeout', 'interrupted', 'chunk_bound'])

// ── Build ───────────────────────────────────────────────────────────────────

export function buildReport(inputs: ReportInputs, env: BuildEnv & { repoRoot: string }): Report {
  const { assignments } = inputs
  const lanes = new Map(assignments.lanes.map((l) => [l.lane_id, l]))
  const readFile = makeFileCache(env)
  const categoryNames = new Map((assignments.category_universe ?? []).map((c) => [c.code, c.name]))
  // Stage 0.5's universe lists only the codes it could assign, so a code a
  // finding carries through its class can be absent from it.
  const owaspName = (code: string) => categoryNames.get(code) ?? OWASP_NAMES[code] ?? code
  const registry = inputs.classRegistry
  const codeToClass = new Map<string, string>()
  for (const [cls, e] of Object.entries(registry)) for (const code of e.codes) codeToClass.set(code, cls)

  const laneClasses = (lane: InLane): string[] =>
    lane.classes && lane.classes.length > 0
      ? lane.classes
      : [...new Set((lane.categories ?? []).map((c) => codeToClass.get(c.code)).filter((c): c is string => !!c))]

  // ── Lane outcomes ─────────────────────────────────────────────────────────
  const legacy = new Map((inputs.consumption?.legacy_entries ?? []).map((e) => [e.lane_id, e]))
  const records = inputs.consumption?.lanes ? new Map(inputs.consumption.lanes.map((r) => [r.lane_id, r])) : null
  const huntLanes = assignments.lanes.filter((l) => l.disposition === 'hunt')
  const skipLanes = assignments.lanes.filter((l) => l.disposition === 'skip')

  // Task 1c's hand-off, most authoritative first: the CLI's run record, then
  // Stage 2's own status, then Stage 1's scan plan. A run made before those
  // existed has none of them, and everything below falls back to deriving the
  // same facts from the lane manifest and the consumption record.
  const verdict = inputs.runRecord?.status
    ? { status: inputs.runRecord.status, reasons: inputs.runRecord.incomplete_reasons ?? [], source: 'run record' }
    : inputs.runStatus?.status
      ? { status: inputs.runStatus.status, reasons: inputs.runStatus.reasons ?? [], source: 'Stage 2 status' }
      : null
  const unscannedInfo = new Map(
    (inputs.runRecord?.unscanned ?? inputs.runStatus?.unscanned ?? []).map((u) => [u.lane_id, u]))
  // Hunt files the user's scope left out (--paths, --include/--exclude,
  // --max-file-size) were never meant to run: they are skipped, not missing.
  const scopeExcluded = new Map(
    (inputs.runRecord?.scope_excluded ?? inputs.runStatus?.scope_excluded ??
      (inputs.scanPlan?.excluded ?? []).filter((x) => x.reason !== 'over-max-files'))
      .map((x) => [x.lane_id, x]))

  const scanned = new Set<string>()
  const failed: FailedLane[] = []
  const notRun: InLane[] = []
  let unmeasuredCalls = 0
  for (const lane of huntLanes) {
    if (scopeExcluded.has(lane.lane_id)) continue
    const e = legacy.get(lane.lane_id)
    if (!e) { notRun.push(lane); continue }
    if (e.failed) {
      failed.push({ lane_id: lane.lane_id, path: lane.target_file, reason: e.failure_reason ?? 'lane failed' })
      continue
    }
    const rec = records?.get(lane.lane_id)
    if (rec) unmeasuredCalls += rec.chunks.filter((c) => c.measured?.total_tokens == null).length
    // A lane the read guard refused returns before any model call: no chunk
    // record and no tokens. It is not scanned, whatever the exit code said.
    if (records && (!rec || rec.chunks.length === 0) && !(e.tokens_used > 0)) {
      failed.push({ lane_id: lane.lane_id, path: lane.target_file, reason: 'no model call made: file read refused or missing' })
      continue
    }
    scanned.add(lane.lane_id)
  }

  // ── Findings ──────────────────────────────────────────────────────────────
  const findings: ReportFinding[] = []
  for (const f of inputs.findings) findings.push(buildFinding(f))

  function buildFinding(f: InFinding): ReportFinding {
    const lane = lanes.get(f.lane_id)
    // A finding whose lane is gone from the manifest still gets reported, at
    // the file the model named — but marked, since that path is unverified.
    const path = lane?.target_file ?? f.trace[f.trace.length - 1]?.file ?? '(unknown file)'
    const view = readFile(path)
    const n = view.lines?.length ?? 0

    const evidence: EvidenceStep[] = f.trace.map((s, i) => {
      const line = Number.isInteger(s.line) ? s.line : NaN
      const resolves = view.lines !== null && line >= 1 && line <= n
      const step: EvidenceStep = {
        index: i, kind: s.kind, path, line, resolves,
        description: s.description ?? '',
        excerpt: resolves ? excerptAround(view.lines!, line) : null,
      }
      if (s.file && s.file !== path) step.model_cited_file = s.file
      return step
    })
    // The primary location is the FIRST sink step. Stage 2 guarantees the last
    // step is a sink, but a trace may name several (the dangerous call, then
    // what its result reaches), and the first is the line to change.
    const sink = evidence.find((s) => s.kind === 'sink') ?? evidence[evidence.length - 1]
    const sinkText = sink?.resolves ? view.lines![sink.line - 1] : null

    const classes = [...new Set((f.finding_classes ?? []).map((c) => c.class))]
    const codes = f.categories && f.categories.length > 0
      ? f.categories
      : [...new Set(classes.flatMap((c) => registry[c]?.codes ?? []))]
    const owasp = codes.map((code) => ({ code, name: owaspName(code) }))
    const cwe = Array.isArray(f.cwe) ? f.cwe.filter((c) => typeof c === 'string') : []
    const builtIn = classes.filter((c) => registry[c])
    const categoryLabel = builtIn.length === 0
      ? 'other (recon-guided)'
      : [owasp.map((o) => o.code).join(', '), cwe.join(', ')].filter(Boolean).join(' · ')

    const severity = normSeverity(f.severity_estimate)
    const confidence = normConfidence(f.confidence)
    const signals = scannerSignals(lane, path, evidence, view, classes)
    const cr = f.confidence_reason
    const modelReasoning = cr && typeof cr === 'object'
      ? {
          validation: typeof cr.validation === 'string' ? cr.validation : null,
          assumptions: Array.isArray(cr.assumptions) ? cr.assumptions.filter((a) => typeof a === 'string') : [],
          summary: typeof cr.summary === 'string' && cr.summary ? cr.summary : null,
        }
      : null

    const fields_missing = EXPLANATION_FIELDS.filter((k) => {
      const v = (f as unknown as Record<string, unknown>)[k]
      return v === undefined || v === null || v === ''
    })

    const fp = fingerprintOf(path, sinkText, sink?.line ?? 0, classes[0])
    return {
      id: 'SS-' + fp.slice(0, 12).toUpperCase(),
      fingerprint: fp,
      source_finding_id: f.finding_id,
      lane_id: f.lane_id,
      title: f.title,
      description: f.description ?? '',
      classes,
      owasp,
      cwe,
      category_label: categoryLabel,
      severity,
      severity_reason: f.severity_reason || null,
      confidence,
      confidence_band: confidenceBand(confidence),
      confidence_explanation: {
        text: explanationText(confidence, signals, modelReasoning),
        scanner_signals: signals,
        model_reasoning: modelReasoning,
      },
      location: {
        path,
        line: sink?.line ?? 0,
        resolves: sink?.resolves ?? false,
        display: `${path}:${sink?.line ?? 0}`,
        permalink: sink?.resolves ? permalink(env.repo, path, sink.line) : null,
      },
      evidence,
      attack_scenario: f.attack_scenario || null,
      remediation: f.remediation || null,
      fields_missing: [...fields_missing],
      file_changed_since_scan: !!lane && view.lines !== null && view.lines.length !== lane.file_lines,
      rank_score: SEVERITY_WEIGHT[severity] * confidence,
    }
  }

  function scannerSignals(
    lane: InLane | undefined, path: string, evidence: EvidenceStep[],
    view: FileView, classes: string[],
  ): ScannerSignal[] {
    const out: ScannerSignal[] = []

    // 1. Trace complete from entry point to sink, every cited line on disk.
    const shape = evidence.length >= 2 && evidence[0].kind === 'entrypoint' && evidence[evidence.length - 1].kind === 'sink'
    const unresolved = evidence.filter((s) => !s.resolves).length
    out.push({
      signal: 'trace_complete',
      value: shape && unresolved === 0,
      detail: !shape
        ? 'trace does not run from an entry point to a sink'
        : unresolved > 0
          ? `${unresolved} of ${evidence.length} cited lines not found in the file on disk`
          : `entry point → ${evidence.length - 2} intermediate step(s) → sink, every line found on disk`,
    })

    // 2. Entry point exposed per recon: a route registered in this file, or
    //    whose handler is defined in it.
    const routes = inputs.architecture?.route_table?.hand_written_routes
    if (!routes) {
      out.push({ signal: 'entry_exposed', value: null, detail: 'no route table from recon' })
    } else {
      const content = view.lines?.join('\n') ?? ''
      const matched = routes.filter((r) => {
        if (r.file && toTargetRelative(r.file, env.repo.root, env.repoRoot) === path) return true
        const name = /([A-Za-z_$][\w$]*)\s*(?:\(.*)?$/.exec(r.handler ?? '')?.[1]
        if (!name || name.length < 4 || !content) return false
        return new RegExp(`\\bfunction\\s+${escapeRegex(name)}\\b|\\b(?:const|let|var)\\s+${escapeRegex(name)}\\s*=|\\bexports\\.${escapeRegex(name)}\\s*=`).test(content)
      })
      const open = matched.filter((r) => isAuthNone(r.auth))
      const show = (r: { method?: string; path?: string }) => `${r.method ?? ''} ${r.path ?? ''}`.trim()
      out.push(
        open.length > 0
          ? { signal: 'entry_exposed', value: true, detail: `public route ${show(open[0])}${open.length > 1 ? ` (+${open.length - 1} more)` : ''}, no auth found by recon` }
          : matched.length > 0
            ? { signal: 'entry_exposed', value: false, detail: `route ${show(matched[0])} has auth per recon (${matched[0].auth})` }
            : { signal: 'entry_exposed', value: null, detail: 'no route in the recon table reaches this file' },
      )
    }

    // 3. Sink in a known dangerous API: a recon escape hatch on a cited line,
    //    else a Stage 0 sink signal in the file tied to one of the classes.
    const lines = new Set(evidence.map((s) => s.line))
    const hatch = (inputs.architecture?.client_side?.escape_hatch_findings ?? []).find(
      (h) => lines.has(h.line) && toTargetRelative(h.file, env.repo.root, env.repoRoot) === path)
    if (hatch) {
      out.push({ signal: 'known_sink', value: true, detail: `cited line ${hatch.line} is a recon-detected ${hatch.type}` })
    } else if (!inputs.fileSignals?.files) {
      out.push({ signal: 'known_sink', value: null, detail: 'Stage 0 signals unavailable' })
    } else {
      const fileSignals = (inputs.fileSignals.files[path] ?? []).filter((s) => SINK_SIGNALS.has(s))
      const map = inputs.signalClasses?.signals ?? {}
      const relevant = fileSignals.filter((s) => (map[s] ?? []).some((c) => classes.includes(c)))
      out.push(
        relevant.length > 0
          ? { signal: 'known_sink', value: true, detail: `file contains dangerous-API signal(s) ${relevant.join(', ')} tied to this class (file-level, not line-level)` }
          : fileSignals.length > 0
            ? { signal: 'known_sink', value: false, detail: `file has ${fileSignals.join(', ')}, none tied to this finding's class` }
            : { signal: 'known_sink', value: false, detail: 'no dangerous-API signal found in this file by Stage 0' },
      )
    }

    // 4. Which playbooks reached the file. Dynamic (recon-guided) playbooks do
    //    not exist yet (plan §2.4), so every reachable class is built-in.
    const assigned = lane ? laneClasses(lane) : []
    const builtIn = assigned.filter((c) => registry[c])
    const recon = assigned.filter((c) => !registry[c])
    out.push({
      signal: 'playbook_coverage',
      value: lane ? classes.every((c) => assigned.includes(c)) : null,
      detail: lane
        ? `file hunted with ${builtIn.length} built-in playbook(s)${recon.length ? ` and ${recon.length} recon-guided` : ''}: ${assigned.join(', ')}`
        : 'lane not in the manifest; playbooks unknown',
    })
    return out
  }

  // Duplicate fingerprints are distinct findings at the same sink with the
  // same first class. They keep separate ids, suffixed in a fixed order, rather
  // than one silently absorbing the other.
  const byFp = new Map<string, ReportFinding[]>()
  for (const f of findings) byFp.set(f.id, [...(byFp.get(f.id) ?? []), f])
  for (const group of byFp.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.title.localeCompare(b.title) || a.source_finding_id.localeCompare(b.source_finding_id))
    group.forEach((f, i) => { if (i > 0) { f.id = `${f.id}-${i + 1}`; f.fingerprint = `${f.fingerprint}:${i + 1}` } })
  }

  findings.sort((a, b) =>
    b.rank_score - a.rank_score ||
    SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
    b.confidence - a.confidence ||
    a.location.path.localeCompare(b.location.path) ||
    a.location.line - b.location.line ||
    a.id.localeCompare(b.id))

  // ── Summary ───────────────────────────────────────────────────────────────
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>
  const byBand = { High: 0, Medium: 0, Low: 0 } as Record<ConfidenceBand, number>
  const owaspCount = new Map<string, number>()
  const cweCount = new Map<string, number>()
  const hot = new Map<string, number>()
  let otherRecon = 0
  for (const f of findings) {
    bySeverity[f.severity]++
    byBand[f.confidence_band]++
    for (const o of f.owasp) owaspCount.set(o.code, (owaspCount.get(o.code) ?? 0) + 1)
    for (const c of f.cwe) cweCount.set(c, (cweCount.get(c) ?? 0) + 1)
    if (f.category_label === 'other (recon-guided)') otherRecon++
    hot.set(f.location.path, (hot.get(f.location.path) ?? 0) + 1)
  }
  const countDesc = <T extends { count: number }>(a: T, b: T, ka: string, kb: string) => b.count - a.count || ka.localeCompare(kb)

  // ── Coverage ──────────────────────────────────────────────────────────────
  const skippedByReason: Record<string, number> = {}
  const skippedFiles: SkippedFile[] = [
    ...skipLanes.map((l) => ({ path: l.target_file, category: skipCategory(l), reason: l.skip_reason ?? '' })),
    ...[...scopeExcluded.values()].map((x) => ({
      path: x.target_file, category: SCOPE_BUCKET[x.reason] ?? x.reason, reason: x.detail,
    })),
  ].sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path))
  for (const f of skippedFiles) skippedByReason[f.category] = (skippedByReason[f.category] ?? 0) + 1

  const measured = new Set((env.benchmark?.languages ?? []).map((l) => l.toLowerCase()))
  const isMeasured = (language: string) => measured.has(language.toLowerCase())
  const langs = new Map<string, { files: number; scanned: number; code: boolean }>()
  let codeTotal = 0
  let codeScanned = 0
  const dirsScanned = new Set<string>()
  const dirsAll = new Set<string>()
  for (const l of assignments.lanes) {
    const { language, code } = languageOf(l.target_file)
    const entry = langs.get(language) ?? { files: 0, scanned: 0, code }
    entry.files++
    const isScanned = scanned.has(l.lane_id)
    if (isScanned) entry.scanned++
    langs.set(language, entry)
    if (code) {
      codeTotal += l.file_lines
      if (isScanned) codeScanned += l.file_lines
    }
    const dir = l.target_file.includes('/') ? l.target_file.split('/')[0] + '/' : './'
    dirsAll.add(dir)
    if (isScanned) dirsScanned.add(dir)
  }

  const conf = inputs.runRecord?.confirmation?.summary
  const confirmedDirs = conf?.scan?.dirs ? { included: [...conf.scan.dirs], excluded: [...(conf.skip?.dirs ?? [])] } : null

  const classLanes = new Map<string, number>()
  for (const l of huntLanes) for (const c of laneClasses(l)) classLanes.set(c, (classLanes.get(c) ?? 0) + 1)

  // ── Status ────────────────────────────────────────────────────────────────
  const stops = (verdict?.reasons ?? []).filter((r) => STOP_REASONS.has(r.reason))
  const stopReason = stops.length ? stops.map((r) => r.detail).join('; ') : null
  const derived: string[] = []
  if (!inputs.consumption) derived.push('no Stage 2 usage record (budget-consumption.json) — lane outcomes unknown')
  const admittedHunt = huntLanes.length - scopeExcluded.size
  if (notRun.length > 0) derived.push(`${notRun.length} of ${admittedHunt} hunt lane(s) never ran`)
  if (failed.length > 0) derived.push(`${failed.length} hunt lane(s) failed and produced no findings`)
  if (!inputs.stage2Meta) derived.push('Stage 2 recorded no completion (meta.json missing)')
  else if (inputs.stage2Meta.exit_code !== undefined && inputs.stage2Meta.exit_code !== 0) {
    derived.push(`Stage 2 exited with code ${inputs.stage2Meta.exit_code}`)
  }
  if (inputs.consumption && inputs.consumption.lanes && !inputs.consumption.rollup) {
    derived.push('Stage 2 usage record has no final rollup (the last pass did not finish)')
  }
  if (assignments.coverage_ledger.unaccounted !== 0) {
    derived.push(`coverage ledger has ${assignments.coverage_ledger.unaccounted} unaccounted file(s)`)
  }
  // The pipeline's own verdict wins and its wording is used as is. The report's
  // derivation is a second opinion that can only ever make a run INCOMPLETE:
  // a partial run must never be presented as a whole one, whoever missed it.
  const reasons = verdict?.status === 'INCOMPLETE'
    ? verdict.reasons.map((r) => r.detail)
    : verdict?.status === 'COMPLETE' && derived.length
      ? [...derived.map((d) => `${d} (the report's own check; the ${verdict.source} said COMPLETE)`)]
      : derived

  // ── Run stats ─────────────────────────────────────────────────────────────
  let input: number | null = null, cached: number | null = null, written: number | null = null
  let output: number | null = null, total: number | null = null, calls: number | null = null
  let cost: number | null = null
  let costSource = 'not available'
  const usage = inputs.usage && !inputs.usageStale ? inputs.usage : null
  if (usage) {
    input = usage.input_tokens ?? null
    cached = usage.cached_input_tokens ?? null
    written = usage.cache_write_tokens ?? null
    output = usage.output_tokens ?? null
    total = usage.total_tokens ?? null
    calls = usage.calls ?? null
    cost = usage.cost_usd ?? null
    costSource = cost != null ? 'usage-v2.json (Stage 1 reconcile)' : 'usage-v2.json carries no cost (model unpriced)'
  } else if (inputs.consumption?.lanes) {
    // Same derivation as Stage 1's reconcile (usageReportV2): lane totals for
    // input and output, per-call records for the cache split.
    input = 0; output = 0; total = 0; calls = 0; cached = 0; written = 0
    for (const l of inputs.consumption.lanes) {
      input += l.lane_totals?.prompt_tokens ?? 0
      output += l.lane_totals?.completion_tokens ?? 0
      total += l.lane_totals?.total_tokens ?? 0
      calls += l.chunks.length
      for (const c of l.chunks) {
        cached += c.measured?.cached_prompt_tokens ?? 0
        written += c.measured?.cache_write_prompt_tokens ?? 0
      }
    }
    cost = env.costUsd(input, output, cached, written)
    costSource = cost != null
      ? `computed from Stage 2 measured tokens at the registry price${env.priceAsOf ? ` (as of ${env.priceAsOf})` : ''}`
      : 'model is unpriced in the registry'
    if (inputs.usageStale) costSource += '; usage-v2.json was older than this Stage 2 run and was ignored'
  }

  const secs = (a?: string, b?: string) => {
    const t0 = a ? Date.parse(a) : NaN, t1 = b ? Date.parse(b) : NaN
    return Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 ? Math.round((t1 - t0) / 1000) : null
  }
  const s2 = inputs.stage2Meta
  const stage2Seconds = secs(s2?.started, s2?.ended)
  // Whole-pipeline time only when Stage 0 provably belongs to the same run:
  // the benchmark reuses committed Stage 0 artifacts days older than Stage 2.
  const runIdOf = (m: typeof s2) => (m?.run_context as { run_id?: string | null } | undefined)?.run_id ?? null
  const sameRun = runIdOf(inputs.stage0Meta) !== null && runIdOf(inputs.stage0Meta) === runIdOf(s2)
  const wall = sameRun ? secs(inputs.stage0Meta?.started, s2?.ended) : null
  const effort = (s2?.sampling?.reasoning_effort as string | undefined) ?? null

  // ── Header and config ─────────────────────────────────────────────────────
  const model = s2?.model ?? inputs.consumption?.model ?? env.modelLabel
  const config: Record<string, unknown> = {
    provider: env.provider,
    model,
    profile: env.profile,
    scope: 'full',
    sampling: s2?.sampling ?? null,
    max_output_tokens: s2?.max_output_tokens ?? null,
    loop_mode: s2?.loop_mode ?? null,
    loop_passes: s2?.loop_passes ?? null,
    sweep_group_size: s2?.sweep_group_size ?? null,
    playbooks: 'built-in',
    class_registry_sha256: sha256(canonicalJson(registry)),
    limits: inputs.runRecord?.limits ?? inputs.scanPlan?.limits ?? null,
    config_file_sha256: inputs.runRecord?.config_file?.sha256 ?? null,
    confirmed_by: inputs.runRecord?.confirmation?.by ?? null,
  }

  // ── Limitations, generated from this run ──────────────────────────────────
  const limitations: string[] = []
  const scannedLangs = [...langs.entries()].filter(([, v]) => v.code && v.scanned > 0).map(([k]) => k)
  const unmeasured = scannedLangs.filter((l) => !isMeasured(l)).sort()
  if (unmeasured.length > 0) {
    limitations.push(`Unmeasured language(s): ${unmeasured.join(', ')}. The scanner has no benchmark result for ${unmeasured.length === 1 ? 'it' : 'them'} on this model, so detection quality there is unknown.`)
  }
  if (skipLanes.length > 0) limitations.push(`${skipLanes.length} file(s) in the inventory were skipped and not examined (reasons in Coverage and the Appendix).`)
  if (failed.length > 0) limitations.push(`${failed.length} file(s) failed to scan and contribute no findings.`)
  if (scopeExcluded.size > 0) limitations.push(`${scopeExcluded.size} file(s) were left out by the scan's scope (--paths, --include/--exclude or --max-file-size) and were not examined.`)
  if (notRun.length > 0) limitations.push(`${notRun.length} file(s) were planned but never scanned${stopReason ? ` (${stopReason})` : ''}.`)
  if (stopReason) limitations.push(`The run stopped early: ${stopReason}.`)
  limitations.push('Files outside the inventory (for example ignored by .gitignore or not recognised as source) are not counted above and were not examined.')
  limitations.push('Static reasoning only: no finding was executed, reproduced or independently verified.')
  const bench = env.benchmark
  limitations.push(bench?.precision_proxy
    ? `Expect false positives. On the lab benchmark this model's precision proxy was ${bench.precision_proxy}; that is a floor (real bugs outside the known set count against it), not a prediction for this repo.`
    : 'Expect false positives. On the lab benchmark the precision proxy ranged from 6.4% to 16.5% across models (a floor, not a prediction); this model has no benchmark figure.')
  limitations.push('Re-runs can differ: the model is not deterministic, so findings, wording and confidence vary between runs.')
  limitations.push('Each file is analysed on its own; flows that cross files are seen only through the recon context (routes, architecture summary) given to each lane.')
  limitations.push(`No recall figure exists for this repository: without known vulnerabilities there is nothing to score against.${bench ? ` For reference, on the lab benchmark (${bench.corpus}) this model found ${bench.recall} of known bugs at the exact line and ${bench.localization} within ±15 lines.` : ''}`)
  const changed = findings.filter((f) => f.file_changed_since_scan).length
  if (changed > 0) limitations.push(`${changed} finding(s) are in files whose line count changed since the scan; their locations may have drifted.`)
  const unresolved = findings.filter((f) => !f.location.resolves).length
  if (unresolved > 0) limitations.push(`${unresolved} finding(s) cite a line that does not exist in the file on disk; no excerpt is shown for them.`)
  if (env.repo.github && env.repo.commit) {
    const noLink = new Set(findings.filter((f) => f.location.resolves && !f.location.permalink).map((f) => f.location.path)).size
    if (noLink > 0) limitations.push(`${noLink} file(s) with findings differ from commit ${env.repo.commit.slice(0, 7)} (uncommitted changes), so their findings carry a local path but no GitHub permalink.`)
  }
  const old = findings.filter((f) => f.fields_missing.length > 0).length
  if (old > 0) limitations.push(`${old} finding(s) lack some explanation fields (CWE, severity reason, confidence reason, attack scenario or remediation) — typically Stage 2 output written before those fields existed.`)
  if ((s2?.blocked_reads ?? 0) > 0) limitations.push(`The read guard blocked ${s2!.blocked_reads} read(s) during Stage 2.`)
  if (unmeasuredCalls > 0) limitations.push(`${unmeasuredCalls} model call(s) returned no usage figures (the call failed, or the provider omits usage); token and cost totals undercount by that much.`)
  if (s2?.degraded) limitations.push('Stage 2 recorded a degraded run (a fallback replaced a model call).')

  const benchRef = bench ? { ...bench, provider: env.provider } : null

  return {
    schema_version: '1.0',
    generated_at: env.generatedAt,
    tool: { name: env.tool.name, version: env.tool.version, scanner_git_sha: env.tool.scannerGitSha },
    header: {
      repo: env.repo.github ? `${env.repo.github.owner}/${env.repo.github.repo}` : env.repo.name,
      root: env.repo.root,
      branch: env.repo.branch,
      commit: env.repo.commit,
      github: env.repo.github ? `${env.repo.github.server}/${env.repo.github.owner}/${env.repo.github.repo}` : null,
      date: env.generatedAt,
      model,
      provider: env.provider,
      scope: { mode: 'full', detail: `all ${assignments.coverage_ledger.total_files_in_inventory} files in the inventory` },
      config_hash: sha256(canonicalJson(config)).slice(0, 16),
      profile: env.profile,
      run_id: env.runId,
    },
    status: { state: reasons.length === 0 ? 'COMPLETE' : 'INCOMPLETE', reasons },
    summary: {
      total: findings.length,
      by_severity: bySeverity,
      by_confidence_band: byBand,
      by_owasp: [...owaspCount].map(([code, count]) => ({ code, name: owaspName(code), count }))
        .sort((a, b) => countDesc(a, b, a.code, b.code)),
      by_cwe: [...cweCount].map(([cwe, count]) => ({ cwe, count })).sort((a, b) => countDesc(a, b, a.cwe, b.cwe)),
      other_recon_guided: otherRecon,
      review_first: findings.slice(0, 5).map((f) => f.id),
      hotspots: [...hot].map(([path, count]) => ({ path, count })).sort((a, b) => countDesc(a, b, a.path, b.path)).slice(0, 10),
    },
    coverage: {
      files_total: assignments.coverage_ledger.total_files_in_inventory,
      files_scanned: scanned.size,
      files_skipped: skipLanes.length + scopeExcluded.size,
      skipped_by_reason: Object.fromEntries(Object.entries(skippedByReason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
      files_failed: failed.length,
      files_not_run: notRun.length,
      code_lines_scanned: codeScanned,
      code_lines_total: codeTotal,
      code_lines_pct: codeTotal > 0 ? Math.round((codeScanned / codeTotal) * 1000) / 10 : null,
      languages: [...langs].map(([language, v]) => ({ language, files: v.files, scanned: v.scanned, code: v.code, measured: v.code && isMeasured(language) }))
        .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
      // What the user confirmed, when the CLI recorded it; otherwise what ran.
      directories_included: confirmedDirs?.included ?? [...dirsScanned].sort(),
      directories_excluded: confirmedDirs?.excluded ?? [...dirsAll].filter((d) => !dirsScanned.has(d)).sort(),
      directories_basis: confirmedDirs ? 'confirmed' as const : 'derived' as const,
      files_scope_excluded: scopeExcluded.size,
      classes_hunted: [...classLanes].map(([cls, n]) => ({
        class: cls,
        source: registry[cls] ? 'built-in' as const : 'recon-guided' as const,
        playbook: registry[cls]?.playbook ?? '(dynamic)',
        owasp: registry[cls]?.codes ?? [],
        lanes: n,
      })).sort((a, b) => b.lanes - a.lanes || a.class.localeCompare(b.class)),
      guidance_sources: [],
    },
    limitations,
    run_stats: {
      model,
      provider: env.provider,
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      total_tokens: total,
      calls,
      cost_usd: cost,
      cost_source: costSource,
      // The confirmed scope's estimate (scan plan) over the whole-inventory one.
      estimate_usd: inputs.runRecord?.spend?.estimate_usd ?? inputs.scanPlan?.totals?.projected_cost_usd ??
        inputs.plan?.total_projected_cost_usd ?? null,
      cap_usd: inputs.runRecord?.spend?.cap_usd ?? inputs.scanPlan?.cap?.max_cost_usd ?? inputs.runStatus?.spend?.cap_usd ?? null,
      price_asof: usage?.price_asof ?? env.priceAsOf,
      wall_clock_seconds: wall,
      stage2_seconds: stage2Seconds,
      retries: inputs.retries,
      loop_mode: s2?.loop_mode ?? null,
      reasoning_effort: effort,
    },
    benchmark_reference: benchRef,
    findings,
    appendix: {
      skipped_files: skippedFiles,
      failed_lanes: [
        ...failed,
        ...notRun.map((l) => {
          const u = unscannedInfo.get(l.lane_id)
          return { lane_id: l.lane_id, path: l.target_file, reason: u ? `${u.reason}: ${u.detail}` : 'never ran' }
        }),
      ],
      guidance_sources: [],
      config,
    },
  }
}

function explanationText(
  confidence: number,
  signals: ScannerSignal[],
  model: ReportFinding['confidence_explanation']['model_reasoning'],
): string {
  const parts: string[] = []
  const sig = (k: ScannerSignal['signal']) => signals.find((s) => s.signal === k)
  const entry = sig('entry_exposed')
  if (entry?.value === true) parts.push('public route, no auth found by recon')
  else if (entry?.value === false) parts.push('route requires auth per recon')
  const trace = sig('trace_complete')
  parts.push(trace?.value ? 'traced from entry point to sink' : 'trace incomplete')
  if (sig('known_sink')?.value) parts.push('dangerous API at or near the sink')
  if (model) {
    const v: Record<string, string> = {
      looked_for_absent: 'no validation or sanitising found on the path',
      looked_for_insufficient: 'validation present but insufficient',
      not_looked_for: 'validation not checked',
    }
    if (model.validation && v[model.validation]) parts.push(v[model.validation])
    if (model.assumptions.length > 0) parts.push(`assumes ${model.assumptions.join('; ')}`)
  } else {
    parts.push('no model reasoning recorded')
  }
  return `${confidence.toFixed(2)} ${confidenceBand(confidence)}: ${parts.join('; ')}.`
}
