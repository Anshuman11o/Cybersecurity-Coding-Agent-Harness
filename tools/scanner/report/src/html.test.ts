/**
 * report.html (option 1, summary tables) and index.html against synthetic
 * reports: hostile model text, the no-network rules, determinism, the special
 * run states, the links into findings.json, and the index.
 * Rendering only; no stage, model, file system or network is involved.
 *
 *   npx tsx --test src/html.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, fmtTokens, fmtDuration, fmtUsd, codeLabel, codesHeading } from './html.js'
import { renderReportHtml, type ReportLinks } from './option1-summary.js'
import { findingLines, serializeReport, vscodeHref } from './serialize.js'
import { renderIndexHtml, relativeHref } from './index-page.js'
import { makeFinding, makeReport, realisticReport, indexEntryFor } from './fixtures.js'
import type { FindingsReport, IndexEntry } from './types.js'

const CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`
const LS = '\u2028'
const PS = '\u2029'
const HOSTILE = `</script><script>alert(1)</script><img src=x onerror=alert(1)>"onmouseover="x${LS}'${PS}`

const count = (hay: string, needle: string) => hay.split(needle).length - 1

/** Links as generateReport builds them, for a findings.json at a made-up path. */
function linksFor(r: FindingsReport, path = '/home/dev/projects/shop-api/.secscan/runs/20261014-091207/findings.json'): ReportLinks {
  return { findingsPath: path, findingLines: findingLines(serializeReport(r), r.findings.length)! }
}

function hostileReport(): FindingsReport {
  const evilFile = `src/${HOSTILE}/x.ts`
  const f = makeFinding({
    id: `FIND-0001${HOSTILE}`, title: `Title ${HOSTILE}`, description: `Line one ${HOSTILE}\nLine two`,
    severity: 'critical', confidence: 0.91, file: evilFile, line: 12, classes: [`class-${HOSTILE}`, 'sql-injection'],
    categories: [`A99${HOSTILE}`, 'A03', 'constructor', '__proto__'], steps: 4, lane: `lane-${HOSTILE}`, entryFile: `entry-${HOSTILE}.ts`,
  })
  f.trace = f.trace.map(s => ({ ...s, description: `step ${HOSTILE}` }))
  const g = makeFinding({ id: 'FIND-0002', title: 'Plain', severity: HOSTILE, confidence: 0.3, file: evilFile, line: 12, classes: ['xss'] })
  return makeReport([f, g], {
    id: `run-${HOSTILE}`,
    status: 'INCOMPLETE',
    target: { root: `/home/${HOSTILE}`, branch: `br-${HOSTILE}`, commit: `<img src=x onerror=alert(1)>` },
    model: { key: `k-${HOSTILE}`, name: null, label: `Model ${HOSTILE}` },
    scan_gaps: [{ reason: HOSTILE, detail: `Gap ${HOSTILE}` }],
    resume_command: `secscan scan --resume ${HOSTILE}`,
    category_names: { [`A99${HOSTILE}`]: `Name ${HOSTILE}`, A03: 'Injection' },
    class_codes: { [`class-${HOSTILE}`]: [`A99${HOSTILE}`] },
    coverage: { scanned: 5, in_scope: 9, not_scanned: 4, not_scanned_by_reason: { [HOSTILE]: 4 } },
    not_scanned: [{ file: HOSTILE, reason: HOSTILE, detail: HOSTILE }],
  })
}

// ── Safety ──────────────────────────────────────────────────────────────────

test('hostile model text never reaches the page as markup', () => {
  const report = hostileReport()
  for (const html of [renderReportHtml(report), renderReportHtml(report, linksFor(report, `/x/${HOSTILE}/findings.json`))]) {
    assert.ok(!html.includes('<img src=x'), 'no raw <img src=x')
    assert.ok(!html.includes('<script>alert(1)'), 'no injected script element')
    assert.ok(!html.includes('"onmouseover="x'), 'no attribute break-out')
    assert.equal(count(html, '<script'), 1)
    assert.equal(count(html, '</script>'), 1)
    // Hostile text does appear, escaped: the type, file and gap cells.
    assert.ok(html.includes('class-&lt;/script&gt;'))
    assert.ok(html.includes('Gap &lt;/script&gt;'))
  }
})

