/**
 * Renders report.html: one self-contained page built from a FindingsReport.
 *
 * The Summary view is rendered here, at build time, through `h`, a template tag
 * that HTML-escapes every interpolated value unless it is markup `h` itself
 * produced. The Findings view is built in the browser from the report embedded
 * once as JSON, with every data string reaching the DOM through textContent or
 * setAttribute. Model-written text (titles, descriptions, trace steps, class
 * ids, codes, paths) is untrusted, so neither half ever turns data into markup.
 *
 * The page makes no network requests: inline CSS and JS only, a strict CSP, and
 * no network URL anywhere in the file, even inside data, so "no URL in the
 * output" stays a plain grep. Output is a pure function of the report (dates
 * come from the report, not the clock), so rendering twice gives identical bytes.
 *
 * Zero dependencies.
 */
import { SEVERITIES, confidenceBand, type FindingsReport, type ReportFinding, type SeverityCounts } from './types.js'

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

/**
 * JSON for a `<script type="application/json">` block. `<` is escaped so no
 * value can close the element or open a comment; U+2028/U+2029 so the text is
 * also valid JS; `/` so no URL in the data appears literally. JSON.parse
 * restores every value exactly.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/\//g, '\\/')
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
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

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

function plural(n: number, one: string, many: string): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`
}

function fmtConfidence(c: unknown): string {
  return isNum(c) ? `${c.toFixed(2)} · ${confidenceBand(c)}` : UNKNOWN
}

function locText(file: unknown, line: unknown): string {
  return line === null || line === undefined ? String(file) : `${String(file)}:${String(line)}`
}

const SEV_LABEL: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }
function sevKey(s: unknown): string {
  return typeof s === 'string' && hasOwn(SEV_LABEL, s) ? s : 'other'
}
function sevLabel(s: unknown): string {
  return typeof s === 'string' && hasOwn(SEV_LABEL, s) ? SEV_LABEL[s] : String(s)
}

export function sevBadge(severity: unknown): Html {
  return h`<span class="badge sev-${sevKey(severity)}">${sevLabel(severity)}</span>`
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

function codeLabel(code: string, names: Record<string, string>): string {
  return hasOwn(names, code) && names[code] ? `${code} ${names[code]}` : code
}

function basename(path: string): string {
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

// ── Report-specific style ──────────────────────────────────────────────────

const REPORT_CSS = String.raw`
.topbar {
  position: sticky; top: 0; z-index: 20; background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.topbar-inner { display: flex; align-items: center; gap: 16px; min-height: 54px; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 15px; min-width: 0; }
.brand-icon { width: 22px; height: 22px; color: var(--accent); flex: none; }
.brand-run { font-weight: 500; color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tabs { display: flex; gap: 4px; margin-left: auto; align-self: stretch; }
.tab {
  display: inline-flex; align-items: center; gap: 7px; padding: 0 14px; color: var(--muted);
  text-decoration: none; font-weight: 600; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }
.tab-count {
  font-size: 11.5px; font-weight: 700; padding: 1px 7px; border-radius: 999px;
  background: var(--surface-3); color: var(--text-2);
}
main.wrap { padding-top: 22px; }
.view > * + * { margin-top: 16px; }
.section-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 18px 10px; flex-wrap: wrap; }
.section-h h2 { font-size: 15px; font-weight: 650; }
.section-h .sub { color: var(--muted); font-size: 12.5px; }
.note { color: var(--muted); font-size: 12.5px; padding: 10px 18px 14px; margin: 0; border-top: 1px solid var(--border); }

/* Header */
.run-header { padding: 20px 22px 18px; }
.rh-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rh-reason { color: var(--text-2); font-weight: 500; }
.rh-title { font-size: 24px; font-weight: 700; margin-top: 12px; letter-spacing: -.01em; }
.rh-root { color: var(--muted); margin-top: 3px; overflow-wrap: anywhere; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 22px; margin: 18px 0 0; padding-top: 16px; border-top: 1px solid var(--border); }
.meta div { min-width: 0; }
.meta dt { font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.meta dd { margin: 2px 0 0; font-weight: 500; overflow-wrap: anywhere; }
.partial {
  display: flex; gap: 10px; align-items: flex-start; padding: 12px 16px; border-radius: var(--radius);
  background: var(--warn-bg); color: var(--warn-fg); border: 1px solid var(--warn-border); font-weight: 500;
}
.partial::before { content: "!"; flex: none; width: 20px; height: 20px; border-radius: 50%; background: var(--warn); color: #fff; font-weight: 800; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }

/* Headline and tiles */
.headline { padding: 20px 22px; }
.headline-text { margin: 0; font-size: 20px; color: var(--text-2); font-weight: 500; }
.headline-text .nw { white-space: nowrap; }
.headline-text strong { color: var(--text); font-weight: 750; font-size: 26px; letter-spacing: -.01em; }
.headline-empty { margin: 0; font-size: 20px; font-weight: 650; }
.headline-empty-sub { margin: 6px 0 0; color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
.tile {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 14px 16px 12px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-2); cursor: pointer; text-align: left; overflow: hidden;
  transition: border-color .12s, transform .12s, background .12s;
}
.tile::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--tc); }
.tile:hover:not(:disabled) { border-color: var(--tc); background: var(--surface); }
.tile:disabled { cursor: default; opacity: .62; }
.tile-label { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 650; color: var(--text-2); text-transform: uppercase; letter-spacing: .05em; }
.tile-label::before { content: ""; width: 9px; height: 9px; border-radius: 3px; background: var(--tc); }
.tile-n { font-size: 30px; font-weight: 750; line-height: 1.15; color: var(--tf); font-variant-numeric: tabular-nums; }
.tile-cta { font-size: 12px; color: var(--muted); }
.tile:hover:not(:disabled) .tile-cta { color: var(--accent); }
.tile.sev-critical { --tc: var(--crit); --tf: var(--crit-fg); }
.tile.sev-high { --tc: var(--high); --tf: var(--high-fg); }
.tile.sev-medium { --tc: var(--med); --tf: var(--med-fg); }
.tile.sev-low { --tc: var(--low); --tf: var(--low-fg); }

