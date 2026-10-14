/**
 * Renders the reports folder's index.html: every run that has a report, in the
 * order given (the caller sorts newest first), each linking to its report.html.
 *
 * Same look, CSP and rules as report.html: built entirely at build time through
 * the escaping template tag, no network URL anywhere, and output that depends
 * only on its arguments. The one inline script swaps build-time UTC timestamps
 * for the viewer's local time; it reads no data.
 *
 * Zero dependencies.
 */
import { SEVERITIES, type IndexEntry, type SeverityCounts } from './types.js'
import {
  h, raw, BASE_CSS, CSP_META, FAVICON_LINK, BRAND_ICON, UNKNOWN,
  fmtInt, fmtUsd, timeEl, branchAtCommit, statusBadge,
} from './html.js'

/**
 * A relative path becomes a relative URL: each segment is percent-encoded, so a
 * run id can neither carry a scheme ("javascript:") nor break out of the path.
 */
export function relativeHref(path: string): string {
  return String(path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

const INDEX_CSS = String.raw`
.index-head { display: flex; align-items: center; gap: 12px; padding: 28px 0 18px; }
.index-head .brand-icon { width: 30px; height: 30px; color: var(--accent); }
.index-head h1 { font-size: 22px; font-weight: 700; }
.index-head .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
.runs td { white-space: nowrap; }
.runs td.wrapok { white-space: normal; overflow-wrap: anywhere; min-width: 200px; width: 32%; }
.runs .two { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.runs .primary { font-weight: 550; }
.runs .secondary { color: var(--muted); font-size: 12px; }
.runs .vulns { display: inline-flex; align-items: center; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.runs .total { font-weight: 650; margin-right: 10px; font-variant-numeric: tabular-nums; }
.runs .open { font-weight: 600; text-decoration: none; }
.runs .open:hover { text-decoration: underline; }
.runs tbody tr:hover td { background: var(--surface-2); }
.empty { padding: 40px 20px; text-align: center; color: var(--muted); }
@media (max-width: 760px) {
  .runs thead { display: none; }
  table.data.runs, .runs tbody, .runs tr, .runs td { display: block; width: 100%; }
  .runs tr { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .runs tr:last-child { border-bottom: 0; }
  table.data.runs td { border: 0; padding: 3px 0; white-space: normal; display: flex; gap: 12px; justify-content: space-between; align-items: center; }
  .runs td::before { content: attr(data-label); color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; flex: none; }
  .runs td.wrapok { min-width: 0; width: auto; text-align: right; }
  .runs .two { align-items: flex-end; text-align: right; }
}
@media print { .runs .open { display: none; } }
`

const INDEX_JS = String.raw`
(function () {
  var times = document.querySelectorAll('time[data-local]');
  for (var i = 0; i < times.length; i++) {
    var iso = times[i].getAttribute('datetime');
    var d = new Date(iso);
    if (!isNaN(d.getTime())) {
      times[i].textContent = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      times[i].title = iso;
    }
  }
})();
`

const SEV_SHORT: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }

function split(by: SeverityCounts) {
  return h`<span class="split">${SEVERITIES.map(s =>
    h`<span class="sevnum sev-${s}${by[s] === 0 ? ' zero' : ''}" title="${SEV_SHORT[s]}">${fmtInt(by[s])}</span>`)}</span>`
}

function scannedText(e: IndexEntry): string {
  if (!isNum(e.scanned)) return UNKNOWN
  return isNum(e.in_scope) ? `${fmtInt(e.scanned)} of ${fmtInt(e.in_scope)}` : fmtInt(e.scanned)
}

function costText(e: IndexEntry): string {
  if (!isNum(e.spent_usd)) return isNum(e.budget_usd) ? `unknown of ${fmtUsd(e.budget_usd)}` : UNKNOWN
  return isNum(e.budget_usd) ? `${fmtUsd(e.spent_usd)} of ${fmtUsd(e.budget_usd)}` : fmtUsd(e.spent_usd)
}

function row(e: IndexEntry) {
  return h`<tr>
    <td data-label="Run"><span class="two"><span class="primary">${timeEl(e.started_at)}</span><span class="secondary mono">${e.run_id}</span></span></td>
    <td data-label="Status">${statusBadge(e.status)}</td>
    <td data-label="Target" class="wrapok"><span class="two"><span class="primary mono">${e.target_root ?? UNKNOWN}</span><span class="secondary mono">${branchAtCommit(e.branch, e.commit)}</span></span></td>
    <td data-label="Vulnerabilities"><span class="vulns"><span class="total">${fmtInt(e.findings_total)}</span>${split(e.by_severity)}</span></td>
    <td data-label="Scanned" class="num">${scannedText(e)}</td>
    <td data-label="Cost" class="num">${costText(e)}</td>
    <td data-label="Report" class="num"><a class="open" href="${relativeHref(e.href)}">Open report</a></td>
  </tr>`
}

export function renderIndexHtml(entries: IndexEntry[], generatedAt: string): string {
  const body = entries.length === 0
    ? h`<div class="card empty">No reports yet.</div>`
    : h`<div class="card"><div class="table-scroll"><table class="data runs">
  <thead><tr><th>Run</th><th>Status</th><th>Target</th><th>Vulnerabilities</th><th class="num">Scanned</th><th class="num">Cost</th><th><span class="sr">Report</span></th></tr></thead>
  <tbody>${entries.map(row)}</tbody>
</table></div></div>`
  const page = h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${raw(CSP_META)}
<meta name="color-scheme" content="light dark">
<title>secscan reports</title>
${raw(FAVICON_LINK)}
<style>${raw(BASE_CSS)}${raw(INDEX_CSS)}</style>
</head>
<body>
<main class="wrap">
<header class="index-head">${raw(BRAND_ICON)}<div><h1>secscan reports</h1>${entries.length ? h`<div class="sub">${entries.length === 1 ? '1 run' : `${fmtInt(entries.length)} runs`}, newest first</div>` : ''}</div></header>
${body}
</main>
<footer class="wrap site-footer">Generated ${timeEl(generatedAt)}.</footer>
<script>${raw(INDEX_JS)}</script>
</body>
</html>
`
  return page.html
}
