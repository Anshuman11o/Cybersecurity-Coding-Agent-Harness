/**
 * Synthetic FindingsReport builders for the HTML tests and visual checks.
 *
 * Everything here is invented: the files (`src/api/users.ts` and friends), the
 * findings, the run. Nothing is taken from a real scan or any real target. The
 * summary is computed from the findings the same way the contract describes it
 * (report order, multi-class counting, distinct locations), so a fixture is
 * internally consistent without depending on build.ts.
 *
 * Zero dependencies.
 */
import {
  FINDINGS_SCHEMA, SEVERITIES,
  type ClassRow, type Coverage, type FileRow, type FindingsReport, type IndexEntry, type ReportFinding,
  type ScanGap, type SeverityCounts, type TraceStep,
} from './types.js'

export const CATEGORY_NAMES: Record<string, string> = {
  A01: 'Broken Access Control',
  A02: 'Cryptographic Failures',
  A03: 'Injection',
  A04: 'Insecure Design',
  A05: 'Security Misconfiguration',
  A07: 'Identification and Authentication Failures',
  A08: 'Software and Data Integrity Failures',
  A10: 'Server-Side Request Forgery',
}

/** Invented class ids and the codes each maps to. */
export const CLASS_CODES: Record<string, string[]> = {
  'sql-injection': ['A03'],
  'nosql-injection': ['A03'],
  'xss': ['A03'],
  'path-traversal': ['A01'],
  'ssrf': ['A10'],
  'idor': ['A01'],
  'missing-authz': ['A01'],
  'weak-crypto': ['A02'],
  'hardcoded-secret': ['A02', 'A07'],
  'broken-auth': ['A07'],
  'open-redirect': ['A01'],
  'mass-assignment': ['A04', 'A08'],
  'insecure-deserialization': ['A08'],
  'xxe': ['A05'],
}

export interface FindingSpec {
  id: string
  title: string
  description?: string
  severity: string
  confidence: number
  file: string
  line: number | null
  classes: string[]
  categories?: string[]
  /** Trace length, at least 1; the last step is the sink at file:line. */
  steps?: number
  lane?: string
  entryFile?: string
}

const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export function makeFinding(spec: FindingSpec): ReportFinding {
  const n = Math.max(1, spec.steps ?? 3)
  const trace: TraceStep[] = []
  for (let i = 0; i < n; i++) {
    const last = i === n - 1
    const kind: TraceStep['kind'] = last ? 'sink' : i === 0 ? 'entrypoint' : 'propagation'
    trace.push({
      kind,
      file: last ? spec.file : i === 0 ? (spec.entryFile ?? 'src/routes/index.ts') : spec.file,
      line: last ? (spec.line ?? 1) : 10 + i * 7,
      description: last
        ? `The value reaches the sink here without validation.`
        : i === 0
          ? `Request input enters through the route handler.`
          : `The value is passed on unchanged (step ${i + 1}).`,
    })
  }
  const categories = spec.categories ?? [...new Set(spec.classes.flatMap(c => CLASS_CODES[c] ?? []))]
  return {
    finding_id: spec.id,
    lane_id: spec.lane ?? `lane-${spec.file.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`,
    finding_classes: spec.classes.map(c => ({ class: c, justified_by_step: n - 1 })),
    categories,
    title: spec.title,
    description: spec.description ?? `${spec.title}. Invented for a test.`,
    trace,
    severity_estimate: spec.severity,
    confidence: spec.confidence,
    location: { file: spec.file, line: spec.line },
  }
}

