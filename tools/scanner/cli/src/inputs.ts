/** Round-1 inputs and the at-cap prompt. IO is injectable; no stage runs here. */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, resolve, sep } from 'path'
import { Writable } from 'stream'
import { createInterface } from 'readline/promises'
import { UsageError, type ScanArgs } from './args.js'
import { RUN_RECORD_FILE, RUN_RECORD_SCHEMA, type RunRecord } from './run-record.js'
import { compileGlob, parseCost, type RunLimits } from '../../stage1-budget-governor/src/limits.js'
import type { ModelInfo } from './registry.js'
import type { LedgerTotals } from '../../shared/ledger.js'
import type { ApiProfile } from '../../shared/api-profile.js'
import type { ScanPlan } from '../../stage1-budget-governor/src/scan-plan.js'
import { usd } from './display.js'

export interface InputIO {
  interactive: boolean
  write(text: string): void
  read(prompt: string, options?: { hidden?: boolean }): Promise<string>
  close?(): void
}

export class InputCancelled extends Error {}

export function terminalIO(): InputIO {
  let rl: ReturnType<typeof createInterface> | undefined
  let hidden = false
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!hidden) process.stdout.write(chunk, encoding as BufferEncoding)
      done()
    },
  })
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: text => { process.stdout.write(text + '\n') },
    async read(prompt, options) {
      rl ??= createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) })
      const abort = new AbortController()
      const onInterrupt = () => abort.abort()
      rl.once('SIGINT', onInterrupt)
      try {
        if (options?.hidden) {
          process.stdout.write(prompt)
          hidden = true
        }
        return await rl.question(options?.hidden ? '' : prompt, { signal: abort.signal })
      } catch {
        throw new InputCancelled('Input cancelled')
      } finally {
        rl.removeListener('SIGINT', onInterrupt)
        if (hidden) { hidden = false; process.stdout.write('\n') }
      }
    },
    close() { rl?.close(); output.end() },
  }
}

function directory(path: string): string | null {
  try { return statSync(path).isDirectory() ? realpathSync(path) : null } catch { return null }
}

