/**
 * report.md — the Part 4.1 sections in order, one entry per finding with the
 * Part 4.2 fields. Doubles as the GitHub job summary in Option B, which is why
 * every location is a commit-pinned permalink whenever one exists.
 */
import {
  SIGNAL_LABEL, VALIDATION_LABEL, cap, excerptText, findingById, fmtDuration, fmtInt, fmtUsd, pct, signalMark,
} from './format.js'
import type { Report, ReportFinding } from './types.js'

/** Escape text for a Markdown table cell or inline run. */
function md(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/([*_`[\]<>])/g, '\\$1').replace(/\r?\n/g, ' ')
}

/** A fence longer than any backtick run inside, so excerpts cannot break out. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}text\n${text}\n${f}`
}

function loc(f: ReportFinding): string {
  return f.location.permalink ? `[${md(f.location.display)}](${f.location.permalink})` : `\`${f.location.display}\``
}

export function renderMarkdown(report: Report): string {
  const h = report.header
  const s = report.summary
  const c = report.coverage
  const r = report.run_stats
  const byId = findingById(report)
  const out: string[] = []
  const push = (...l: string[]) => out.push(...l)

  // 1. Header
  push(`# Security scan report: ${md(h.repo)}`, '')
  push(`**Status: ${report.status.state}**${report.status.reasons.length ? ` — ${md(report.status.reasons.join('; '))}` : ''}`, '')
  push('| | |', '|---|---|')
  push(`| Repository | ${md(h.repo)}${h.github ? ` (${h.github})` : ''} |`)
  push(`| Branch | ${md(h.branch ?? 'unknown')} |`)
  push(`| Commit | ${h.commit ? `\`${h.commit}\`` : 'unknown (not a git checkout)'} |`)
  push(`| Date | ${h.date} |`)
  push(`| Scanner | ${md(report.tool.name)} ${md(report.tool.version)}${report.tool.scanner_git_sha ? ` (${report.tool.scanner_git_sha})` : ''} |`)
  push(`| Model | ${md(h.model)} (\`${md(h.provider)}\`) |`)
  push(`| Scope | ${h.scope.mode}: ${md(h.scope.detail)} |`)
  push(`| Config hash | \`${h.config_hash}\` |`, '')

  // 2. Summary
  push('## Summary at a glance', '')
  push(`**${s.total} potential vulnerabilit${s.total === 1 ? 'y' : 'ies'}.** These are candidates from static reasoning, not confirmed bugs.`, '')
  push('| Severity | Count | | Confidence | Count |', '|---|---|---|---|---|')
  const bands = [['High (≥ 0.8)', s.by_confidence_band.High], ['Medium (0.5 to 0.8)', s.by_confidence_band.Medium], ['Low (< 0.5)', s.by_confidence_band.Low]] as const
  ;(['critical', 'high', 'medium', 'low'] as const).forEach((sev, i) => {
    const b = bands[i]
    push(`| ${cap(sev)} | ${s.by_severity[sev]} | | ${b ? b[0] : ''} | ${b ? b[1] : ''} |`)
  })
  push('')
  if (s.by_owasp.length || s.by_cwe.length || s.other_recon_guided) {
    push('**By category**', '')
    push('| OWASP | Findings |', '|---|---|')
    for (const o of s.by_owasp) push(`| ${md(o.name)} | ${o.count} |`)
    if (s.other_recon_guided) push(`| other (recon-guided) | ${s.other_recon_guided} |`)
    push('')
    if (s.by_cwe.length) {
      push('| CWE | Findings |', '|---|---|')
      for (const x of s.by_cwe.slice(0, 15)) push(`| ${x.cwe} | ${x.count} |`)
      if (s.by_cwe.length > 15) push(`| (${s.by_cwe.length - 15} more) | |`)
      push('')
    }
  }
  if (s.review_first.length) {
    push('**Review first** (severity × confidence)', '')
    s.review_first.forEach((id, i) => {
      const f = byId.get(id)!
      push(`${i + 1}. [${cap(f.severity)} · ${f.confidence.toFixed(2)}] ${md(f.title)} — ${loc(f)} ([${f.id}](#${f.id.toLowerCase()}))`)
    })
    push('')
  }
  if (s.hotspots.length) {
    push('**Hotspot files**', '')
    push('| File | Findings |', '|---|---|')
    for (const x of s.hotspots) push(`| \`${md(x.path)}\` | ${x.count} |`)
    push('')
  }

  // 3. Coverage
  push('## Coverage', '')
  push(`Status: **${report.status.state}**${report.status.reasons.length ? ` (${md(report.status.reasons.join('; '))})` : ''}`, '')
  push('| Files | Count |', '|---|---|')
  push(`| In inventory | ${c.files_total} |`)
  push(`| Scanned | ${c.files_scanned} |`)
  push(`| Skipped | ${c.files_skipped}${c.files_scope_excluded ? ` (${c.files_scope_excluded} by your scope)` : ''} |`)
  for (const [k, v] of Object.entries(c.skipped_by_reason)) push(`| &nbsp;&nbsp;${md(k)} | ${v} |`)
  push(`| Failed | ${c.files_failed} |`)
  if (c.files_not_run) push(`| Never ran | ${c.files_not_run} |`)
  push('')
  push(`Code lines scanned: **${fmtInt(c.code_lines_scanned)} of ${fmtInt(c.code_lines_total)}** (${c.code_lines_pct == null ? 'n/a' : c.code_lines_pct + '%'}).`, '')
  push('| Language | Files | Scanned | Benchmark status |', '|---|---|---|---|')
  for (const l of c.languages) push(`| ${md(l.language)} | ${l.files} | ${l.scanned} | ${l.code ? (l.measured ? 'measured' : 'unmeasured') : 'not code'} |`)
  push('')
  const basis = c.directories_basis === 'confirmed' ? ' (as confirmed)' : ''
  push(`Directories included${basis}: ${c.directories_included.map((d) => `\`${md(d)}\``).join(', ') || 'none'}`, '')
  push(`Directories excluded${basis || ' (no file scanned)'}: ${c.directories_excluded.map((d) => `\`${md(d)}\``).join(', ') || 'none'}`, '')
  push('| Class hunted | Source | OWASP | Files |', '|---|---|---|---|')
  for (const k of c.classes_hunted) push(`| ${md(k.class)} | ${k.source} | ${k.owasp.join(', ')} | ${k.lanes} |`)
  push('')
  push(`Guidance sources: ${c.guidance_sources.length ? c.guidance_sources.map(md).join(', ') : 'none (built-in playbooks only)'}`, '')

  // 4. Limitations
  push('## Limitations', '')
  for (const l of report.limitations) push(`- ${md(l)}`)
  push('')

  // 5. Run stats
  push('## Run stats', '')
  push('| | |', '|---|---|')
  push(`| Model | ${md(r.model)} (\`${md(r.provider)}\`)${r.reasoning_effort ? `, effort ${md(r.reasoning_effort)}` : ''}${r.loop_mode ? `, loop ${md(r.loop_mode)}` : ''} |`)
  push(`| Tokens in | ${fmtInt(r.input_tokens)}${r.cached_input_tokens ? ` (${fmtInt(r.cached_input_tokens)} cached)` : ''} |`)
  push(`| Tokens out | ${fmtInt(r.output_tokens)} |`)
  push(`| Model calls | ${fmtInt(r.calls)} |`)
  push(`| Cost | ${fmtUsd(r.cost_usd)} — ${md(r.cost_source)} |`)
  push(`| Estimate | ${fmtUsd(r.estimate_usd)}${r.cost_usd != null && r.estimate_usd ? ` (actual is ${pct(r.cost_usd, r.estimate_usd)} of estimate)` : ''} |`)
  if (r.cap_usd != null) push(`| Spend cap | ${fmtUsd(r.cap_usd)} |`)
  push(`| Wall clock | ${r.wall_clock_seconds != null ? fmtDuration(r.wall_clock_seconds) + ' (whole run)' : `${fmtDuration(r.stage2_seconds)} (Stage 2)`} |`)
  push(`| Retries | ${r.retries == null ? 'not recorded (no Stage 2 log)' : r.retries} |`, '')
  if (report.benchmark_reference) {
    const b = report.benchmark_reference
    push(`Benchmark reference for this model (${md(b.corpus)}, ${md(b.run)}; ${md(b.source)}): exact-line recall ${b.recall}, localization ${b.localization}${b.precision_proxy ? `, precision proxy ${b.precision_proxy}` : ''}. These describe the lab benchmark, not this repository.`, '')
  }

  // 6. Findings
  push('## Findings', '')
  if (report.findings.length === 0) push('No findings.', '')
  for (const f of report.findings) push(...renderFinding(f))

  // 7. Appendix
  push('## Appendix', '')
  push(`### Skipped files (${report.appendix.skipped_files.length})`, '')
  if (report.appendix.skipped_files.length) {
    push('<details><summary>Show</summary>', '', '| File | Bucket | Reason |', '|---|---|---|')
    for (const x of report.appendix.skipped_files) push(`| \`${md(x.path)}\` | ${md(x.category)} | ${md(x.reason)} |`)
    push('', '</details>', '')
  }
  push(`### Failed lanes (${report.appendix.failed_lanes.length})`, '')
  for (const x of report.appendix.failed_lanes) push(`- \`${md(x.path)}\` (${x.lane_id}): ${md(x.reason)}`)
  if (report.appendix.failed_lanes.length) push('')
  push('### Guidance sources', '', report.appendix.guidance_sources.length ? report.appendix.guidance_sources.map((g) => `- ${md(g)}`).join('\n') : 'None: built-in playbooks only.', '')
  push('### Full config', '', fence(JSON.stringify(report.appendix.config, null, 2)), '')
  return out.join('\n')
}

function renderFinding(f: ReportFinding): string[] {
  const out: string[] = []
  const e = f.confidence_explanation
  out.push(`### <a id="${f.id.toLowerCase()}"></a>${md(f.title)}`, '')
  out.push('| | |', '|---|---|')
  out.push(`| ID | \`${f.id}\` |`)
  out.push(`| Category | ${md(f.category_label)}${f.classes.length ? ` (${f.classes.map(md).join(', ')})` : ''} |`)
  out.push(`| Severity | **${cap(f.severity)}**${f.severity_reason ? ` — ${md(f.severity_reason)}` : ''} |`)
  out.push(`| Confidence | **${f.confidence.toFixed(2)} ${f.confidence_band}** — ${md(e.text)} |`)
  out.push(`| Location | ${loc(f)}${f.location.resolves ? '' : ' (line not found in the file on disk)'}${f.file_changed_since_scan ? ' (file changed since the scan)' : ''} |`, '')
  out.push(`**What's wrong.** ${md(f.description)}`, '')
  out.push('**Confidence explanation**', '')
  for (const sgn of e.scanner_signals) out.push(`- ${SIGNAL_LABEL[sgn.signal]}: ${signalMark(sgn.value)} (${md(sgn.detail)})`)
  if (e.model_reasoning) {
    const m = e.model_reasoning
    if (m.validation) out.push(`- Validation or sanitising: ${md(VALIDATION_LABEL[m.validation] ?? m.validation)}`)
    if (m.assumptions.length) out.push(`- Assumes: ${m.assumptions.map(md).join('; ')}`)
    if (m.summary) out.push(`- Model: ${md(m.summary)}`)
  } else {
    out.push('- Model reasoning: not recorded for this finding')
  }
  out.push('')
  out.push('**Evidence**', '')
  for (const s of f.evidence) {
    out.push(`${s.index + 1}. *${s.kind}* \`${md(s.path)}:${s.line}\` — ${md(s.description)}${s.model_cited_file ? ` (model named \`${md(s.model_cited_file)}\`)` : ''}`)
    out.push(s.excerpt ? `\n${fence(excerptText(s.excerpt)).replace(/^/gm, '   ')}\n` : '   (line not found in the file on disk)')
  }
  out.push('')
  out.push(`**Attack scenario.** ${f.attack_scenario ? md(f.attack_scenario) : '*Not recorded for this finding.*'}`, '')
  out.push(`**Remediation.** ${f.remediation ? md(f.remediation) : '*Not recorded for this finding.*'}`, '')
  if (f.cwe.length === 0 && f.fields_missing.includes('cwe')) out.push('*No CWE recorded for this finding.*', '')
  return out
}
