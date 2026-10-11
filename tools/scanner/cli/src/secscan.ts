#!/usr/bin/env -S npx tsx
/**
 * secscan — the command a user runs (productization plan §2.5–§2.7).
 *
 *   secscan models                 the registry: price, measured/unmeasured, key status
 *   secscan scan [dir] [flags]     recon, plan, confirm, hunt with live progress
 *
 * A scan runs Stage 0 (recon), 0.5 (lanes) and 1 (scan plan and estimate)
 * first; those make at most two small recon model calls. It then shows the
 * confirmation screen and spends nothing on the hunt until the user starts it
 * (or --yes says so). The hunt runs behind Stage 1's spend gate with live
 * progress; a limit or Ctrl-C ends it cleanly, and either way the run record
 * says COMPLETE or INCOMPLETE and lists what was not scanned.
 *
 * Nothing here names a model, an endpoint or a credential: the registry
 * (shared/models.json) and the user's flags supply all three.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, relative, resolve } from 'path'
import { createInterface } from 'readline/promises'
import { parseArgs, usage, UsageError, type ScanArgs } from './args.js'
import { applyModelFlags, loadRegistryModules, genericNames, type ModelInfo } from './registry.js'
import { CONFIG_FILENAME, loadConfig, configFromRun, writeConfig, type LoadedConfig } from './config.js'
import { buildSummary, renderSummary, PROMPT_LINE, type ConfirmationSummary, type LaneLite } from './confirm.js'
import { launchStage, signalStage, type RunningStage } from './stages.js'
import { startProgress, readProgress } from './progress.js'
import {
  RUN_RECORD_FILE, RUN_RECORD_SCHEMA, decideStatus, writeRunRecord,
  type RunRecord, type StageResult,
} from './run-record.js'
import { renderModels, usd, int } from './display.js'
import {
  NO_LIMITS, LIMIT_ENV, limitsToEnv, parseCost, parsePositiveInt, parseSize, parseDuration,
  normalizeScopePath, compileGlob, type RunLimits,
} from '../../stage1-budget-governor/src/limits.js'
import { SCAN_PLAN_FILE, type ScanPlan } from '../../stage1-budget-governor/src/scan-plan.js'
import {
  PROGRESS_FILE, RUN_STATUS_FILE, STOP_REQUEST_FILE, type Stage2RunStatus,
} from '../../stage1-budget-governor/src/run-status.js'
import { resolveRunContext, PRODUCT_DIRNAME } from '../../shared/run-context.js'

const EXIT = { complete: 0, failure: 1, usage: 2, incomplete: 3, interrupted: 130 } as const
const HUNT = 'stage2-hunt-lanes-perfile'
const PRE_STAGES = ['stage0-recon', 'stage05-lane-selector-perfile', 'stage1-budget-governor-perfile'] as const
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const err = (msg: string) => process.stderr.write(`secscan: ${msg}\n`)
const say = (msg = '') => process.stdout.write(msg + '\n')

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function merge(base: RunLimits, over: Partial<RunLimits>): RunLimits {
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) if (v !== undefined) (out as any)[k] = v
  return out
}

/** A product run id: the same shape run.sh generates, suffixed when taken. */
function newRunId(target: string): string {
  const d = new Date().toISOString()
  const base = `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}`
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    const dir = resolveRunContext({ SCANNER_TARGET: target, SCANNER_PROFILE: 'product', SCANNER_RUN_ID: id }, [], target).runsRoot
    if (!existsSync(dir)) return id
  }
}

async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs(argv)
  } catch (e: any) {
    if (e instanceof UsageError) {
      err(`${e.message}\nRun "secscan help" for usage.`)
      return EXIT.usage
    }
    throw e
  }
  if (args.command === 'help') {
    let keyDefault = 'the variable models.json names'
    try { keyDefault = genericNames().api_key_env_default } catch { /* no generic template */ }
    say(usage(keyDefault))
    return EXIT.complete
  }
  if (args.command === 'version') {
    const pkg = readJson<{ version: string }>(new URL('../package.json', import.meta.url).pathname)
    say(pkg?.version ?? 'unknown')
    return EXIT.complete
  }
  if (args.command === 'models') {
    applyModelFlags(args)
    const reg = await loadRegistryModules()
    say(renderModels(reg.list(), args.all))
    return EXIT.complete
  }
  return scan(args)
}

