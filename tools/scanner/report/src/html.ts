/**
 * What the report page (report-page.ts) and the index page share: the safe
 * template tag, formatting, labels and the index's base look.
 *
 * Every page is rendered at build time through `h`, a template tag that
 * HTML-escapes every interpolated value unless it is markup `h` itself
 * produced. Model-written text (titles, class ids, codes, paths) is untrusted,
 * so no page ever turns data into markup.
 *
 * Pages make no network requests: inline CSS and JS only, a strict CSP, and
 * no network URL anywhere in the file, so "no URL in the output" stays a plain
 * grep. Output is a pure function of its inputs (dates come from the report,
 * not the clock), so rendering twice gives identical bytes.
 *
 * Zero dependencies.
 */
import type { Severity, SeverityCounts } from './types.js'

// ── Escaping and the safe template tag ─────────────────────────────────────

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"
export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`

/** Escape for HTML text and double- or single-quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    // A URL inside model text is still text; writing its colon as an entity
    // renders identically and keeps the file free of any literal scheme://.
    .replace(/:\/\//g, '&#58;//')
}

/** Markup that has already been escaped or is static. Only `h` and `raw` make one. */
export class Html {
  constructor(readonly html: string) {}
  toString(): string { return this.html }
}

/** Trust a static string as markup. Never pass data. */
export function raw(markup: string): Html {
  return new Html(markup)
}

function part(v: unknown): string {
  if (v instanceof Html) return v.html
  if (Array.isArray(v)) return v.map(part).join('')
  if (v === null || v === undefined || v === false) return ''
  return escapeHtml(v)
}

/** Template tag: every interpolation is escaped unless it is an Html value. */
export function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1]
  return new Html(out)
}

// ── Formatting (deterministic: no locale, no clock) ────────────────────────

export const UNKNOWN = 'unknown'
export const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
export const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function group3(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function fmtInt(n: number | null | undefined): string {
  if (!isNum(n)) return UNKNOWN
  const r = Math.round(n)
  return (r < 0 ? '-' : '') + group3(String(Math.abs(r)))
}

export function fmtUsd(n: number | null | undefined): string {
  if (!isNum(n)) return UNKNOWN
  if (n !== 0 && Math.abs(n) < 0.01) return '$' + n.toPrecision(2)
  const [whole, cents] = Math.abs(n).toFixed(2).split('.')
  return (n < 0 ? '-$' : '$') + group3(whole) + '.' + cents
}

export function fmtTokens(n: number | null | undefined): string {
  if (!isNum(n)) return UNKNOWN
  const trim = (s: string) => s.replace(/\.0$/, '')
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  if (k < 10) return trim(k.toFixed(1)) + 'k'
  if (Math.round(k) < 1000) return Math.round(k) + 'k'
  const m = n / 1e6
  return (m < 100 ? trim(m.toFixed(1)) : String(Math.round(m))) + 'M'
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return UNKNOWN
  const s = Math.max(0, Math.round(seconds))
  const hrs = Math.floor(s / 3600), mins = Math.floor((s % 3600) / 60), secs = s % 60
  if (hrs > 0) return `${hrs}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

/** Build-time text for a timestamp; the page swaps in the viewer's local time. */
export function fmtUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

export function timeEl(iso: string | null | undefined): Html {
  if (!iso) return h`${UNKNOWN}`
  return h`<time datetime="${iso}" data-local>${fmtUtc(iso)}</time>`
}

export function shortCommit(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 7) : null
}

export function branchAtCommit(branch: string | null | undefined, commit: string | null | undefined): string {
  const c = shortCommit(commit)
  if (!branch && !c) return UNKNOWN
  return `${branch || UNKNOWN} @ ${c || UNKNOWN}`
}

