/**
 * Report option 1: summary tables.
 *
 * One page, summary only: run header, severity range, the ten most severe
 * findings, counts by vulnerability type and by file, coverage, cost and usage.
 * There is no findings view in the page; findings.json is the detailed record,
 * and every link here opens it in VS Code at the finding it points to. A run
 * whose findings.json path is not known renders the same page without links.
 *
 * Rendered entirely at build time through `h` (see html.ts); the only script
 * localises timestamps, copies the resume command and makes a whole table row
 * follow its link. No report data is embedded in the page.
 *
 * Zero dependencies.
 */
import {
  h, raw, BASE_CSS, CSP_META, FAVICON_LINK, BRAND_ICON, UNKNOWN, SEV_LABEL,
  isNum, plural, fmtInt, fmtUsd, fmtTokens, fmtDuration, timeEl, branchAtCommit,
  sevBadge, statusBadge, gapShort, notScannedBreakdown, codeLabel, codesHeading,
  countOf, sectionHead, basename, type Html,
} from './html.js'
import { vscodeHref } from './serialize.js'
import { shownSeverities, type FindingsReport, type ReportFinding, type Severity, type SeverityCounts } from './types.js'

/** Where findings.json is and the line each finding starts on, for VS Code links. */
export interface ReportLinks {
  findingsPath: string
  /** 1-based, in findings order. */
  findingLines: number[]
}

const OPTION1_CSS = String.raw`

.topbar {
  position: sticky; top: 0; z-index: 20; background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.topbar-inner { display: flex; align-items: center; gap: 16px; min-height: 54px; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 15px; min-width: 0; }
.brand-icon { width: 22px; height: 22px; color: var(--accent); flex: none; }
.brand-run { font-weight: 500; color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
main.wrap { padding-top: 22px; }
main.wrap > * + * { margin-top: 16px; }
.section-h { display: flex; align-items: baseline; justify-content: space-between; gap: 6px 16px; padding: 14px 18px 10px; flex-wrap: wrap; }
.section-t { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; min-width: 0; }
.section-h h2 { font-size: 15px; font-weight: 650; }
.section-h .sub, .tiles-h .sub { color: var(--muted); font-size: 12.5px; }
.section-h .hint { color: var(--muted); font-size: 12px; }
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
.tiles-h { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; margin-top: 18px; }
.tiles-title { font-size: 14px; font-weight: 650; }
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 10px; }
.tiles.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.tile {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 14px 16px 12px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-2); color: inherit; text-decoration: none; text-align: left; overflow: hidden;
  transition: border-color .12s, transform .12s, background .12s;
}
.tile::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--tc); }
a.tile:hover { border-color: var(--tc); background: var(--surface); }
.tile.is-empty { opacity: .62; }
.tile-label { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 650; color: var(--text-2); text-transform: uppercase; letter-spacing: .05em; }
.tile-label::before { content: ""; width: 9px; height: 9px; border-radius: 3px; background: var(--tc); }
.tile-n { font-size: 30px; font-weight: 750; line-height: 1.15; color: var(--tf); font-variant-numeric: tabular-nums; }
.tile-cta { font-size: 12px; color: var(--muted); }
a.tile:hover .tile-cta { color: var(--accent); }
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
table.data.review td { color: var(--text-2); }
table.data.review td.c-type { color: var(--text); }
table.data.review .row-link { font-weight: 600; }
table.data.review td.c-file { font-size: 12.5px; overflow-wrap: anywhere; }
@media (min-width: 641px) {
  table.data.review td.c-type { min-width: 200px; }
  table.data.review td.c-file { min-width: 220px; }
}

/* Tables */
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: var(--surface-2); }
a.row-link { color: var(--text); text-decoration: none; }
tr.clickable:hover .row-link, a.row-link:focus-visible { color: var(--accent); }
.type-name { font-weight: 600; }
.file-name { overflow-wrap: anywhere; }
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

/* Severity band columns: one per severity, the label and its counts left-aligned in a narrow column */
table.data.banded th.band-group { text-align: left; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
table.data.banded tr.band-row th { padding-top: 6px; }
table.data.banded th[rowspan] { vertical-align: bottom; }
table.data.banded .c-band { width: 1%; white-space: nowrap; padding-left: 10px; padding-right: 22px; }
table.data.banded .c-band .sevnum { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; }
table.data.banded .c-band .sevnum::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--sq, var(--other)); }
table.data.banded th.c-band .sevnum { font-size: 11.5px; letter-spacing: .04em; }
table.data.banded .sev-critical { --sq: var(--crit); }
table.data.banded .sev-high { --sq: var(--high); }
table.data.banded .sev-medium { --sq: var(--med); }
table.data.banded .sev-low { --sq: var(--low); }
table.data.banded td .zero::before { opacity: .45; }

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

@media (max-width: 900px) {
  .facts { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  .wrap { padding: 0 14px; }
  .topbar-inner { flex-wrap: wrap; gap: 0 12px; min-height: 0; padding-top: 10px; }
  .brand { flex: 1 1 100%; }
  .rh-title { font-size: 20px; }
  .run-header, .headline { padding: 16px; }
  .headline-text { font-size: 16px; }
  .headline-text strong { font-size: 22px; }
  .tiles { gap: 10px; }
  .tiles.cols-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tile-n { font-size: 26px; }
  .section-h { padding: 12px 16px 8px; }
  table.data.stack thead { display: none; }
  table.data.stack, table.data.stack tbody { display: block; }
  table.data.stack tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 14px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  table.data.stack tr:last-child { border-bottom: 0; }
  table.data.stack td { display: block; padding: 0; border: 0; min-width: 0; }
  table.data.stack td.c-name, table.data.stack td.c-codes { grid-column: 1 / -1; }
  table.data.stack .countcell { min-width: 0; }
  table.data.stack.banded tr { grid-template-columns: minmax(0, 1fr) repeat(var(--bands), auto); }
  table.data.stack.banded .c-band { width: auto; padding: 0; }
  table.data.labelled thead { display: none; }
  table.data.labelled, table.data.labelled tbody { display: block; }
  table.data.labelled tr { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  table.data.labelled tr:last-child { border-bottom: 0; }
  table.data.labelled td { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 0; border: 0; min-width: 0; text-align: left; }
  table.data.labelled td::before { content: attr(data-label); font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
  table.data.review td.c-type, table.data.review td.c-file { grid-column: 1 / -1; }
}
@media print {
  .topbar { display: none !important; }
  main.wrap { padding-top: 0; max-width: none; }
  .run-header, .headline, .gaps, .partial, .facts .card, table.data tr { break-inside: avoid; }
  .section-h { break-after: avoid; }
  table.data td, table.data th { padding: 6px 10px; }
  .countcell { min-width: 110px; }
  .track { min-width: 48px; }
  .tile { break-inside: avoid; }
  .tile-cta, .btn, .hint { display: none !important; }
}
`

