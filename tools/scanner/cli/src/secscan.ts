#!/usr/bin/env -S npx tsx
/**
 * secscan — the command a user runs (productization plan §2.5–§2.7).
 *
 *   secscan models                 the registry: price, measured/unmeasured, key status
 *   secscan scan [dir] [flags]     recon, plan, confirm, hunt with live progress
 *   secscan report [run-id]        rebuild a run's report.html and findings.json
 *
 * A scan runs Stage 0 (recon), 0.5 (lanes) and 1 (scan plan and estimate)
 * first; those make up to five recon model calls, counted against the budget. It then shows the
 * confirmation screen and spends nothing on the hunt until the user starts it
 * (or --yes says so). The hunt runs behind Stage 1's spend gate with live
 * progress; a limit or Ctrl-C ends it cleanly, and either way the run record
 * says COMPLETE or INCOMPLETE and lists what was not scanned. The report
 * (Task 1d) is then written next to the run record and opened.
 *
 * Nothing here names a model, an endpoint or a credential: the registry
 * (shared/models.json) and the user's flags supply all three.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { parseArgs, usage, UsageError, type ReportArgs, type ScanArgs } from './args.js'
import { applyModelFlags, loadRegistryModules, genericNames } from './registry.js'
import { CONFIG_FILENAME, loadConfig, configFromRun, writeConfig, type LoadedConfig } from './config.js'
import { buildSummary, type ConfirmationSummary, type LaneLite } from './confirm.js'
import { roundTwo } from './round2.js'
import type { InputIO } from './inputs.js'
import { launchStage, signalStage, type RunningStage } from './stages.js'
import { startProgress, readProgress, severityText } from './progress.js'
import { roundOneInputs, terminalIO, InputCancelled, findResume, askNewBudget, tierNotice, reconRefusal, assertSameReadScope } from './inputs.js'
import {
  RUN_RECORD_FILE, RUN_RECORD_SCHEMA, decideStatus, writeRunRecord,
  type RunRecord, type StageResult,
} from './run-record.js'
import { renderModels, usd, int } from './display.js'
import {
  NO_LIMITS, LIMIT_ENV, limitsToEnv, parseCost, parsePositiveInt, parseSize, parseDuration,
  normalizeScopePath, compileGlob, type RunLimits,
} from '../../stage1-budget-governor/src/limits.js'
import type { ScanPlan } from '../../stage1-budget-governor/src/scan-plan.js'
import {
  PROGRESS_FILE, RUN_STATUS_FILE, STOP_REQUEST_FILE, type Stage2RunStatus,
} from '../../stage1-budget-governor/src/run-status.js'
import { PRODUCT_DIRNAME } from '../../shared/run-context.js'
import { isEntryPoint, readBuildInfo } from '../../shared/entry.js'
import { readRunPlaybooks } from './playbooks.js'
import { API_PROFILE_FILE, readApiProfile } from '../../shared/api-profile.js'
import { recordCalibration } from '../../shared/calibration.js'
import { generateReport, isRunId, listRunIds, type GenerateResult } from '../../report/src/write.js'
import { openInBrowser } from '../../report/src/open.js'

const EXIT = { complete: 0, failure: 1, usage: 2, incomplete: 3, interrupted: 130 } as const
const HUNT = 'stage2-hunt-lanes-perfile'
export const PRE_STAGES = ['stage0-recon', 'stage-playbook-agent', 'stage05-lane-selector-perfile', 'stage1-budget-governor-perfile'] as const

const err = (msg: string) => process.stderr.write(`secscan: ${msg}\n`)
const say = (msg = '') => process.stdout.write(msg + '\n')
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

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

/**
 * The packaged CLI names its version and the harness commit it was built from
 * (dist/build-info.json). From source there is no build, so the version is
 * cli/package.json's. fileURLToPath, not URL.pathname: a pathname keeps its
 * percent-escapes (a space is %20) and, on Windows, reads "/C:/...", which no
 * fs call accepts.
 */
function cliVersion(): string {
  const build = readBuildInfo()
  if (build) return `${build.version} (harness ${build.harness_commit})`
  return readJson<{ version: string }>(fileURLToPath(new URL('../package.json', import.meta.url)))?.version ?? 'unknown'
}