async function scan(args: ScanArgs): Promise<number> {
  // ── Target ────────────────────────────────────────────────────────────────
  const targetAbs = resolve(args.target)
  if (!existsSync(targetAbs) || !statSync(targetAbs).isDirectory()) {
    err(`not a directory: ${targetAbs}`)
    return EXIT.usage
  }
  const target = realpathSync(targetAbs)
  const targetDisplay = relative(process.cwd(), target) === '' ? '.' : (relative(process.cwd(), target).startsWith('..') ? target : `./${relative(process.cwd(), target)}`)

  // Decided before anything runs: recon spends a little, so a run that could
  // never be confirmed must not start it.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!args.yes && !interactive) {
    err('no terminal to confirm on. Pass --yes to start without the prompt (in CI, commit a secscan.config.json and pass --yes).')
    return EXIT.usage
  }

  // ── Run id and the previous record on --resume ───────────────────────────
  let runId: string
  let previous: RunRecord | null = null
  if (args.resume) {
    if (!RUN_ID_RE.test(args.resume)) {
      err(`--resume "${args.resume}" is not a run id`)
      return EXIT.usage
    }
    runId = args.resume
    const dir = resolveRunContext({ SCANNER_TARGET: target, SCANNER_PROFILE: 'product', SCANNER_RUN_ID: runId }, [], target).runsRoot
    previous = readJson<RunRecord>(join(dir, RUN_RECORD_FILE))
    if (!previous || previous.schema !== RUN_RECORD_SCHEMA) {
      err(`no run record for run "${runId}" under ${dir}`)
      return EXIT.usage
    }
  } else {
    runId = newRunId(target)
  }

  // ── Config file ───────────────────────────────────────────────────────────
  let config: LoadedConfig | null = null
  const configPath = args.configPath ? resolve(args.configPath) : join(target, CONFIG_FILENAME)
  if (!args.noConfig && !previous) {
    try {
      config = loadConfig(configPath)
    } catch (e: any) {
      err(e.message)
      return EXIT.usage
    }
    if (args.configPath && !config) {
      err(`--config ${configPath} does not exist`)
      return EXIT.usage
    }
  }

  // ── Model ─────────────────────────────────────────────────────────────────
  // Nothing may import the registry before this block: it reads the model
  // flags from the environment once, when first imported.
  //
  // A resumed run keeps its model: artifacts are provider-scoped, and the
  // checkpoint's spend was measured at that model's price.
  if (previous) {
    if (args.model || args.baseUrl) {
      err(`run ${runId} was made with "${previous.model.key}"; a resumed run keeps its model`)
      return EXIT.usage
    }
    restoreModelEnv(previous)
  }
  let modelKey = applyModelFlags(args) ?? previous?.model.key ?? config?.config.model
  let reg
  let model: ModelInfo
  try {
    reg = await loadRegistryModules()
    modelKey = modelKey ?? reg.defaultKey()
    model = reg.info(modelKey)
  } catch (e: any) {
    err(`${e.message}\nRun "secscan models" to list the models.`)
    return EXIT.usage
  }
  if (model.transport !== 'openai') {
    err(`"${model.key}" uses the lab-only "${model.transport}" transport and cannot run here. Pick another with --model.`)
    return EXIT.usage
  }
  if (!model.keyPresent) {
    err(`${model.apiKeyEnv} is not set. secscan runs on your own provider account: export ${model.apiKeyEnv}=<your key>` +
      (model.origin === 'generic' ? ' (or name another variable with --api-key-env)' : ''))
    return EXIT.usage
  }

  // The run context for this process. run-paths resolves it — and the model
  // registry — once, at import, so both are imported only now, after the
  // model flags are in the environment.
  process.env.SCANNER_TARGET = target
  process.env.SCANNER_PROFILE = 'product'
  process.env.SCANNER_RUN_ID = runId
  delete process.env.SCANNER_RUNS_ROOT
  const paths = await import('../../shared/run-paths.js')
  const runsRoot = paths.RUNS_ROOT

  // ── Limits: flags over the file (or the run being resumed) over none ─────
  let limits = merge(merge(NO_LIMITS, previous ? previous.limits : config?.config.limits ?? {}), args.limits)
  if (limits.max_cost_usd != null && !model.price) {
    err(`--max-cost needs a priced model, and "${model.key}" has no price. ` +
      (model.origin === 'generic' ? 'Pass --price <in/out>.' : 'Add price_per_mtok in a --models-file entry.'))
    return EXIT.usage
  }

  // Stages inherit exactly what was confirmed: no stray limit, per-stage
  // provider override or lab knob from the caller's shell.
  const childEnvFor = (l: RunLimits): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.values(LIMIT_ENV)) delete env[k]
    for (const k of Object.keys(env)) if (k.startsWith('SCANNER_PROVIDER')) delete env[k]
    delete env.HUNT_MAX_LANES
    delete env.SCANNER_RESUME
    delete env.SCANNER_RUNS_ROOT
    return { ...env, ...limitsToEnv(l) }
  }

  // ── Run directory ─────────────────────────────────────────────────────────
  // The same rule run.sh applies: `.secscan/` carries a `*` .gitignore before
  // anything is written, so run artifacts can never be committed by accident.
  const productDir = join(target, PRODUCT_DIRNAME)
  mkdirSync(runsRoot, { recursive: true })
  if (!existsSync(join(productDir, '.gitignore'))) writeFileSync(join(productDir, '.gitignore'), '*\n')
  const logPath = join(runsRoot, 'secscan.log')
  const stageDir = (s: Parameters<typeof paths.runPath>[1]) => paths.runPath(model.key, s)
  const stopPath = join(stageDir(HUNT), STOP_REQUEST_FILE)

  const created = previous?.created_at ?? new Date().toISOString()
  const stages: StageResult[] = previous ? [...previous.stages] : []
  /** Stages launched by this invocation; the verdict is about this pass. */
  const thisPass: StageResult[] = []
  let confirmation: RunRecord['confirmation'] = null
  let summary: ConfirmationSummary | null = null
  let plan: ScanPlan | null = null

  // ── Interrupts ────────────────────────────────────────────────────────────
  let current: RunningStage | null = null
  let interrupts = 0
  let lastInterrupt = 0
  let interrupted = false
  const onInterrupt = () => {
    const now = Date.now()
    if (now - lastInterrupt < 800) return
    lastInterrupt = now
    interrupted = true
    interrupts++
    if (!current) return
    if (current.stage === HUNT) {
      if (interrupts === 1) {
        writeFileSync(stopPath, 'stop\n')
        process.stderr.write('\nStopping: no new files will start, the ones in flight will finish. Ctrl-C again to abandon them.\n')
      } else if (interrupts === 2) {
        writeFileSync(stopPath, 'abort\n')
        process.stderr.write('\nAbandoning the files in flight…\n')
      } else {
        signalStage(current, 'SIGKILL')
      }
    } else {
      signalStage(current, interrupts === 1 ? 'SIGINT' : 'SIGKILL')
    }
  }
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onInterrupt)

  const runOne = async (stage: string, resume = false): Promise<StageResult> => {
    current = launchStage({ stage, provider: model.key, target, runId, resume, env: childEnvFor(limits), logPath })
    const r = await current.done
    current = null
    stages.push(r)
    thisPass.push(r)
    return r
  }

  const finish = (cancelled: boolean): number => {
    // Quitting at the confirmation of a resumed run changes nothing: the
    // record still describes what the earlier passes did, and must keep doing so.
    if (cancelled && previous) {
      say(`Run ${runId} left as it was (${previous.status}). Its record: ${join(runsRoot, RUN_RECORD_FILE)}`)
      return EXIT.complete
    }
    const stage2 = readJson<Stage2RunStatus>(join(stageDir(HUNT), RUN_STATUS_FILE))
    // A status left by an earlier pass describes that pass, not this one.
    const fresh = stage2 && thisPass.some(s => s.stage === HUNT && Date.parse(stage2.generated_at) >= Date.parse(s.started_at))
      ? stage2 : null
    const verdict = decideStatus(fresh, thisPass, cancelled)
    const usage = readJson<any>(join(stageDir('stage1-budget-governor-perfile'), 'usage-v2.json'))
    const usageFresh = usage && fresh && Date.parse(usage.generated_at) >= Date.parse(fresh.ended_at) ? usage : null
    const progress = readProgress(join(stageDir(HUNT), PROGRESS_FILE))
    const unscanned = fresh?.unscanned
      ?? (plan ? plan.admitted.map(l => ({ lane_id: l.lane_id, target_file: l.target_file, reason: 'interrupted' as const, detail: cancelled ? 'not started: cancelled at confirmation' : 'the hunt did not run' })) : [])
    const record: RunRecord = {
      schema: RUN_RECORD_SCHEMA,
      run_id: runId,
      passes: (previous?.passes ?? 0) + 1,
      created_at: created,
      updated_at: new Date().toISOString(),
      status: verdict.status,
      incomplete_reasons: verdict.reasons,
      target: { root: target, commit: git(target, 'rev-parse', 'HEAD'), branch: git(target, 'rev-parse', '--abbrev-ref', 'HEAD') },
      model: {
        key: model.key,
        model: model.model,
        label: model.label,
        origin: model.origin,
        measured: model.measured,
        benchmark: model.benchmark,
        api_key_env: model.apiKeyEnv,
        base_url: model.origin === 'registry' ? null : model.baseUrl,
        price_per_mtok: model.price,
        price_asof: model.priceAsOf,
        ...(process.env.SCANNER_MODELS_FILE ? { models_file: process.env.SCANNER_MODELS_FILE } : {}),
      } as RunRecord['model'],
      config_file: config ? { path: config.path, sha256: config.sha256 } : previous?.config_file ?? null,
      limits,
      confirmation: confirmation ?? previous?.confirmation ?? null,
      stages,
      coverage: {
        inventory_files: summary?.target.files ?? null,
        hunt_lanes: fresh?.lanes.hunt ?? plan?.totals.hunt_lanes ?? null,
        admitted: fresh?.lanes.admitted ?? plan?.totals.admitted_lanes ?? null,
        completed: fresh?.lanes.completed ?? null,
        failed: fresh?.lanes.failed ?? null,
        not_started: fresh?.lanes.not_started ?? null,
      },
      unscanned,
      scope_excluded: fresh?.scope_excluded
        ?? (plan?.excluded.filter(e => e.reason !== 'over-max-files').map(e => ({ lane_id: e.lane_id, target_file: e.target_file, reason: e.reason as 'user-excluded' | 'too-large', detail: e.detail })) ?? []),
      spend: {
        estimate_usd: plan?.totals.projected_cost_usd ?? null,
        spent_usd: fresh?.spend.spent_usd ?? null,
        reconciled_usd: usageFresh?.cost_usd ?? null,
        cap_usd: limits.max_cost_usd,
        input_tokens: usageFresh?.input_tokens ?? null,
        output_tokens: usageFresh?.output_tokens ?? null,
        calls: usageFresh?.calls ?? null,
      },
      findings_total: fresh?.findings_total ?? null,
      artifacts: Object.fromEntries(
        [...PRE_STAGES, HUNT].map(s => [s, stageDir(s as Parameters<typeof paths.runPath>[1])]).filter(([, d]) => existsSync(d)),
      ),
      resume_command: null,
    }
    // A run cut by a limit continues once the limit is raised; say which. The
    // timeout needs no flag: each resumed pass gets a fresh window.
    const resumable = record.status === 'INCOMPLETE' && !cancelled && record.unscanned.length > 0
    const cut = (r: string) => record.incomplete_reasons.some(x => x.reason === r)
    record.resume_command = resumable
      ? `secscan scan ${targetDisplay} --resume ${runId}` +
        (cut('max_cost') ? ' --max-cost <higher>' : '') +
        (cut('over-max-files') ? ' --max-files <higher>' : '')
      : null
    writeRunRecord(join(runsRoot, RUN_RECORD_FILE), record)

    // ── Terminal summary ──────────────────────────────────────────────────
    say()
    say(`Run ${runId}: ${record.status}`)
    for (const r of record.incomplete_reasons) say(`  - ${r.reason}: ${r.detail}`)
    if (record.coverage.admitted != null && fresh) {
      // In scope = admitted plus what --max-files cut: the files this scope
      // covers, whether or not a limit let them run.
      const inScope = record.coverage.admitted + record.unscanned.filter(u => u.reason === 'over-max-files').length
      say(`Scanned ${int(record.coverage.completed ?? 0)} of ${int(inScope)} files in scope` +
        (record.coverage.failed ? `, ${record.coverage.failed} failed` : '') +
        (record.unscanned.length ? `; ${int(record.unscanned.length)} not scanned (listed in the run record)` : ''))
    }
    if (progress && fresh) {
      const s = progress.findings.by_severity
      say(`Findings: ${progress.findings.total} (${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low) — ` +
        'candidates from static reasoning, not verified')
      say(`  ${join(stageDir(HUNT), 'candidate-findings.json')}`)
    }
    if (fresh) {
      say(`Spend: ${usd(record.spend.spent_usd)}` +
        (record.spend.estimate_usd != null ? ` (estimate ${usd(record.spend.estimate_usd)})` : '') +
        (record.spend.cap_usd != null ? `, cap ${usd(record.spend.cap_usd)}` : ''))
    }
    say(`Run record: ${join(runsRoot, RUN_RECORD_FILE)}`)
    if (record.resume_command) say(`Continue: ${record.resume_command}`)

    if (record.status === 'COMPLETE') return EXIT.complete
    if (cancelled) return EXIT.complete
    if (interrupted) return EXIT.interrupted
    if (record.incomplete_reasons.some(r => r.reason === 'stage_failed')) return EXIT.failure
    return EXIT.incomplete
  }

  // ── Recon, lanes, plan ────────────────────────────────────────────────────
  say(`secscan · run ${runId} · ${targetDisplay}${previous ? ' (resumed)' : ''}`)
  say(`Model ${model.model} (${model.label}), ${model.measured ? 'measured' : 'unmeasured'}. Full stage output: ${logPath}`)
  say('Reading the repository. Recon makes up to two small model calls; nothing else is spent before you confirm.')
  for (const stage of PRE_STAGES) {
    const metaDone = previous && stage !== 'stage1-budget-governor-perfile' &&
      readJson<{ exit_code: number }>(join(stageDir(stage), 'meta.json'))?.exit_code === 0
    if (metaDone) continue
    const t0 = Date.now()
    process.stdout.write(`  ${stage} … `)
    const r = await runOne(stage)
    say(r.exit_code === 0 ? `done (${Math.round((Date.now() - t0) / 1000)}s)` : 'FAILED')
    if (r.exit_code !== 0) {
      if (!interrupted) err(`${stage} failed; the last lines of ${logPath}:\n${tail(logPath, 15)}`)
      return finish(false)
    }
  }

  const loadPlanAndSummary = () => {
    plan = readJson<ScanPlan>(join(stageDir('stage1-budget-governor-perfile'), SCAN_PLAN_FILE))
    const assignments = readJson<{ lanes: LaneLite[]; coverage_ledger: { total_files_in_inventory: number } }>(
      join(stageDir('stage05-lane-selector-perfile'), 'lane-assignments.json'))
    const arch = readJson<{ file_inventory?: { by_language?: Record<string, { count: number }> } }>(
      join(stageDir('stage0-recon'), 'architecture-summary.json'))
    if (!plan || !assignments) throw new Error('Stage 1 or Stage 0.5 left no plan to confirm')
    let resume: Parameters<typeof buildSummary>[0]['resume'] = null
    if (previous) {
      const consumption = readJson<any>(join(stageDir(HUNT), 'budget-consumption.json'))
      const entries: { lane_id: string; failed?: boolean }[] =
        Array.isArray(consumption) ? consumption : consumption?.legacy_entries ?? []
      const status = readJson<Stage2RunStatus>(join(stageDir(HUNT), RUN_STATUS_FILE))
      resume = {
        runId,
        doneLaneIds: new Set(entries.filter(e => !e.failed).map(e => e.lane_id)),
        spentUsd: status?.spend.spent_usd ?? null,
      }
    }
    summary = buildSummary({
      targetDisplay,
      targetRoot: target,
      commit: git(target, 'rev-parse', '--short', 'HEAD'),
      branch: git(target, 'rev-parse', '--abbrev-ref', 'HEAD'),
      lanes: assignments.lanes,
      inventoryFiles: assignments.coverage_ledger.total_files_in_inventory,
      byLanguage: arch?.file_inventory?.by_language,
      plan,
      model,
      resume,
    })
  }
  loadPlanAndSummary()

  // ── Confirmation ──────────────────────────────────────────────────────────
  say()
  say(renderSummary(summary!))
  if (args.yes) {
    say('\nStarting (--yes).')
    confirmation = { by: '--yes', at: new Date().toISOString(), summary: summary! }
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let quit = false
    rl.on('SIGINT', () => { quit = true; rl.close() })
    try {
      for (;;) {
        say('\n' + PROMPT_LINE)
        let answer: string
        try {
          answer = (await rl.question('> ')).trim().toLowerCase()
        } catch {
          quit = true
          break
        }
        if (answer === '' ) break
        if (answer === 'q' || answer === 'quit') { quit = true; break }
        if (answer === 's' || answer === 'save') {
          if (existsSync(configPath)) {
            const ok = (await rl.question(`${configPath} exists. Overwrite? [y/N] `)).trim().toLowerCase()
            if (ok !== 'y' && ok !== 'yes') continue
          }
          writeConfig(configPath, configFromRun(model.origin === 'registry' ? model.key : null, limits))
          say(`Saved ${configPath}` + (model.origin !== 'registry'
            ? ' (without the model: a committed config cannot name a custom endpoint or overlay)' : ''))
          continue
        }
        if (answer === 'e' || answer === 'edit') {
          const edited = await editLimits(rl, limits)
          if (edited.max_cost_usd != null && !model.price) {
            say('A cost cap needs a priced model; the cap was not changed.')
            edited.max_cost_usd = limits.max_cost_usd
          }
          limits = edited
          process.stdout.write('  re-planning … ')
          const r = await runOne('stage1-budget-governor-perfile')
          if (r.exit_code !== 0) {
            say('FAILED')
            err(`re-planning failed; the last lines of ${logPath}:\n${tail(logPath, 15)}`)
            rl.close()
            return finish(false)
          }
          say('done')
          loadPlanAndSummary()
          say()
          say(renderSummary(summary!))
          continue
        }
        say(`Unrecognised answer "${answer}".`)
      }
    } finally {
      rl.close()
    }
    if (quit) {
      say('Not started. Nothing was spent on the hunt.')
      return finish(true)
    }
    confirmation = { by: 'prompt', at: new Date().toISOString(), summary: summary! }
  }

  // ── Hunt, with live progress ──────────────────────────────────────────────
  if (interrupted) return finish(false)
  mkdirSync(stageDir(HUNT), { recursive: true })
  const progressPath = join(stageDir(HUNT), PROGRESS_FILE)
  const huntStart = Date.now()
  const pending = runOne(HUNT, Boolean(previous))
  const progress = startProgressWhenFresh(progressPath, huntStart, summary!.estimate.seconds)
  await pending
  progress.stop()

  // Usage is reconciled whenever the hunt left consumption to reconcile.
  if (existsSync(join(stageDir(HUNT), 'budget-consumption.json'))) {
    interrupts = 0
    await runOne('reconcile-v2')
  }
  return finish(false)
}

