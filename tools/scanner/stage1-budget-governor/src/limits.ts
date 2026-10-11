/**
 * Run limits — what a run is allowed to scan and spend (productization plan §2.6).
 *
 * One resolver, imported by every party that acts on a limit: Stage 1 applies
 * the scope limits and prices what is left, Stage 2 enforces the spend cap and
 * the deadline, and the CLI shows all of them on the confirmation screen before
 * anything is spent. Two stages resolving the same env vars independently is
 * how the seed denylist once went missing from v2 (see shared/loop-config.ts),
 * so none of them parses these variables on its own.
 *
 * Each stage is its own process, so the limits travel as environment variables.
 * The CLI and run.sh set them from flags; a stage launched by hand reads the
 * same names.
 *
 *   SCANNER_MAX_COST       USD. Stage 2 starts no lane once projected spend would
 *                          pass it. Needs a priced model.
 *   SCANNER_MAX_FILES      hunt at most N files; the rest are recorded unscanned
 *   SCANNER_MAX_FILE_SIZE  bytes (k/m suffixes are KiB/MiB); larger files are
 *                          skipped as too large
 *   SCANNER_TIMEOUT        Stage 2 wall clock (s, m or h suffix; bare = seconds).
 *                          After it, no new lane starts.
 *   HUNT_CONCURRENCY       lanes in flight; derived when unset (deriveConcurrency)
 *   SCANNER_PATHS          newline-separated target-relative files or dirs; only
 *                          these are scanned
 *   SCANNER_INCLUDE        newline-separated globs; when set, a file must match one
 *   SCANNER_EXCLUDE        newline-separated globs; a matching file is skipped
 *
 * Lists are newline-separated because a glob may legitimately contain a comma
 * (`{a,b}`) and a path may contain a space.
 *
 * Zero dependencies (node builtins only) so Stage 2 and the CLI can import it
 * across package boundaries.
 */

export interface RunLimits {
  max_cost_usd: number | null
  max_files: number | null
  max_file_size: number | null
  timeout_seconds: number | null
  /** Explicit concurrency only. Null means derive it; see deriveConcurrency(). */
  concurrency: number | null
  paths: string[]
  include: string[]
  exclude: string[]
}

export const LIMIT_ENV = {
  max_cost_usd: 'SCANNER_MAX_COST',
  max_files: 'SCANNER_MAX_FILES',
  max_file_size: 'SCANNER_MAX_FILE_SIZE',
  timeout_seconds: 'SCANNER_TIMEOUT',
  concurrency: 'HUNT_CONCURRENCY',
  paths: 'SCANNER_PATHS',
  include: 'SCANNER_INCLUDE',
  exclude: 'SCANNER_EXCLUDE',
} as const satisfies Record<keyof RunLimits, string>

export const NO_LIMITS: RunLimits = {
  max_cost_usd: null,
  max_files: null,
  max_file_size: null,
  timeout_seconds: null,
  concurrency: null,
  paths: [],
  include: [],
  exclude: [],
}

/**
 * Lanes in flight when nothing says otherwise. It is Stage 2's historical
 * default: measured on 2026-07-28, 8 was already too many for one luna account
 * tier (52 of 541 lanes died on tokens-per-minute limits before the backoff was
 * lengthened), so it is not raised for users whose limits are unknown.
 */
export const DEFAULT_CONCURRENCY = 8

type Env = Record<string, string | undefined>

// ── Parsers ────────────────────────────────────────────────────────────────
// Strict on purpose: parseInt("1e5") is 1, and a silently wrong limit is either
// a run that stops at its first lane or one with no cap at all.

export function parseCost(raw: string, what = 'max cost'): number {
  const m = /^\s*\$?\s*([0-9]*\.?[0-9]+)\s*$/.exec(raw)
  if (!m || !(Number(m[1]) > 0)) throw new Error(`${what} "${raw}" is not a positive amount in USD, e.g. 5 or 2.50`)
  return Number(m[1])
}

export function parsePositiveInt(raw: string, what: string): number {
  const t = raw.trim()
  if (!/^[0-9]+$/.test(t) || Number(t) <= 0) throw new Error(`${what} "${raw}" is not a positive integer`)
  return Number(t)
}

/** "200000", "200k", "1.5m" (KiB / MiB). */
export function parseSize(raw: string, what = 'max file size'): number {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*([kKmM]?)[bB]?\s*$/.exec(raw)
  if (!m) throw new Error(`${what} "${raw}" is not a size, e.g. 200000, 200k or 1m`)
  const mult = m[2].toLowerCase() === 'k' ? 1024 : m[2].toLowerCase() === 'm' ? 1024 * 1024 : 1
  const n = Math.round(Number(m[1]) * mult)
  if (!(n > 0)) throw new Error(`${what} "${raw}" must be positive`)
  return n
}

