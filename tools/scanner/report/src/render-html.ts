/**
 * report.html — one self-contained file (plan §4.4): inline CSS, no script, no
 * external request, so it opens offline and can be attached to a workflow run
 * as-is. Same sections and fields as report.md.
 */
import {
  SIGNAL_LABEL, VALIDATION_LABEL, cap, findingById, fmtDuration, fmtInt, fmtUsd, pct, signalMark,
} from './format.js'
import type { Report, ReportFinding } from './types.js'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Only http(s) links are ever emitted; anything else renders as text. */
const safeHref = (u: string) => (/^https:\/\/[^\s"'<>]+$/.test(u) ? esc(u) : null)

function loc(f: ReportFinding): string {
  const href = f.location.permalink ? safeHref(f.location.permalink) : null
  return href ? `<a href="${href}"><code>${esc(f.location.display)}</code></a>` : `<code>${esc(f.location.display)}</code>`
}

const CSS = `
:root{--bg:#fff;--fg:#1d232b;--muted:#5d6672;--line:#d9dee4;--card:#f6f8fa;--code:#f0f2f5;--hl:#fff3c4;
--crit:#9f1239;--high:#c2410c;--med:#a16207;--low:#4b5563;--ok:#15803d;--bad:#b91c1c;--link:#0b5cad}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1318;--fg:#e3e7ec;--muted:#9aa4b0;--line:#2c333c;
--card:#161b22;--code:#1b2129;--hl:#3a3216;--crit:#fb7185;--high:#fb923c;--med:#facc15;--low:#9ca3af;--ok:#4ade80;--bad:#f87171;--link:#7cb7ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}a{color:var(--link)}
h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.25rem;margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:1.05rem;margin:0}table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:.92rem}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--card)}
.wrap{overflow-x:auto}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86rem}
pre{background:var(--code);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0 12px}
.ex .c{background:var(--hl)}.status{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;color:#fff}
.COMPLETE{background:var(--ok)}.INCOMPLETE{background:var(--bad)}.muted{color:var(--muted)}
.sev{font-weight:600}.critical{color:var(--crit)}.high{color:var(--high)}.medium{color:var(--med)}.low{color:var(--low)}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.tile{flex:1 1 120px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile b{display:block;font-size:1.5rem}details.f{border:1px solid var(--line);border-radius:8px;margin:10px 0;background:var(--bg)}
details.f>summary{cursor:pointer;padding:10px 12px;list-style:none;display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
details.f>summary::-webkit-details-marker{display:none}details.f[open]>summary{border-bottom:1px solid var(--line);background:var(--card)}
.body{padding:4px 14px 12px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:10px 0}dt{color:var(--muted)}dd{margin:0}
ol.ev{padding-left:22px}ul{padding-left:22px}dd,li,td,code,h1{min-width:0;overflow-wrap:anywhere}details.f>summary>*{min-width:0;max-width:100%}
@media (max-width:640px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
`

export function renderHtml(report: Report): string {
  const h = report.header, s = report.summary, c = report.coverage, r = report.run_stats
  const byId = findingById(report)
  const o: string[] = []
  const reasons = report.status.reasons.length ? ` <span class="muted">${esc(report.status.reasons.join('; '))}</span>` : ''

  o.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`)
  o.push(`<title>Security scan: ${esc(h.repo)}</title><style>${CSS}</style></head><body><main>`)

  // 1. Header
  o.push(`<h1>Security scan report: ${esc(h.repo)}</h1>`)
  o.push(`<p><span class="status ${report.status.state}">${report.status.state}</span>${reasons}</p>`)
  o.push('<div class="wrap"><table>')
  const row = (k: string, v: string) => o.push(`<tr><th>${k}</th><td>${v}</td></tr>`)
  const gh = h.github ? safeHref(h.github) : null
  row('Repository', `${esc(h.repo)}${gh ? ` (<a href="${gh}">${gh}</a>)` : ''}`)
  row('Branch', esc(h.branch ?? 'unknown'))
  row('Commit', h.commit ? `<code>${esc(h.commit)}</code>` : 'unknown (not a git checkout)')
  row('Date', esc(h.date))
  row('Scanner', `${esc(report.tool.name)} ${esc(report.tool.version)}${report.tool.scanner_git_sha ? ` (<code>${esc(report.tool.scanner_git_sha)}</code>)` : ''}`)
  row('Model', `${esc(h.model)} (<code>${esc(h.provider)}</code>)`)
  row('Scope', `${esc(h.scope.mode)}: ${esc(h.scope.detail)}`)
  row('Config hash', `<code>${esc(h.config_hash)}</code>`)
  o.push('</table></div>')

  // 2. Summary
  o.push('<h2>Summary at a glance</h2>')
  o.push(`<p><b>${s.total} potential vulnerabilit${s.total === 1 ? 'y' : 'ies'}.</b> Candidates from static reasoning, not confirmed bugs.</p>`)
  o.push('<div class="tiles">')
  for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
    o.push(`<div class="tile"><span class="sev ${sev}">${cap(sev)}</span><b>${s.by_severity[sev]}</b></div>`)
  }
  o.push('</div><div class="tiles">')
  o.push(`<div class="tile">High confidence (≥ 0.8)<b>${s.by_confidence_band.High}</b></div>`)
  o.push(`<div class="tile">Medium (0.5 to 0.8)<b>${s.by_confidence_band.Medium}</b></div>`)
  o.push(`<div class="tile">Low (&lt; 0.5)<b>${s.by_confidence_band.Low}</b></div></div>`)
  if (s.by_owasp.length || s.other_recon_guided) {
    o.push('<div class="wrap"><table><tr><th>OWASP category</th><th>Findings</th></tr>')
    for (const x of s.by_owasp) o.push(`<tr><td>${esc(x.name)}</td><td>${x.count}</td></tr>`)
    if (s.other_recon_guided) o.push(`<tr><td>other (recon-guided)</td><td>${s.other_recon_guided}</td></tr>`)
    o.push('</table></div>')
  }
  if (s.by_cwe.length) {
    o.push(`<p>By CWE: ${s.by_cwe.map((x) => `${esc(x.cwe)} (${x.count})`).join(', ')}</p>`)
  }
  if (s.review_first.length) {
    o.push('<h3>Review first</h3><ol>')
    for (const id of s.review_first) {
      const f = byId.get(id)!
      o.push(`<li><span class="sev ${f.severity}">${cap(f.severity)}</span> · ${f.confidence.toFixed(2)} — <a href="#${esc(f.id)}">${esc(f.title)}</a> ${loc(f)}</li>`)
    }
    o.push('</ol>')
  }
  if (s.hotspots.length) {
    o.push('<h3>Hotspot files</h3><div class="wrap"><table><tr><th>File</th><th>Findings</th></tr>')
    for (const x of s.hotspots) o.push(`<tr><td><code>${esc(x.path)}</code></td><td>${x.count}</td></tr>`)
    o.push('</table></div>')
  }

  // 3. Coverage
  o.push('<h2>Coverage</h2>')
  o.push(`<p>Status: <span class="status ${report.status.state}">${report.status.state}</span>${reasons}</p>`)
  o.push('<div class="wrap"><table><tr><th>Files</th><th>Count</th></tr>')
  o.push(`<tr><td>In inventory</td><td>${c.files_total}</td></tr><tr><td>Scanned</td><td>${c.files_scanned}</td></tr>`)
  o.push(`<tr><td>Skipped</td><td>${c.files_skipped}</td></tr>`)
  for (const [k, v] of Object.entries(c.skipped_by_reason)) o.push(`<tr><td>&nbsp;&nbsp;&nbsp;${esc(k)}</td><td>${v}</td></tr>`)
  o.push(`<tr><td>Failed</td><td>${c.files_failed}</td></tr>`)
  if (c.files_not_run) o.push(`<tr><td>Never ran</td><td>${c.files_not_run}</td></tr>`)
  o.push('</table></div>')
  o.push(`<p>Code lines scanned: <b>${fmtInt(c.code_lines_scanned)} of ${fmtInt(c.code_lines_total)}</b> (${c.code_lines_pct == null ? 'n/a' : c.code_lines_pct + '%'})</p>`)
  o.push('<div class="wrap"><table><tr><th>Language</th><th>Files</th><th>Scanned</th><th>Benchmark status</th></tr>')
  for (const l of c.languages) o.push(`<tr><td>${esc(l.language)}</td><td>${l.files}</td><td>${l.scanned}</td><td>${l.code ? (l.measured ? 'measured' : '<b>unmeasured</b>') : 'not code'}</td></tr>`)
  o.push('</table></div>')
  o.push(`<p>Directories included: ${c.directories_included.map((d) => `<code>${esc(d)}</code>`).join(', ') || 'none'}<br>`)
  o.push(`Directories excluded (no file scanned): ${c.directories_excluded.map((d) => `<code>${esc(d)}</code>`).join(', ') || 'none'}</p>`)
  o.push('<div class="wrap"><table><tr><th>Class hunted</th><th>Source</th><th>OWASP</th><th>Files</th></tr>')
  for (const k of c.classes_hunted) o.push(`<tr><td>${esc(k.class)}</td><td>${k.source}</td><td>${esc(k.owasp.join(', '))}</td><td>${k.lanes}</td></tr>`)
  o.push('</table></div>')
  o.push(`<p>Guidance sources: ${c.guidance_sources.length ? c.guidance_sources.map(esc).join(', ') : 'none (built-in playbooks only)'}</p>`)

  // 4. Limitations
  o.push('<h2>Limitations</h2><ul>')
  for (const l of report.limitations) o.push(`<li>${esc(l)}</li>`)
  o.push('</ul>')

  // 5. Run stats
  o.push('<h2>Run stats</h2><div class="wrap"><table>')
  row('Model', `${esc(r.model)} (<code>${esc(r.provider)}</code>)${r.reasoning_effort ? `, effort ${esc(r.reasoning_effort)}` : ''}${r.loop_mode ? `, loop ${esc(r.loop_mode)}` : ''}`)
  row('Tokens in', `${fmtInt(r.input_tokens)}${r.cached_input_tokens ? ` (${fmtInt(r.cached_input_tokens)} cached)` : ''}`)
  row('Tokens out', fmtInt(r.output_tokens))
  row('Model calls', fmtInt(r.calls))
  row('Cost', `${fmtUsd(r.cost_usd)} <span class="muted">${esc(r.cost_source)}</span>`)
  row('Estimate', `${fmtUsd(r.estimate_usd)}${r.cost_usd != null && r.estimate_usd ? ` (actual is ${pct(r.cost_usd, r.estimate_usd)} of estimate)` : ''}`)
  row('Wall clock', r.wall_clock_seconds != null ? `${fmtDuration(r.wall_clock_seconds)} (whole run)` : `${fmtDuration(r.stage2_seconds)} (Stage 2)`)
  row('Retries', r.retries == null ? 'not recorded (no Stage 2 log)' : String(r.retries))
  o.push('</table></div>')
  if (report.benchmark_reference) {
    const b = report.benchmark_reference
    o.push(`<p class="muted">Benchmark reference for this model (${esc(b.source)}, ${esc(b.run)}): recall ${esc(b.recall)}, localization ${esc(b.localization)}, precision proxy ${esc(b.precision_proxy)}. These describe the lab benchmark, not this repository.</p>`)
  }

  // 6. Findings
  o.push(`<h2>Findings (${report.findings.length})</h2>`)
  if (report.findings.length === 0) o.push('<p>No findings.</p>')
  for (const f of report.findings) o.push(renderFinding(f))

  // 7. Appendix
  o.push('<h2>Appendix</h2>')
  o.push(`<details><summary>Skipped files (${report.appendix.skipped_files.length})</summary><div class="wrap"><table><tr><th>File</th><th>Bucket</th><th>Reason</th></tr>`)
  for (const x of report.appendix.skipped_files) o.push(`<tr><td><code>${esc(x.path)}</code></td><td>${esc(x.category)}</td><td>${esc(x.reason)}</td></tr>`)
  o.push('</table></div></details>')
  o.push(`<details><summary>Failed lanes (${report.appendix.failed_lanes.length})</summary><ul>`)
  for (const x of report.appendix.failed_lanes) o.push(`<li><code>${esc(x.path)}</code> (${esc(x.lane_id)}): ${esc(x.reason)}</li>`)
  o.push('</ul></details>')
  o.push(`<details><summary>Guidance sources (${report.appendix.guidance_sources.length})</summary><p>${report.appendix.guidance_sources.length ? report.appendix.guidance_sources.map(esc).join('<br>') : 'None: built-in playbooks only.'}</p></details>`)
  o.push(`<details><summary>Full config</summary><pre>${esc(JSON.stringify(report.appendix.config, null, 2))}</pre></details>`)
  o.push(`<p class="muted">Generated ${esc(report.generated_at)} by ${esc(report.tool.name)} ${esc(report.tool.version)}.</p>`)
  o.push('</main></body></html>')
  return o.join('\n')
}

function renderFinding(f: ReportFinding): string {
  const e = f.confidence_explanation
  const o: string[] = []
  o.push(`<details class="f" id="${esc(f.id)}"><summary><span class="sev ${f.severity}">${cap(f.severity)}</span>`)
  o.push(`<span>${f.confidence.toFixed(2)} ${f.confidence_band}</span><h3>${esc(f.title)}</h3><span class="muted">${loc(f)}</span></summary><div class="body">`)
  o.push('<dl>')
  o.push(`<dt>ID</dt><dd><code>${esc(f.id)}</code></dd>`)
  o.push(`<dt>Category</dt><dd>${esc(f.category_label)}${f.classes.length ? ` <span class="muted">(${esc(f.classes.join(', '))})</span>` : ''}</dd>`)
  o.push(`<dt>Severity</dt><dd><span class="sev ${f.severity}">${cap(f.severity)}</span>${f.severity_reason ? ` — ${esc(f.severity_reason)}` : ''}</dd>`)
  o.push(`<dt>Confidence</dt><dd>${esc(e.text)}</dd>`)
  o.push(`<dt>Location</dt><dd>${loc(f)}${f.location.resolves ? '' : ' <b>(line not found in the file on disk)</b>'}${f.file_changed_since_scan ? ' <b>(file changed since the scan)</b>' : ''}</dd>`)
  o.push(`<dt>What's wrong</dt><dd>${esc(f.description)}</dd>`)
  o.push(`<dt>Attack scenario</dt><dd>${f.attack_scenario ? esc(f.attack_scenario) : '<i class="muted">Not recorded for this finding.</i>'}</dd>`)
  o.push(`<dt>Remediation</dt><dd>${f.remediation ? esc(f.remediation) : '<i class="muted">Not recorded for this finding.</i>'}</dd>`)
  o.push('</dl>')
  o.push('<b>Confidence explanation</b><ul>')
  for (const s of e.scanner_signals) o.push(`<li>${SIGNAL_LABEL[s.signal]}: <b>${signalMark(s.value)}</b> <span class="muted">(${esc(s.detail)})</span></li>`)
  if (e.model_reasoning) {
    const m = e.model_reasoning
    if (m.validation) o.push(`<li>Validation or sanitising: ${esc(VALIDATION_LABEL[m.validation] ?? m.validation)}</li>`)
    if (m.assumptions.length) o.push(`<li>Assumes: ${esc(m.assumptions.join('; '))}</li>`)
    if (m.summary) o.push(`<li>Model: ${esc(m.summary)}</li>`)
  } else {
    o.push('<li class="muted">Model reasoning: not recorded for this finding</li>')
  }
  o.push('</ul><b>Evidence</b><ol class="ev">')
  for (const s of f.evidence) {
    o.push(`<li><i>${esc(s.kind)}</i> <code>${esc(s.path)}:${s.line}</code> — ${esc(s.description)}${s.model_cited_file ? ` <span class="muted">(model named <code>${esc(s.model_cited_file)}</code>)</span>` : ''}`)
    if (s.excerpt) {
      const w = String(s.excerpt[s.excerpt.length - 1].n).length
      o.push(`<pre class="ex">${s.excerpt.map((l) => `<span${l.cited ? ' class="c"' : ''}>${String(l.n).padStart(w)} | ${esc(l.text)}</span>`).join('\n')}</pre>`)
    } else {
      o.push('<div class="muted">(line not found in the file on disk)</div>')
    }
    o.push('</li>')
  }
  o.push('</ol></div></details>')
  return o.join('')
}
