/**
 * The run-start confirmation (plan §2.7): what will be scanned, with which
 * model, under which limits, for roughly how much — shown before the hunt
 * spends anything.
 *
 * Every figure comes from an artifact the run itself wrote: languages from
 * Stage 0's file inventory, the file split from Stage 0.5's lanes and Stage 1's
 * scan plan, the estimate and the cap from the scan plan. The summary object is
 * also saved in the run record, so the screen a user confirmed can be checked
 * against what the run then did (Part 3, CLI row).
 */
import type { ScanPlan } from '../../stage1-budget-governor/src/scan-plan.js'
import type { RunLimits } from '../../stage1-budget-governor/src/limits.js'
import type { ModelInfo } from './registry.js'
import { languageShares, topDirs, usd, int, bytes, duration, type LanguageShare } from './display.js'

export interface LaneLite {
  lane_id: string
  target_file: string
  disposition: 'hunt' | 'skip'
  skip_reason: string | null
  classes?: string[]
  chunk_plan?: { total_chunks: number; chunks?: unknown[] }
}

export interface ClassRow {
  id: string
  files: number
  added_by_user: boolean
  source?: string
  all_files: boolean
}

export interface BudgetMessage {
  kind: 'full' | 'partial' | 'low' | 'blocked' | 'empty' | 'unpriced'
  text: string
  can_start: boolean
  requires_confirmation: boolean
  input_threshold_usd: number | null
  first_start_usd: number | null
}

export function budgetMessage(input: {
  cap: number | null; total: number | null; spent: number; inputThreshold: number | null
  firstStart: number | null; files: number; withinCap: number | null; noClasses?: boolean
}): BudgetMessage {
  const base = { input_threshold_usd: input.inputThreshold, first_start_usd: input.firstStart }
  const result = (kind: BudgetMessage['kind'], text: string, can_start = true, requires_confirmation = false): BudgetMessage =>
    ({ ...base, kind, text, can_start, requires_confirmation })
  if (input.noClasses) return result('empty', 'No classes selected; add a class before starting.', false)
  if (input.files === 0) return result('empty', 'No files remain to scan.', false)
  if (input.cap != null && input.cap <= input.spent) return result('blocked', `Budget must exceed ${usd(input.spent)} already spent.`, false)
  if (input.cap != null && input.firstStart != null && input.cap < input.firstStart) {
    return result('blocked', `The scan can't start: the first file alone may cost up to ${usd(input.firstStart - input.spent)}; raise the total budget to ${usd(input.firstStart)}.`, false)
  }
  if (input.total == null) return result('unpriced', 'The scan estimate is unavailable.', false)
  if (input.cap == null || input.cap >= input.total) return result('full', 'Budget covers the full scan.')
  if (input.inputThreshold != null && input.cap < input.inputThreshold) {
    return result('low', `Budget too low: raise to at least ${usd(input.inputThreshold)} for a useful scan.`, true, true)
  }
  return result('partial', `Budget covers about ${input.withinCap ?? 0} of ${input.files} files, riskiest first; raise to ${usd(input.total)} for all. The report will be INCOMPLETE if the budget stops the scan.`)
}

export interface ConfirmationSummary {
  target: { display: string; root: string; commit: string | null; branch: string | null; files: number }
  languages: LanguageShare[]
  scan: { files: number; dirs: string[] }
  skip: { files: number; dirs: string[]; by_reason: Record<string, number> }
  model: {
    key: string
    label: string
    model: string
    api_key_env: string
    key_present: boolean
    measured: boolean
    origin: string
    base_url: string | null
  }
  guidance: string
  estimate: {
    usd: number | null
    seconds: number
    basis: string
    cap_usd: number | null
    exceeds_cap: boolean | null
    lanes_within_cap: number | null
    breakdown?: {
      total_usd: number; input_usd: number; output_usd: number; spent_usd: number
      band_pct: number | null; tier_label: string; tier_multiplier: number
    }
  }
  classes?: ClassRow[]
  budget_message?: BudgetMessage
  limits: RunLimits
  concurrency: { value: number; basis: string }
  /** Set on --resume: what earlier passes already finished. */
  resume: { run_id: string; done: number; spent_usd: number | null } | null
}

export interface SummaryInput {
  targetDisplay: string
  targetRoot: string
  commit: string | null
  branch: string | null
  lanes: LaneLite[]
  inventoryFiles: number
  byLanguage: Record<string, { count: number }> | undefined
  plan: ScanPlan
  /** Selected ids, including classes that currently reach no admitted file. */
  selection?: { classes: string[] }
  unrouted?: string[]
  userAdded?: Record<string, string>
  spentUsd?: number
  model: ModelInfo
  /** Lanes already finished on a resumed run, and what they cost. */
  resume: { runId: string; doneLaneIds: Set<string>; spentUsd: number | null } | null
}

/** Stage 0.5's skip reasons, folded into a few words for the screen. */
function skipCategory(reason: string | null): string {
  const r = (reason ?? '').toLowerCase()
  if (r.includes('no selected class')) return 'no selected class'
  if (r.includes('denylist')) return 'denylisted'
  return 'not code'
}

