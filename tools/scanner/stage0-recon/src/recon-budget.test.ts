import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { ReconMeter, ReconStopError } from './llm-probe.js'
import { readApiProfile } from '../../shared/api-profile.js'
import { worstCaseCallUsd } from '../../shared/pricing.js'
import { modelFor } from '../../shared/provider.js'
import { makeReadGuard, writeReadAllowlist, beginReconReadAudit, READ_AUDIT_FILE } from '../../shared/read-guard.js'
import type { RunContext } from '../../shared/run-context.js'
import { selectFilesWithRunsRoot } from './file-selection.js'
import { detectExpress, extract } from './ast-extractor.js'
import { detectFrontendFrameworks } from './frontend-grep.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-budget-'))
  const ctx: RunContext = {
    profile: 'product', targetRoot: root, reportsRoot: path.join(root, 'reports'),
    runsRoot: path.join(root, 'reports', 'runs', 'fixture'), runId: 'fixture', resume: false,
  }
  return { root, ctx, profile: path.join(ctx.runsRoot, 'luna6', 'stage0-recon', 'api-profile.json') }
}

function fakeClient(responses: any[], headers: Headers | null = null) {
  const sent: any[] = []
  return {
    sent,
    chat: { completions: { create(params: any) {
      sent.push(params)
      const response = responses.shift()
      if (response instanceof Error) return Promise.reject(response)
      return { withResponse: async () => ({ data: response, response: { headers } }) }
    } } },
  }
}

const request = (text: string) => ({ model: modelFor('luna6'), messages: [{ role: 'user', content: text }] })
const reply = (tier: string | null, usage: any = { prompt_tokens: 20, completion_tokens: 10 }) => ({
  ...(tier ? { service_tier: tier } : {}), usage, choices: [{ message: { content: '{}' } }],
})