export function plural(n: number, one: string, many: string): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`
}

export const SEV_LABEL: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }
export function countOf(by: SeverityCounts, s: Severity): number {
  const n = by[s]
  return isNum(n) ? n : 0
}

export function statusBadge(status: unknown): Html {
  const s = String(status)
  const cls = s === 'COMPLETE' ? 'ok' : s === 'INCOMPLETE' ? 'warn' : 'grey'
  return h`<span class="status status-${cls}"><span class="status-dot"></span>${s}</span>`
}

/** Short form of a run-level gap reason, for the status line. */
const GAP_SHORT: Record<string, string> = {
  max_cost: 'budget reached',
  timeout: 'time limit reached',
  interrupted: 'interrupted',
  chunk_bound: 'bounded pass',
  provider_quota: 'provider quota reached',
  provider_failing: 'provider failing',
  unpriced_service_tier: 'unpriced service tier',
  failed_lanes: 'some files failed',
  blocked_reads: 'blocked file reads',
  'over-max-files': 'file limit reached',
  cancelled: 'cancelled',
  stage_failed: 'a stage failed',
  not_scanned: 'files not scanned',
  unrecorded: 'stopped before recording',
  stale_record: 'a later pass did not finish',
  no_record: 'no run record',
}

/** Short words for a not-scanned reason code. */
const NOT_SCANNED_SHORT: Record<string, string> = {
  max_cost: 'budget',
  timeout: 'time limit',
  interrupted: 'interrupted',
  failed: 'failed',
  aborted_in_flight: 'abandoned',
  'over-max-files': 'file limit',
  provider_quota: 'provider quota',
  provider_failing: 'provider failing',
  unpriced_service_tier: 'unpriced tier',
  chunk_bound: 'bounded pass',
  unrecorded: 'stopped before recording',
}

export function gapShort(reason: string): string {
  return hasOwn(GAP_SHORT, reason) ? GAP_SHORT[reason] : reason
}

export function notScannedBreakdown(byReason: Record<string, number> | null | undefined): string {
  if (!byReason) return ''
  return Object.keys(byReason)
    .filter(k => isNum(byReason[k]) && byReason[k] > 0)
    .sort((a, b) => byReason[b] - byReason[a] || (a < b ? -1 : a > b ? 1 : 0))
    .map(k => `${fmtInt(byReason[k])} ${hasOwn(NOT_SCANNED_SHORT, k) ? NOT_SCANNED_SHORT[k] : k}`)
    .join(', ')
}

export function basename(path: string): string {
  const segs = path.split(/[\\/]+/).filter(Boolean)
  return segs.length ? segs[segs.length - 1] : path
}

// ── Shared look ─────────────────────────────────────────────────────────────

/** A data: favicon, so the browser never asks for /favicon.ico (which the CSP would refuse). */
const FAVICON_SVG = '<svg xmlns="' + ['http', '://www.w3.org/2000/svg'].join('') +
  '" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2056c7"/>' +
  '<path d="M16 6l8 3v6c0 5.2-3.4 9.3-8 11-4.6-1.7-8-5.8-8-11V9z" fill="#fff"/></svg>'
export const FAVICON_LINK = `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(FAVICON_SVG).toString('base64')}">`