/** Draw progress only from a progress.json written by this hunt, not an earlier pass. */
function startProgressWhenFresh(path: string, sinceMs: number, plannedSeconds: number) {
  let handle: ReturnType<typeof startProgress> | null = null
  const timer = setInterval(() => {
    const p = readProgress(path)
    if (p && Date.parse(p.started_at) >= sinceMs - 2000) {
      clearInterval(timer)
      handle = startProgress(path, plannedSeconds)
    }
  }, 250)
  return {
    stop() {
      clearInterval(timer)
      handle?.stop()
    },
  }
}

function tail(path: string, n: number): string {
  try {
    return readFileSync(path, 'utf-8').trimEnd().split('\n').slice(-n).map(l => `    ${l}`).join('\n')
  } catch {
    return '    (no log)'
  }
}

/** Put a resumed run's custom endpoint or overlay back into the environment. */
function restoreModelEnv(previous: RunRecord): void {
  const m = previous.model as RunRecord['model'] & { models_file?: string }
  if (m.models_file && !process.env.SCANNER_MODELS_FILE) process.env.SCANNER_MODELS_FILE = m.models_file
  if (m.origin === 'generic' && m.base_url) {
    const price = m.price_per_mtok as { input: number; output: number } | null
    applyModelFlags({
      baseUrl: m.base_url,
      model: m.model,
      apiKeyEnv: m.api_key_env,
      ...(price ? { price: `${price.input}/${price.output}` } : {}),
    })
  }
}