/** "600", "90s", "30m", "1.5h" -> seconds. */
export function parseDuration(raw: string, what = 'timeout'): number {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*([smhSMH]?)\s*$/.exec(raw)
  if (!m) throw new Error(`${what} "${raw}" is not a duration, e.g. 600, 90s, 30m or 1h`)
  const mult = { '': 1, s: 1, m: 60, h: 3600 }[m[2].toLowerCase() as '' | 's' | 'm' | 'h']
  const n = Math.round(Number(m[1]) * mult)
  if (!(n > 0)) throw new Error(`${what} "${raw}" must be positive`)
  return n
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split('\n').map(s => s.trim()).filter(Boolean)
}

/**
 * A scope path as the user typed it, made target-relative and canonical:
 * `./src/` -> `src`. Absolute paths and `..` are refused — a scope that points
 * outside the target is a mistake the read guard would silently turn into
 * "nothing scanned".
 */
export function normalizeScopePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/')
  if (s.startsWith('/')) throw new Error(`path "${p}" must be relative to the target root`)
  s = s.replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/')
  if (s === '' || s === '.') return ''
  if (s.split('/').some(seg => seg === '..')) throw new Error(`path "${p}" leaves the target root`)
  return s
}

/** Resolve the limits for this process from the environment. Throws on a malformed value. */
export function resolveLimits(env: Env = process.env): RunLimits {
  const get = (k: keyof RunLimits) => {
    const v = env[LIMIT_ENV[k]]
    return v === undefined || v.trim() === '' ? undefined : v
  }
  const cost = get('max_cost_usd')
  const files = get('max_files')
  const size = get('max_file_size')
  const timeout = get('timeout_seconds')
  const conc = get('concurrency')
  return {
    max_cost_usd: cost !== undefined ? parseCost(cost, LIMIT_ENV.max_cost_usd) : null,
    max_files: files !== undefined ? parsePositiveInt(files, LIMIT_ENV.max_files) : null,
    max_file_size: size !== undefined ? parseSize(size, LIMIT_ENV.max_file_size) : null,
    timeout_seconds: timeout !== undefined ? parseDuration(timeout, LIMIT_ENV.timeout_seconds) : null,
    concurrency: conc !== undefined ? parsePositiveInt(conc, LIMIT_ENV.concurrency) : null,
    paths: parseList(env[LIMIT_ENV.paths]).map(normalizeScopePath).filter(p => p !== ''),
    include: parseList(env[LIMIT_ENV.include]),
    exclude: parseList(env[LIMIT_ENV.exclude]),
  }
}

/** The environment that makes resolveLimits() return `l`. For the CLI. */
export function limitsToEnv(l: RunLimits): Record<string, string> {
  const env: Record<string, string> = {}
  if (l.max_cost_usd != null) env[LIMIT_ENV.max_cost_usd] = String(l.max_cost_usd)
  if (l.max_files != null) env[LIMIT_ENV.max_files] = String(l.max_files)
  if (l.max_file_size != null) env[LIMIT_ENV.max_file_size] = String(l.max_file_size)
  if (l.timeout_seconds != null) env[LIMIT_ENV.timeout_seconds] = String(l.timeout_seconds)
  if (l.concurrency != null) env[LIMIT_ENV.concurrency] = String(l.concurrency)
  if (l.paths.length) env[LIMIT_ENV.paths] = l.paths.join('\n')
  if (l.include.length) env[LIMIT_ENV.include] = l.include.join('\n')
  if (l.exclude.length) env[LIMIT_ENV.exclude] = l.exclude.join('\n')
  return env
}

/**
 * The limits that decide WHICH files are scanned. Stage 2 checks that Stage 1
 * planned under the same ones: a plan computed for one scope and executed under
 * another would scan files nobody confirmed. The cap, timeout and concurrency
 * are enforced at run time and may change between Stage 1 and Stage 2 — which
 * is what lets a capped run be resumed with a higher cap.
 */
export function admissionKey(l: RunLimits): string {
  return JSON.stringify({
    max_files: l.max_files,
    max_file_size: l.max_file_size,
    paths: l.paths,
    include: l.include,
    exclude: l.exclude,
  })
}

// ── Globs ──────────────────────────────────────────────────────────────────

/**
 * Compile a gitignore-flavoured glob to a RegExp over target-relative paths.
 *
 *   *       any run of characters within one path segment
 *   **      any number of whole segments
 *   ?       one character within a segment
 *   {a,b}   alternatives
 *   [abc]   a character class ([!abc] negates)
 *
 * A pattern with no `/` matches at any depth (`*.min.js`, `fixtures`); one with
 * a `/` is anchored at the target root (`src/legacy/**`). A pattern that names a
 * directory also matches everything under it, so `vendor` excludes the tree.
 */