test('the page embeds no report data and its script never parses HTML', () => {
  const html = renderReportHtml(realisticReport(), linksFor(realisticReport()))
  assert.ok(!html.includes('report-data') && !html.includes('application/json'))
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'JSON.parse']) {
    assert.ok(!html.includes(sink), `no ${sink}`)
  }
})

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  assert.ok(!escapeHtml('see https://example.invalid/').includes('://'))
})

test('no network URL in report.html or index.html', () => {
  const report = realisticReport()
  const html = renderReportHtml(report, linksFor(report))
  const index = renderIndexHtml([indexEntryFor(report)], report.generated_at)
  for (const page of [html, index]) {
    assert.ok(!page.includes('://'), 'no literal scheme://, VS Code links included')
  }
  // Nothing that would fetch: no src= or external stylesheet anywhere.
  assert.ok(!/\ssrc=/.test(html))
  assert.ok(!/<link[^>]+stylesheet/.test(html))
})

test('CSP meta tag present in both pages', () => {
  const report = realisticReport()
  assert.ok(renderReportHtml(report).includes(CSP_TAG))
  assert.ok(renderIndexHtml([indexEntryFor(report)], report.generated_at).includes(CSP_TAG))
  assert.ok(renderIndexHtml([], report.generated_at).includes(CSP_TAG))
})

test('rendering is deterministic', () => {
  const report = realisticReport()
  assert.equal(renderReportHtml(report, linksFor(report)), renderReportHtml(structuredClone(report), linksFor(report)))
  const entries = [indexEntryFor(report)]
  assert.equal(renderIndexHtml(entries, report.generated_at), renderIndexHtml(entries, report.generated_at))
  // The page shows the report's own time, not the render time.
  const later = { ...report, generated_at: '2027-01-02T03:04:05.000Z' }
  assert.ok(renderReportHtml(later).includes('datetime="2027-01-02T03:04:05.000Z"'))
})

// ── Summary only ────────────────────────────────────────────────────────────

test('summary only: no findings view, tabs, filters or in-page finding links', () => {
  const r = realisticReport()
  const html = renderReportHtml(r, linksFor(r))
  for (const gone of ['view-findings', 'data-tab', 'data-filter-', 'data-sev-chip', 'data-goto', 'href="#', 'View in Findings', 'Copy JSON']) {
    assert.ok(!html.includes(gone), `no ${gone}`)
  }
  for (const f of r.findings) assert.ok(!html.includes(escapeHtml(f.title)), 'no finding titles or descriptions in the page')
})

test('links open findings.json in VS Code at the finding: review rows and severity tiles', () => {
  const r = realisticReport()
  const links = linksFor(r)
  const html = renderReportHtml(r, links)
  r.summary.review_first.forEach(id => {
    const i = r.findings.findIndex(f => f.finding_id === id)
    assert.ok(html.includes(`<a class="row-link" href="${escapeHtml(vscodeHref(links.findingsPath, links.findingLines[i]))}">`))
  })
  for (const s of ['critical', 'high', 'medium', 'low']) {
    const first = r.findings.findIndex(f => f.severity_estimate === s)
    assert.ok(html.includes(`<a class="tile sev-${s}" href="${escapeHtml(vscodeHref(links.findingsPath, links.findingLines[first]))}"`), s)
  }
  assert.ok(html.includes('Select a row to open it in findings.json (VS Code)'))
  // Without a findings.json path: the same page, no links.
  const plain = renderReportHtml(r)
  assert.ok(!plain.includes('vscode') && !plain.includes('class="clickable"') && !plain.includes('<a class="tile'))
})

test('findingLines and vscodeHref', () => {
  const r = realisticReport()
  const text = serializeReport(r)
  const lines = text.split('\n')
  const at = findingLines(text, r.findings.length)!
  assert.equal(at.length, r.findings.length)
  at.forEach((n, i) => assert.equal(lines[n], `      "finding_id": ${JSON.stringify(r.findings[i].finding_id)},`))
  assert.equal(findingLines(text, r.findings.length + 1), null, 'a mismatch gives no links, not wrong ones')
  assert.equal(vscodeHref('/a b/#x?/findings.json', 7), 'vscode:' + '//file/a%20b/%23x%3F/findings.json:7')
  assert.equal(vscodeHref('C:\\work\\findings.json', 3), 'vscode:' + '//file/C:/work/findings.json:3')
})

// ── Summary content and special states ──────────────────────────────────────

