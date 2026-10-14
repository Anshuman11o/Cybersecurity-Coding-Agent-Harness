/**
 * Report option 2 (ZAP-style summary) and the impact text it reads from the
 * scanner's outputs. Rendering and file reads only; no stage, model or network.
 *
 *   npx tsx --test src/option2.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escapeHtml } from './html.js'
import { classImpacts, plainText, scopeLine, type ClassImpact } from './impact.js'
import { impactOrder, renderOption2Html } from './option2-zap-style.js'
import { findingLines, serializeReport, vscodeHref } from './serialize.js'
import { makeFinding, makeReport, realisticReport } from './fixtures.js'
import type { FindingsReport } from './types.js'

const HOSTILE = `</script><script>alert(1)</script><img src=x onerror=alert(1)>"onmouseover="x`
const count = (hay: string, needle: string) => hay.split(needle).length - 1
const PATH = '/home/dev/projects/shop-api/.secscan/runs/20261014-091207/findings.json'
const linksFor = (r: FindingsReport) => ({ findingsPath: PATH, findingLines: findingLines(serializeReport(r), r.findings.length)! })

function impactsFor(r: FindingsReport): Record<string, ClassImpact> {
  const out: Record<string, ClassImpact> = {}
  for (const row of r.summary.by_class) out[row.class] = { scope: `Scope of ${row.class}.`, reason: `Why ${row.class} applies here.` }
  return out
}

test('option 2: one light page, every section, no requests, no embedded data', () => {
  const r = realisticReport()
  const html = renderOption2Html(r, linksFor(r), impactsFor(r))
  for (const h2 of ['Summary', 'Vulnerability Severity', 'Vulnerabilities by Type', 'Top 10 Files with the Most Bugs', 'Vulnerability Impact']) {
    assert.ok(html.includes(`<h2>${h2}`), h2)
  }
  assert.ok(html.includes('<h3>Run details</h3>') && html.includes('<h3>Scan results</h3>'))
  assert.ok(html.includes('background: #fff') && html.includes('--navy: #164194'))
  assert.ok(!html.includes('://'), 'no literal scheme://, VS Code links included')
  assert.ok(!/\ssrc=/.test(html) && !/<link[^>]+stylesheet/.test(html))
  assert.equal(count(html, '<script'), 1)
  assert.ok(!html.includes('report-data') && !html.includes('JSON.parse') && !html.includes('innerHTML'))
  assert.equal(renderOption2Html(r, linksFor(r), impactsFor(r)), renderOption2Html(structuredClone(r), linksFor(r), impactsFor(r)), 'deterministic')
})

test('option 2: summary tables carry run, cost, usage, results and coverage', () => {
  const r = realisticReport()
  const html = renderOption2Html(r, null, {})
  for (const field of ['Target', 'Branch @ commit', 'Run ID', 'Status', 'Started', 'Model', 'secscan version', 'Budget', 'Spent', 'Input tokens', 'Output tokens', 'Wall clock',
    'Vulnerabilities', 'Distinct locations', 'Files with findings', 'Most severe level', 'Most common type', 'Files in repo', 'In scope', 'Scanned', 'Not scanned']) {
    assert.ok(html.includes(`<td class="field">${field}</td>`), field)
  }
  assert.ok(html.includes('$4.91 (98% of budget)'))
  assert.ok(html.includes('<span class="risk risk-critical">Critical</span>'))
  assert.ok(html.includes('Why the scan is not complete') && html.includes('Continue with'))
})

test('option 2: doughnut and legend match the severity counts; legend links open findings.json', () => {
  const r = realisticReport()
  const links = linksFor(r)
  const html = renderOption2Html(r, links, impactsFor(r))
  const present = (['critical', 'high', 'medium', 'low'] as const).filter(s => (r.summary.by_severity[s] ?? 0) > 0)
  assert.equal(count(html, '<circle '), present.length)
  for (const s of present) {
    const n = r.summary.by_severity[s]!
    assert.ok(html.includes(`<span class="n">${n}</span>`), s)
    const first = r.findings.findIndex(f => f.severity_estimate === s)
    assert.ok(html.includes(`<a href="${escapeHtml(vscodeHref(PATH, links.findingLines[first]))}"`), `${s} legend link`)
  }
  assert.ok(html.includes(`class="donut-total">${r.summary.findings_total}<`))
})

test('option 2: by-type bars put each severity count in its own coloured segment', () => {
  const r = realisticReport()
  const html = renderOption2Html(r, null, {})
  const section = html.slice(html.indexOf('Vulnerabilities by Type'), html.indexOf('Top 10 Files'))
  for (const row of r.summary.by_class) {
    const tr = section.slice(section.indexOf(`<td class="type-name">${escapeHtml(row.class)}</td>`))
    const bar = tr.slice(0, tr.indexOf('</tr>'))
    for (const s of ['critical', 'high', 'medium', 'low'] as const) {
      const n = row.by_severity[s] ?? 0
      assert.equal(bar.includes(`class="seg-${s}"`), n > 0, `${row.class} ${s}`)
      if (n > 0) assert.ok(bar.includes(`title="${s[0].toUpperCase() + s.slice(1)}: ${n}">${n}</span>`))
    }
    assert.ok(bar.includes(`<span class="bar-total">${row.count}</span>`))
  }
})

test('option 2: impact table ranks types by highs, then mediums, then lows, and shows scope then codebase reason', () => {
  const r = realisticReport()
  const html = renderOption2Html(r, linksFor(r), impactsFor(r))
  const order = impactOrder(r.summary.by_class)
  for (let i = 1; i < order.length; i++) {
    const [a, b] = [order[i - 1].by_severity, order[i].by_severity]
    const key = (x: typeof a) => [x.critical ?? 0, x.high, x.medium, x.low]
    const ka = key(a), kb = key(b)
    const j = ka.findIndex((v, k) => v !== kb[k])
    assert.ok(j === -1 || ka[j] > kb[j], `${order[i - 1].class} before ${order[i].class}`)
  }
  const section = html.slice(html.indexOf('<h2>Vulnerability Impact'))
  let at = 0
  for (const row of order) {
    const next = section.indexOf(`>${escapeHtml(row.class)}</a>`, at)
    assert.ok(next > at, `${row.class} in rank order`)
    at = next
  }
  const top = escapeHtml(order[0].class)
  assert.ok(section.includes(`<p>Scope of ${top}.</p><p class="ctx">In this codebase: Why ${top} applies here.</p>`))
  const bare = renderOption2Html(r, null, {})
  assert.ok(bare.includes('No description recorded for this type.'))
})

test('option 2: no critical anywhere when the run has none; hostile text stays text', () => {
  const plain = makeReport([
    makeFinding({ id: 'F1', title: 'A', severity: 'high', confidence: 0.9, file: `a${HOSTILE}.ts`, line: 1, classes: [`x${HOSTILE}`] }),
    makeFinding({ id: 'F2', title: 'B', severity: 'low', confidence: 0.3, file: 'b.ts', line: 2, classes: ['xss'] }),
  ])
  const html = renderOption2Html(plain, linksFor(plain), { [`x${HOSTILE}`]: { scope: HOSTILE, reason: HOSTILE } })
  assert.ok(!html.includes('Critical') && !html.includes('risk-critical"') && !html.includes('seg-critical"'))
  assert.ok(!html.includes('<img src=x') && !html.includes('<script>alert(1)') && !html.includes('"onmouseover="x'))
  assert.equal(count(html, '<script'), 1)
})

test('option 2: title, the findings.json link and note on top, and a link per top file', () => {
  const r = realisticReport()
  const links = linksFor(r)
  const html = renderOption2Html(r, links, impactsFor(r))
  assert.ok(html.includes('<h1>Vulnerability Scan Summary Report</h1>') && !html.includes('secscan Scanning Report'))
  assert.ok(html.includes(`<a href="${escapeHtml(vscodeHref(PATH, 1))}">View detailed JSON bug report on VS Code</a>`))
  assert.ok(html.includes('Every link in this report opens the detailed bug report, findings.json, in VS Code'))
  for (const f of r.summary.top_files) {
    const first = r.findings.findIndex(x => x.location.file === f.file)
    assert.ok(html.includes(`<a href="${escapeHtml(vscodeHref(PATH, links.findingLines[first]))}" title="Open this file's most severe finding in findings.json">${escapeHtml(f.file)}</a>`), f.file)
  }
  assert.ok(!/\d+ high · \d+ medium/.test(html), 'no per-type counts under the impact names')
  const bare = renderOption2Html(r, null, {})
  assert.ok(!bare.includes('View detailed JSON') && !bare.includes('vscode'))
})

test('option 2: zero scanned and no findings render without a chart or tables', () => {
  const r = makeReport([], { status: 'INCOMPLETE', coverage: { scanned: 0, in_scope: 40, not_scanned: 40, not_scanned_by_reason: { provider_quota: 40 } } })
  const html = renderOption2Html(r, null, {})
  assert.ok(html.includes('No files were scanned, so there is nothing to chart.'))
  assert.ok(!html.includes('<circle') && !html.includes('Vulnerability Impact') && !html.includes('Files with the Most Bugs'))
})

test('impact text: scope line, citation clean-up, and reading the scanner outputs', () => {
  assert.equal(scopeLine('Title\n=====\n\nScope: Detect a thing.\n\n## More'), 'Detect a thing.')
  assert.equal(scopeLine('no scope here'), null)
  assert.equal(plainText('Covers wallets. ([owasp.example](https' + '://owasp.example/x?utm_source=openai))'), 'Covers wallets.')
  assert.equal(plainText('Relevant here. Source: https' + '://example.invalid/a'), 'Relevant here.')
  assert.equal(plainText('Relevant. OWASP sources: https' + '://a.invalid/x and https' + '://b.invalid/y ([a.invalid](https' + '://a.invalid/x))'), 'Relevant.')
  assert.equal(plainText('See [the guide](https' + '://g.invalid) now.'), 'See the guide now.')

  const root = mkdtempSync(join(tmpdir(), 'secscan-impact-'))
  try {
    const agent = join(root, 'runs', 'r1', 'm', 'stage-playbook-agent')
    mkdirSync(agent, { recursive: true })
    writeFileSync(join(agent, 'classes-overlay.json'), JSON.stringify({ 'ws-sec': { playbook: 'ws-sec', framework: 'socket-io', model: 'gpt-x' }, 'bad': { playbook: '../../etc', framework: 'x', model: 'y' } }))
    mkdirSync(join(root, 'playbooks', 'ws-sec', 'socket-io', 'gpt-x'), { recursive: true })
    writeFileSync(join(root, 'playbooks', 'ws-sec', 'socket-io', 'gpt-x', 'playbook.md'), 'Playbook\n\nScope: Detect socket flaws.\n')
    writeFileSync(join(agent, 'playbook-plan.json'), JSON.stringify({ decision: {
      builtin_classes: [{ id: 'access-control', reason: 'Routes take ids.' }],
      classes: [{ id: 'ws-sec', reason: 'Socket.IO is present. Source: https' + '://x.invalid/' }],
    } }))
    const m = classImpacts({ stageDir: () => agent, reportsRoot: root })
    assert.deepEqual(m['ws-sec'], { scope: 'Detect socket flaws.', reason: 'Socket.IO is present.' })
    assert.equal(m['access-control'].reason, 'Routes take ids.')
    assert.match(m['access-control'].scope ?? '', /^Detect authorization gaps/, 'built-in scope from the Stage 2 playbook')
    assert.ok(!('bad' in m) || m.bad.scope === null, 'an unsafe path segment is never read')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