export function compileGlob(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (p === '') throw new Error('empty glob')
  const leadingSlash = p.startsWith('/')
  p = p.replace(/^\/+/, '').replace(/\/+$/, '')
  // A trailing slash marks a directory but does not anchor it, as in gitignore.
  const anchored = leadingSlash || p.includes('/')
  let re = ''
  let i = 0
  let inBrace = 0
  while (i < p.length) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/'
        const atEnd = i + 2 === p.length || p[i + 2] === '/'
        if (atStart && atEnd) {
          if (i + 2 === p.length) {
            re += '.*'
            i += 2
          } else {
            re += '(?:.*/)?'
            i += 3
          }
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      re += '[^/]*'
      i++
      continue
    }
    if (c === '?') { re += '[^/]'; i++; continue }
    if (c === '[') {
      const close = p.indexOf(']', i + 1)
      if (close > i + 1) {
        let body = p.slice(i + 1, close).replace(/\\/g, '\\\\')
        if (body.startsWith('!')) body = '^' + body.slice(1)
        re += `[${body}]`
        i = close + 1
        continue
      }
      re += '\\['
      i++
      continue
    }
    if (c === '{') { re += '(?:'; inBrace++; i++; continue }
    if (c === '}' && inBrace > 0) { re += ')'; inBrace--; i++; continue }
    if (c === ',' && inBrace > 0) { re += '|'; i++; continue }
    re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    i++
  }
  if (inBrace > 0) throw new Error(`glob "${pattern}" has an unclosed {`)
  const prefix = anchored ? '^' : '^(?:.*/)?'
  return new RegExp(`${prefix}${re}(?:/.*)?$`)
}

export function matchesAny(path: string, globs: RegExp[]): boolean {
  return globs.some(g => g.test(path))
}

function inScope(path: string, scopes: string[]): boolean {
  return scopes.some(s => path === s || path.startsWith(s + '/'))
}

// ── Admission ──────────────────────────────────────────────────────────────

/** Why a hunt lane is not scanned. The report (Task 1d) groups by these. */
export type ExclusionReason =
  /** --paths, --include or --exclude left it out. Scope, not incompleteness. */
  | 'user-excluded'
  /** Larger than --max-file-size. Scope, not incompleteness. */
  | 'too-large'
  /** Past --max-files. A limit cut it, so the run is INCOMPLETE. */
  | 'over-max-files'

/** Exclusions that make a run INCOMPLETE rather than merely narrower. */
export const INCOMPLETE_EXCLUSIONS: ReadonlySet<ExclusionReason> = new Set(['over-max-files'])

export interface AdmissionCandidate {
  lane_id: string
  target_file: string
  file_bytes: number
}

export interface Exclusion<T> {
  lane: T
  reason: ExclusionReason
  detail: string
}

/**
 * Split hunt lanes into the ones this run scans and the ones the limits leave
 * out, in lane order. Deterministic: the same lanes and limits always give the
 * same split, so the confirmation screen describes exactly what Stage 2 runs.
 *
 * Order of the filters: scope (paths, include, exclude), then size, then the
 * file count — so --max-files counts only files the run would otherwise scan.
 */
export function admitLanes<T extends AdmissionCandidate>(
  lanes: readonly T[],
  limits: RunLimits,
): { admitted: T[]; excluded: Exclusion<T>[] } {
  const include = limits.include.map(compileGlob)
  const exclude = limits.exclude.map(compileGlob)
  const admitted: T[] = []
  const excluded: Exclusion<T>[] = []
  for (const lane of lanes) {
    const f = lane.target_file.replace(/\\/g, '/')
    if (limits.paths.length && !inScope(f, limits.paths)) {
      excluded.push({ lane, reason: 'user-excluded', detail: 'outside --paths' })
    } else if (include.length && !matchesAny(f, include)) {
      excluded.push({ lane, reason: 'user-excluded', detail: 'matches no --include glob' })
    } else if (exclude.length && matchesAny(f, exclude)) {
      const g = limits.exclude[exclude.findIndex(r => r.test(f))]
      excluded.push({ lane, reason: 'user-excluded', detail: `matches --exclude ${g}` })
    } else if (limits.max_file_size != null && lane.file_bytes > limits.max_file_size) {
      excluded.push({
        lane,
        reason: 'too-large',
        detail: `${lane.file_bytes.toLocaleString('en-US')} B > --max-file-size ${limits.max_file_size.toLocaleString('en-US')} B`,
      })
    } else if (limits.max_files != null && admitted.length >= limits.max_files) {
      excluded.push({ lane, reason: 'over-max-files', detail: `past --max-files ${limits.max_files}` })
    } else {
      admitted.push(lane)
    }
  }
  return { admitted, excluded }
}

/**
 * Lanes in flight. An explicit value wins; otherwise the stage default, held
 * under the vendor's documented ceiling when the registry records one, and never
 * more than there are lanes to run.
 */
export function deriveConcurrency(
  explicit: number | null,
  vendorCeiling: number | null,
  laneCount: number,
): { value: number; basis: string } {
  if (explicit != null) {
    return {
      value: explicit,
      basis: vendorCeiling != null && explicit > vendorCeiling
        ? `explicit, ABOVE the vendor's documented ceiling of ${vendorCeiling}`
        : 'explicit',
    }
  }
  let value = DEFAULT_CONCURRENCY
  let basis = `default ${DEFAULT_CONCURRENCY}`
  if (vendorCeiling != null && vendorCeiling < value) {
    value = vendorCeiling
    basis = `vendor ceiling ${vendorCeiling}`
  }
  if (laneCount > 0 && laneCount < value) {
    value = laneCount
    basis += `, bounded by ${laneCount} lane(s)`
  }
  return { value: Math.max(1, value), basis }
}