test('zero files scanned says so and never shows a zero count', () => {
  const r = makeReport([], {
    status: 'INCOMPLETE',
    coverage: { scanned: 0, in_scope: 40, not_scanned: 40, not_scanned_by_reason: { provider_quota: 40 } },
    scan_gaps: [{ reason: 'provider_quota', detail: 'The provider refused for quota.' }],
  })
  const html = renderReportHtml(r)
  assert.ok(html.includes('No files were scanned'))
  assert.ok(!html.includes('0 vulnerabilities'))
  assert.ok(!html.includes('class="tiles'), 'no severity tiles')
  assert.ok(!html.includes('Partial scan:'), 'no partial line when nothing was scanned')
})

test('complete run with no findings', () => {
  const html = renderReportHtml(makeReport([], { status: 'COMPLETE', coverage: { scanned: 88, in_scope: 88 } }))
  assert.ok(html.includes('No vulnerabilities found in 88 scanned files'))
  assert.ok(!html.includes('id="s-gaps"'), 'no scan gaps box')
  assert.ok(!html.includes('id="s-review"'))
})

test('partial run: partial line, gaps, resume command, breakdown and cost', () => {
  const html = renderReportHtml(realisticReport())
  assert.ok(html.includes('Partial scan: 374 of 412 files scanned. Everything below covers those files.'))
  assert.ok(html.includes('<h2 id="s-gaps">Scan gaps</h2>'))
  assert.ok(html.includes('Continue:'))
  assert.ok(html.includes('secscan scan /home/dev/projects/shop-api --resume 20261014-091207'))
  assert.ok(html.includes('35 budget, 3 failed'))
  assert.ok(html.includes('$4.91 spent of $5.00 budget'))
  assert.ok(html.includes('40 vulnerabilities'))
  assert.ok(html.includes('INCOMPLETE') && html.includes('budget reached'))
  assert.ok(html.includes('main @ 1a2b3c4') && !html.includes('1a2b3c4d'), 'short commit only')
  assert.ok(html.includes('A finding counts under every type it carries.'))
  assert.ok(html.includes('No selected class after review'))
})

test('review first: rank, severity, vulnerability type, file, LLM confidence score; one field per column', () => {
  const r = realisticReport()
  const html = renderReportHtml(r, linksFor(r))
  assert.ok(html.includes('<h2 id="s-review">Top 10 most severe vulnerabilities to review first</h2><span class="sub">Ranked by severity, then LLM confidence score</span>'))
  assert.ok(html.includes('<thead><tr><th class="num">Rank</th><th>Severity</th><th>Vulnerability</th><th>File</th><th class="num">LLM confidence score</th></tr></thead>'))
  const table = html.slice(html.indexOf('id="s-review"'), html.indexOf('id="s-types"'))
  const rows = table.match(/<tr class="clickable">[\s\S]*?<\/tr>/g) ?? []
  assert.equal(rows.length, 10)
  r.summary.review_first.forEach((id, i) => {
    const f = r.findings.find(x => x.finding_id === id)!
    const types = [...new Set(f.finding_classes.map(c => c.class))].join(', ')
    assert.ok(rows[i].includes(`data-label="Rank">${i + 1}<`))
    assert.ok(rows[i].includes(`">${escapeHtml(types)}</a>`), 'the type, not the title')
    assert.ok(rows[i].includes(`data-label="File">${escapeHtml(f.location.file)}<`))
    assert.ok(rows[i].includes(`data-label="LLM confidence score">${f.confidence.toFixed(2)}<`))
    assert.ok(!rows[i].includes(' · ') && !rows[i].includes('Line') && !rows[i].includes('band'))
  })
})