export function buildSummary(input: SummaryInput): ConfirmationSummary {
  const { plan, model } = input
  const remaining = input.resume
    ? plan.admitted.filter(l => !input.resume!.doneLaneIds.has(l.lane_id))
    : plan.admitted
  const skipped: { file: string; reason: string }[] = []
  for (const l of input.lanes) {
    if (l.disposition === 'skip') skipped.push({ file: l.target_file, reason: skipCategory(l.skip_reason) })
  }
  for (const e of plan.excluded) skipped.push({ file: e.target_file, reason: e.reason })
  const byReason: Record<string, number> = {}
  for (const s of skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1

  // On a resume the estimate is for what is left; the cap covers the whole run.
  const remainingInputTokens = remaining.reduce((sum, lane) => sum + lane.projected_input_tokens, 0)
  const estimateMatchesRemaining = plan.estimate?.input_tokens === remainingInputTokens
  const remainingCost = remaining.some(l => l.projected_cost_usd == null)
    ? null
    : estimateMatchesRemaining ? plan.estimate!.scan_usd : remaining.reduce((s, l) => s + (l.projected_cost_usd ?? 0), 0)
  const totalCalls = plan.totals.projected_calls
  const remainingCalls = remaining.reduce((s, l) => s + l.projected_calls, 0)
  const seconds = totalCalls > 0 ? Math.round(plan.totals.projected_wall_seconds * (remainingCalls / totalCalls)) : 0
  const spent = input.spentUsd ?? input.resume?.spentUsd ?? plan.estimate?.spent_before_usd ?? 0
  const detail = plan.estimate
  const remainingShare = estimateMatchesRemaining ? 1 : detail && detail.input_tokens > 0
    ? remainingInputTokens / detail.input_tokens
    : detail && detail.scan_usd > 0 && remainingCost != null ? remainingCost / detail.scan_usd : 0
  const cap = plan.limits.max_cost_usd
  let withinCap: number | null = null
  if (cap != null && remainingCost != null) {
    let running = spent
    withinCap = 0
    for (const l of remaining) {
      running += l.projected_cost_usd ?? 0
      if (running > cap) break
      withinCap++
    }
  }

  const remainingIds = new Set(remaining.map(l => l.lane_id))
  const rows = input.selection?.classes.map(id => ({
    id,
    files: input.lanes.filter(l => remainingIds.has(l.lane_id) && l.classes?.includes(id)).length,
    added_by_user: Object.hasOwn(input.userAdded ?? {}, id),
    ...(input.userAdded?.[id] ? { source: input.userAdded[id] } : {}),
    all_files: input.unrouted?.includes(id) ?? false,
  }))
  const first = input.lanes.find(l => l.lane_id === remaining[0]?.lane_id)
  const firstStart = first && plan.reservation_unit_usd != null
    ? spent + (first.chunk_plan?.chunks?.length ?? first.chunk_plan?.total_chunks ?? 1) * plan.reservation_unit_usd
    : plan.first_start_usd != null ? plan.first_start_usd + spent - (detail?.spent_before_usd ?? 0) : null
  const inputThreshold = detail ? spent + detail.input_usd * remainingShare : plan.input_threshold_usd ?? null

  return {
    ...(rows ? { classes: rows } : {}),
    ...(input.selection ? { budget_message: budgetMessage({
      cap, total: remainingCost == null ? null : spent + remainingCost, spent,
      inputThreshold, firstStart, files: remaining.length, withinCap, noClasses: rows?.length === 0,
    }) } : {}),
    target: {
      display: input.targetDisplay,
      root: input.targetRoot,
      commit: input.commit,
      branch: input.branch,
      files: input.inventoryFiles,
    },
    languages: languageShares(input.byLanguage, model.benchmark?.languages ?? []),
    scan: { files: remaining.length, dirs: topDirs(remaining.map(l => l.target_file)) },
    skip: { files: skipped.length, dirs: topDirs(skipped.map(s => s.file)), by_reason: byReason },
    model: {
      key: model.key,
      label: model.label,
      model: model.model,
      api_key_env: model.apiKeyEnv,
      key_present: model.keyPresent,
      measured: model.measured,
      origin: model.origin,
      base_url: model.origin === 'registry' ? null : model.baseUrl,
    },
    guidance: input.selection ? 'reviewed class selection' : 'none (built-in playbooks only)',
    estimate: {
      usd: detail && remainingCost != null ? spent + remainingCost : remainingCost,
      seconds,
      basis: plan.totals.wall_basis,
      cap_usd: cap,
      exceeds_cap: cap != null && remainingCost != null ? spent + remainingCost > cap : null,
      lanes_within_cap: withinCap,
      ...(detail ? { breakdown: {
        total_usd: spent + (remainingCost ?? 0),
        input_usd: detail.input_usd * remainingShare,
        output_usd: detail.output_usd * remainingShare,
        spent_usd: spent,
        band_pct: detail.band_pct,
        tier_label: detail.tier_label,
        tier_multiplier: detail.tier_multiplier,
      } } : {}),
    },
    limits: plan.limits,
    concurrency: plan.concurrency,
    resume: input.resume
      ? { run_id: input.resume.runId, done: plan.admitted.length - remaining.length, spent_usd: input.resume.spentUsd }
      : null,
  }
}

function pct(share: number): string {
  const p = share * 100
  return p >= 1 || p === 0 ? `${Math.round(p)}%` : '<1%'
}

export function renderSummary(s: ConfirmationSummary): string {
  const out: string[] = []
  if (s.estimate.breakdown) out.push(`Recon and planning done · spent so far ${usd(s.estimate.breakdown.spent_usd)}`)
  const commit = s.target.commit ? `commit ${s.target.commit}` : 'not a git checkout'
  out.push(`Target: ${s.target.display} (${commit}, ${int(s.target.files)} files)`)

  const langs = s.languages.slice(0, 5)
  if (langs.length) {
    const unmeasured = s.model.measured
      ? s.languages.filter(l => !l.measured).map(l => l.name)
      : []
    const note = !s.model.measured
      ? ' (this model is unmeasured in every language)'
      : unmeasured.length ? ` (${unmeasured.join(', ')}: unmeasured)` : ''
    out.push(`Languages: ${langs.map(l => `${l.name} ${pct(l.share)}`).join(', ')}` +
      (s.languages.length > langs.length ? `, +${s.languages.length - langs.length} more` : '') + note)
  } else {
    out.push('Languages: none recognised by recon')
  }

  if (s.classes) {
    out.push('', 'Vulnerability classes for this repo                       files')
    s.classes.forEach((row, index) => out.push(`  ${index + 1}  ${row.id}  ${row.files}` +
      (row.added_by_user ? `  added by you (${row.source ?? 'catalog'})` : '') +
      (row.all_files ? '  no matching signal (all files)' : '')))
    out.push('')
  }
  const reasons = Object.entries(s.skip.by_reason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${int(n)} ${r}`).join(', ')
  out.push(`Scan ${int(s.scan.files)} files in: ${s.scan.dirs.join(' ') || '(nothing)'}   ` +
    `Skip ${int(s.skip.files)}: ${s.skip.dirs.join(' ') || '-'}` + (reasons ? `  (${reasons})` : ''))

  const key = s.model.key_present ? `${s.model.api_key_env} found` : `${s.model.api_key_env} NOT SET`
  out.push(`Model: ${s.model.model} (${key})` +
    (s.model.base_url ? ` at ${s.model.base_url}` : '') +
    `, ${s.model.measured ? 'measured' : 'unmeasured'}   Extra guidance: ${s.guidance}`)

  const est = `~${usd(s.estimate.usd)}, ~${Math.max(1, Math.round(s.estimate.seconds / 60))} min`
  const cap = s.estimate.cap_usd != null ? usd(s.estimate.cap_usd) : 'none (set --max-cost)'
  out.push(`Estimate: ${est}    Cap: ${cap}`)
  const detail = s.estimate.breakdown
  if (detail) {
    out.push(`  Total ${usd(detail.total_usd)}: ${usd(detail.spent_usd)} spent + input ${usd(detail.input_usd)} + output ${usd(detail.output_usd)}.`)
    out.push(`  ${detail.band_pct == null ? 'Can vary widely (fewer than 10 files).' : `Accuracy band: ±${detail.band_pct}% (90%).`}`)
  }
  if (s.budget_message) out.push(s.budget_message.text)
  else if (s.estimate.exceeds_cap) {
    out.push(`  The estimate exceeds the cap: about ${s.estimate.lanes_within_cap} of ${s.scan.files} files fit. ` +
      `The run stops there, is recorded INCOMPLETE, and --resume with a higher cap continues it.`)
  }
  const l = s.limits
  const lim = [
    l.max_files != null ? `max ${int(l.max_files)} files` : null,
    l.max_file_size != null ? `files up to ${bytes(l.max_file_size)}` : null,
    l.timeout_seconds != null ? `timeout ${duration(l.timeout_seconds)}` : null,
    `concurrency ${s.concurrency.value} (${s.concurrency.basis})`,
    l.paths.length ? `paths ${l.paths.join(', ')}` : null,
    l.include.length ? `include ${l.include.join(', ')}` : null,
    l.exclude.length ? `exclude ${l.exclude.join(', ')}` : null,
  ].filter(Boolean)
  out.push(`Limits: ${lim.join('; ')}`)
  if (s.resume) {
    out.push(`Resuming run ${s.resume.run_id}: ${int(s.resume.done)} file(s) already scanned` +
      (s.resume.spent_usd != null ? `, ${usd(s.resume.spent_usd)} spent` : '') +
      (detail ? '; the total includes earlier spend and the remaining scan.' : '; the estimate covers the rest.'))
  }
  return out.join('\n')
}

export const PROMPT_LINE = '[Enter] start   [e] edit dirs/limits   [s] save as secscan.config.json   [q] quit'