export const BRAND_ICON = '<svg class="brand-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l7.5 2.8v5.6c0 4.9-3.2 8.8-7.5 10.6-4.3-1.8-7.5-5.7-7.5-10.6V5.3z" fill="currentColor"/><path class="brand-tick" d="M8.6 12.2l2.3 2.3 4.6-4.8" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** Tokens, base typography, badges and tables: shared with index.html. */
export const BASE_CSS = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f4f5f7; --surface: #ffffff; --surface-2: #f6f7f9; --surface-3: #eceef2;
  --border: #e2e5ea; --border-strong: #ccd1d9;
  --text: #15171c; --text-2: #3a414d; --muted: #616a78;
  --accent: #1f55c4; --accent-bg: #e9effb; --focus: #2f6fed;
  --shadow: 0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.07);
  --crit: #b3121f; --crit-bg: #fde8ea; --crit-fg: #8e0d18; --crit-border: #f3b9be;
  --high: #df4a0f; --high-bg: #ffebe0; --high-fg: #9a3107; --high-border: #fbc4a5;
  --med: #cf8a00; --med-bg: #fff4d4; --med-fg: #774f00; --med-border: #f2d488;
  --low: #5577ab; --low-bg: #e8eef8; --low-fg: #2c4c7c; --low-border: #bfd0ea;
  --other-bg: #eceef2; --other-fg: #454c59; --other: #8a93a3;
  --ok-bg: #dcf4e3; --ok-fg: #13542c; --ok: #1f9d4c;
  --warn-bg: #fff2d9; --warn-fg: #7a3b05; --warn: #d98a06; --warn-border: #f3d396;
  --grey-bg: #eceef2; --grey-fg: #4a5160; --grey: #8a93a3;
  --radius: 10px;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1014; --surface: #161920; --surface-2: #1b1f27; --surface-3: #252a34;
    --border: #2a303b; --border-strong: #3a4250;
    --text: #e7e9ee; --text-2: #c3c8d2; --muted: #98a1b0;
    --accent: #84a9ff; --accent-bg: #1c2740; --focus: #84a9ff;
    --shadow: 0 1px 2px rgba(0,0,0,.4);
    --crit: #f0545c; --crit-bg: #3b1a1f; --crit-fg: #ffadb2; --crit-border: #6b2a31;
    --high: #fb7b3f; --high-bg: #3b2217; --high-fg: #ffbf9b; --high-border: #6e3a22;
    --med: #f2b33d; --med-bg: #362a12; --med-fg: #fbd88c; --med-border: #66501f;
    --low: #7ea6e8; --low-bg: #1b2638; --low-fg: #b5cdf5; --low-border: #2f4466;
    --other-bg: #252a34; --other-fg: #c3c8d2; --other: #7a8394;
    --ok-bg: #15301f; --ok-fg: #8ee3ab; --ok: #3cc46b;
    --warn-bg: #33270f; --warn-fg: #f8cf7f; --warn: #f0a92a; --warn-border: #5e4a1c;
    --grey-bg: #252a34; --grey-fg: #c3c8d2; --grey: #7a8394;
  }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 var(--sans); overflow-wrap: break-word;
}
a { color: var(--accent); }
code, .mono { font-family: var(--mono); font-size: 0.92em; }
h1, h2, h3 { margin: 0; line-height: 1.25; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.muted { color: var(--muted); }
.brand-tick { stroke: var(--surface); }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 20px; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.badge {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px;
  font-size: 11.5px; font-weight: 650; letter-spacing: .02em; white-space: nowrap;
  border: 1px solid transparent;
}
.badge.sev-critical { background: var(--crit-bg); color: var(--crit-fg); border-color: var(--crit-border); }
.badge.sev-high { background: var(--high-bg); color: var(--high-fg); border-color: var(--high-border); }
.badge.sev-medium { background: var(--med-bg); color: var(--med-fg); border-color: var(--med-border); }
.badge.sev-low { background: var(--low-bg); color: var(--low-fg); border-color: var(--low-border); }
.badge.sev-other { background: var(--other-bg); color: var(--other-fg); border-color: var(--border-strong); }
.status {
  display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 11px; border-radius: 999px;
  font-size: 12px; font-weight: 700; letter-spacing: .05em;
}
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.status-ok { background: var(--ok-bg); color: var(--ok-fg); }
.status-ok .status-dot { background: var(--ok); }
.status-warn { background: var(--warn-bg); color: var(--warn-fg); }
.status-warn .status-dot { background: var(--warn); }
.status-grey { background: var(--grey-bg); color: var(--grey-fg); }
.status-grey .status-dot { background: var(--grey); }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.data { width: 100%; border-collapse: collapse; font-size: 13.5px; }
table.data th {
  text-align: left; font-weight: 600; font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--muted); padding: 9px 14px; border-bottom: 1px solid var(--border); white-space: nowrap;
  background: var(--surface-2);
}
table.data td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.data tr:last-child td { border-bottom: 0; }
table.data .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sevnum { font-weight: 600; font-variant-numeric: tabular-nums; }
.sevnum.sev-critical { color: var(--crit-fg); }
.sevnum.sev-high { color: var(--high-fg); }
.sevnum.sev-medium { color: var(--med-fg); }
.sevnum.sev-low { color: var(--low-fg); }
.sevnum.zero { color: var(--muted); font-weight: 400; opacity: .6; }
.split { display: inline-flex; gap: 10px; font-size: 12.5px; white-space: nowrap; }
.split .sevnum { display: inline-flex; align-items: center; gap: 4px; }
.split .sevnum::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--sq, var(--other)); }
.split .sev-critical { --sq: var(--crit); }
.split .sev-high { --sq: var(--high); }
.split .sev-medium { --sq: var(--med); }
.split .sev-low { --sq: var(--low); }
.split .zero::before { opacity: .45; }
.site-footer { color: var(--muted); font-size: 12.5px; padding-top: 28px; padding-bottom: 40px; }
@media print {
  :root {
    color-scheme: light;
    --bg: #fff; --surface: #fff; --surface-2: #f6f7f9; --surface-3: #eceef2; --border: #d5d9e0; --border-strong: #c2c8d1;
    --text: #000; --text-2: #222; --muted: #555; --accent: #1f55c4; --accent-bg: #e9effb; --shadow: none;
    --crit: #b3121f; --crit-bg: #fde8ea; --crit-fg: #8e0d18; --crit-border: #f3b9be;
    --high: #df4a0f; --high-bg: #ffebe0; --high-fg: #9a3107; --high-border: #fbc4a5;
    --med: #cf8a00; --med-bg: #fff4d4; --med-fg: #774f00; --med-border: #f2d488;
    --low: #5577ab; --low-bg: #e8eef8; --low-fg: #2c4c7c; --low-border: #bfd0ea;
    --other-bg: #eceef2; --other-fg: #454c59;
    --ok-bg: #dcf4e3; --ok-fg: #13542c; --warn-bg: #fff2d9; --warn-fg: #7a3b05; --warn-border: #f3d396;
    --grey-bg: #eceef2; --grey-fg: #4a5160;
  }
  body { background: #fff; font-size: 11.5px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .no-print { display: none !important; }
  .card { box-shadow: none; }
  .table-scroll { overflow: visible; }
  tr { break-inside: avoid; }
  a { text-decoration: none; color: inherit; }
}
`