/** Print where the report went and open it; a run with no report says why. */
function announceReport(result: GenerateResult, noOpen: boolean): void {
  if (!result.written) {
    say(`No report: ${result.why}.`)
    return
  }
  say(`Report:   ${result.html}`)
  say(`Findings: ${result.json}`)
  if (!noOpen && process.stdout.isTTY) openInBrowser(result.html)
}

function merge(base: RunLimits, over: Partial<RunLimits>): RunLimits {
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) if (v !== undefined) (out as any)[k] = v
  return out
}

/** A product run id: the same shape run.sh generates, suffixed when taken. */
function newRunId(reportsRoot: string): string {
  const d = new Date().toISOString()
  const base = `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}`
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    const dir = join(reportsRoot, 'runs', id)
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
    say(usage(keyDefault, args.topic))
    return EXIT.complete
  }
  if (args.command === 'version') {
    say(cliVersion())
    return EXIT.complete
  }
  if (args.command === 'report') return report(args)
  if (args.command === 'models') {
    applyModelFlags(args)
    const reg = await loadRegistryModules()
    say(renderModels(reg.list(), args.all))
    return EXIT.complete
  }
  return scan(args)
}

export interface ScanDependencies {
  launchStage?: typeof launchStage
  review?: Pick<typeof import('../../stage-playbook-agent/src/review.js'), 'reviewClass' | 'readClassReview' | 'initializeClassReview' | 'recordReviewBudget'>
  io?: () => InputIO
}