function zero(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0 }
}
function bump(c: SeverityCounts, sev: string): void {
  if (sev in c) c[sev as keyof SeverityCounts]++
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function reportOrder(findings: ReportFinding[]): ReportFinding[] {
  return [...findings].sort((a, b) =>
    (RANK[a.severity_estimate] ?? 9) - (RANK[b.severity_estimate] ?? 9) ||
    b.confidence - a.confidence ||
    cmp(a.location.file, b.location.file) ||
    (a.location.line ?? Infinity) - (b.location.line ?? Infinity) ||
    cmp(a.finding_id, b.finding_id))
}

export interface ReportOptions {
  id?: string
  status?: FindingsReport['run']['status']
  passes?: number | null
  started_at?: string | null
  generated_at?: string
  target?: FindingsReport['run']['target']
  model?: FindingsReport['run']['model']
  scan_gaps?: ScanGap[]
  resume_command?: string | null
  coverage?: Partial<Coverage>
  cost?: FindingsReport['summary']['cost']
  usage?: FindingsReport['summary']['usage']
  not_scanned?: FindingsReport['not_scanned']
  category_names?: Record<string, string>
  class_codes?: Record<string, string[]>
}

/** A consistent FindingsReport around the given findings. */
export function makeReport(input: ReportFinding[], o: ReportOptions = {}): FindingsReport {
  const findings = reportOrder(input)
  const bySeverity = zero()
  const classes = new Map<string, ClassRow>()
  const files = new Map<string, FileRow>()
  const locations = new Set<string>()
  const usedCodes = new Set<string>()
  const classCodes = o.class_codes ?? CLASS_CODES
  for (const f of findings) {
    bump(bySeverity, f.severity_estimate)
    locations.add(`${f.location.file}\n${f.location.line}`)
    f.categories.forEach(c => usedCodes.add(c))
    for (const cls of new Set(f.finding_classes.map(c => c.class))) {
      const row = classes.get(cls) ?? { class: cls, codes: classCodes[cls] ?? [], count: 0, by_severity: zero() }
      row.count++
      bump(row.by_severity, f.severity_estimate)
      classes.set(cls, row)
    }
    const fr = files.get(f.location.file) ?? { file: f.location.file, count: 0, by_severity: zero() }
    fr.count++
    bump(fr.by_severity, f.severity_estimate)
    files.set(f.location.file, fr)
  }
  const names = o.category_names ?? CATEGORY_NAMES
  const categoryNames: Record<string, string> = {}
  for (const code of [...usedCodes].sort()) if (Object.prototype.hasOwnProperty.call(names, code)) categoryNames[code] = names[code]

  const coverage: Coverage = {
    files_in_repo: 120, skipped_by_selector: 14, skipped_no_selected_class: 6, scope_excluded: 0,
    in_scope: 100, scanned: 100, not_scanned: 0, not_scanned_by_reason: {},
    ...o.coverage,
  }
  return {
    schema: FINDINGS_SCHEMA,
    generated_at: o.generated_at ?? '2026-10-14T09:31:40.000Z',
    secscan_version: '0.4.0',
    run: {
      id: o.id ?? '20261014-091207',
      passes: o.passes === undefined ? 1 : o.passes,
      status: o.status ?? 'COMPLETE',
      started_at: o.started_at === undefined ? '2026-10-14T09:12:07.000Z' : o.started_at,
      ended_at: '2026-10-14T09:31:38.000Z',
      target: o.target ?? { root: '/home/dev/projects/shop-api', branch: 'main', commit: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' },
      model: o.model ?? { key: 'luna', name: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    },
    scan_gaps: o.scan_gaps ?? [],
    summary: {
      findings_total: findings.length,
      distinct_locations: locations.size,
      files_with_findings: files.size,
      by_severity: bySeverity,
      by_class: [...classes.values()].sort((a, b) => b.count - a.count || cmp(a.class, b.class)),
      top_files: [...files.values()].sort((a, b) => b.count - a.count || cmp(a.file, b.file)).slice(0, 10),
      review_first: findings.slice(0, 10).map(f => f.finding_id),
      category_names: categoryNames,
      coverage,
      cost: o.cost ?? { spent_usd: 3.27, budget_usd: 5 },
      usage: o.usage ?? { input_tokens: 1_480_000, output_tokens: 121_500, wall_clock_seconds: 1171 },
    },
    not_scanned: o.not_scanned ?? [],
    resume_command: o.resume_command === undefined ? null : o.resume_command,
    findings,
  }
}

// ── A realistic run: ~40 findings over 12 files, stopped by the budget ──────

/** Small deterministic PRNG so the realistic fixture is identical every time. */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const LONG_TAIL = [
  'An attacker who controls this parameter can change the meaning of the query.',
  'The handler trusts the client-supplied value and never checks it against the session.',
  'No allow-list or canonicalisation step sits between the request and the call.',
]

export function realisticReport(): FindingsReport {
  const rnd = prng(7)
  const conf = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100
  const specs: Omit<FindingSpec, 'id'>[] = []
  const add = (s: Omit<FindingSpec, 'id'>) => specs.push(s)

  // Same-line clusters: several vulnerabilities at one sink.
  add({ title: 'SQL injection in user search', severity: 'critical', confidence: 0.93, file: 'src/api/users.ts', line: 42,
    classes: ['sql-injection'], steps: 5, entryFile: 'src/routes/users.ts',
    description: 'The search term from the query string is concatenated into a raw SQL statement.\n\nAn attacker can append a UNION clause and read any table the application user can read, including password hashes.\n\n' + LONG_TAIL.join(' ') })
  add({ title: 'Authentication bypass through crafted search filter', severity: 'high', confidence: 0.71, file: 'src/api/users.ts', line: 42,
    classes: ['sql-injection', 'broken-auth'], steps: 6, entryFile: 'src/routes/users.ts',
    description: 'The same concatenated statement is reused by the login lookup, so a tautology in the filter matches the first account.' })
  add({ title: 'User enumeration through search error messages', severity: 'low', confidence: 0.44, file: 'src/api/users.ts', line: 42,
    classes: ['broken-auth'], steps: 3, entryFile: 'src/routes/users.ts' })
  add({ title: 'Path traversal in attachment download', severity: 'high', confidence: 0.88, file: 'src/api/files.ts', line: 77,
    classes: ['path-traversal'], steps: 4, entryFile: 'src/routes/files.ts',
    description: 'The file name is joined to the uploads directory without normalisation. A name such as ../../etc/passwd escapes it.' })
  add({ title: 'Arbitrary file overwrite via upload name', severity: 'critical', confidence: 0.82, file: 'src/api/files.ts', line: 77,
    classes: ['path-traversal', 'missing-authz'], steps: 7, entryFile: 'src/routes/files.ts' })
  add({ title: 'Server-side request forgery in webhook preview', severity: 'high', confidence: 0.86, file: 'src/routes/webhooks.ts', line: 58,
    classes: ['ssrf'], steps: 9, entryFile: 'src/routes/webhooks.ts',
    description: 'The preview endpoint fetches whatever URL the caller supplies, including link-local addresses such as http://169.254.169.254/latest/meta-data/ and internal services on https://intranet.invalid/.\n\nThe response body is returned to the caller verbatim.' })

  const pool: Array<[string, string, string, string[]]> = [
    ['critical', 'src/lib/db.ts', 'NoSQL operator injection in order lookup', ['nosql-injection']],
    ['critical', 'src/services/payments.ts', 'Refund amount taken from the request body', ['mass-assignment', 'missing-authz']],
    ['critical', 'src/lib/crypto.ts', 'Hard-coded signing key for session tokens', ['hardcoded-secret', 'weak-crypto']],
    ['high', 'src/api/orders.ts', 'Insecure direct object reference on order detail', ['idor']],
    ['high', 'src/api/orders.ts', 'Order status changed without ownership check', ['idor', 'missing-authz']],
    ['high', 'src/routes/admin.ts', 'Admin export reachable without the admin role', ['missing-authz']],
    ['high', 'src/lib/templates.ts', 'Stored cross-site scripting in product review', ['xss']],
    ['high', 'src/middleware/session.ts', 'Session id not rotated after login', ['broken-auth']],
    ['high', 'src/api/search.ts', 'Reflected cross-site scripting in search results', ['xss']],
    ['medium', 'src/api/auth.ts', 'Open redirect after login', ['open-redirect']],
    ['medium', 'src/api/auth.ts', 'Password reset token compared non-constantly', ['weak-crypto']],
    ['medium', 'src/lib/crypto.ts', 'MD5 used for password hashing', ['weak-crypto']],
    ['medium', 'src/lib/templates.ts', 'Template helper disables output escaping', ['xss']],
    ['medium', 'src/services/payments.ts', 'Untrusted YAML parsed with the unsafe loader', ['insecure-deserialization']],
    ['medium', 'src/routes/admin.ts', 'XML import resolves external entities', ['xxe']],
    ['medium', 'src/api/search.ts', 'Sort column passed to the query builder unchecked', ['sql-injection']],
    ['medium', 'src/middleware/session.ts', 'Session cookie missing the secure attribute', ['broken-auth']],
    ['low', 'src/api/users.ts', 'Profile endpoint returns internal user flags', ['mass-assignment']],
    ['low', 'src/api/orders.ts', 'Order ids are sequential and guessable', ['idor']],
    ['low', 'src/api/auth.ts', 'Login rate limit keyed on a spoofable header', ['broken-auth']],
    ['low', 'src/lib/db.ts', 'Connection string with credentials in a comment', ['hardcoded-secret']],
    ['low', 'src/routes/webhooks.ts', 'Webhook signature check skipped when header absent', ['broken-auth', 'missing-authz']],
  ]
  for (const [severity, file, title, classes] of pool) {
    const band = severity === 'critical' ? [0.75, 0.97] : severity === 'high' ? [0.55, 0.92] : severity === 'medium' ? [0.4, 0.85] : [0.25, 0.7]
    const steps = 3 + Math.floor(rnd() * 13)
    const extra = rnd() < 0.35 ? '\n\n' + LONG_TAIL.slice(0, 1 + Math.floor(rnd() * 3)).join('\n') : ''
    add({ title, severity, confidence: conf(band[0], band[1]), file, line: 20 + Math.floor(rnd() * 260), classes, steps,
      entryFile: file.replace(/^src\/(api|lib|services|middleware)\//, 'src/routes/'),
      description: `${title}. The value comes from the request and reaches the sink below without a check.${extra}` })
  }
  // A second same-line pair, and a few more to reach ~40.
  add({ title: 'Mass assignment of the role field on profile update', severity: 'high', confidence: 0.79, file: 'src/api/users.ts', line: 118,
    classes: ['mass-assignment'], steps: 4, entryFile: 'src/routes/users.ts' })
  add({ title: 'Privilege escalation through profile update', severity: 'critical', confidence: 0.77, file: 'src/api/users.ts', line: 118,
    classes: ['mass-assignment', 'missing-authz'], steps: 15, entryFile: 'src/routes/users.ts',
    description: 'Combined with the missing role check in the admin router, setting role to "admin" on the profile endpoint grants full access.' })
  for (let i = 0; i < 10; i++) {
    const files = ['src/api/search.ts', 'src/lib/templates.ts', 'src/routes/admin.ts', 'src/services/payments.ts', 'src/middleware/session.ts']
    const sev = SEVERITIES[Math.floor(rnd() * 4)]
    const cls = Object.keys(CLASS_CODES)[Math.floor(rnd() * Object.keys(CLASS_CODES).length)]
    add({ title: `Unvalidated input reaches ${cls.replace(/-/g, ' ')} sink`, severity: sev, confidence: conf(0.3, 0.95),
      file: files[i % files.length], line: 300 + i * 11, classes: [cls], steps: 3 + Math.floor(rnd() * 8) })
  }

  const findings = specs.map((s, i) => makeFinding({ ...s, id: `FIND-${String(i + 1).padStart(4, '0')}` }))
  const notScanned = [
    ...Array.from({ length: 35 }, (_, i) => ({ file: `src/legacy/module-${String(i + 1).padStart(2, '0')}.ts`, reason: 'max_cost', detail: 'The budget ran out before this file.' })),
    ...Array.from({ length: 3 }, (_, i) => ({ file: `src/jobs/worker-${i + 1}.ts`, reason: 'failed', detail: 'Every attempt failed.' })),
  ]
  return makeReport(findings, {
    status: 'INCOMPLETE',
    passes: 1,
    scan_gaps: [
      { reason: 'max_cost', detail: 'The scan stopped early: scanning the next file would have taken spend past the $5.00 budget. 35 files were not scanned.' },
      { reason: 'failed_lanes', detail: '3 files failed on every attempt and were not scanned. A resume retries them.' },
    ],
    resume_command: 'secscan scan /home/dev/projects/shop-api --resume 20261014-091207',
    coverage: {
      files_in_repo: 486, skipped_by_selector: 61, skipped_no_selected_class: 13, scope_excluded: 0,
      in_scope: 412, scanned: 374, not_scanned: 38, not_scanned_by_reason: { max_cost: 35, failed: 3 },
    },
    cost: { spent_usd: 4.91, budget_usd: 5 },
    usage: { input_tokens: 2_104_332, output_tokens: 180_410, wall_clock_seconds: 372 },
    not_scanned: notScanned,
  })
}

// ── Index entries ───────────────────────────────────────────────────────────

export function indexEntryFor(r: FindingsReport): IndexEntry {
  return {
    run_id: r.run.id,
    href: `runs/${r.run.id}/report.html`,
    status: r.run.status,
    started_at: r.run.started_at,
    target_root: r.run.target.root,
    branch: r.run.target.branch,
    commit: r.run.target.commit,
    findings_total: r.summary.findings_total,
    by_severity: r.summary.by_severity,
    scanned: r.summary.coverage.scanned,
    in_scope: r.summary.coverage.in_scope,
    spent_usd: r.summary.cost.spent_usd,
    budget_usd: r.summary.cost.budget_usd,
  }
}