function gitDescription(target: string): string {
  const git = (...args: string[]) => execFileSync('git', ['-C', target, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  try { return `git ${git('rev-parse', '--abbrev-ref', 'HEAD')} @ ${git('rev-parse', '--short', 'HEAD')}` }
  catch { return 'not a git checkout' }
}

/** Select only a complete run record, never a partial JSON write or a COMPLETE run. */
export function findResume(reportsRoot: string, selector: string | true): RunRecord {
  const runs = join(reportsRoot, 'runs')
  if (selector !== true && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(selector)) {
    throw new UsageError(`--resume "${selector}" is not a run id`)
  }
  const ids = selector === true
    ? (existsSync(runs) ? readdirSync(runs, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [])
    : [selector]
  const records: RunRecord[] = []
  for (const id of ids) {
    try {
      const record = JSON.parse(readFileSync(join(runs, id, RUN_RECORD_FILE), 'utf8')) as RunRecord
      if (record.schema === RUN_RECORD_SCHEMA && record.run_id === id && record.status === 'INCOMPLETE') records.push(record)
    } catch { /* a run without a record is not resumable */ }
  }
  records.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || b.run_id.localeCompare(a.run_id))
  if (!records.length) throw new UsageError(selector === true
    ? `no INCOMPLETE run under ${runs}` : `no INCOMPLETE run record for "${selector}" under ${runs}`)
  return records[0]
}

export function prepareReportsFolder(reportsRoot: string): void {
  mkdirSync(reportsRoot, { recursive: true })
  const ignore = join(reportsRoot, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { flag: 'wx' })
  else if (!readFileSync(ignore, 'utf8').split(/\r?\n/).includes('*')) {
    throw new UsageError(`${ignore} already exists without '*'; choose a reports folder kept out of git`)
  }
}

export interface RoundOne {
  target: string
  reportsRoot: string
  limits: RunLimits
}

/** Recon's inventory and read allowlist belong to one immutable reading scope. */
export function assertSameReadScope(previous: RunLimits, next: RunLimits): void {
  for (const key of ['paths', 'exclude'] as const) {
    if (JSON.stringify([...previous[key]].sort()) !== JSON.stringify([...next[key]].sort())) {
      throw new UsageError(`--${key} cannot change after recon; start a new scan for a different reading scope`)
    }
  }
}

export async function roundOneInputs(opts: {
  args: ScanArgs
  model: ModelInfo
  limits: RunLimits
  io: InputIO
  env?: NodeJS.ProcessEnv
  resumed?: RunRecord | null
  targetSelected?: (target: string) => Promise<{ model: ModelInfo; limits: RunLimits }>
}): Promise<RoundOne | null> {
  const { args, io } = opts
  let model = opts.model
  let configuredLimits = opts.limits
  const env = opts.env ?? process.env
  if (args.yes && args.resume === undefined && args.limits.max_cost_usd == null) {
    throw new UsageError('--yes requires --budget (or --max-cost), except with --resume')
  }
  if (!args.yes && !io.interactive) throw new UsageError('no terminal to confirm on. Pass --yes with --budget.')
  const present = Boolean(env[model.apiKeyEnv])
  io.write(`secscan · model ${model.label} · ${model.apiKeyEnv} ${present ? 'found' : 'not set'}`)

  let target = resolve(opts.resumed?.target.root ?? args.target)
  const targetDecided = args.targetProvided || Boolean(opts.resumed) || args.yes
  for (;;) {
    const valid = directory(target)
    if (!valid) {
      if (targetDecided) throw new UsageError(`not a directory: ${target}`)
      io.write(`not a directory: ${target}`)
      target = resolve((await io.read('Repository path: ')).trim() || '.')
      continue
    }
    target = valid
    io.write(`Scan this repository?  ${target}  (${gitDescription(target)})`)
    if (targetDecided) break
    io.write('                       [Enter] yes   [c] change   [q] quit')
    const answer = (await io.read('> ')).trim().toLowerCase()
    if (answer === 'q') return null
    if (answer === '') break
    if (answer === 'c') target = resolve((await io.read('Repository path: ')).trim() || target)
    else io.write('Choose Enter, c or q.')
  }

  if (opts.targetSelected) {
    const selected = await opts.targetSelected(target)
    configuredLimits = selected.limits
    if (selected.model.key !== model.key) {
      io.write(`secscan · model ${selected.model.label} · ${selected.model.apiKeyEnv} ${env[selected.model.apiKeyEnv] ? 'found' : 'not set'}`)
    }
    model = selected.model
  }
  if (!env[model.apiKeyEnv]) {
    if (args.yes || !io.interactive) throw new UsageError(`${model.apiKeyEnv} is not set. Export the key before starting a non-interactive scan.`)
    const key = (await io.read(`${model.apiKeyEnv}: `, { hidden: true })).trim()
    if (!key) throw new UsageError(`${model.apiKeyEnv} was empty; no scan started`)
    env[model.apiKeyEnv] = key
  }

  let reportsRoot = resolve(args.out ?? join(target, '.secscan'))
  const reportsDecided = args.out !== undefined || Boolean(opts.resumed) || args.yes
  for (;;) {
    if (reportsRoot === target || target.startsWith(reportsRoot + sep)) {
      throw new UsageError('the reports folder must not contain the target repository')
    }
    if (existsSync(reportsRoot) && !directory(reportsRoot)) {
      if (reportsDecided) throw new UsageError(`not a directory: ${reportsRoot}`)
      io.write(`not a directory: ${reportsRoot}`)
      reportsRoot = resolve((await io.read('Reports folder: ')).trim() || reportsRoot)
      continue
    }
    io.write(`Save reports to?       ${reportsRoot}/   (kept out of git)`)
    if (reportsDecided) break
    io.write('                       [Enter] yes   [c] change')
    const answer = (await io.read('> ')).trim().toLowerCase()
    if (answer === '') break
    if (answer === 'c') reportsRoot = resolve((await io.read('Reports folder: ')).trim() || reportsRoot)
    else io.write('Choose Enter or c.')
  }

  const limits = { ...configuredLimits, exclude: [...configuredLimits.exclude] }
  const ignoreFound = existsSync(join(target, '.secscanignore'))
  const exclusions = () => limits.exclude.length ? limits.exclude.join(', ')
    : ignoreFound ? '.secscanignore rules' : 'none  (.secscanignore not found)'
  io.write(`Exclude anything?      ${exclusions()}`)
  if (!args.yes && args.limits.exclude === undefined && !opts.resumed) {
    for (;;) {
      io.write('                       [Enter] no    [c] add files or folders')
      const answer = (await io.read('> ')).trim().toLowerCase()
      if (answer === '') break
      if (answer !== 'c') { io.write('Choose Enter or c.'); continue }
      const patterns = (await io.read('Files or folders (comma-separated): ')).split(',').map(v => v.trim()).filter(Boolean)
      try {
        patterns.forEach(compileGlob)
        limits.exclude.push(...patterns)
        io.write(`Exclude anything?      ${exclusions()}`)
        break
      } catch (e: any) { io.write(e.message) }
    }
  }

  if (args.limits.max_cost_usd != null || args.yes) {
    io.write(`Budget in USD?         ${limits.max_cost_usd ?? 'none (previous budget)'}`)
  } else {
    for (;;) {
      const answer = (await io.read('Budget in USD?         > ')).trim()
      try { limits.max_cost_usd = parseCost(answer, 'budget'); break }
      catch (e: any) { io.write(e.message) }
    }
  }
  prepareReportsFolder(reportsRoot)
  return { target, reportsRoot, limits }
}

export function tierNotice(profile: ApiProfile | null): { message: string | null; refuse: boolean } {
  if (!profile) return { message: null, refuse: false }
  if (profile.tier_multiplier === null) return {
    message: `Service tier ${profile.served_tier ?? profile.tier_label} is unpriced. The run is INCOMPLETE; the hunt cannot start.`,
    refuse: true,
  }
  return {
    message: profile.tier_label === 'Standard' ? null
      : `Service tier: ${profile.tier_label} (${profile.tier_multiplier}× Standard); the estimate includes this tier.`,
    refuse: false,
  }
}

export function reconRefusal(profile: ApiProfile | null): { reason: 'provider_quota' | 'unpriced_service_tier'; detail: string } | null {
  if (profile?.stop_reason === 'provider_quota') return {
    reason: 'provider_quota', detail: 'The provider refused a recon call because of a quota or spending limit. The run is INCOMPLETE.',
  }
  const tier = tierNotice(profile)
  return tier.refuse ? { reason: 'unpriced_service_tier', detail: tier.message! } : null
}

export function budgetRemainder(totals: LedgerTotals, done: number, total: number, plan: ScanPlan) {
  const left = Math.max(0, total - done)
  const estimatePerFile = (plan.estimate?.scan_usd ?? plan.totals.projected_cost_usd ?? 0) /
    Math.max(1, plan.estimate?.files ?? plan.totals.admitted_lanes)
  const average = done > 0 ? (totals.by_source.hunt ?? 0) / done : estimatePerFile
  return { spent: totals.total_usd, done, total, left, average, more: left * average }
}

export async function askNewBudget(io: InputIO, opts: {
  yes: boolean; totals: LedgerTotals; done: number; total: number; plan: ScanPlan
}): Promise<number | null> {
  if (opts.yes || !io.interactive) return null
  const b = budgetRemainder(opts.totals, opts.done, opts.total, opts.plan)
  io.write(`Budget reached: ${usd(b.spent)} spent. ${b.done} of ${b.total} files done, ${b.left} left.`)
  io.write(`At this run's average (${usd(b.average)} per file), finishing needs about ${usd(b.more)} more.`)
  for (;;) {
    const answer = (await io.read('New budget, or Enter to stop: > ')).trim()
    if (!answer) return null
    try {
      const budget = parseCost(answer, 'budget')
      if (budget <= b.spent) throw new UsageError(`new budget must exceed ${usd(b.spent)} already spent`)
      return budget
    } catch (e: any) { io.write(e.message) }
  }
}