export async function scan(args: ScanArgs, dependencies: ScanDependencies = {}): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const initialTarget = resolve(args.target)
  const initialReports = resolve(args.out ?? join(initialTarget, PRODUCT_DIRNAME))
  let previous: RunRecord | null = null
  if (args.resume !== undefined) {
    previous = findResume(initialReports, args.resume)
    if (args.targetProvided && realpathSync(initialTarget) !== previous.target.root) {
      throw new UsageError(`run ${previous.run_id} belongs to ${previous.target.root}`)
    }
    args = { ...args, target: previous.target.root, out: initialReports }
  }

  let config: LoadedConfig | null = null
  let configPath = args.configPath ? resolve(args.configPath) : join(initialTarget, CONFIG_FILENAME)
  if (!args.noConfig && !previous) {
    config = loadConfig(configPath)
    if (args.configPath && !config) throw new UsageError(`--config ${configPath} does not exist`)
  }

  // Registry loading follows flags, including a resumed custom endpoint.
  if (previous) {
    if (args.model || args.baseUrl) throw new UsageError(`run ${previous.run_id} was made with "${previous.model.key}"; a resumed run keeps its model`)
    restoreModelEnv(previous)
  }
  let modelKey = applyModelFlags(args) ?? previous?.model.key ?? config?.config.model
  const reg = await loadRegistryModules()
  modelKey ??= reg.defaultKey()
  let model = reg.info(modelKey)
  if (model.transport !== 'openai') throw new UsageError(`"${model.key}" uses the lab-only "${model.transport}" transport and cannot run here. Pick another with --model.`)
  let limits = merge(merge(NO_LIMITS, previous ? previous.limits : config?.config.limits ?? {}), args.limits)
  if (previous) assertSameReadScope(previous.limits, limits)
  const input = (dependencies.io ?? terminalIO)()
  let round
  try {
    round = await roundOneInputs({
      args, model, limits, io: input, resumed: previous,
      async targetSelected(target) {
        if (!previous && !args.noConfig && !args.configPath && target !== initialTarget) {
          configPath = join(target, CONFIG_FILENAME)
          config = loadConfig(configPath)
          model = reg.info(applyModelFlags(args) ?? config?.config.model ?? reg.defaultKey())
          if (model.transport !== 'openai') throw new UsageError(`"${model.key}" uses a lab-only transport. Pick another with --model.`)
          limits = merge(merge(NO_LIMITS, config?.config.limits ?? {}), args.limits)
        }
        return { model, limits }
      },
    })
  }
  catch (e) { if (e instanceof InputCancelled) return EXIT.complete; throw e }
  finally { input.close?.() }
  if (!round) { say('Not started.'); return EXIT.complete }
  const { target, reportsRoot } = round
  limits = round.limits
  if (limits.max_cost_usd != null && !model.price) throw new UsageError(`--budget needs a priced model, and "${model.key}" has no price. ` +
    (model.origin === 'generic' ? 'Pass --price <in/out>.' : 'Add price_per_mtok in a --models-file entry.'))
  model = reg.info(model.key) // hidden input may have supplied the key
  if (!args.configPath) configPath = join(target, CONFIG_FILENAME)
  const targetDisplay = relative(process.cwd(), target) === '' ? '.' : (relative(process.cwd(), target).startsWith('..') ? target : `./${relative(process.cwd(), target)}`)
  const runId = previous?.run_id ?? newRunId(reportsRoot)

  process.env.SCANNER_TARGET = target
  process.env.SCANNER_PROFILE = 'product'
  process.env.SCANNER_PLAYBOOK_AGENT = '1'
  process.env.SCANNER_RUN_ID = runId
  process.env.SCANNER_REPORTS_ROOT = reportsRoot
  process.env.SCANNER_RUNS_ROOT = join(reportsRoot, 'runs', runId)
  const paths = await import('../../shared/run-paths.js')
  const { SCAN_PLAN_FILE } = await import('../../stage1-budget-governor/src/scan-plan.js')
  const { ledgerPathFor, readLedgerTotals } = await import('../../shared/ledger.js')
  const runsRoot = paths.RUNS_ROOT
  const ledgerPath = ledgerPathFor(runsRoot, model.key)
  const ledgerTotals = () => readLedgerTotals(ledgerPath)

  // Stages inherit exactly what was confirmed: no stray limit, per-stage
  // provider override or lab knob from the caller's shell.
  const childEnvFor = (l: RunLimits): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.values(LIMIT_ENV)) delete env[k]
    for (const k of Object.keys(env)) if (k.startsWith('SCANNER_PROVIDER')) delete env[k]
    delete env.HUNT_MAX_LANES
    delete env.SCANNER_RESUME
    return { ...env, ...limitsToEnv(l) }
  }

  // ── Run directory ─────────────────────────────────────────────────────────
  // The same rule run.sh applies: `.secscan/` carries a `*` .gitignore before
  // anything is written, so run artifacts can never be committed by accident.
  mkdirSync(runsRoot, { recursive: true })
  // The agent playbook cache is run-scoped (<run>/playbooks). A cache at the
  // top of the reports folder can only be the shared one older versions kept;
  // a new run must not inherit it. A resume leaves it for the run it belongs to.
  if (!previous) {
    const legacyCache = join(reportsRoot, 'playbooks')
    if (existsSync(legacyCache)) {
      try {
        rmSync(legacyCache, { recursive: true, force: true })
        say(`Removed the playbook cache left by earlier runs: ${legacyCache}`)
      } catch (e: any) { err(`warning: could not remove the playbook cache left by earlier runs (${legacyCache}): ${e?.message ?? e}`) }
    }
  }
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
  let resuming = Boolean(previous)
  const frozen = Boolean(previous?.stages.some(s => s.stage === HUNT))
  if (frozen) {
    for (const key of Object.keys(args.limits)) {
      if (key !== 'max_cost_usd' && JSON.stringify((limits as any)[key]) !== JSON.stringify((previous!.limits as any)[key])) {
        throw new UsageError('Resume allows budget edits only after the hunt starts; classes and limits are frozen.')
      }
    }
  }
  let reviewApi: ScanDependencies['review']
  let reviewing: AbortController | null = null

  // ── Interrupts ────────────────────────────────────────────────────────────
  let current: RunningStage | null = null
  let interrupts = 0
  let lastInterrupt = 0
  let interrupted = false
  const onInterrupt = () => {
    const now = Date.now()
    if (now - lastInterrupt < 800) return
    lastInterrupt = now
    if (reviewing) { reviewing.abort(); return }
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
    current = (dependencies.launchStage ?? launchStage)({ stage, provider: model.key, target, runId, resume, env: childEnvFor(limits), logPath })
    const r = await current.done
    current = null
    stages.push(r)
    thisPass.push(r)
    return r
  }

  const finish = (cancelled: boolean): number => {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onInterrupt)
    // Preserve prior hunt coverage on a cancelled resume, while persisting any
    // newly reviewed budget and its audit. Before the first hunt, normal finish
    // records the new class selection, paid review attempts and revised scope.
    if (previous && frozen && !thisPass.some(stage => stage.stage === HUNT)) {
      const totals = ledgerTotals()
      const audit = reviewApi?.readClassReview(model.key) ?? previous.class_review
      const record: RunRecord = { ...previous, updated_at: new Date().toISOString(), limits,
        ...(audit ? { class_review: { ...audit, review_spend_usd: audit.edits.reduce((sum, edit) => sum + edit.cost_usd, 0) } } : {}),
        spend: { ...previous.spend, spent_usd: totals.total_usd,
          estimate_usd: summary?.estimate.usd ?? previous.spend.estimate_usd, cap_usd: limits.max_cost_usd,
          input_tokens: totals.prompt_tokens, output_tokens: totals.completion_tokens, calls: totals.calls } }
      writeRunRecord(join(runsRoot, RUN_RECORD_FILE), record)
      say(`Run ${runId} remains ${record.status}; review changes saved. Its record: ${join(runsRoot, RUN_RECORD_FILE)}`)
      return cancelled ? EXIT.complete : EXIT.failure
    }
    const stage2 = readJson<Stage2RunStatus>(join(stageDir(HUNT), RUN_STATUS_FILE))
    // A status left by an earlier pass describes that pass, not this one.
    const fresh = stage2 && thisPass.some(s => s.stage === HUNT && Date.parse(stage2.generated_at) >= Date.parse(s.started_at))
      ? stage2 : null
    const refusal = reconRefusal(readApiProfile(join(stageDir('stage0-recon'), API_PROFILE_FILE)))
    const verdict = refusal
      ? { status: 'INCOMPLETE' as const, reasons: [refusal] }
      : decideStatus(fresh, thisPass, cancelled)
    const totals = ledgerTotals()
    const usage = readJson<any>(join(stageDir('stage1-budget-governor-perfile'), 'usage-v2.json'))
    const usageFresh = usage && fresh && Date.parse(usage.generated_at) >= Date.parse(fresh.ended_at) ? usage : null
    const progress = readProgress(join(stageDir(HUNT), PROGRESS_FILE))
    const unscanned = fresh?.unscanned
      ?? (plan ? plan.admitted.map(l => ({ lane_id: l.lane_id, target_file: l.target_file, reason: 'interrupted' as const, detail: cancelled ? 'not started: cancelled at confirmation' : 'the hunt did not run' })) : [])
    const classReview = reviewApi?.readClassReview(model.key) ?? previous?.class_review
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
        estimate_usd: fresh?.spend.estimate_usd ?? summary?.estimate.usd ?? plan?.estimate?.total_usd ?? plan?.totals.projected_cost_usd ?? null,
        spent_usd: totals.total_usd,
        reconciled_usd: usageFresh?.cost_usd ?? null,
        cap_usd: limits.max_cost_usd,
        input_tokens: totals.prompt_tokens,
        output_tokens: totals.completion_tokens,
        calls: totals.calls,
      },
      findings_total: fresh?.findings_total ?? null,
      ...(classReview ? { class_review: { ...classReview, review_spend_usd: classReview.edits.reduce((sum, edit) => sum + edit.cost_usd, 0) } } : {}),
      playbooks: readRunPlaybooks(stageDir(HUNT), stageDir('stage-playbook-agent'), previous?.playbooks),
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
      ? `secscan scan ${shellQuote(targetDisplay)} --resume ${runId}` +
        ` --out ${shellQuote(reportsRoot)}` +
        (cut('max_cost') ? ' --budget <higher>' : '') +
        (cut('over-max-files') ? ' --max-files <higher>' : '')
      : null
    writeRunRecord(join(runsRoot, RUN_RECORD_FILE), record)
    if (totals.prompt_tokens > 0) recordCalibration(reportsRoot, {
      run_id: runId, at: record.updated_at, model: model.model, effort: reg.effort(model.key),
      files: record.coverage.completed ?? 0, calls: totals.calls,
      input_tokens: totals.prompt_tokens, output_tokens: totals.completion_tokens,
      chars_sent: totals.chars_with_prompt_tokens, prompt_tokens_for_chars: totals.prompt_tokens_with_chars,
      ratio_R: totals.completion_tokens / totals.prompt_tokens,
      chars_per_token: totals.prompt_tokens_with_chars > 0 ? totals.chars_with_prompt_tokens / totals.prompt_tokens_with_chars : null,
    })

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
      say(`Findings: ${progress.findings.total} (${severityText(s)}) — ` +
        'candidates from static reasoning, not verified')
    }
    if (totals.calls || fresh) {
      say(`Spend: ${usd(record.spend.spent_usd)}` +
        (record.spend.estimate_usd != null ? ` (estimate ${usd(record.spend.estimate_usd)})` : '') +
        (record.spend.cap_usd != null ? `, cap ${usd(record.spend.cap_usd)}` : ''))
    }
    say(`Run record: ${join(runsRoot, RUN_RECORD_FILE)}`)
    if (record.resume_command) say(`Continue: ${record.resume_command}`)

    // ── Report ────────────────────────────────────────────────────────────
    // The run record above is the verdict; the report is how it is read, so a
    // report that cannot be written never changes the exit code.
    try {
      const result = generateReport({ runDir: runsRoot, reportsRoot, stageDir, secscanVersion: cliVersion() })
      if (result.written || !cancelled) announceReport(result, args.noOpen)
    } catch (e: any) {
      err(`the report could not be written: ${e?.message ?? e}\n` +
        `Rebuild it with: secscan report ${runId} --out ${shellQuote(reportsRoot)}`)
    }

    // The agent playbook cache only saves repeated research within this run.
    // Any INCOMPLETE run can still be picked up by `--resume` (findResume), even
    // one without a resume_command (quit at confirmation, failed replan), and
    // its later stages read this cache back; so only a run that can no longer
    // be resumed clears it. Like the report, a failed removal never changes
    // the exit code.
    if (record.status !== 'INCOMPLETE') {
      const runCache = join(runsRoot, 'playbooks')
      try { rmSync(runCache, { recursive: true, force: true }) }
      catch (e: any) { err(`warning: could not remove this run's playbook cache (${runCache}): ${e?.message ?? e}`) }
    }

    if (record.status === 'COMPLETE') return EXIT.complete
    if (cancelled) return EXIT.complete
    if (interrupted) return EXIT.interrupted
    if (record.incomplete_reasons.some(r => r.reason === 'stage_failed')) return EXIT.failure
    return EXIT.incomplete
  }

  // ── Recon, lanes, plan ────────────────────────────────────────────────────
  say(`secscan · run ${runId} · ${targetDisplay}${previous ? ' (resumed)' : ''}`)
  say(`Model ${model.model} (${model.label}), ${model.measured ? 'measured' : 'unmeasured'}. Full stage output: ${logPath}`)
  say('Reading the repository. Recon, playbook coverage and uncached web research run before confirmation and count against the budget.')
  let upstreamRebuilt = false
  for (const stage of PRE_STAGES) {
    if (frozen) continue // Preserve assignments, U and order once hunting has started.
    const scopeChanged = !frozen && ['paths', 'include', 'exclude', 'max_files', 'max_file_size', 'concurrency']
      .some(key => key in args.limits)
    const savedPlan = stage === 'stage1-budget-governor-perfile' && !scopeChanged &&
      existsSync(join(stageDir(stage), SCAN_PLAN_FILE))
    const previousStage = previous?.stages.findLast(result => result.stage === stage)
    const metaDone = previous && previousStage?.exit_code === 0 && !upstreamRebuilt && (savedPlan || (stage !== 'stage1-budget-governor-perfile' &&
      readJson<{ exit_code: number }>(join(stageDir(stage), 'meta.json'))?.exit_code === 0))
    if (metaDone) continue
    const t0 = Date.now()
    process.stdout.write(`  ${stage} … `)
    const r = await runOne(stage, Boolean(previous))
    upstreamRebuilt = true // Its new artifacts invalidate every downstream cached stage.
    say(r.exit_code === 0 ? `done (${Math.round((Date.now() - t0) / 1000)}s)` : 'FAILED')
    if (r.exit_code !== 0) {
      const refusal = reconRefusal(readApiProfile(join(stageDir('stage0-recon'), API_PROFILE_FILE)))
      if (refusal) say(refusal.detail)
      else if (!interrupted) err(`${stage} failed; the last lines of ${logPath}:\n${tail(logPath, 15)}`)
      return finish(false)
    }
    const refusal = reconRefusal(readApiProfile(join(stageDir('stage0-recon'), API_PROFILE_FILE)))
    if (refusal) { say(refusal.detail); return finish(false) }
  }

  const loadPlanAndSummary = () => {
    plan = readJson<ScanPlan>(join(stageDir('stage1-budget-governor-perfile'), SCAN_PLAN_FILE))
    const assignments = readJson<{ lanes: LaneLite[]; coverage_ledger: { total_files_in_inventory: number }; class_selection?: { unrouted: string[] } }>(
      join(stageDir('stage05-lane-selector-perfile'), 'lane-assignments.json'))
    const arch = readJson<{ file_inventory?: { by_language?: Record<string, { count: number }> } }>(
      join(stageDir('stage0-recon'), 'architecture-summary.json'))
    if (!plan || !assignments) throw new Error('Stage 1 or Stage 0.5 left no plan to confirm')
    // Budget-only resumes keep the original U and concurrency. The cap comes
    // from this invocation's limits, which Stage 2 receives in its environment.
    plan.limits = limits
    let resume: Parameters<typeof buildSummary>[0]['resume'] = null
    if (resuming) {
      const consumption = readJson<any>(join(stageDir(HUNT), 'budget-consumption.json'))
      const entries: { lane_id: string; failed?: boolean }[] =
        Array.isArray(consumption) ? consumption : consumption?.legacy_entries ?? []
      resume = {
        runId,
        doneLaneIds: new Set(entries.filter(e => !e.failed).map(e => e.lane_id)),
        spentUsd: ledgerTotals().total_usd,
      }
    }
    const review = reviewApi?.readClassReview(model.key)
    const agentClasses = new Set(review?.agent_selection.classes ?? [])
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
      spentUsd: ledgerTotals().total_usd,
      selection: readJson<{ classes: string[] }>(join(stageDir('stage-playbook-agent'), 'class-selection.json')) ?? { classes: [] },
      unrouted: assignments.class_selection?.unrouted,
      userAdded: Object.fromEntries((review?.edits ?? [])
        .filter(e => e.action === 'add' && e.resolved.id && !agentClasses.has(e.resolved.id) && !['failed', 'rejected'].includes(e.resolved.kind))
        .map(e => [e.resolved.id, e.resolved.kind === 'researched' ? 'web' : e.resolved.kind])),
    })
    summary.guidance = `${summary.classes?.length ?? 0} reviewed classes`
  }
  loadPlanAndSummary()

  // ── Confirmation: reviewed classes and the exact plan that will run ──────
  const tier = tierNotice(readApiProfile(join(stageDir('stage0-recon'), API_PROFILE_FILE)))
  if (tier.message) say(tier.message)
  if (tier.refuse) return finish(false)
  reviewApi = dependencies.review ?? await import('../../stage-playbook-agent/src/review.js')
  reviewApi.initializeClassReview(model.key)
  const reviewIO = (dependencies.io ?? terminalIO)()
  const stopReviewInterrupts = reviewIO.onInterrupt?.(() => reviewing?.abort())
  const replan = async () => {
    const started = Date.now()
    for (const stage of ['stage05-lane-selector-perfile', 'stage1-budget-governor-perfile']) {
      const result = await runOne(stage)
      if (result.exit_code !== 0) throw new Error(`Re-planning failed; the last lines of ${logPath}:\n${tail(logPath, 15)}`)
    }
    loadPlanAndSummary()
    reviewIO.write(`Re-planning done (${((Date.now() - started) / 1000).toFixed(2)}s; no model calls).`)
  }
  let reviewResult: Awaited<ReturnType<typeof roundTwo>>
  try {
    reviewResult = await roundTwo({
      io: reviewIO, yes: args.yes, frozen,
      requested: { ...config?.config.classes, ...args.classes },
      summary() { loadPlanAndSummary(); return summary! },
      async edit(action, input, confirmCall, rawInput) {
        reviewing = new AbortController()
        try {
          return await reviewApi!.reviewClass({ provider: model.key, action, input, rawInput,
            budgetUsd: limits.max_cost_usd, signal: reviewing.signal, confirmCall })
        } finally { reviewing = null }
      },
      replan,
      async budget(budget) {
        limits = { ...limits, max_cost_usd: budget }
        reviewApi!.recordReviewBudget(model.key, budget)
        if (frozen) loadPlanAndSummary()
        else await replan()
      },
      async editLimits() {
        const edited = await editLimits(reviewIO, limits)
        try { assertSameReadScope(limits, edited) }
        catch (e: any) { reviewIO.write(e.message); return }
        if (edited.max_cost_usd != null && edited.max_cost_usd <= ledgerTotals().total_usd) {
          reviewIO.write(`Budget must exceed ${usd(ledgerTotals().total_usd)} already spent.`)
          return
        }
        if (edited.max_cost_usd !== limits.max_cost_usd) reviewApi!.recordReviewBudget(model.key, edited.max_cost_usd)
        limits = edited
        await replan()
      },
      async save() {
        if (existsSync(configPath)) {
          const ok = (await reviewIO.read(`${configPath} exists. Overwrite? [y/N] `)).trim().toLowerCase()
          if (ok !== 'y' && ok !== 'yes') return
        }
        const review = reviewApi!.readClassReview(model.key)!
        const agentClasses = new Set(review.agent_selection.classes)
        const finalClasses = new Set(review.final.classes)
        const classes = {
          drop: [...agentClasses].filter(id => !finalClasses.has(id)),
          add: [...finalClasses].filter(id => !agentClasses.has(id)),
        }
        writeConfig(configPath, configFromRun(model.origin === 'registry' ? model.key : null, limits, classes))
        reviewIO.write(`Saved ${configPath}`)
      },
    })
  } catch (e: any) {
    err(e.message)
    finish(false)
    return EXIT.failure
  } finally { stopReviewInterrupts?.(); reviewIO.close?.() }
  if (reviewResult === 'failed') { loadPlanAndSummary(); finish(false); return EXIT.failure }
  if (reviewResult === 'quit') {
    say('Not started. Nothing was spent on the hunt.')
    return finish(true)
  }
  confirmation = { by: args.yes ? '--yes' : 'prompt', at: new Date().toISOString(), summary: summary! }

  // ── Hunt, with live progress ──────────────────────────────────────────────
  if (interrupted) return finish(false)
  mkdirSync(stageDir(HUNT), { recursive: true })
  const progressPath = join(stageDir(HUNT), PROGRESS_FILE)
  let resumeHunt = Boolean(previous)
  for (;;) {
    const huntStart = Date.now()
    const pending = runOne(HUNT, resumeHunt)
    const progress = startProgressWhenFresh(progressPath, huntStart, summary!.estimate.seconds, () => ledgerTotals().total_usd)
    await pending
    progress.stop()
    const status = readJson<Stage2RunStatus>(join(stageDir(HUNT), RUN_STATUS_FILE))
    const atCap = status?.reasons.some(r => r.reason === 'max_cost') &&
      Date.parse(status.generated_at) >= huntStart - 2000
    if (interrupted || !atCap || args.yes || !interactive) break
    const budgetIO = (dependencies.io ?? terminalIO)()
    let budget: number | null
    try {
      budget = await askNewBudget(budgetIO, {
        yes: args.yes, totals: ledgerTotals(), done: status!.lanes.completed,
        total: status!.lanes.admitted, plan: plan!,
      })
    } catch (e) {
      if (e instanceof InputCancelled) break
      throw e
    } finally { budgetIO.close?.() }
    if (budget === null) break
    limits = { ...limits, max_cost_usd: budget }
    reviewApi!.recordReviewBudget(model.key, budget)
    resuming = true
    loadPlanAndSummary()
    resumeHunt = true
    say(`Continuing run ${runId} with budget ${usd(budget)}.`)
  }

  // The ledger is authoritative; reconciliation remains a separate usage artifact.
  if (existsSync(join(stageDir(HUNT), 'budget-consumption.json'))) {
    interrupts = 0
    await runOne('reconcile-v2')
  }
  return finish(false)
}

