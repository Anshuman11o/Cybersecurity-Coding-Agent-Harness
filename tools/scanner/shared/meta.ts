/**
 * Run provenance: meta.json write + upstream assertions.
 *
 * Path centralisation (run-paths.ts) prevents a provider mix-up; this file
 * DETECTS one. Without the assertion, a mis-threaded provider argument yields
 * a run that silently consumed the other provider's artifacts and looks
 * completely normal in the output — which is the exact failure mode the
 * two-provider split exists to avoid.
 *
 * Zero dependencies (node builtins only).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { runPath, REPO_ROOT, type Provider, type Stage } from './run-paths.js'
import { isDegraded, degradedReasons } from './degraded.js'
import { isProviderExplicit } from './provider.js'

export interface RunMeta {
  provider: Provider
  model: string
  stage: Stage
  git_sha: string
  started: string
  ended: string
  exit_code: number
  blocked_reads?: number
  /** True if any LLM call fell back to deterministic analysis. */
  degraded: boolean
  degraded_reasons?: string[]
  /**
   * Sampling / effort parameters the run actually sent, as resolved from the
   * registry. Recorded because a run's behaviour is otherwise recoverable only
   * from the git sha, and an artifact that does not say which reasoning effort
   * produced it can be cited later as a baseline for an effort it never ran at.
   */
  sampling?: Record<string, number | string>
  /** Output-token cap the run actually sent. */
  max_output_tokens?: number
  /**
   * The per-lane agent loop the run executed under, for the same reason
   * `sampling` is here: the loop is selected by env var, so `git_sha` cannot
   * tell two runs of the same tree apart, and an artifact that does not name
   * its arm gets cited later as a baseline for an arm it never ran.
   * `"none"` is the historic single-turn behaviour.
   */
  loop_mode?: string
  /** Follow-up turns permitted per chunk. Absent when loop_mode is "none". */
  loop_passes?: number
  /** Classes per group in sweep mode. Absent for every other mode. */
  sweep_group_size?: number
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

/** Write meta.json alongside a stage's artifacts. */
export function writeMeta(
  provider: Provider,
  stage: Stage,
  model: string,
  startedIso: string,
  exitCode = 0,
  blockedReads = 0,
  extra: Pick<RunMeta,
    'sampling' | 'max_output_tokens' | 'loop_mode' | 'loop_passes' | 'sweep_group_size'> = {},
): void {
  const dir = runPath(provider, stage)
  mkdirSync(dir, { recursive: true })
  const meta: RunMeta = {
    provider,
    model,
    stage,
    git_sha: gitSha(),
    started: startedIso,
    ended: new Date().toISOString(),
    exit_code: exitCode,
    blocked_reads: blockedReads,
    degraded: isDegraded(),
    ...(isDegraded() ? { degraded_reasons: degradedReasons() } : {}),
    ...extra,
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
}

/**
 * Read an upstream artifact. Only ever called with hardcoded filenames —
 * never with a model-supplied path. See read-guard.ts for that case.
 */
export function readUpstreamArtifact(
  provider: Provider,
  stage: Stage,
  file: string,
): string {
  return readFileSync(join(runPath(provider, stage), file), 'utf-8')
}

/**
 * Fail fast if an upstream stage's artifacts were produced by a different
 * provider, or by a run that did not succeed.
 */
export function assertUpstream(provider: Provider, stage: Stage): void {
  const metaPath = join(runPath(provider, stage), 'meta.json')

  if (!existsSync(metaPath)) {
    // Tolerated: the baseline artifacts predate meta.json. Warn so it is
    // visible, but do not block — the path itself is already provider-scoped.
    console.error(
      `  [PROVENANCE] no meta.json for ${stage} under "${provider}" — ` +
        `cannot verify provenance (pre-existing baseline?)`,
    )
    return
  }

  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as RunMeta

  if (meta.provider !== provider) {
    throw new Error(
      `PROVENANCE MISMATCH: ${stage} artifacts were produced by ` +
        `"${meta.provider}", but this run is "${provider}". ` +
        `Re-run ${stage} under ${provider} before continuing.`,
    )
  }

  if (meta.exit_code !== 0) {
    throw new Error(
      `UPSTREAM FAILED: ${stage} (provider "${provider}") exited with ` +
        `code ${meta.exit_code}. Refusing to build on a failed run.`,
    )
  }
}

/**
 * Exit non-zero if the run degraded AND the provider was chosen explicitly.
 * Call at the very end of a stage, after writeMeta().
 *
 * Rationale: a degraded run under the default provider is the historical
 * safety-net behaviour and stays non-fatal. A degraded run under an explicitly
 * selected provider means the model someone is evaluating never actually ran —
 * that must not be reportable as a success.
 */
export function failIfDegraded(stageKey: string, stage: Stage): void {
  if (!isDegraded()) return
  const reasons = degradedReasons()
  console.error(
    `\n[DEGRADED] ${stage} fell back to deterministic analysis ` +
      `${reasons.length} time(s):`,
  )
  for (const r of reasons) console.error(`  - ${r}`)
  if (isProviderExplicit(stageKey)) {
    console.error(
      `\nFAILING: provider was selected explicitly, so a deterministic ` +
        `substitute would misrepresent it. See meta.json "degraded": true.`,
    )
    process.exit(1)
  }
  console.error(
    `\n(not failing: provider was defaulted, so fallback is the intended ` +
      `safety net. meta.json records "degraded": true.)`,
  )
}