test('a run with no critical finding shows High, Medium and Low only; one that has one shows Critical', () => {
  const plain = makeReport([
    makeFinding({ id: 'F1', title: 'A', severity: 'high', confidence: 0.9, file: 'a.ts', line: 1, classes: ['sql-injection'] }),
    makeFinding({ id: 'F2', title: 'B', severity: 'medium', confidence: 0.6, file: 'b.ts', line: 2, classes: ['xss'] }),
    makeFinding({ id: 'F3', title: 'C', severity: 'low', confidence: 0.3, file: 'b.ts', line: 3, classes: ['xss'] }),
  ])
  assert.ok(!('critical' in plain.summary.by_severity))
  const html = renderReportHtml(plain, linksFor(plain))
  assert.ok(!html.includes('sev-critical"') && !html.includes('>Critical<'))
  assert.ok(html.includes('<div class="tiles cols-3">'))
  assert.equal(count(html, '<th class="band-group" colspan="3" scope="colgroup">Severity band</th>'), 2, 'type and file tables')
  assert.equal(count(html, '<tr class="band-row"><th class="c-band" scope="col"><span class="sevnum sev-high">High</span></th><th class="c-band" scope="col"><span class="sevnum sev-medium">Medium</span></th><th class="c-band" scope="col"><span class="sevnum sev-low">Low</span></th></tr>'), 2)
  // Every row has one count cell per severity column, in the same order.
  const typeRows = html.slice(html.indexOf('id="s-types"'), html.indexOf('id="s-files"')).match(/<tr>[\s\S]*?<\/tr>/g) ?? []
  assert.ok(typeRows.length > 0)
  for (const row of typeRows.filter(r => r.includes('class="c-name"'))) assert.deepEqual([...row.matchAll(/data-label="(High|Medium|Low|Critical)"/g)].map(m => m[1]), ['High', 'Medium', 'Low'])
  assert.ok(html.includes('<h2 class="tiles-title">Severity range</h2><span class="sub">Number of vulnerabilities in each severity band</span>'))
  const withCritical = renderReportHtml(realisticReport())
  assert.ok(withCritical.includes('<div class="tiles cols-4">'))
  assert.ok(withCritical.includes('<th class="band-group" colspan="4" scope="colgroup">Severity band</th>'))
  assert.ok(withCritical.includes('<th class="c-band" scope="col"><span class="sevnum sev-critical">Critical</span></th>'))
})

test('header has no Pass field; top files says it lists the files with the most bugs', () => {
  const html = renderReportHtml(realisticReport())
  assert.ok(!html.includes('<dt>Pass</dt>'))
  assert.ok(html.includes('<h2 id="s-files">Top files</h2><span class="sub">Files with the most bugs</span>'))
})

test('codes column names the families present, and each code shows its name once', () => {
  assert.equal(codesHeading(['A01', 'API1', 'LLM05', 'OWASP SCSVS', 'OWASP API10:2023 Unsafe Consumption of APIs']), 'OWASP codes')
  assert.equal(codesHeading(['A03', 'CWE-89']), 'OWASP and CWE codes')
  assert.equal(codesHeading(['A03', 'NIST SSDF PW.5']), 'OWASP and other codes')
  assert.equal(codesHeading(['A03', 'CWE-79', 'PCI DSS 6.2']), 'OWASP, CWE and other codes')
  assert.equal(codesHeading(['CWE-79']), 'CWE codes')
  assert.equal(codesHeading(['PCI DSS 6.2']), 'Codes')
  assert.equal(codeLabel('A01', { A01: 'A01: Broken Access Control' }), 'A01: Broken Access Control')
  assert.equal(codeLabel('A03', { A03: 'Injection' }), 'A03: Injection')
  assert.equal(codeLabel('OWASP SCSVS', {}), 'OWASP SCSVS')
  const r = realisticReport()
  r.summary.category_names = { ...r.summary.category_names, A03: 'A03: Injection' }
  const html = renderReportHtml(r)
  assert.ok(html.includes('<th rowspan="2">OWASP codes</th>'))
  assert.ok(html.includes('>A03: Injection<') && !html.includes('A03 A03'))
})

test('null numbers render as unknown, never 0', () => {
  const r = makeReport([makeFinding({ id: 'F1', title: 't', severity: 'low', confidence: 0.2, file: 'src/a.ts', line: 1, classes: ['xss'] })], {
    status: 'UNKNOWN',
    passes: null,
    coverage: { files_in_repo: null, skipped_by_selector: null, skipped_no_selected_class: null, scope_excluded: null, in_scope: null, scanned: null, not_scanned: null },
    cost: { spent_usd: null, budget_usd: null },
    usage: { input_tokens: null, output_tokens: null, wall_clock_seconds: null },
  })
  const html = renderReportHtml(r)
  const kv = html.slice(html.indexOf('id="s-coverage"'))
  for (const label of ['Files in repo', 'Skipped by file selection', 'No selected class after review', 'Excluded by your scope', 'In scope', 'Scanned', 'Not scanned']) {
    assert.ok(new RegExp(`<dt>${label}</dt><dd>unknown`).test(kv), `${label} is unknown`)
  }
  assert.ok(/<dt>Input tokens<\/dt><dd[^>]*>unknown/.test(html))
  assert.ok(/<dt>Wall clock<\/dt><dd>unknown/.test(html))
  assert.ok(/<p class="stat-line">unknown<\/p>/.test(html))
  assert.ok(html.includes('UNKNOWN'))
})