// Plain ES2017 in a String.raw literal: no backticks, no "${", nothing that
// would close the script element.
const OPTION1_JS = String.raw`
(function () {
  'use strict';
  var times = document.querySelectorAll('time[data-local]');
  for (var t = 0; t < times.length; t++) {
    var iso = times[t].getAttribute('datetime');
    var d = new Date(iso);
    if (!isNaN(d.getTime())) {
      times[t].textContent = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      times[t].title = iso;
    }
  }

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

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target.closest) return;
    if (target.closest('a')) return;
    var row = target.closest('tr.clickable');
    if (row) {
      var link = row.querySelector('a.row-link');
      if (link) link.click();
      return;
    }
    var rc = target.closest('[data-copy-resume]');
    if (rc) {
      var code = rc.parentNode.querySelector('code');
      if (code) copyText(code.textContent, rc);
    }
  });
})();
`

// ── Sections ────────────────────────────────────────────────────────────────

/** The link that opens findings.json at finding `i`, or null when there is none. */
type FindingHref = (i: number) => string | null

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

/** Findings are in severity order, so a severity's first finding starts its block in findings.json. */
function severityTiles(r: FindingsReport, href: FindingHref): Html {
  const counts = r.summary.by_severity
  const sevs = shownSeverities(counts)
  return h`<div class="tiles-h"><h2 class="tiles-title">Severity range</h2><span class="sub">Number of vulnerabilities in each severity band</span></div>
  <div class="tiles cols-${sevs.length}">${sevs.map(s => {
    const n = countOf(counts, s)
    const first = r.findings.findIndex(f => f.severity_estimate === s)
    const link = n > 0 && first >= 0 ? href(first) : null
    const inner = h`<span class="tile-label">${SEV_LABEL[s]}</span><span class="tile-n">${fmtInt(n)}</span>`
    if (link) {
      return h`<a class="tile sev-${s}" href="${link}" aria-label="${`Open the first ${s} vulnerability in findings.json`}">${inner}<span class="tile-cta">Open in findings.json</span></a>`
    }
    return h`<div class="tile sev-${s}${n === 0 ? ' is-empty' : ''}">${inner}${n === 0 ? h`<span class="tile-cta">None</span>` : ''}</div>`
  })}</div>`
}