/** [e]: edit scope and limits field by field; Enter keeps a value, '-' clears it. */
async function editLimits(rl: ReturnType<typeof createInterface>, l: RunLimits): Promise<RunLimits> {
  const out: RunLimits = { ...l, paths: [...l.paths], include: [...l.include], exclude: [...l.exclude] }
  const ask = async <T>(label: string, current: string, parse: (s: string) => T, clear: T): Promise<T | undefined> => {
    for (;;) {
      const a = (await rl.question(`  ${label} [${current || '-'}]: `)).trim()
      if (a === '') return undefined
      if (a === '-') return clear
      try {
        return parse(a)
      } catch (e: any) {
        say(`    ${e.message}`)
      }
    }
  }
  const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
  say("Edit scope and limits. Enter keeps a value, '-' clears it; lists are comma-separated.")
  const paths = await ask('Paths to scan', l.paths.join(', '), s => list(s).map(normalizeScopePath).filter(Boolean), [] as string[])
  if (paths !== undefined) out.paths = paths
  const include = await ask('Include globs', l.include.join(', '), s => { const g = list(s); g.forEach(compileGlob); return g }, [] as string[])
  if (include !== undefined) out.include = include
  const exclude = await ask('Exclude globs', l.exclude.join(', '), s => { const g = list(s); g.forEach(compileGlob); return g }, [] as string[])
  if (exclude !== undefined) out.exclude = exclude
  const cost = await ask<number | null>('Max cost (USD)', l.max_cost_usd?.toString() ?? '', s => parseCost(s), null)
  if (cost !== undefined) out.max_cost_usd = cost
  const files = await ask<number | null>('Max files', l.max_files?.toString() ?? '', s => parsePositiveInt(s, 'max files'), null)
  if (files !== undefined) out.max_files = files
  const size = await ask<number | null>('Max file size (bytes, 200k, 1m)', l.max_file_size?.toString() ?? '', s => parseSize(s), null)
  if (size !== undefined) out.max_file_size = size
  const timeout = await ask<number | null>('Timeout (600, 30m, 1h)', l.timeout_seconds != null ? `${l.timeout_seconds}s` : '', s => parseDuration(s), null)
  if (timeout !== undefined) out.timeout_seconds = timeout
  const conc = await ask<number | null>('Concurrency', l.concurrency?.toString() ?? '', s => parsePositiveInt(s, 'concurrency'), null)
  if (conc !== undefined) out.concurrency = conc
  return out
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  e => {
    err(e?.stack ?? String(e))
    process.exit(EXIT.failure)
  },
)