/**
 * `secscan report [run-id]`: rebuild a run's report from what is on disk,
 * after the CLI was killed before writing it, or to re-render an older run.
 * Stage directories are resolved through runPath() under the run's own
 * context, exactly as the scan resolved them.
 */
async function report(args: ReportArgs): Promise<number> {
  const reportsRoot = resolve(args.out ?? join(process.cwd(), PRODUCT_DIRNAME))
  if (args.runId !== undefined && !isRunId(args.runId)) throw new UsageError(`"${args.runId}" is not a run id`)
  const runId = args.runId ?? listRunIds(reportsRoot)[0]
  if (!runId) throw new UsageError(`no runs in ${reportsRoot}; pass --out <reports folder>`)
  const runDir = join(reportsRoot, 'runs', runId)
  if (!existsSync(runDir)) throw new UsageError(`no run ${runId} in ${reportsRoot}`)
  const record = readJson<RunRecord>(join(runDir, RUN_RECORD_FILE))
  const allowlist = readJson<{ target_root?: string }>(join(runDir, 'read-allowlist.json'))
  // Without a record, the run's one model folder names the provider.
  const modelDirs = readdirSync(runDir).filter(d => existsSync(join(runDir, d, HUNT)) || existsSync(join(runDir, d, 'stage0-recon')))
  const modelKey = record?.model.key ?? (modelDirs.length === 1 ? modelDirs[0] : undefined)
  const target = record?.target.root ?? allowlist?.target_root
  if (!modelKey || !target) throw new UsageError(`run ${runId} has no run record or allowlist to rebuild a report from`)

  const progress = readProgress(join(runDir, modelKey, HUNT, PROGRESS_FILE))
  if (progress && (progress.status === 'running' || progress.status === 'stopping') &&
      Date.now() - Date.parse(progress.updated_at) < 120_000) {
    throw new UsageError(`run ${runId} is still scanning; rebuild its report once it ends`)
  }

  if (record) restoreModelEnv(record)
  process.env.SCANNER_TARGET = target
  process.env.SCANNER_PROFILE = 'product'
  process.env.SCANNER_RUN_ID = runId
  process.env.SCANNER_REPORTS_ROOT = reportsRoot
  process.env.SCANNER_RUNS_ROOT = runDir
  const paths = await import('../../shared/run-paths.js')
  const result = generateReport({
    runDir, reportsRoot, modelKey, secscanVersion: cliVersion(),
    stageDir: stage => paths.runPath(modelKey, stage),
  })
  announceReport(result, args.noOpen)
  return result.written ? EXIT.complete : EXIT.failure
}