function headline(r: FindingsReport, href: FindingHref): Html {
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
  ${severityTiles(r, href)}
</section>`
}

function resumeBlock(cmd: string): Html {
  return h`<div class="resume">
    <div class="resume-label">Continue:</div>
    <div class="codebox"><code>${cmd}</code><button type="button" class="btn" data-copy-resume>Copy</button></div>
  </div>`
}

function gapsBox(r: FindingsReport): Html | '' {
  if (r.scan_gaps.length === 0) {
    return r.resume_command ? h`<section class="card resume-only" aria-label="Continue">${resumeBlock(r.resume_command)}</section>` : ''
  }
  return h`<section class="card gaps" aria-labelledby="s-gaps">
  ${sectionHead('s-gaps', 'Scan gaps')}
  <ul>${r.scan_gaps.map(g => h`<li>${g.detail}</li>`)}</ul>
  ${r.resume_command ? resumeBlock(r.resume_command) : ''}
</section>`
}

/** The finding's vulnerability types, as Stage 2 lists them (the first is its primary type). */
function typesOf(f: ReportFinding): string {
  const ids = [...new Set((f.finding_classes ?? []).map(c => String(c.class)))]
  return ids.length ? ids.join(', ') : UNKNOWN
}

function reviewFirst(r: FindingsReport, href: FindingHref): Html | '' {
  const index = new Map<string, number>()
  r.findings.forEach((f, i) => { if (!index.has(f.finding_id)) index.set(f.finding_id, i) })
  const rows = r.summary.review_first.slice(0, 10)
    .map(id => index.get(id))
    .filter((i): i is number => i !== undefined)
  if (!rows.length) return ''
  const title = rows.length === 1 ? 'The most severe vulnerability to review first' : `Top ${rows.length} most severe vulnerabilities to review first`
  const linked = rows.some(i => href(i) !== null)
  return h`<section class="card" aria-labelledby="s-review">
  ${sectionHead('s-review', title, 'Ranked by severity, then LLM confidence score', linked ? 'Select a row to open it in findings.json (VS Code)' : undefined)}
  <div class="table-scroll"><table class="data labelled review">
    <thead><tr><th class="num">Rank</th><th>Severity</th><th>Vulnerability</th><th>File</th><th class="num">LLM confidence score</th></tr></thead>
    <tbody>${rows.map((i, n) => {
      const f: ReportFinding = r.findings[i]
      const link = href(i)
      const types = typesOf(f)
      return h`<tr${link ? raw(' class="clickable"') : ''}>
      <td class="num c-rank" data-label="Rank">${fmtInt(n + 1)}</td>
      <td class="c-sev" data-label="Severity">${sevBadge(f.severity_estimate)}</td>
      <td class="c-type" data-label="Vulnerability">${link ? h`<a class="row-link" href="${link}">${types}</a>` : h`<span class="type-name">${types}</span>`}</td>
      <td class="c-file mono" data-label="File">${f.location.file}</td>
      <td class="num c-conf" data-label="LLM confidence score">${isNum(f.confidence) ? f.confidence.toFixed(2) : UNKNOWN}</td>
    </tr>`
    })}</tbody>
  </table></div>
</section>`
}

function countCell(count: number, by: SeverityCounts, max: number, sevs: Severity[]): Html {
  const total = sevs.reduce((a, s) => a + countOf(by, s), 0)
  const width = max > 0 && isNum(count) ? Math.min(100, (count / max) * 100) : 0
  const segs = total > 0
    ? sevs.filter(s => countOf(by, s) > 0).map(s =>
      h`<span class="b-${s}" style="width:${((countOf(by, s) / total) * 100).toFixed(2)}%"></span>`)
    : []
  return h`<div class="countcell"><span class="n">${fmtInt(count)}</span><span class="track"><span class="bar" style="width:${width.toFixed(2)}%">${segs}</span></span></div>`
}

/** One cell per severity, each under its own column so the counts line up with their labels. */
function bandCells(by: SeverityCounts, sevs: Severity[]): Html {
  return h`${sevs.map(s => {
    const n = countOf(by, s)
    return h`<td class="c-band" data-label="${SEV_LABEL[s]}"><span class="sevnum sev-${s}${n === 0 ? ' zero' : ''}" title="${SEV_LABEL[s]}">${fmtInt(n)}</span></td>`
  })}`
}

/** A two-row header: "Severity band" over one column per severity, each marked in its colour. */
function bandHead(leading: Html, sevs: Severity[]): Html {
  return h`<thead>
      <tr>${leading}<th class="band-group" colspan="${sevs.length}" scope="colgroup">Severity band</th></tr>
      <tr class="band-row">${sevs.map(s => h`<th class="c-band" scope="col"><span class="sevnum sev-${s}">${SEV_LABEL[s]}</span></th>`)}</tr>
    </thead>`
}

function byClass(r: FindingsReport): Html | '' {
  const rows = r.summary.by_class
  if (!rows.length) return ''
  const names = r.summary.category_names
  const sevs = shownSeverities(r.summary.by_severity)
  const max = Math.max(0, ...rows.map(x => (isNum(x.count) ? x.count : 0)))
  return h`<section class="card" aria-labelledby="s-types">
  ${sectionHead('s-types', 'By vulnerability type')}
  <div class="table-scroll"><table class="data stack banded" style="--bands:${sevs.length}">
    ${bandHead(h`<th rowspan="2">Type</th><th rowspan="2">${codesHeading(rows.flatMap(x => x.codes))}</th><th rowspan="2">Vulnerabilities</th>`, sevs)}
    <tbody>${rows.map(row => h`<tr>
      <td class="c-name"><span class="type-name">${row.class}</span></td>
      <td class="c-codes"><span class="codes">${row.codes.length ? row.codes.map(c => h`<span class="tag code">${codeLabel(c, names)}</span>`) : h`<span class="muted">none</span>`}</span></td>
      <td class="c-count">${countCell(row.count, row.by_severity, max, sevs)}</td>
      ${bandCells(row.by_severity, sevs)}
    </tr>`)}</tbody>
  </table></div>
  <p class="note">A finding counts under every type it carries.</p>
</section>`
}

function topFiles(r: FindingsReport): Html | '' {
  const rows = r.summary.top_files
  if (!rows.length) return ''
  const sevs = shownSeverities(r.summary.by_severity)
  const max = Math.max(0, ...rows.map(x => (isNum(x.count) ? x.count : 0)))
  return h`<section class="card" aria-labelledby="s-files">
  ${sectionHead('s-files', 'Top files', 'Files with the most bugs')}
  <div class="table-scroll"><table class="data stack banded" style="--bands:${sevs.length}">
    ${bandHead(h`<th rowspan="2">File</th><th rowspan="2">Vulnerabilities</th>`, sevs)}
    <tbody>${rows.map(row => h`<tr>
      <td class="file-cell c-name"><span class="file-name mono">${row.file}</span></td>
      <td class="c-count">${countCell(row.count, row.by_severity, max, sevs)}</td>
      ${bandCells(row.by_severity, sevs)}
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
    ${sectionHead('s-coverage', 'Coverage')}
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
    ${sectionHead('s-cost', 'Cost')}
    <p class="stat-line">${costLine}</p>
    ${meter(spent, budget, isNum(spent) && isNum(budget) && budget > 0 ? `${Math.round((spent / budget) * 100)}% of budget used` : '')}
  </section>
  <section class="card" aria-labelledby="s-usage">
    ${sectionHead('s-usage', 'Usage')}
    <dl class="kv">
      <div><dt>Input tokens</dt><dd title="${fmtInt(u.input_tokens)}">${fmtTokens(u.input_tokens)}</dd></div>
      <div><dt>Output tokens</dt><dd title="${fmtInt(u.output_tokens)}">${fmtTokens(u.output_tokens)}</dd></div>
      <div><dt>Wall clock</dt><dd>${fmtDuration(u.wall_clock_seconds)}</dd></div>
    </dl>
  </section>
</div>`
}

// ── Page ────────────────────────────────────────────────────────────────────

export function renderReportHtml(report: FindingsReport, links: ReportLinks | null = null): string {
  const r = report
  const href: FindingHref = i => {
    const line = links?.findingLines[i]
    return links && isNum(line) ? vscodeHref(links.findingsPath, line) : null
  }
  const page = h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${raw(CSP_META)}
<meta name="color-scheme" content="light dark">
<title>${`secscan report · ${r.run.id}`}</title>
${raw(FAVICON_LINK)}
<style>${raw(BASE_CSS)}${raw(OPTION1_CSS)}</style>
</head>
<body>
<header class="topbar">
  <div class="wrap topbar-inner">
    <div class="brand">${raw(BRAND_ICON)}<span>secscan</span><span class="brand-run mono">${r.run.id}</span></div>
  </div>
</header>
<main class="wrap">
${headerCard(r)}
${partialLine(r)}
${headline(r, href)}
${gapsBox(r)}
${reviewFirst(r, href)}
${byClass(r)}
${topFiles(r)}
${facts(r)}
</main>
<footer class="wrap site-footer">Generated ${timeEl(r.generated_at)} by secscan ${r.secscan_version}. Every finding, in full, is in findings.json next to this file${links ? '; links open it in VS Code' : ''}.</footer>
<script>${raw(OPTION1_JS)}</script>
</body>
</html>
`
  return page.html
}
