/**
 * Report option 2: a plain, light page styled after ZAP's HTML reports
 * (the Modern report's Corporate theme for tables and colours, the High Level
 * report for the severity chart and the Vulnerability Impact table).
 *
 * One summary page: run and results tables, a severity doughnut, counts by
 * vulnerability type as split severity bars, the ten files with the most bugs,
 * and an impact table ranked by severity. The only links open findings.json in
 * VS Code at a finding. Charts are inline SVG drawn here at build time: ZAP
 * loads Chart.js, but this page makes no requests.
 *
 * Same data as option 1 (the FindingsReport), plus the per-type impact text
 * read from the scanner's own outputs (impact.ts), which is never written to
 * findings.json.
 *
 * Zero dependencies.
 */
import {
  h, raw, CSP_META, FAVICON_LINK, UNKNOWN, SEV_LABEL,
  isNum, plural, fmtInt, fmtUsd, fmtTokens, fmtDuration, timeEl, branchAtCommit,
  gapShort, notScannedBreakdown, countOf, basename, type Html,
} from './html.js'
import type { ClassImpact } from './impact.js'
import type { ReportLinks } from './option1-summary.js'
import { vscodeHref } from './serialize.js'
import { shownSeverities, type ClassRow, type FindingsReport, type Severity, type SeverityCounts } from './types.js'

/** ZAP Corporate theme: navy headers, zebra rows, red / orange / yellow risk colours. */
const CSS = String.raw`
:root {
  --navy: #164194; --text: #1f1f1f; --muted: #5f6368; --rule: #dddddd;
  --row: #f2f2f2; --row-alt: #fafafa;
  --critical: #a1151b; --high: #ed5033; --medium: #ffb900; --low: #ece04c;
  color-scheme: light;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: #fff; color: var(--text); font: 14px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; }
.page { max-width: 1120px; margin: 0 auto; padding: 32px 16px 48px; }
a { color: var(--navy); text-decoration: underline dotted; text-underline-offset: 2px; }
a:hover { opacity: .65; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; overflow-wrap: anywhere; }
.muted { color: var(--muted); }

header.title { text-align: center; padding-bottom: 8px; }
.json-link { margin: 14px 0 0; font-size: 15px; font-weight: 700; }
.click-note { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
h1 { margin: 0; color: var(--navy); font-size: 30px; font-weight: 700; letter-spacing: -.01em; }
.target { margin: 6px 0 0; font-size: 16px; }
.generated { margin: 4px 0 0; color: var(--muted); font-style: italic; }
h2 { color: var(--navy); font-size: 21px; font-weight: 400; margin: 36px 0 12px; }
h2 .note { color: var(--muted); font-size: 13px; margin-left: 8px; }

table.zap { width: 100%; border-collapse: collapse; background: #fff; }
.zap th { background: var(--navy); color: #fff; font-weight: 700; text-align: left; padding: 10px 14px; }
.zap td { background: var(--row); padding: 9px 14px; vertical-align: top; }
.zap tbody tr:nth-child(odd) td { background: var(--row-alt); }
.zap .num { text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
.zap td.field { width: 42%; color: var(--muted); }
.zap .zero { color: #9aa0a6; }

.risk { display: inline-block; padding: 1px 10px; font-weight: 700; }
.risk-critical { background: var(--critical) !important; color: #fff !important; }
.risk-high { background: var(--high) !important; color: #fff !important; }
.risk-medium { background: var(--medium) !important; color: #303030 !important; }
.risk-low { background: var(--low) !important; color: #303030 !important; }
.status-COMPLETE { color: #0f7b3f; font-weight: 700; }
.status-INCOMPLETE { color: #b45309; font-weight: 700; }
.status-UNKNOWN { color: var(--muted); font-weight: 700; }

.pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; align-items: start; }
.pair h3 { margin: 0 0 8px; color: var(--navy); font-size: 16px; font-weight: 700; }

/* Severity chart, boxed as in ZAP's High Level report */
.chart-box { display: flex; align-items: center; justify-content: center; gap: 40px; flex-wrap: wrap; padding: 24px; box-shadow: 0 1px 4px rgba(0,0,0,.16); border: 1px solid #dee2e6; border-radius: 5px; }
.chart-box svg { display: block; width: 240px; height: 240px; }
.donut-total { font-size: 34px; font-weight: 700; fill: var(--text); }
.donut-label { font-size: 12px; fill: var(--muted); }
.legend { list-style: none; margin: 0; padding: 0; min-width: 220px; }
.legend li { display: grid; grid-template-columns: 14px 1fr auto auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--rule); }
.legend li:last-child { border-bottom: 0; }
.sw { width: 14px; height: 14px; }
.sw.critical { background: var(--critical); } .sw.high { background: var(--high); } .sw.medium { background: var(--medium); } .sw.low { background: var(--low); }
.legend .n { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
.legend .pct { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; min-width: 3.5em; }

/* Split severity bars */
.key { display: flex; gap: 16px; flex-wrap: wrap; margin: 0 0 10px; color: var(--muted); font-size: 13px; }
.key span { display: inline-flex; align-items: center; gap: 6px; }
.barcell { display: flex; align-items: center; gap: 10px; }
.sbar { display: flex; height: 22px; flex: none; }
.sbar span { display: flex; align-items: center; justify-content: center; min-width: 22px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
.seg-critical { background: var(--critical); color: #fff; } .seg-high { background: var(--high); color: #fff; }
.seg-medium { background: var(--medium); color: #303030; } .seg-low { background: var(--low); color: #303030; }
.bar-total { font-weight: 700; font-variant-numeric: tabular-nums; }
.zap td.type-name { font-weight: 700; white-space: nowrap; }
.zap td.bars { width: 75%; }

/* Impact */
.zap td.rank { width: 48px; text-align: center; font-weight: 700; }
.zap td.impact { overflow-wrap: anywhere; }
.zap td.impact p { margin: 0; }
.zap td.impact p + p { margin-top: 6px; }
.zap td.impact .ctx { color: var(--muted); }

.gaps ul { margin: 0; padding-left: 18px; }
.gaps li + li { margin-top: 4px; }
footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 12.5px; }

@media (max-width: 760px) {
  .pair { grid-template-columns: minmax(0, 1fr); }
  .zap th, .zap td { padding: 8px 10px; }
  .zap td.type-name { white-space: normal; overflow-wrap: anywhere; }
  .zap td.bars { width: auto; }
  .zap .num { padding-left: 6px; padding-right: 6px; }
  .zap td.field { width: 45%; }
  .chart-box { gap: 20px; padding: 16px; }
  .legend { min-width: 0; width: 100%; }
}
@media print {
  .page { max-width: none; padding: 0; }
  tr, .chart-box { break-inside: avoid; }
  h2 { break-after: avoid; }
}
`