test('recon pins first served tier, captures first rate limits, and books actual usage', async () => {
  const f = fixture()
  try {
    const meter = new ReconMeter('luna6', f.ctx, f.profile)
    const client = fakeClient([reply('flex'), reply('flex', { input_tokens: 40, output_tokens: 12 })],
      new Headers({ 'x-ratelimit-limit-tokens': '120000', 'x-ratelimit-limit-requests': '60' }))
    await meter.call(client, request('x'.repeat(80)), 'architecture', 100)
    await meter.call(client, request('y'.repeat(120)), 'tool-calling', 100)
    assert.equal(client.sent[0].service_tier, undefined)
    assert.equal(client.sent[1].service_tier, 'flex')
    const profile = readApiProfile(f.profile)!
    assert.equal(profile.served_tier, 'flex')
    assert.equal(profile.tier_multiplier, 0.5)
    assert.deepEqual(profile.rate_limits, { tokens_per_minute: 120000, requests_per_minute: 60 })
    assert.equal(profile.recon_calls, 2)
    assert.equal(profile.chars_per_token, 200 / 60)
    const totals = meter.ledger.totals()
    assert.equal(totals.calls, 2)
    assert.equal(totals.reserved_calls, 0)
    assert.equal(totals.prompt_tokens, 60)
    assert.ok(Math.abs(totals.total_usd - 0.0000085) < 1e-12)
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('missing usage and thrown attempts each book one conservative reservation', async () => {
  const f = fixture()
  try {
    const meter = new ReconMeter('luna6', f.ctx, f.profile)
    const client = fakeClient([reply('default', null), new Error('offline')])
    const params = request('é'.repeat(16))
    await meter.call(client, params, 'architecture', 100)
    await assert.rejects(meter.call(client, params, 'tool-calling', 100), /offline/)
    const unit = worstCaseCallUsd('luna6', { promptBytes: 32, outputCap: 100, servedTier: 'default' })!
    assert.equal(meter.ledger.total(), unit * 2)
    assert.equal(meter.ledger.totals().reserved_calls, 2)
    assert.equal(readApiProfile(f.profile)!.recon_calls, 2)
    assert.equal(readApiProfile(f.profile)!.chars_per_token, null)
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('an unpriced tier stops later calls, including a response without usage', async () => {
  for (const usage of [null, { prompt_tokens: 10, completion_tokens: 4 }]) {
    const f = fixture()
    try {
      const meter = new ReconMeter('luna6', f.ctx, f.profile)
      const client = fakeClient([reply('default'), reply('unknown-tier', usage), reply('default')])
      await meter.call(client, request('first'), 'architecture', 100)
      await assert.rejects(meter.call(client, request('second'), 'tool-calling', 100), /unpriced_service_tier/)
      await assert.rejects(meter.call(client, request('third'), 'category', 100), /unpriced_service_tier/)
      assert.equal(client.sent.length, 2)
      assert.equal(meter.ledger.totals().calls, 2)
      assert.equal(readApiProfile(f.profile)!.tier_multiplier, null)
      assert.equal(readApiProfile(f.profile)!.served_tier, 'unknown-tier')
      assert.equal(readApiProfile(f.profile)!.stop_reason, 'unpriced_service_tier')
    } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
  }
})

test('a failed response carrying usage books its actual cost', async () => {
  const f = fixture()
  try {
    const meter = new ReconMeter('luna6', f.ctx, f.profile)
    const failed = Object.assign(new Error('provider failure'), {
      status: 500, service_tier: 'flex', usage: { prompt_tokens: 20, completion_tokens: 10 },
    })
    await assert.rejects(meter.call(fakeClient([failed]), request('x'.repeat(80)), 'architecture', 100), /provider failure/)
    assert.equal(meter.ledger.totals().calls, 1)
    assert.equal(meter.ledger.totals().reserved_calls, 0)
    assert.ok(Math.abs(meter.ledger.total() - 0.0000035) < 1e-12)
    assert.equal(readApiProfile(f.profile)!.chars_per_token, 4)
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('quota is booked once and stops every later recon call', async () => {
  const f = fixture()
  try {
    const meter = new ReconMeter('luna6', f.ctx, f.profile)
    const quota = Object.assign(new Error('quota exhausted'), { status: 429, code: 'insufficient_quota' })
    const client = fakeClient([quota, reply('default')])
    const stopped = (err: unknown) => err instanceof ReconStopError && err.code === 'provider_quota'
    await assert.rejects(meter.call(client, request('one'), 'architecture', 100), stopped)
    await assert.rejects(meter.call(client, request('two'), 'category', 100), stopped)
    assert.equal(client.sent.length, 1)
    assert.equal(meter.ledger.totals().calls, 1)
    assert.equal(meter.ledger.totals().reserved_calls, 1)
    assert.equal(readApiProfile(f.profile)!.stop_reason, 'provider_quota')
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('product recon appends on resume; benchmark recon starts a fresh ledger', async () => {
  const f = fixture()
  try {
    const first = new ReconMeter('luna6', f.ctx, f.profile)
    await first.call(fakeClient([reply('default')]), request('one'), 'architecture', 100)
    const resumed = new ReconMeter('luna6', { ...f.ctx, resume: true }, f.profile)
    assert.equal(resumed.ledger.totals().calls, 1)
    assert.equal(readApiProfile(f.profile)!.recon_calls, 0)
    assert.equal(readApiProfile(f.profile)!.chars_per_token, null)
    assert.equal(readApiProfile(f.profile)!.served_tier, null)
    assert.deepEqual(readApiProfile(f.profile)!.rate_limits, { requests_per_minute: null, tokens_per_minute: null })
    const benchmark = new ReconMeter('luna6', { ...f.ctx, profile: 'benchmark', reportsRoot: null }, f.profile)
    assert.equal(benchmark.ledger.totals().calls, 0)
    assert.equal(readApiProfile(f.profile)!.recon_calls, 0)
    const labClient = fakeClient([reply('flex'), reply('flex')])
    const lab = new ReconMeter('luna', { ...f.ctx, profile: 'benchmark', reportsRoot: null }, f.profile)
    await lab.call(labClient, request('one'), 'architecture', 100)
    await lab.call(labClient, request('two'), 'category', 100)
    assert.ok(labClient.sent.every(p => !('service_tier' in p)))
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('product allowlist guards later reads, excludes the entire reports folder, and audits recon reads', () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.root, '.secscanignore'), 'secret.ts\n')
    fs.writeFileSync(path.join(f.root, 'allowed.ts'), 'export const allowed = true\n')
    fs.writeFileSync(path.join(f.root, 'README.md'), 'Application overview\n')
    fs.writeFileSync(path.join(f.root, 'secret.ts'), 'hidden\n')
    fs.mkdirSync(f.ctx.reportsRoot!, { recursive: true })
    fs.writeFileSync(path.join(f.ctx.reportsRoot!, 'old.json'), '{}')
    beginReconReadAudit(f.ctx)
    const inventory = selectFilesWithRunsRoot(f.root, {}, f.ctx.runsRoot, { reportsRoot: f.ctx.reportsRoot, env: {} })
    writeReadAllowlist(f.ctx, inventory.read_files!)
    const guard = makeReadGuard(f.ctx)
    assert.equal(guard.readCorpusFile(path.join(f.root, 'allowed.ts')), 'export const allowed = true\n')
    assert.equal(guard.readCorpusFile(path.join(f.root, 'README.md')), 'Application overview\n')
    assert.ok(!inventory.files.some(f => f.path === 'README.md'))
    assert.equal(guard.isCorpusReadable(path.join(f.root, 'secret.ts')), false)
    assert.equal(guard.isCorpusReadable(path.join(f.ctx.reportsRoot!, 'old.json')), false)
    fs.writeFileSync(path.join(f.root, 'new.ts'), 'new after selection\n')
    assert.equal(guard.isCorpusReadable(path.join(f.root, 'new.ts')), false)
    const audit = fs.readFileSync(path.join(f.ctx.runsRoot, READ_AUDIT_FILE), 'utf8').trim().split('\n').map(s => JSON.parse(s).path)
    assert.ok(audit.includes('allowed.ts'))
    assert.ok(audit.includes('.secscanignore'))
    assert.ok(!audit.some(p => p === 'secret.ts' || p.startsWith('reports/')))
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('framework hooks never stat or read excluded manifests, entry points, or report trees', () => {
  const f = fixture()
  const fsCjs = createRequire(import.meta.url)('node:fs') as Record<string, any>
  const names = ['statSync', 'readFileSync', 'readdirSync']
  const saved = Object.fromEntries(names.map(n => [n, fsCjs[n]]))
  const touched: string[] = []
  try {
    for (const n of names) fsCjs[n] = (p: unknown, ...args: unknown[]) => {
      touched.push(String(p)); return saved[n](p, ...args)
    }
    syncBuiltinESMExports()
    assert.equal(detectExpress(f.root, () => false, () => { throw new Error('excluded read') }).isExpress, false)
    assert.equal(detectExpress(f.root, p => p === 'package.json', () => '{"dependencies":{"express":"*"}}').isExpress, false)
    assert.deepEqual(detectFrontendFrameworks(f.root, ['src/package.json'], p => {
      assert.equal(p, 'src/package.json'); return '{"dependencies":{"react":"*"}}'
    }), ['react'])
    const ast = extract(path.join(f.root, 'server.ts'), 'const app = express(); app.get("/ok", handler)')
    assert.equal(ast.routes.length, 1)
    assert.ok(!touched.some(p => p === f.root || p.startsWith(f.root + path.sep)))
  } finally {
    for (const n of names) fsCjs[n] = saved[n]
    syncBuiltinESMExports()
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
