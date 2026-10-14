/**
 * report.html and index.html against synthetic reports: hostile model text,
 * the no-network rules, determinism, the special run states, and the index.
 * Rendering only; no stage, model, file system or network is involved.
 *
 *   npx tsx --test src/html.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReportHtml, escapeHtml, embedJson, fmtTokens, fmtDuration, fmtUsd } from './html.js'
import { renderIndexHtml, relativeHref } from './index-page.js'
import { makeFinding, makeReport, realisticReport, indexEntryFor } from './fixtures.js'
import type { FindingsReport, IndexEntry } from './types.js'

const CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`
const LS = '\u2028'
const PS = '\u2029'
const HOSTILE = `</script><script>alert(1)</script><img src=x onerror=alert(1)>"onmouseover="x${LS}'${PS}`

const count = (hay: string, needle: string) => hay.split(needle).length - 1

function dataBlock(html: string): string {
  const m = html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)
  assert.ok(m, 'report-data block present')
  return m[1]
}

/** The executable part of the page: everything except the embedded data. */
function withoutData(html: string): string {
  return html.replace(dataBlock(html), '')
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
  const html = renderReportHtml(report)
  assert.ok(!html.includes('<img src=x'), 'no raw <img src=x')
  assert.ok(!html.includes('<script>alert(1)'), 'no injected script element')
  assert.ok(!html.includes('"onmouseover="x'), 'no attribute break-out')
  // The data block cannot end early: one closing tag per script element emitted.
  assert.equal(count(html, '<script'), 2)
  assert.equal(count(html, '</script>'), 2)
  const block = dataBlock(html)
  assert.ok(!block.includes('<'), 'no "<" inside the data block')
  assert.ok(!block.includes(LS) && !block.includes(PS), 'line and paragraph separators escaped')
  assert.deepEqual(JSON.parse(block), report, 'embedded JSON round-trips exactly')
  // Hostile text does appear, escaped, in the build-time summary.
  assert.ok(html.includes('Title &lt;&#47;script&gt;') || html.includes('Title &lt;/script&gt;'))
})

test('the page script builds the DOM without HTML parsing of data', () => {
  const page = withoutData(renderReportHtml(realisticReport()))
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    assert.ok(!page.includes(sink), `no ${sink}`)
  }
  assert.ok(page.includes("JSON.parse(document.getElementById('report-data').textContent)"))
})

test('escapeHtml and embedJson', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  assert.ok(!escapeHtml('see https://example.invalid/').includes('://'))
  const v = { s: `</script>${LS}${PS} https://example.invalid/a` }
  const j = embedJson(v)
  assert.ok(!j.includes('<') && !j.includes('://') && !j.includes(LS) && !j.includes(PS))
  assert.deepEqual(JSON.parse(j), v)
})

test('no network URL in report.html or index.html, even when findings quote URLs', () => {
  const report = realisticReport()
  assert.ok(JSON.stringify(report).includes('http://'), 'fixture quotes a URL in a description')
  const html = renderReportHtml(report)
  const index = renderIndexHtml([indexEntryFor(report)], report.generated_at)
  for (const page of [html, index]) {
    assert.ok(!page.includes('http://'), 'no http://')
    assert.ok(!page.includes('https://'), 'no https://')
  }
  assert.deepEqual(JSON.parse(dataBlock(html)), report)
  // Nothing that would fetch: no src= or external stylesheet anywhere.
  assert.ok(!/\ssrc=/.test(withoutData(html)))
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
  assert.equal(renderReportHtml(report), renderReportHtml(structuredClone(report)))
  const entries = [indexEntryFor(report)]
  assert.equal(renderIndexHtml(entries, report.generated_at), renderIndexHtml(entries, report.generated_at))
  // The page shows the report's own time, not the render time.
  const later = { ...report, generated_at: '2027-01-02T03:04:05.000Z' }
  assert.ok(renderReportHtml(later).includes('datetime="2027-01-02T03:04:05.000Z"'))
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
  assert.ok(!html.includes('class="tiles"'), 'no severity tiles')
  assert.ok(!html.includes('Partial scan:'), 'no partial line when nothing was scanned')
})

test('complete run with no findings', () => {
  const html = renderReportHtml(makeReport([], { status: 'COMPLETE', coverage: { scanned: 88, in_scope: 88 } }))
  assert.ok(html.includes('No vulnerabilities found in 88 scanned files'))
  assert.ok(!html.includes('id="s-gaps"'), 'no scan gaps box')
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
  assert.ok(html.includes('main @ 1a2b3c4') && !withoutData(html).includes('1a2b3c4d'), 'short commit outside the data')
  assert.ok(html.includes('A finding counts under every type it carries.'))
  assert.ok(html.includes('No selected class after review'))
})

test('review first lists at most ten rows, each linking to its finding', () => {
  const r = realisticReport()
  const html = renderReportHtml(r)
  const rows = html.match(/class="review-row" href="#([^"]+)" data-goto="(\d+)"/g) ?? []
  assert.equal(rows.length, 10)
  r.summary.review_first.forEach((id, i) => {
    const idx = r.findings.findIndex(f => f.finding_id === id)
    assert.ok(rows[i].includes(`href="#${encodeURIComponent(id)}" data-goto="${idx}"`))
  })
  assert.ok(html.includes('0.96 · High') || /0\.\d\d · (High|Medium|Low)/.test(html))
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
  assert.ok(!html.includes('<dt>Pass</dt>'), 'pass hidden when unknown')
})

test('no confidence breakdown and no benchmark line', () => {
  for (const r of [realisticReport(), hostileReport()]) {
    const html = renderReportHtml(r)
    assert.ok(!/by confidence/i.test(html))
    assert.ok(!/benchmark/i.test(html))
  }
})

test('severity tiles, type rows and file rows carry filters by index, not by data', () => {
  const r = hostileReport()
  const html = renderReportHtml(r)
  for (const s of ['critical', 'high', 'medium', 'low']) assert.ok(html.includes(`data-filter-sev="${s}"`))
  r.summary.by_class.forEach((_, i) => assert.ok(html.includes(`data-filter-class="${i}"`)))
  r.summary.top_files.forEach((_, i) => assert.ok(html.includes(`data-filter-file="${i}"`)))
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