/** Localise timestamps; nothing else runs. */
const JS = String.raw`
(function () {
  var times = document.querySelectorAll('time[data-local]');
  for (var t = 0; t < times.length; t++) {
    var d = new Date(times[t].getAttribute('datetime'));
    if (!isNaN(d.getTime())) {
      times[t].title = times[t].getAttribute('datetime');
      times[t].textContent = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  }
})();
`

type FindingHref = (i: number) => string | null

function riskChip(s: Severity | string): Html {
  const label = (SEV_LABEL as Record<string, string>)[s] ?? String(s)
  return h`<span class="risk risk-${s in SEV_LABEL ? s : 'low'}">${label}</span>`
}

function row(field: string, value: Html | string): Html {
  return h`<tr><td class="field">${field}</td><td>${value}</td></tr>`
}

function kvTable(title: string, rows: Html[]): Html {
  return h`<div><h3>${title}</h3><table class="zap"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

// ── Header and summary tables ──────────────────────────────────────────────

function titleBlock(r: FindingsReport, links: ReportLinks | null): Html {
  const root = r.run.target.root
  return h`<header class="title">
  <h1>Vulnerability Scan Summary Report</h1>
  <p class="target">${root ? basename(root) : 'Target unknown'}</p>
  <p class="generated">Generated on ${timeEl(r.generated_at)}</p>
  ${links ? h`<p class="json-link"><a href="${vscodeHref(links.findingsPath, 1)}">View detailed JSON bug report on VS Code</a></p>
  <p class="click-note">Every link in this report opens the detailed bug report, findings.json, in VS Code at that finding.</p>` : ''}
</header>`
}

function summaryTables(r: FindingsReport): Html {
  const run = r.run
  const s = r.summary
  const c = s.coverage
  const { spent_usd: spent, budget_usd: budget } = s.cost
  const sevs = shownSeverities(s.by_severity)
  const worst = sevs.find(v => countOf(s.by_severity, v) > 0)
  const common = [...s.by_class].sort((a, b) => b.count - a.count || a.class.localeCompare(b.class))[0]
  const breakdown = notScannedBreakdown(c.not_scanned_by_reason)
  const pct = isNum(spent) && isNum(budget) && budget > 0 ? ` (${Math.round((spent / budget) * 100)}% of budget)` : ''

  const runRows = [
    row('Target', h`<span class="mono">${run.target.root ?? UNKNOWN}</span>`),
    row('Branch @ commit', h`<span class="mono">${branchAtCommit(run.target.branch, run.target.commit)}</span>`),
    row('Run ID', h`<span class="mono">${run.id}</span>`),
    row('Status', h`<span class="status-${['COMPLETE', 'INCOMPLETE'].includes(run.status) ? run.status : 'UNKNOWN'}">${run.status}</span>${r.scan_gaps[0] ? h` <span class="muted">(${gapShort(r.scan_gaps[0].reason)})</span>` : ''}`),
    row('Started', timeEl(run.started_at)),
    row('Model', run.model.label || run.model.name || run.model.key || UNKNOWN),
    row('secscan version', r.secscan_version),
    row('Budget', fmtUsd(budget)),
    row('Spent', `${fmtUsd(spent)}${pct}`),
    row('Input tokens', isNum(s.usage.input_tokens) ? `${fmtTokens(s.usage.input_tokens)} (${fmtInt(s.usage.input_tokens)})` : UNKNOWN),
    row('Output tokens', isNum(s.usage.output_tokens) ? `${fmtTokens(s.usage.output_tokens)} (${fmtInt(s.usage.output_tokens)})` : UNKNOWN),
    row('Wall clock', fmtDuration(s.usage.wall_clock_seconds)),
  ]
  const scanned = c.scanned === 0
  const resultRows = [
    row('Vulnerabilities', scanned ? 'none (no files were scanned)' : fmtInt(s.findings_total)),
    row('Distinct locations', fmtInt(s.distinct_locations)),
    row('Files with findings', fmtInt(s.files_with_findings)),
    row('Most severe level', worst ? riskChip(worst) : 'none'),
    row('Most common type', common ? `${common.class} (${fmtInt(common.count)})` : 'none'),
    row('Files in repo', fmtInt(c.files_in_repo)),
    row('In scope', fmtInt(c.in_scope)),
    row('Scanned', isNum(c.scanned) && isNum(c.in_scope) && c.in_scope > 0 ? `${fmtInt(c.scanned)} of ${fmtInt(c.in_scope)} (${Math.round((c.scanned / c.in_scope) * 100)}%)` : fmtInt(c.scanned)),
    row('Not scanned', breakdown ? `${fmtInt(c.not_scanned)} (${breakdown})` : fmtInt(c.not_scanned)),
  ]
  const gaps = r.scan_gaps.length || r.resume_command
    ? h`<h2>Scan gaps</h2>
<table class="zap gaps"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>
  ${r.scan_gaps.length ? row('Why the scan is not complete', h`<ul>${r.scan_gaps.map(g => h`<li>${g.detail}</li>`)}</ul>`) : ''}
  ${r.resume_command ? row('Continue with', h`<span class="mono">${r.resume_command}</span>`) : ''}
</tbody></table>`
    : ''
  return h`<h2>Summary</h2>
<div class="pair">${kvTable('Run details', runRows)}${kvTable('Scan results', resultRows)}</div>
${gaps}`
}

// ── Severity doughnut ──────────────────────────────────────────────────────

function severityChart(r: FindingsReport, href: FindingHref): Html {
  const by = r.summary.by_severity
  const total = r.summary.findings_total
  if (!total) {
    return h`<h2>Vulnerability Severity</h2><table class="zap"><tbody><tr><td>${r.summary.coverage.scanned === 0 ? 'No files were scanned, so there is nothing to chart.' : 'No vulnerabilities were found.'}</td></tr></tbody></table>`
  }
  const sevs = shownSeverities(by)
  const R = 80, W = 36, C = 2 * Math.PI * R
  let offset = 0
  const arcs = sevs.filter(s => countOf(by, s) > 0).map(s => {
    const n = countOf(by, s)
    const len = (n / total) * C
    const arc = h`<circle cx="120" cy="120" r="${R}" fill="none" stroke="var(--${s})" stroke-width="${W}" stroke-dasharray="${`${len.toFixed(3)} ${(C - len).toFixed(3)}`}" stroke-dashoffset="${(-offset).toFixed(3)}" transform="rotate(-90 120 120)"><title>${`${SEV_LABEL[s]}: ${n} (${Math.round((n / total) * 100)}%)`}</title></circle>`
    offset += len
    return arc
  })
  const legend = sevs.map(s => {
    const n = countOf(by, s)
    const first = r.findings.findIndex(f => f.severity_estimate === s)
    const link = n > 0 && first >= 0 ? href(first) : null
    return h`<li><span class="sw ${s}"></span><span>${link ? h`<a href="${link}" title="Open the first ${s} vulnerability in findings.json">${SEV_LABEL[s]}</a>` : SEV_LABEL[s]}</span><span class="n">${fmtInt(n)}</span><span class="pct">${Math.round((n / total) * 100)}%</span></li>`
  })
  return h`<h2>Vulnerability Severity</h2>
<div class="chart-box">
  <svg viewBox="0 0 240 240" role="img" aria-label="${`Severity of ${total} vulnerabilities: ${sevs.map(s => `${countOf(by, s)} ${s}`).join(', ')}`}">
    ${arcs}
    <text x="120" y="122" text-anchor="middle" class="donut-total">${fmtInt(total)}</text>
    <text x="120" y="144" text-anchor="middle" class="donut-label">vulnerabilities</text>
  </svg>
  <ul class="legend" aria-label="Severity legend">${legend}</ul>
</div>`
}

// ── Vulnerabilities by type ────────────────────────────────────────────────

function keyLine(sevs: Severity[]): Html {
  return h`<div class="key" aria-hidden="true">${sevs.map(s => h`<span><span class="sw ${s}"></span>${SEV_LABEL[s]}</span>`)}</div>`
}

function splitBar(by: SeverityCounts, count: number, max: number, sevs: Severity[]): Html {
  const present = sevs.filter(s => countOf(by, s) > 0)
  const width = max > 0 ? (count / max) * 100 : 0
  return h`<div class="barcell"><div class="sbar" style="${`width: max(${width.toFixed(2)}%, ${present.length * 22}px); max-width: calc(100% - 3em)`}">${present.map(s => {
    const n = countOf(by, s)
    return h`<span class="seg-${s}" style="${`flex: ${n} 1 0`}" title="${`${SEV_LABEL[s]}: ${n}`}">${fmtInt(n)}</span>`
  })}</div><span class="bar-total">${fmtInt(count)}</span></div>`
}

function byType(r: FindingsReport): Html | '' {
  const rows = r.summary.by_class
  if (!rows.length) return ''
  const sevs = shownSeverities(r.summary.by_severity)
  const max = Math.max(0, ...rows.map(x => x.count))
  return h`<h2>Vulnerabilities by Type<span class="note">A finding counts under every type it carries.</span></h2>
${keyLine(sevs)}
<table class="zap">
  <thead><tr><th>Vulnerability type</th><th>Severity and occurrences</th></tr></thead>
  <tbody>${rows.map(x => h`<tr><td class="type-name">${x.class}</td><td class="bars">${splitBar(x.by_severity, x.count, max, sevs)}</td></tr>`)}</tbody>
</table>`
}

// ── Top files ──────────────────────────────────────────────────────────────

function topFiles(r: FindingsReport, href: FindingHref): Html | '' {
  const rows = r.summary.top_files
  if (!rows.length) return ''
  const sevs = shownSeverities(r.summary.by_severity)
  return h`<h2>Top ${rows.length} Files with the Most Bugs</h2>
<table class="zap">
  <thead><tr><th class="num">#</th><th>File</th>${sevs.map(s => h`<th class="num risk-${s}">${SEV_LABEL[s]}</th>`)}<th class="num">Total</th></tr></thead>
  <tbody>${rows.map((f, i) => {
    // Findings are in severity order, so the file's first finding is its most severe.
    const first = r.findings.findIndex(x => x.location.file === f.file)
    const link = first >= 0 ? href(first) : null
    return h`<tr><td class="num">${fmtInt(i + 1)}</td><td class="mono">${link ? h`<a href="${link}" title="Open this file's most severe finding in findings.json">${f.file}</a>` : f.file}</td>${sevs.map(s => {
    const n = countOf(f.by_severity, s)
    return h`<td class="num${n === 0 ? ' zero' : ''}">${fmtInt(n)}</td>`
  })}<td class="num"><strong>${fmtInt(f.count)}</strong></td></tr>`
  })}</tbody>
</table>`
}

// ── Vulnerability impact ───────────────────────────────────────────────────

/** Most severe first: most highs, then most mediums, then most lows (critical leads when present). */
export function impactOrder(rows: ClassRow[]): ClassRow[] {
  return [...rows].sort((a, b) =>
    countOf(b.by_severity, 'critical') - countOf(a.by_severity, 'critical') ||
    countOf(b.by_severity, 'high') - countOf(a.by_severity, 'high') ||
    countOf(b.by_severity, 'medium') - countOf(a.by_severity, 'medium') ||
    countOf(b.by_severity, 'low') - countOf(a.by_severity, 'low') ||
    a.class.localeCompare(b.class))
}

function impactTable(r: FindingsReport, impacts: Record<string, ClassImpact>, href: FindingHref): Html | '' {
  const rows = impactOrder(r.summary.by_class)
  if (!rows.length) return ''
  const sevs = shownSeverities(r.summary.by_severity)
  return h`<h2>Vulnerability Impact<span class="note">Types ranked by severity: most high, then medium, then low findings.</span></h2>
<table class="zap">
  <thead><tr><th class="num">#</th><th>Vulnerability type</th><th>Impact</th></tr></thead>
  <tbody>${rows.map((x, i) => {
    const worst = sevs.find(s => countOf(x.by_severity, s) > 0) ?? 'low'
    // Findings are in severity order, so the type's first finding is its most severe.
    const first = r.findings.findIndex(f => (f.finding_classes ?? []).some(c => c.class === x.class))
    const link = first >= 0 ? href(first) : null
    const imp = Object.prototype.hasOwnProperty.call(impacts, x.class) ? impacts[x.class] : { scope: null, reason: null }
    return h`<tr>
    <td class="rank risk-${worst}">${fmtInt(i + 1)}</td>
    <td class="type-name">${link ? h`<a href="${link}" title="Open its most severe finding in findings.json">${x.class}</a>` : x.class}</td>
    <td class="impact">${imp.scope || imp.reason
      ? h`${imp.scope ? h`<p>${imp.scope}</p>` : ''}${imp.reason ? h`<p class="ctx">In this codebase: ${imp.reason}</p>` : ''}`
      : h`<p class="muted">No description recorded for this type.</p>`}</td>
  </tr>`
  })}</tbody>
</table>`
}

// ── Page ────────────────────────────────────────────────────────────────────

export function renderOption2Html(report: FindingsReport, links: ReportLinks | null, impacts: Record<string, ClassImpact>): string {
  const r = report
  const href: FindingHref = i => {
    const line = links?.findingLines[i]
    return links && isNum(line) ? vscodeHref(links.findingsPath, line) : null
  }
  const partial = r.run.status === 'INCOMPLETE' && isNum(r.summary.coverage.scanned) && r.summary.coverage.scanned > 0 && isNum(r.summary.coverage.in_scope)
    ? h`<p class="muted" role="note"><strong>Partial scan:</strong> ${fmtInt(r.summary.coverage.scanned)} of ${plural(r.summary.coverage.in_scope, 'file', 'files')} scanned. Everything below covers those files.</p>`
    : ''
  const page = h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${raw(CSP_META)}
<meta name="color-scheme" content="light">
<title>${`Vulnerability Scan Summary Report · ${r.run.id}`}</title>
${raw(FAVICON_LINK)}
<style>${raw(CSS)}</style>
</head>
<body>
<main class="page">
${titleBlock(r, links)}
${partial}
${summaryTables(r)}
${severityChart(r, href)}
${byType(r)}
${topFiles(r, href)}
${impactTable(r, impacts, href)}
<footer>Generated by secscan ${r.secscan_version} on ${timeEl(r.generated_at)}. Every finding, in full, is in findings.json next to this file${links ? '; links open it in VS Code' : ''}. Impact text comes from the scanner's playbooks and its playbook agent.</footer>
</main>
<script>${raw(JS)}</script>
</body>
</html>
`
  return page.html
}