/** Draw progress only from a progress.json written by this hunt, not an earlier pass. */
function startProgressWhenFresh(path: string, sinceMs: number, plannedSeconds: number, ledgerSpend: () => number) {
  let handle: ReturnType<typeof startProgress> | null = null
  const timer = setInterval(() => {
    const p = readProgress(path)
    if (p && Date.parse(p.started_at) >= sinceMs - 2000) {
      clearInterval(timer)
      handle = startProgress(path, plannedSeconds, process.stderr, ledgerSpend)
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
async function editLimits(io: InputIO, l: RunLimits): Promise<RunLimits> {
  const out: RunLimits = { ...l, paths: [...l.paths], include: [...l.include], exclude: [...l.exclude] }
  const ask = async <T>(label: string, current: string, parse: (s: string) => T, clear: T): Promise<T | undefined> => {
    for (;;) {
      const a = (await io.read(`  ${label} [${current || '-'}]: `)).trim()
      if (a === '') return undefined
      if (a === '-') return clear
      try {
        return parse(a)
      } catch (e: any) {
        io.write(`    ${e.message}`)
      }
    }
  }
  const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
  io.write("Edit scope and limits. Enter keeps a value, '-' clears it; lists are comma-separated.")
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

// Realpaths, not URLs: installed, argv[1] is npm's bin symlink (or a
// differently-cased path on Windows) while import.meta.url is the real file.
if (isEntryPoint(import.meta.url)) main(process.argv.slice(2)).then(
  code => process.exit(code),
  e => {
    err(e instanceof UsageError ? e.message : e?.stack ?? String(e))
    process.exit(e instanceof UsageError ? EXIT.usage : EXIT.failure)
  },
)