test('no confidence breakdown and no benchmark line', () => {
  for (const r of [realisticReport(), hostileReport()]) {
    const html = renderReportHtml(r)
    assert.ok(!/by confidence/i.test(html))
    assert.ok(!/benchmark/i.test(html))
  }
})

test('formatting helpers', () => {
  assert.equal(fmtTokens(2_104_332), '2.1M')
  assert.equal(fmtTokens(180_410), '180k')
  assert.equal(fmtTokens(9_500), '9.5k')
  assert.equal(fmtTokens(999_900), '1M')
  assert.equal(fmtTokens(950), '950')
  assert.equal(fmtTokens(null), 'unknown')
  assert.equal(fmtDuration(372), '6m 12s')
  assert.equal(fmtDuration(45), '45s')
  assert.equal(fmtDuration(3900), '1h 5m')
  assert.equal(fmtUsd(4.91), '$4.91')
  assert.equal(fmtUsd(1234.5), '$1,234.50')
  assert.equal(fmtUsd(null), 'unknown')
})

// ── Index ───────────────────────────────────────────────────────────────────

function entry(id: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    run_id: id, href: `runs/${id}/report.html`, status: 'COMPLETE', started_at: '2026-10-14T09:12:07.000Z',
    target_root: '/home/dev/projects/shop-api', branch: 'main', commit: 'abcdef0123456789',
    findings_total: 3, by_severity: { critical: 1, high: 1, medium: 1, low: 0 },
    scanned: 10, in_scope: 12, spent_usd: 1.5, budget_usd: 5, ...over,
  }
}

test('index lists entries in the given order', () => {
  const ids = ['20261014-091207', '20261013-170412', '20261012-081500']
  const html = renderIndexHtml(ids.map(id => entry(id)), '2026-10-14T10:00:00.000Z')
  const at = ids.map(id => html.indexOf(`>${id}<`))
  assert.ok(at.every(i => i > 0))
  assert.deepEqual([...at].sort((a, b) => a - b), at)
  assert.ok(html.includes('<title>secscan reports</title>'))
  assert.ok(html.includes('href="runs/20261014-091207/report.html"'))
  assert.ok(html.includes('10 of 12'))
  assert.ok(html.includes('$1.50 of $5.00'))
  assert.ok(html.includes('main @ abcdef0'))
  assert.ok(html.includes('datetime="2026-10-14T10:00:00.000Z"'), 'generatedAt in the footer')
})

test('index escapes hostile run fields and neutralises the link', () => {
  const html = renderIndexHtml([entry(HOSTILE, {
    href: `javascript:alert(1)/${HOSTILE}`, target_root: HOSTILE, branch: HOSTILE, commit: HOSTILE, status: HOSTILE as never,
  })], '2026-10-14T10:00:00.000Z')
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!html.includes('<script>alert(1)'))
  assert.ok(!html.includes('"onmouseover="x'))
  assert.equal(count(html, '<script'), 1)
  assert.equal(count(html, '</script>'), 1)
  assert.ok(!html.includes('href="javascript:'))
  assert.equal(relativeHref('runs/a b/report.html'), 'runs/a%20b/report.html')
  assert.equal(relativeHref('javascript:alert(1)'), 'javascript%3Aalert(1)')
})

test('index with nulls and with no entries', () => {
  const html = renderIndexHtml([entry('r1', { scanned: null, in_scope: null, spent_usd: null, budget_usd: null, started_at: null, status: 'UNKNOWN' })], '2026-10-14T10:00:00.000Z')
  assert.ok(html.includes('data-label="Scanned" class="num">unknown<'))
  assert.ok(html.includes('data-label="Cost" class="num">unknown<'))
  const empty = renderIndexHtml([], '2026-10-14T10:00:00.000Z')
  assert.ok(empty.includes('No reports yet.'))
  assert.ok(!empty.includes('<table'))
  assert.ok(!empty.includes('http://') && !empty.includes('https://'))
})