/* Scan gaps */
.gaps { border-color: var(--warn-border); }
.gaps .section-h h2 { color: var(--warn-fg); }
.gaps ul { margin: 0; padding: 0 18px 14px 38px; }
.gaps li + li { margin-top: 4px; }
.resume { padding: 0 18px 16px; }
.resume-only .resume { padding-top: 16px; }
.resume-label { font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.codebox {
  display: flex; align-items: center; gap: 10px; background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 8px 8px 12px; min-width: 0;
}
.codebox code { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 7px;
  border: 1px solid var(--border-strong); background: var(--surface); cursor: pointer; font-size: 12.5px;
  font-weight: 600; white-space: nowrap; color: var(--text-2);
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.copied { border-color: var(--ok); color: var(--ok-fg); background: var(--ok-bg); }
.btn-link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font-weight: 600; font-size: 12.5px; }
.btn-link:disabled { color: var(--muted); cursor: default; opacity: .6; }

/* Review first */
.review-list { list-style: none; margin: 0; padding: 0; }
.review-row {
  display: grid; grid-template-columns: 74px 104px minmax(0, 1fr); gap: 14px; align-items: center;
  padding: 10px 18px; border-top: 1px solid var(--border); color: inherit; text-decoration: none;
}
.review-row:hover { background: var(--surface-2); }
.review-row:hover .rr-title { color: var(--accent); }
.rr-conf { font-size: 12.5px; color: var(--text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rr-main { min-width: 0; }
.rr-title { display: block; font-weight: 550; }
.rr-loc { display: block; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }

/* Tables */
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: var(--surface-2); }
.row-link { background: none; border: 0; padding: 0; text-align: left; cursor: pointer; font-weight: 600; color: var(--text); }
tr.clickable:hover .row-link { color: var(--accent); }
.row-link.mono { font-weight: 500; overflow-wrap: anywhere; }
td.file-cell { min-width: 220px; }
@media (max-width: 640px) { td.file-cell { min-width: 0; } }
.codes { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px; border-radius: 6px; font-size: 12px;
  line-height: 18px; background: var(--surface-3); color: var(--text-2); max-width: 100%; overflow-wrap: anywhere;
}
.tag.code { background: var(--accent-bg); color: var(--accent); font-weight: 550; }
.countcell { display: flex; align-items: center; gap: 10px; min-width: 150px; }
.countcell .n { min-width: 3ch; text-align: right; font-weight: 650; font-variant-numeric: tabular-nums; }
.track { flex: 1; min-width: 70px; height: 8px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
.bar { display: flex; height: 100%; border-radius: 4px; overflow: hidden; }
.bar span { display: block; height: 100%; }
.b-critical { background: var(--crit); } .b-high { background: var(--high); }
.b-medium { background: var(--med); } .b-low { background: var(--low); }

/* Coverage, cost, usage */
.facts { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.kv { margin: 0; padding: 0 18px 14px; }
.kv > div { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 6px 0; border-top: 1px dashed var(--border); }
.kv > div:first-child { border-top: 0; }
.kv dt { color: var(--text-2); }
.kv dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.kv .strong dt, .kv .strong dd { font-weight: 700; color: var(--text); }
.kv .why { display: block; font-weight: 400; color: var(--muted); font-size: 12.5px; }
.meter { margin: 0 18px 12px; }
.meter-track { height: 8px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
.meter-fill { height: 100%; background: var(--accent); border-radius: 4px; }
.meter-fill.over { background: var(--warn); }
.meter-label { font-size: 12.5px; color: var(--muted); margin-top: 5px; }
.stat-line { margin: 0; padding: 0 18px 10px; font-size: 18px; font-weight: 650; }
.noscript { padding: 14px 18px; }

/* Findings toolbar */
.toolbar {
  position: sticky; top: var(--topbar-h, 55px); z-index: 10; background: var(--bg);
  padding: 10px 0 12px; margin-top: -6px; border-bottom: 1px solid var(--border);
}
.tb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.tb-row + .tb-row { margin-top: 10px; }
.search { position: relative; flex: 1 1 260px; min-width: 0; }
.search svg { position: absolute; left: 10px; top: 50%; width: 16px; height: 16px; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.search input {
  width: 100%; height: 34px; padding: 0 12px 0 34px; border-radius: 8px; border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--text); font: inherit;
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--border-strong); background: var(--surface); cursor: pointer; font-size: 12.5px; font-weight: 600;
  color: var(--text-2);
}
.chip::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--cc); }
.chip .chip-n { color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.chip[aria-pressed="true"] { background: var(--cbg); border-color: var(--cb); color: var(--cf); }
.chip[aria-pressed="true"] .chip-n { color: inherit; }
.chip.sev-critical { --cc: var(--crit); --cbg: var(--crit-bg); --cb: var(--crit-border); --cf: var(--crit-fg); }
.chip.sev-high { --cc: var(--high); --cbg: var(--high-bg); --cb: var(--high-border); --cf: var(--high-fg); }
.chip.sev-medium { --cc: var(--med); --cbg: var(--med-bg); --cb: var(--med-border); --cf: var(--med-fg); }
.chip.sev-low { --cc: var(--low); --cbg: var(--low-bg); --cb: var(--low-border); --cf: var(--low-fg); }
.field { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); font-weight: 600; min-width: 0; }
.field select {
  height: 32px; max-width: 190px; min-width: 0; padding: 0 8px; border-radius: 7px; border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--text); font: inherit; font-weight: 500;
}
.field input[type="range"] { width: 96px; accent-color: var(--accent); }
.field output { min-width: 4.5ch; color: var(--text); font-variant-numeric: tabular-nums; font-weight: 600; }
.tb-spacer { flex: 1; }
.tb-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; min-width: 0; }
.tb-status { display: inline-flex; align-items: center; gap: 14px; white-space: nowrap; }
.tb-more { display: none; }
.tb-more .tb-more-n { color: var(--accent); }
.tb-count { font-size: 12.5px; color: var(--text-2); font-weight: 600; white-space: nowrap; }
.print-filter-note { display: none; }

