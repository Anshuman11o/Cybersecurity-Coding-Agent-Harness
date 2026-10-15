/**
 * The shared helpers (escaping, formatting, the findings.json link helpers)
 * and index.html. The report page itself is tested in report-page.test.ts.
 * Rendering only; no stage, model, file system or network is involved.
 *
 *   npx tsx --test src/html.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, fmtTokens, fmtDuration, fmtUsd } from './html.js'
import { findingLines, serializeReport, vscodeHref } from './serialize.js'
import { renderIndexHtml, relativeHref } from './index-page.js'
import { realisticReport, indexEntryFor } from './fixtures.js'
import type { IndexEntry } from './types.js'

const CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`
const LS = '\u2028'
const PS = '\u2029'
const HOSTILE = `</script><script>alert(1)</script><img src=x onerror=alert(1)>"onmouseover="x${LS}'${PS}`

const count = (hay: string, needle: string) => hay.split(needle).length - 1

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  assert.ok(!escapeHtml('see https://example.invalid/').includes('://'))
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

test('CSP meta tag and no network URL in index.html', () => {
  const report = realisticReport()
  for (const page of [renderIndexHtml([indexEntryFor(report)], report.generated_at), renderIndexHtml([], report.generated_at)]) {
    assert.ok(page.includes(CSP_TAG))
    assert.ok(!page.includes('http://') && !page.includes('https://'))
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