/* Finding list */
.finding-list { margin-top: 14px; }
.finding-list > * + * { margin-top: 12px; }
.loc-group.multi { border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); background: var(--surface-2); padding: 0 8px 8px; }
.loc-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 6px; font-size: 13px; }
.loc-head::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--muted); flex: none; }
.loc-head code { font-weight: 600; color: var(--text); overflow-wrap: anywhere; min-width: 0; }
.loc-count { color: var(--muted); font-size: 12.5px; }
.loc-group.multi .finding + .finding { margin-top: 8px; }
.finding {
  background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--fc, var(--other));
  border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 18px 12px; scroll-margin-top: 160px;
}
.finding.sev-critical { --fc: var(--crit); --fbg: var(--crit-bg); --ffg: var(--crit-fg); }
.finding.sev-high { --fc: var(--high); --fbg: var(--high-bg); --ffg: var(--high-fg); }
.finding.sev-medium { --fc: var(--med); --fbg: var(--med-bg); --ffg: var(--med-fg); }
.finding.sev-low { --fc: var(--low); --fbg: var(--low-bg); --ffg: var(--low-fg); }
.finding:focus { outline: none; }
.finding.flash { animation: flash 1.8s ease-out; }
@keyframes flash { 0%, 30% { box-shadow: 0 0 0 3px var(--focus); } 100% { box-shadow: var(--shadow); } }
@media (prefers-reduced-motion: reduce) { .finding.flash { animation: none; box-shadow: 0 0 0 3px var(--focus); } }
.f-head { display: flex; align-items: flex-start; gap: 10px; }
.f-head .badge { margin-top: 1px; flex: none; }
.f-title { font-size: 15px; font-weight: 650; flex: 1; min-width: 0; }
.f-id { color: var(--muted); font-size: 12px; white-space: nowrap; margin-top: 2px; }
.f-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin-top: 8px; font-size: 13px; color: var(--text-2); }
.f-conf { font-variant-numeric: tabular-nums; }
.f-conf b { font-weight: 600; color: var(--text); }
.f-loc { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
.f-loc code { overflow-wrap: anywhere; color: var(--text); }
.vscode { font-size: 12px; text-decoration: none; white-space: nowrap; }
.vscode:hover { text-decoration: underline; }
.f-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.f-tags-label { font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin-right: 2px; }
.f-tags-label:not(:first-child) { margin-left: 8px; }
.f-desc { margin: 10px 0 0; white-space: pre-wrap; color: var(--text-2); line-height: 1.55; }
.trace-toggle {
  display: inline-flex; align-items: center; gap: 7px; margin-top: 10px; padding: 4px 0; background: none; border: 0;
  cursor: pointer; color: var(--accent); font-weight: 600; font-size: 13px;
}
.trace-toggle::before {
  content: ""; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
  transform: rotate(-45deg); transition: transform .12s; margin-right: 2px;
}
.trace-toggle[aria-expanded="true"]::before { transform: rotate(45deg); }
.trace { list-style: none; margin: 8px 0 0; padding: 0; position: relative; }
.step { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; padding: 0 0 12px; position: relative; }
.step::before { content: ""; position: absolute; left: 12px; top: 24px; bottom: 0; width: 2px; background: var(--border); }
.step:last-child::before { display: none; }
.step-n {
  width: 26px; height: 26px; border-radius: 50%; background: var(--surface-3); color: var(--text-2);
  display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; position: relative;
}
.step.k-sink .step-n { background: var(--fbg, var(--other-bg)); color: var(--ffg, var(--other-fg)); box-shadow: inset 0 0 0 1.5px var(--fc, var(--other)); }
.step-body { min-width: 0; padding-top: 2px; }
.step-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.kind { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 1px 7px; border-radius: 5px; background: var(--surface-3); color: var(--text-2); }
.kind.k-entrypoint { background: var(--accent-bg); color: var(--accent); }
.kind.k-sink { background: transparent; color: var(--text); box-shadow: inset 0 0 0 1.5px var(--fc, var(--other)); }
.step-loc { font-size: 12.5px; overflow-wrap: anywhere; color: var(--text); }
.step-desc { margin: 4px 0 0; white-space: pre-wrap; color: var(--text-2); }
.step-just { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 5px; font-size: 12px; color: var(--muted); }
.f-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.f-lane { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; min-width: 0; }
.empty { padding: 30px 18px; text-align: center; color: var(--muted); }
.empty p { margin: 0 0 8px; }

@media (max-width: 900px) {
  .facts { grid-template-columns: minmax(0, 1fr); }
  .toolbar { position: static; }
}
@media (max-width: 640px) {
  .wrap { padding: 0 14px; }
  .topbar-inner { flex-wrap: wrap; gap: 0 12px; min-height: 0; padding-top: 10px; }
  .brand { flex: 1 1 100%; }
  .tabs { margin-left: -14px; flex: 1 1 100%; }
  .tab { padding: 10px 14px; }
  .rh-title { font-size: 20px; }
  .run-header, .headline { padding: 16px; }
  .headline-text { font-size: 16px; }
  .headline-text strong { font-size: 22px; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .tile-n { font-size: 26px; }
  .review-row { grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; padding: 10px 16px; }
  .rr-main { grid-column: 1 / -1; }
  .section-h { padding: 12px 16px 8px; }
  .finding { padding: 12px 14px 10px; }
  .f-head { flex-wrap: wrap; }
  .f-id { order: 3; flex-basis: 100%; margin-top: 0; }
  .search { flex-basis: 100%; }
  .chips { gap: 5px; }
  .chip { height: 28px; padding: 0 8px; font-size: 12px; gap: 5px; }
  .tb-more { display: inline-flex; }
  .tb-fields { display: none; order: 5; flex-basis: 100%; }
  .toolbar.open .tb-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .field { display: grid; grid-template-columns: 116px minmax(0, 1fr) auto; }
  .field select { max-width: none; width: 100%; grid-column: 2 / -1; }
  .field input[type="range"] { width: 100%; }
  table.data.stack thead { display: none; }
  table.data.stack, table.data.stack tbody { display: block; }
  table.data.stack tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 14px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  table.data.stack tr:last-child { border-bottom: 0; }
  table.data.stack td { display: block; padding: 0; border: 0; min-width: 0; }
  table.data.stack td.c-name, table.data.stack td.c-codes { grid-column: 1 / -1; }
  table.data.stack .countcell { min-width: 0; }
}
@media print {
  .topbar, .toolbar { display: none !important; }
  main.wrap { padding-top: 0; max-width: none; }
  .view[hidden] { display: block !important; }
  #view-findings { break-before: page; margin-top: 0; }
  #view-findings::before { content: "Findings"; display: block; font-size: 18px; font-weight: 700; margin-bottom: 8px; }
  .print-filter-note { display: block; margin: 0 0 8px; color: var(--muted); }
  .print-filter-note:empty { display: none; }
  .trace[hidden] { display: block !important; }
  .trace-toggle::before { display: none; }
  .finding { break-inside: avoid; box-shadow: none; }
  .run-header, .headline, .gaps, .partial, .facts .card, .review-row { break-inside: avoid; }
  .section-h { break-after: avoid; }
  table.data td, table.data th { padding: 6px 10px; }
  .countcell { min-width: 110px; }
  .track { min-width: 48px; }
  .loc-head { break-after: avoid; }
  .tile { break-inside: avoid; }
  .tile-cta, .vscode, .btn, .f-foot .btn { display: none !important; }
  .finding.flash { animation: none; }
}
`

// ── Client script (static: it reads the report from #report-data) ──────────
// Written as plain ES2017 in a String.raw literal: no backticks, no "${",
// and nothing that would close the script element.

const REPORT_JS = String.raw`
(function () {
  'use strict';
  var SEVS = ['critical', 'high', 'medium', 'low'];
  var SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  var hasOwn = Object.prototype.hasOwnProperty;
  var data = JSON.parse(document.getElementById('report-data').textContent);
  var findings = Array.isArray(data.findings) ? data.findings : [];
  var summary = data.summary || {};
  var catNames = summary.category_names || {};
  var root = data.run && data.run.target ? data.run.target.root : null;

  function byId(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  // Mirrors confidenceBand() in types.ts.
  function band(c) { return c >= 0.8 ? 'High' : c >= 0.5 ? 'Medium' : 'Low'; }
  function locText(file, line) { return line === null || line === undefined ? String(file) : file + ':' + line; }
  function sevKey(s) { return typeof s === 'string' && hasOwn.call(SEV_LABEL, s) ? s : 'other'; }
  function sevLabel(s) { return typeof s === 'string' && hasOwn.call(SEV_LABEL, s) ? SEV_LABEL[s] : String(s); }
  function codeLabel(c) { return hasOwn.call(catNames, c) && catNames[c] ? c + ' ' + catNames[c] : String(c); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function vscodeHref(file, line) {
    if (!root || line === null || line === undefined || file === null || file === undefined) return null;
    var f = String(file).replace(/\\/g, '/');
    var p = /^(\/|[A-Za-z]:\/)/.test(f) ? f
      : String(root).replace(/\\/g, '/').replace(/\/+$/, '') + '/' + f.replace(/^\.?\/+/, '');
    if (p.charAt(0) !== '/') p = '/' + p;
    return 'vscode:' + '//file' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F') + ':' + encodeURIComponent(String(line));
  }

  // Local date and time for every build-time timestamp.
  var times = document.querySelectorAll('time[data-local]');
  for (var t = 0; t < times.length; t++) {
    var iso = times[t].getAttribute('datetime');
    var d = new Date(iso);
    if (!isNaN(d.getTime())) {
      times[t].textContent = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      times[t].title = iso;
    }
  }

  // ── Copy ──
  function copyText(text, btn) {
    var label = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', label);
    function done(ok) {
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      btn.classList.toggle('copied', ok);
      clearTimeout(btn.copyTimer);
      btn.copyTimer = setTimeout(function () { btn.textContent = label; btn.classList.remove('copied'); }, 1500);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  // ── Views ──
  var views = { summary: byId('view-summary'), findings: byId('view-findings') };
  var tabs = document.querySelectorAll('[data-tab]');
  var current = 'summary';
  var scrollMem = {};
  var topbar = document.querySelector('.topbar');
  function syncTopbar() {
    if (topbar) document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
  }
  syncTopbar();
  window.addEventListener('resize', syncTopbar);

  function showView(name) {
    if (name === 'findings') ensureBuilt();
    var changed = current !== name;
    if (changed) scrollMem[current] = window.scrollY;
    views.summary.hidden = name !== 'summary';
    views.findings.hidden = name !== 'findings';
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === name;
      tabs[i].classList.toggle('active', on);
      if (on) tabs[i].setAttribute('aria-current', 'page'); else tabs[i].removeAttribute('aria-current');
    }
    current = name;
    return changed;
  }
  function decodeHash() {
    var h = location.hash.replace(/^#/, '');
    try { return decodeURIComponent(h); } catch (e) { return h; }
  }
  var idxById = new Map();
  for (var fi = 0; fi < findings.length; fi++) {
    var fid = findings[fi] && findings[fi].finding_id;
    if (fid !== undefined && fid !== null && !idxById.has(String(fid))) idxById.set(String(fid), fi);
  }
  function route() {
    var h = decodeHash();
    if (h !== 'summary' && h !== 'findings' && idxById.has(h)) { goTo(idxById.get(h)); return; }
    var name = h === 'findings' ? 'findings' : 'summary';
    if (showView(name)) window.scrollTo(0, scrollMem[name] || 0);
  }

  // ── Findings list ──
  var built = false;
  var recs = [];
  var groups = [];
  var groupOrder = [];
  var classList = [];
  var classIdx = new Map();
  var fileList = [];
  var fileIdx = new Map();
  var list = byId('finding-list');
  var q = byId('f-q'), typeSel = byId('f-type'), fileSel = byId('f-file');
  var confIn = byId('f-conf'), confOut = byId('f-conf-v'), sortSel = byId('f-sort');
  var countEl = byId('f-count'), clearBtn = byId('f-clear'), emptyEl = byId('f-empty');
  var printNote = byId('f-print-note');
  var toolbarEl = byId('toolbar'), moreBtn = byId('f-more'), moreN = byId('f-more-n');
  var chips = document.querySelectorAll('[data-sev-chip]');

  function classesOf(f) {
    var out = [];
    var fc = Array.isArray(f.finding_classes) ? f.finding_classes : [];
    for (var i = 0; i < fc.length; i++) {
      var c = fc[i] && fc[i].class;
      if (c !== undefined && c !== null && out.indexOf(String(c)) < 0) out.push(String(c));
    }
    return out;
  }

  function ensureBuilt() {
    if (built || !list) return;
    built = true;
    var byKey = new Map();
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i] || {};
      var loc = f.location || {};
      var file = loc.file === undefined || loc.file === null ? '' : String(loc.file);
      var line = loc.line === undefined ? null : loc.line;
      var key = line === null ? '#' + i : file + '\n' + line;
      var g = byKey.get(key);
      if (!g) {
        g = { file: file, line: line, members: [], first: i, firstVis: i, vis: 0, el: null, countEl: null };
        byKey.set(key, g);
        groups.push(g);
      }
      var rec = {
        idx: i, f: f, sev: sevKey(f.severity_estimate), conf: f.confidence, classes: classesOf(f),
        file: file, line: line, group: g, el: null, trace: null, traceBtn: null, traceBuilt: false,
        text: [f.title, f.description, file, f.finding_id].map(function (v) { return v === undefined || v === null ? '' : String(v); }).join('\n').toLowerCase()
      };
      g.members.push(rec);
      recs.push(rec);
    }
    var frag = document.createDocumentFragment();
    for (var j = 0; j < groups.length; j++) {
      groups[j].el = buildGroup(groups[j]);
      frag.appendChild(groups[j].el);
    }
    list.appendChild(frag);
    groupOrder = groups.slice();
    populateControls();
    applyFilters();
  }

  function buildGroup(g) {
    var wrap = el('div', 'loc-group');
    if (g.members.length > 1) {
      wrap.classList.add('multi');
      var head = el('div', 'loc-head');
      head.appendChild(el('code', null, locText(g.file, g.line)));
      g.countEl = el('span', 'loc-count');
      head.appendChild(g.countEl);
      wrap.appendChild(head);
    }
    for (var i = 0; i < g.members.length; i++) wrap.appendChild(buildCard(g.members[i]));
    return wrap;
  }

  function tag(text, cls) { return el('span', 'tag' + (cls ? ' ' + cls : ''), text); }

  function buildCard(rec) {
    var f = rec.f;
    var card = el('article', 'finding sev-' + rec.sev);
    if (f.finding_id !== undefined && f.finding_id !== null) card.setAttribute('id', String(f.finding_id));
    card.setAttribute('tabindex', '-1');
    rec.el = card;

    var head = el('div', 'f-head');
    head.appendChild(el('span', 'badge sev-' + rec.sev, sevLabel(f.severity_estimate)));
    head.appendChild(el('h3', 'f-title', f.title === undefined || f.title === null ? '(untitled)' : f.title));
    head.appendChild(el('span', 'f-id mono', f.finding_id));
    card.appendChild(head);

    var meta = el('div', 'f-meta');
    var conf = el('span', 'f-conf');
    conf.appendChild(document.createTextNode('Confidence '));
    conf.appendChild(el('b', null, isNum(f.confidence) ? f.confidence.toFixed(2) + ' · ' + band(f.confidence) : 'unknown'));
    meta.appendChild(conf);
    var locWrap = el('span', 'f-loc');
    locWrap.appendChild(el('code', null, locText(rec.file, rec.line)));
    var href = vscodeHref(rec.file, rec.line);
    if (href) {
      var a = el('a', 'vscode no-print', 'Open in VS Code');
      a.setAttribute('href', href);
      locWrap.appendChild(a);
    }
    meta.appendChild(locWrap);
    card.appendChild(meta);

    var cats = Array.isArray(f.categories) ? f.categories : [];
    if (rec.classes.length || cats.length) {
      var tags = el('div', 'f-tags');
      if (rec.classes.length) {
        tags.appendChild(el('span', 'f-tags-label', 'Type'));
        for (var i = 0; i < rec.classes.length; i++) tags.appendChild(tag(rec.classes[i]));
      }
      if (cats.length) {
        tags.appendChild(el('span', 'f-tags-label', 'OWASP'));
        for (var k = 0; k < cats.length; k++) tags.appendChild(tag(codeLabel(cats[k]), 'code'));
      }
      card.appendChild(tags);
    }

    if (f.description !== undefined && f.description !== null && f.description !== '') {
      card.appendChild(el('p', 'f-desc', f.description));
    }

    var steps = Array.isArray(f.trace) ? f.trace : [];
    if (steps.length) {
      var btn = el('button', 'trace-toggle', 'Trace · ' + plural(steps.length, 'step', 'steps'));
      btn.setAttribute('type', 'button');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('data-trace', String(rec.idx));
      var ol = el('ol', 'trace');
      ol.hidden = true;
      card.appendChild(btn);
      card.appendChild(ol);
      rec.trace = ol;
      rec.traceBtn = btn;
    }

    var foot = el('div', 'f-foot');
    foot.appendChild(el('span', 'f-lane mono', f.lane_id === undefined || f.lane_id === null ? '' : 'lane ' + f.lane_id));
    var copy = el('button', 'btn no-print', 'Copy JSON');
    copy.setAttribute('type', 'button');
    copy.setAttribute('data-copy', String(rec.idx));
    foot.appendChild(copy);
    card.appendChild(foot);
    return card;
  }

  function renderTrace(rec) {
    if (rec.traceBuilt || !rec.trace) return;
    rec.traceBuilt = true;
    var f = rec.f;
    var justifies = new Map();
    var fc = Array.isArray(f.finding_classes) ? f.finding_classes : [];
    for (var i = 0; i < fc.length; i++) {
      if (!fc[i]) continue;
      var at = fc[i].justified_by_step;
      if (!justifies.has(at)) justifies.set(at, []);
      if (justifies.get(at).indexOf(String(fc[i].class)) < 0) justifies.get(at).push(String(fc[i].class));
    }
    var steps = f.trace;
    var frag = document.createDocumentFragment();
    for (var s = 0; s < steps.length; s++) {
      var st = steps[s] || {};
      var kind = st.kind === 'entrypoint' || st.kind === 'propagation' || st.kind === 'sink' ? st.kind : 'other';
      var li = el('li', 'step k-' + kind);
      li.appendChild(el('span', 'step-n', s + 1));
      var body = el('div', 'step-body');
      var head = el('div', 'step-head');
      head.appendChild(el('span', 'kind k-' + kind, st.kind));
      head.appendChild(el('code', 'step-loc', locText(st.file, st.line)));
      body.appendChild(head);
      if (st.description !== undefined && st.description !== null && st.description !== '') body.appendChild(el('p', 'step-desc', st.description));
      var just = justifies.get(s);
      if (just && just.length) {
        var jd = el('div', 'step-just');
        jd.appendChild(el('span', null, 'Justifies'));
        for (var j = 0; j < just.length; j++) jd.appendChild(tag(just[j]));
        body.appendChild(jd);
      }
      li.appendChild(body);
      frag.appendChild(li);
    }
    rec.trace.appendChild(frag);
  }

  function toggleTrace(rec) {
    renderTrace(rec);
    var open = rec.trace.hidden;
    rec.trace.hidden = !open;
    rec.traceBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function addOption(sel, value, text) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }

  function populateControls() {
    var sevCount = { critical: 0, high: 0, medium: 0, low: 0 };
    var clsCount = new Map();
    var fileCount = new Map();
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (hasOwn.call(sevCount, r.sev)) sevCount[r.sev]++;
      for (var c = 0; c < r.classes.length; c++) clsCount.set(r.classes[c], (clsCount.get(r.classes[c]) || 0) + 1);
      fileCount.set(r.file, (fileCount.get(r.file) || 0) + 1);
    }
    for (var k = 0; k < chips.length; k++) {
      var n = chips[k].querySelector('.chip-n');
      if (n) n.textContent = String(sevCount[chips[k].getAttribute('data-sev-chip')] || 0);
    }
    var rows = Array.isArray(summary.by_class) ? summary.by_class : [];
    for (var b = 0; b < rows.length; b++) {
      var id = rows[b] && rows[b].class !== undefined ? String(rows[b].class) : null;
      if (id !== null && !classIdx.has(id) && clsCount.has(id)) { classIdx.set(id, classList.length); classList.push(id); }
    }
    clsCount.forEach(function (_n, id) { if (!classIdx.has(id)) { classIdx.set(id, classList.length); classList.push(id); } });
    if (typeSel) for (var t = 0; t < classList.length; t++) addOption(typeSel, String(t), classList[t] + ' (' + clsCount.get(classList[t]) + ')');
    fileCount.forEach(function (_n, file) { fileList.push(file); });
    fileList.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    for (var x = 0; x < fileList.length; x++) {
      fileIdx.set(fileList[x], x);
      if (fileSel) addOption(fileSel, String(x), fileList[x] + ' (' + fileCount.get(fileList[x]) + ')');
    }
  }

  function activeSevs() {
    var out = [];
    for (var i = 0; i < chips.length; i++) if (chips[i].getAttribute('aria-pressed') === 'true') out.push(chips[i].getAttribute('data-sev-chip'));
    return out;
  }

  function confLabel() {
    var v = parseFloat(confIn.value) || 0;
    confOut.textContent = v <= 0 ? 'Any' : '≥ ' + v.toFixed(2);
  }

  function applyFilters() {
    if (!built) return;
    var needle = q ? q.value.trim().toLowerCase() : '';
    var sevs = activeSevs();
    var cls = typeSel && typeSel.value !== '' ? classList[+typeSel.value] : null;
    var file = fileSel && fileSel.value !== '' ? fileList[+fileSel.value] : null;
    var minC = confIn ? parseFloat(confIn.value) || 0 : 0;
    var shown = 0;
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      var ok = (!sevs.length || sevs.indexOf(r.sev) >= 0) &&
        (cls === null || r.classes.indexOf(cls) >= 0) &&
        (file === null || r.file === file) &&
        (minC <= 0 || (isNum(r.conf) && r.conf >= minC - 1e-9)) &&
        (!needle || r.text.indexOf(needle) >= 0);
      if (r.el.hidden === ok) r.el.hidden = !ok;
      r.visible = ok;
      if (ok) shown++;
    }
    for (var g = 0; g < groups.length; g++) {
      var gr = groups[g];
      var vis = 0, firstVis = -1;
      for (var m = 0; m < gr.members.length; m++) if (gr.members[m].visible) { vis++; if (firstVis < 0) firstVis = gr.members[m].idx; }
      gr.vis = vis;
      gr.firstVis = firstVis < 0 ? gr.first : firstVis;
      if (gr.el.hidden === (vis > 0)) gr.el.hidden = vis === 0;
      if (gr.countEl) {
        gr.countEl.textContent = vis === gr.members.length
          ? plural(vis, 'vulnerability', 'vulnerabilities') + ' at this location'
          : vis + ' of ' + gr.members.length + ' shown at this location';
      }
    }
    reorder();
    var total = recs.length;
    var filtered = shown !== total;
    if (countEl) countEl.textContent = filtered ? 'Showing ' + shown + ' of ' + total : plural(total, 'vulnerability', 'vulnerabilities');
    if (printNote) printNote.textContent = filtered ? 'Filtered: ' + shown + ' of ' + total + ' vulnerabilities shown.' : '';
    if (emptyEl) emptyEl.hidden = shown > 0 || total === 0;
    var any = sevs.length > 0 || cls !== null || file !== null || minC > 0 || needle !== '';
    if (clearBtn) clearBtn.disabled = !any;
    var hiddenActive = (cls !== null ? 1 : 0) + (file !== null ? 1 : 0) + (minC > 0 ? 1 : 0);
    if (moreN) moreN.textContent = hiddenActive ? ' (' + hiddenActive + ')' : '';
  }

  function reorder() {
    var byFile = sortSel && sortSel.value === 'file';
    var order = groups.slice().sort(function (a, b) {
      if (byFile) {
        if (a.file !== b.file) return a.file < b.file ? -1 : 1;
        var la = a.line === null ? Infinity : Number(a.line), lb = b.line === null ? Infinity : Number(b.line);
        if (la !== lb && !(isNaN(la) || isNaN(lb))) return la < lb ? -1 : 1;
      }
      return a.firstVis - b.firstVis;
    });
    var same = order.length === groupOrder.length;
    for (var i = 0; same && i < order.length; i++) if (order[i] !== groupOrder[i]) same = false;
    if (same) return;
    var frag = document.createDocumentFragment();
    for (var j = 0; j < order.length; j++) frag.appendChild(order[j].el);
    list.appendChild(frag);
    groupOrder = order;
  }

  function resetControls() {
    if (q) q.value = '';
    for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', 'false');
    if (typeSel) typeSel.value = '';
    if (fileSel) fileSel.value = '';
    if (confIn) { confIn.value = '0'; confLabel(); }
  }

  function stickyOffset() {
    var h = topbar ? topbar.offsetHeight : 0;
    var bar = byId('toolbar');
    if (bar && getComputedStyle(bar).position === 'sticky') h += bar.offsetHeight;
    return h;
  }

  function goTo(idx) {
    showView('findings');
    var rec = recs[idx];
    if (!rec) return;
    if (rec.el.hidden) { resetControls(); applyFilters(); }
    var top = rec.el.getBoundingClientRect().top + window.scrollY - stickyOffset() - 12;
    window.scrollTo(0, Math.max(0, top));
    rec.el.classList.remove('flash');
    void rec.el.offsetWidth;
    rec.el.classList.add('flash');
    rec.el.focus({ preventScroll: true });
  }

  function openFiltered(setup) {
    ensureBuilt();
    resetControls();
    setup();
    applyFilters();
    showView('findings');
    scrollMem.findings = 0;
    window.scrollTo(0, 0);
    if (decodeHash() !== 'findings') location.hash = 'findings';
  }

  // ── Events ──
  if (q) {
    var timer = null;
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(applyFilters, 120); });
  }
  for (var c = 0; c < chips.length; c++) {
    chips[c].addEventListener('click', function () {
      this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      applyFilters();
    });
  }
  if (typeSel) typeSel.addEventListener('change', applyFilters);
  if (fileSel) fileSel.addEventListener('change', applyFilters);
  if (sortSel) sortSel.addEventListener('change', applyFilters);
  if (confIn) confIn.addEventListener('input', function () { confLabel(); applyFilters(); });
  if (moreBtn && toolbarEl) {
    moreBtn.addEventListener('click', function () {
      var open = !toolbarEl.classList.contains('open');
      toolbarEl.classList.toggle('open', open);
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  if (clearBtn) clearBtn.addEventListener('click', function () { resetControls(); applyFilters(); });
  var emptyClear = byId('f-empty-clear');
  if (emptyClear) emptyClear.addEventListener('click', function () { resetControls(); applyFilters(); });

  if (list) {
    list.addEventListener('click', function (e) {
      var copy = e.target.closest('[data-copy]');
      if (copy) { copyText(JSON.stringify(findings[+copy.getAttribute('data-copy')], null, 2), copy); return; }
      var tr = e.target.closest('[data-trace]');
      if (tr) toggleTrace(recs[+tr.getAttribute('data-trace')]);
    });
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target.closest) return;
    var go = target.closest('a[data-goto]');
    if (go) {
      var idx = +go.getAttribute('data-goto');
      var f = findings[idx];
      if (f && decodeHash() === String(f.finding_id)) { e.preventDefault(); goTo(idx); }
      return;
    }
    var sev = target.closest('[data-filter-sev]');
    if (sev) {
      var s = sev.getAttribute('data-filter-sev');
      openFiltered(function () {
        for (var i = 0; i < chips.length; i++) if (chips[i].getAttribute('data-sev-chip') === s) chips[i].setAttribute('aria-pressed', 'true');
      });
      return;
    }
    var cl = target.closest('[data-filter-class]');
    if (cl) {
      var row = (summary.by_class || [])[+cl.getAttribute('data-filter-class')];
      openFiltered(function () {
        if (row && classIdx.has(String(row.class)) && typeSel) typeSel.value = String(classIdx.get(String(row.class)));
      });
      return;
    }
    var fl = target.closest('[data-filter-file]');
    if (fl) {
      var frow = (summary.top_files || [])[+fl.getAttribute('data-filter-file')];
      openFiltered(function () {
        if (frow && fileIdx.has(String(frow.file)) && fileSel) fileSel.value = String(fileIdx.get(String(frow.file)));
      });
      return;
    }
    var rc = target.closest('[data-copy-resume]');
    if (rc && data.resume_command) copyText(String(data.resume_command), rc);
  });

  window.addEventListener('beforeprint', function () {
    ensureBuilt();
    for (var i = 0; i < recs.length; i++) renderTrace(recs[i]);
  });
  window.addEventListener('hashchange', route);
  route();
})();
`

// ── Summary (build time) ───────────────────────────────────────────────────

function headerCard(r: FindingsReport): Html {
  const run = r.run
  const firstGap = r.scan_gaps[0]
  const root = run.target.root
  const model = run.model.label || run.model.name || run.model.key
  return h`<section class="card run-header" aria-label="Run">
  <div class="rh-status">${statusBadge(run.status)}${firstGap ? h`<span class="rh-reason">${gapShort(firstGap.reason)}</span>` : ''}</div>
  <h1 class="rh-title">${root ? basename(root) : 'Security scan report'}</h1>
  <div class="rh-root mono">${root ?? 'Target unknown'}</div>
  <dl class="meta">
    <div><dt>Branch</dt><dd class="mono">${branchAtCommit(run.target.branch, run.target.commit)}</dd></div>
    <div><dt>Started</dt><dd>${timeEl(run.started_at || r.generated_at)}</dd></div>
    <div><dt>Run</dt><dd class="mono">${run.id}</dd></div>
    ${run.passes !== null && run.passes !== undefined ? h`<div><dt>Pass</dt><dd>${fmtInt(run.passes)}</dd></div>` : ''}
    <div><dt>Model</dt><dd>${model}</dd></div>
    <div><dt>secscan</dt><dd class="mono">${r.secscan_version}</dd></div>
  </dl>
</section>`
}

function partialLine(r: FindingsReport): Html | '' {
  const { scanned, in_scope } = r.summary.coverage
  if (r.run.status !== 'INCOMPLETE' || !isNum(scanned) || !isNum(in_scope) || scanned <= 0) return ''
  return h`<p class="partial" role="note">Partial scan: ${fmtInt(scanned)} of ${fmtInt(in_scope)} files scanned. Everything below covers those files.</p>`
}

function severityTiles(counts: SeverityCounts): Html {
  return h`<div class="tiles">${SEVERITIES.map(s => {
    const n = isNum(counts[s]) ? counts[s] : 0
    return h`<button type="button" class="tile sev-${s}" data-filter-sev="${s}"${n === 0 ? raw(' disabled') : ''} aria-label="${`Show ${plural(n, s + ' vulnerability', s + ' vulnerabilities')}`}">
      <span class="tile-label">${SEV_LABEL[s]}</span><span class="tile-n">${fmtInt(counts[s])}</span><span class="tile-cta no-print">${n === 0 ? 'None' : 'View in Findings'}</span>
    </button>`
  })}</div>`
}

function headline(r: FindingsReport): Html {
  const s = r.summary
  const scanned = s.coverage.scanned
  if (scanned === 0) {
    return h`<section class="card headline" aria-label="Headline">
  <p class="headline-empty">No files were scanned</p>
  <p class="headline-empty-sub">This run ended before any file finished, so it has no results.</p>
</section>`
  }
  if (r.run.status === 'COMPLETE' && s.findings_total === 0) {
    const where = isNum(scanned) ? plural(scanned, 'scanned file', 'scanned files') : 'the scanned files'
    return h`<section class="card headline" aria-label="Headline">
  <p class="headline-empty">No vulnerabilities found in ${where}</p>
</section>`
  }
  return h`<section class="card headline" aria-label="Headline">
  <p class="headline-text"><strong class="nw">${plural(s.findings_total, 'vulnerability', 'vulnerabilities')}</strong> · <span class="nw">${plural(s.distinct_locations, 'location', 'locations')}</span> · <span class="nw">${plural(s.files_with_findings, 'file', 'files')}</span></p>
  ${severityTiles(s.by_severity)}
</section>`
}

function resumeBlock(cmd: string): Html {
  return h`<div class="resume">
    <div class="resume-label">Continue:</div>
    <div class="codebox"><code>${cmd}</code><button type="button" class="btn no-print" data-copy-resume>Copy</button></div>
  </div>`
}

function gapsBox(r: FindingsReport): Html | '' {
  if (r.scan_gaps.length === 0) {
    return r.resume_command ? h`<section class="card resume-only" aria-label="Continue">${resumeBlock(r.resume_command)}</section>` : ''
  }
  return h`<section class="card gaps" aria-labelledby="s-gaps">
  <div class="section-h"><h2 id="s-gaps">Scan gaps</h2></div>
  <ul>${r.scan_gaps.map(g => h`<li>${g.detail}</li>`)}</ul>
  ${r.resume_command ? resumeBlock(r.resume_command) : ''}
</section>`
}

function reviewFirst(r: FindingsReport): Html | '' {
  const index = new Map<string, number>()
  r.findings.forEach((f, i) => { if (!index.has(f.finding_id)) index.set(f.finding_id, i) })
  const rows = r.summary.review_first.slice(0, 10)
    .map(id => index.get(id))
    .filter((i): i is number => i !== undefined)
  if (!rows.length) return ''
  return h`<section class="card" aria-labelledby="s-review">
  <div class="section-h"><h2 id="s-review">Review first</h2><span class="sub">Most severe, then most confident</span></div>
  <ol class="review-list">${rows.map(i => {
    const f: ReportFinding = r.findings[i]
    return h`<li><a class="review-row" href="#${encodeURIComponent(f.finding_id)}" data-goto="${i}">
      ${sevBadge(f.severity_estimate)}
      <span class="rr-conf">${fmtConfidence(f.confidence)}</span>
      <span class="rr-main"><span class="rr-title">${f.title}</span><span class="rr-loc mono">${locText(f.location.file, f.location.line)}</span></span>
    </a></li>`
  })}</ol>
</section>`
}

function countCell(count: number, by: SeverityCounts, max: number): Html {
  const total = SEVERITIES.reduce((a, s) => a + (isNum(by[s]) ? by[s] : 0), 0)
  const width = max > 0 && isNum(count) ? Math.min(100, (count / max) * 100) : 0
  const segs = total > 0
    ? SEVERITIES.filter(s => isNum(by[s]) && by[s] > 0).map(s =>
      h`<span class="b-${s}" style="width:${((by[s] / total) * 100).toFixed(2)}%"></span>`)
    : []
  return h`<div class="countcell"><span class="n">${fmtInt(count)}</span><span class="track"><span class="bar" style="width:${width.toFixed(2)}%">${segs}</span></span></div>`
}

function splitCells(by: SeverityCounts): Html {
  return h`<span class="split">${SEVERITIES.map(s =>
    h`<span class="sevnum sev-${s}${by[s] === 0 ? ' zero' : ''}" title="${SEV_LABEL[s]}">${fmtInt(by[s])}</span>`)}</span>`
}

function byClass(r: FindingsReport): Html | '' {
  const rows = r.summary.by_class
  if (!rows.length) return ''
  const names = r.summary.category_names
  const max = Math.max(0, ...rows.map(x => (isNum(x.count) ? x.count : 0)))
  return h`<section class="card" aria-labelledby="s-types">
  <div class="section-h"><h2 id="s-types">By vulnerability type</h2><span class="sub">Select a row to see those findings</span></div>
  <div class="table-scroll"><table class="data stack">
    <thead><tr><th>Type</th><th>OWASP</th><th>Vulnerabilities</th><th>Critical · High · Medium · Low</th></tr></thead>
    <tbody>${rows.map((row, i) => h`<tr class="clickable" data-filter-class="${i}">
      <td class="c-name"><button type="button" class="row-link">${row.class}</button></td>
      <td class="c-codes"><span class="codes">${row.codes.length ? row.codes.map(c => h`<span class="tag code">${codeLabel(c, names)}</span>`) : h`<span class="muted">none</span>`}</span></td>
      <td class="c-count">${countCell(row.count, row.by_severity, max)}</td>
      <td class="c-split">${splitCells(row.by_severity)}</td>
    </tr>`)}</tbody>
  </table></div>
  <p class="note">A finding counts under every type it carries.</p>
</section>`
}

function topFiles(r: FindingsReport): Html | '' {
  const rows = r.summary.top_files
  if (!rows.length) return ''
  const max = Math.max(0, ...rows.map(x => (isNum(x.count) ? x.count : 0)))
  return h`<section class="card" aria-labelledby="s-files">
  <div class="section-h"><h2 id="s-files">Top files</h2><span class="sub">Files with the most findings</span></div>
  <div class="table-scroll"><table class="data stack">
    <thead><tr><th>File</th><th>Vulnerabilities</th><th>Critical · High · Medium · Low</th></tr></thead>
    <tbody>${rows.map((row, i) => h`<tr class="clickable" data-filter-file="${i}">
      <td class="file-cell c-name"><button type="button" class="row-link mono">${row.file}</button></td>
      <td class="c-count">${countCell(row.count, row.by_severity, max)}</td>
      <td class="c-split">${splitCells(row.by_severity)}</td>
    </tr>`)}</tbody>
  </table></div>
</section>`
}

function kvRow(label: string, value: string, opts: { strong?: boolean; why?: string } = {}): Html {
  return h`<div${opts.strong ? raw(' class="strong"') : ''}><dt>${label}</dt><dd>${value}${opts.why ? h`<span class="why">${opts.why}</span>` : ''}</dd></div>`
}

function meter(value: number | null, max: number | null, label: string): Html | '' {
  if (!isNum(value) || !isNum(max) || max <= 0) return ''
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return h`<div class="meter"><div class="meter-track"><div class="meter-fill${value > max ? ' over' : ''}" style="width:${pct.toFixed(1)}%"></div></div><div class="meter-label">${label}</div></div>`
}

function facts(r: FindingsReport): Html {
  const c = r.summary.coverage
  const breakdown = notScannedBreakdown(c.not_scanned_by_reason)
  const { spent_usd: spent, budget_usd: budget } = r.summary.cost
  const costLine = isNum(spent)
    ? (isNum(budget) ? `${fmtUsd(spent)} spent of ${fmtUsd(budget)} budget` : `${fmtUsd(spent)} spent`)
    : (isNum(budget) ? `Spent: unknown · budget ${fmtUsd(budget)}` : UNKNOWN)
  const u = r.summary.usage
  const pct = isNum(c.scanned) && isNum(c.in_scope) && c.in_scope > 0 ? Math.round((c.scanned / c.in_scope) * 100) : null
  return h`<div class="facts">
  <section class="card" aria-labelledby="s-coverage">
    <div class="section-h"><h2 id="s-coverage">Coverage</h2></div>
    ${meter(c.scanned, c.in_scope, `${fmtInt(c.scanned)} of ${fmtInt(c.in_scope)} in-scope files scanned (${pct}%)`)}
    <dl class="kv">
      ${kvRow('Files in repo', fmtInt(c.files_in_repo))}
      ${kvRow('Skipped by file selection', fmtInt(c.skipped_by_selector))}
      ${kvRow('No selected class after review', fmtInt(c.skipped_no_selected_class))}
      ${kvRow('Excluded by your scope', fmtInt(c.scope_excluded))}
      ${kvRow('In scope', fmtInt(c.in_scope), { strong: true })}
      ${kvRow('Scanned', fmtInt(c.scanned), { strong: true })}
      ${kvRow('Not scanned', fmtInt(c.not_scanned), { why: breakdown })}
    </dl>
  </section>
  <section class="card" aria-labelledby="s-cost">
    <div class="section-h"><h2 id="s-cost">Cost</h2></div>
    <p class="stat-line">${costLine}</p>
    ${meter(spent, budget, isNum(spent) && isNum(budget) && budget > 0 ? `${Math.round((spent / budget) * 100)}% of budget used` : '')}
  </section>
  <section class="card" aria-labelledby="s-usage">
    <div class="section-h"><h2 id="s-usage">Usage</h2></div>
    <dl class="kv">
      <div><dt>Input tokens</dt><dd title="${fmtInt(u.input_tokens)}">${fmtTokens(u.input_tokens)}</dd></div>
      <div><dt>Output tokens</dt><dd title="${fmtInt(u.output_tokens)}">${fmtTokens(u.output_tokens)}</dd></div>
      <div><dt>Wall clock</dt><dd>${fmtDuration(u.wall_clock_seconds)}</dd></div>
    </dl>
  </section>
</div>`
}

function summaryView(r: FindingsReport): Html {
  return h`${headerCard(r)}
${partialLine(r)}
${headline(r)}
${gapsBox(r)}
${reviewFirst(r)}
${byClass(r)}
${topFiles(r)}
${facts(r)}
<noscript><div class="card noscript">The findings list needs JavaScript. Every finding is also in findings.json next to this file.</div></noscript>`
}

// ── Findings view shell (build time; the list itself is built in the page) ──

const SEARCH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M13 13l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'

function findingsView(r: FindingsReport): Html {
  if (r.findings.length === 0) {
    const why = r.summary.coverage.scanned === 0
      ? 'No files were scanned, so this report has no findings.'
      : 'No vulnerabilities were found in the scanned files.'
    return h`<div class="card empty"><p>${why}</p></div>`
  }
  return h`<div class="toolbar no-print" id="toolbar">
  <div class="tb-row">
    <label class="search">${raw(SEARCH_ICON)}<input type="search" id="f-q" placeholder="Search title, description or file" aria-label="Search findings" autocomplete="off"></label>
    <div class="chips" role="group" aria-label="Severity">${SEVERITIES.map(s =>
      h`<button type="button" class="chip sev-${s}" data-sev-chip="${s}" aria-pressed="false">${SEV_LABEL[s]} <span class="chip-n"></span></button>`)}</div>
  </div>
  <div class="tb-row">
    <button type="button" class="btn tb-more" id="f-more" aria-expanded="false" aria-controls="f-fields">Filters<span class="tb-more-n" id="f-more-n"></span></button>
    <div class="tb-fields" id="f-fields">
    <label class="field">Type <select id="f-type"><option value="">All types</option></select></label>
    <label class="field">File <select id="f-file"><option value="">All files</option></select></label>
    <label class="field">Min confidence <input type="range" id="f-conf" min="0" max="1" step="0.05" value="0"><output id="f-conf-v" for="f-conf">Any</output></label>
    <label class="field">Sort <select id="f-sort"><option value="report">Report order</option><option value="file">File, then line</option></select></label>
    </div>
    <span class="tb-spacer"></span>
    <span class="tb-status"><span class="tb-count" id="f-count" aria-live="polite"></span><button type="button" class="btn-link" id="f-clear" disabled>Clear filters</button></span>
  </div>
</div>
<p class="print-filter-note" id="f-print-note"></p>
<div class="finding-list" id="finding-list"></div>
<div class="card empty" id="f-empty" hidden><p>No vulnerabilities match these filters.</p><button type="button" class="btn" id="f-empty-clear">Clear filters</button></div>`
}

// ── Page ────────────────────────────────────────────────────────────────────

export function renderReportHtml(report: FindingsReport): string {
  const r = report
  const page = h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${raw(CSP_META)}
<meta name="color-scheme" content="light dark">
<title>${`secscan report · ${r.run.id}`}</title>
${raw(FAVICON_LINK)}
<style>${raw(BASE_CSS)}${raw(REPORT_CSS)}</style>
</head>
<body>
<header class="topbar">
  <div class="wrap topbar-inner">
    <div class="brand">${raw(BRAND_ICON)}<span>secscan</span><span class="brand-run mono">${r.run.id}</span></div>
    <nav class="tabs" aria-label="Views">
      <a class="tab active" href="#summary" data-tab="summary" aria-current="page">Summary</a>
      <a class="tab" href="#findings" data-tab="findings">Findings <span class="tab-count">${fmtInt(r.findings.length)}</span></a>
    </nav>
  </div>
</header>
<main class="wrap">
<section class="view" id="view-summary" aria-label="Summary">
${summaryView(r)}
</section>
<section class="view" id="view-findings" aria-label="Findings" hidden>
${findingsView(r)}
</section>
</main>
<footer class="wrap site-footer">Generated ${timeEl(r.generated_at)} by secscan ${r.secscan_version}. The same data is in findings.json next to this file.</footer>
<script type="application/json" id="report-data">${raw(embedJson(r))}</script>
<script>${raw(REPORT_JS)}</script>
</body>
</html>
`
  return page.html
}
