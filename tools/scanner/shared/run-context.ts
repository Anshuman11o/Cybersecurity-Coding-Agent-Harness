/**
 * Run context — the one place that decides WHAT a run scans and WHERE its
 * artifacts go.
 *
 * Before this existed, both answers were hardcoded to the benchmark: the read
 * guard only allowed `target-apps/juice-shop{,-blind}`, every artifact landed in
 * `tools/scanner/runs/`, and Stage 0.5 fell back to `juice-shop-blind` when it
 * could not infer a target. Pointed at any other repo, every lane was blocked
 * and the run still exited 0 looking clean.
 *
 * Two profiles:
 *
 *   benchmark  The lab. Target defaults to target-apps/juice-shop-blind,
 *              artifacts go to tools/scanner/runs/<provider>/<stage>/, the
 *              seed denylist applies, Stage 2 resumes from its checkpoint as
 *              it always has. Every lab guarantee is unchanged.
 *
 *   product    A user's repo. Target is wherever SCANNER_TARGET points, reads
 *              are confined to it, artifacts go to
 *              <target>/.secscan/runs/<run-id>/<provider>/<stage>/, and Stage 2
 *              resumes only when SCANNER_RESUME=1 says so explicitly.
 *
 * Each stage is its own process (run.sh launches them one by one), so the
 * context is resolved from the environment rather than passed in memory.
 * run.sh exports the variables; a stage launched by hand resolves the same way.
 *
 *   SCANNER_TARGET     target root. Relative paths resolve against the process
 *                      cwd, so run.sh always exports an absolute path.
 *   SCANNER_PROFILE    benchmark | product. Optional — inferred below.
 *   SCANNER_RUNS_ROOT  override for the artifact root. Optional.
 *   SCANNER_RUN_ID     product only: names the run directory.
 *   SCANNER_RESUME     product only: '1' allows Stage 2 to resume.
 *
 * Profile inference: no target, or a target inside <repo>/target-apps/, is the
 * benchmark; any other target is a product run. SCANNER_PROFILE overrides.
 *
 * Zero dependencies (node builtins only) so it can be imported across stage
 * package boundaries without its own node_modules.
 */
import { existsSync, realpathSync, statSync } from 'fs'
import { join, dirname, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Repo root, from tools/scanner/shared/ */
export const REPO_ROOT = join(__dirname, '../../..')

export const PROFILES = ['benchmark', 'product'] as const
export type Profile = (typeof PROFILES)[number]

/** The benchmark target when none is given. */
export const BENCHMARK_TARGET = join(REPO_ROOT, 'target-apps/juice-shop-blind')

/** Where benchmark artifacts live — the lab's historical run tree. */
export const BENCHMARK_RUNS_ROOT = join(REPO_ROOT, 'tools/scanner/runs')

/** Directory created inside a user's repo to hold product run artifacts. */
export const PRODUCT_DIRNAME = '.secscan'

/** A run id becomes a path segment, so it is restricted to safe characters. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface RunContext {
  profile: Profile
  /** Absolute target root, symlinks resolved. */
  targetRoot: string
  /** Absolute artifact root. Stage artifacts live at <runsRoot>/<provider>/<stage>/. */
  runsRoot: string
  /** Product run id; null in the benchmark profile. */
  runId: string | null
  /** Product only: Stage 2 may resume from an existing checkpoint. */
  resume: boolean
}

type Env = Record<string, string | undefined>

function targetFromArgv(argv: readonly string[]): string | undefined {
  // Stage 0 historically accepted --target <path> / --target=<path>.
  const i = argv.indexOf('--target')
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--target='))
  return eq ? eq.slice('--target='.length) : undefined
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep)
}

/**
 * Resolve a run context from an environment. Pure apart from filesystem
 * checks on the target, so tests can build any context they need.
 * Throws with a readable message on an invalid configuration.
 */
export function resolveRunContext(
  env: Env = process.env,
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
): RunContext {
  const rawTarget = targetFromArgv(argv) ?? (env.SCANNER_TARGET || undefined)
  const targetPath = rawTarget ? resolve(cwd, rawTarget) : BENCHMARK_TARGET

  if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
    throw new Error(`[run-context] target is not a directory: ${targetPath}`)
  }
  const targetRoot = realpathSync(targetPath)

  let profile: Profile
  if (env.SCANNER_PROFILE) {
    if (!(PROFILES as readonly string[]).includes(env.SCANNER_PROFILE)) {
      throw new Error(
        `[run-context] SCANNER_PROFILE must be one of ${PROFILES.join(' | ')}, got '${env.SCANNER_PROFILE}'`,
      )
    }
    profile = env.SCANNER_PROFILE as Profile
  } else {
    const targetApps = realpathSync(join(REPO_ROOT, 'target-apps'))
    profile = !rawTarget || isWithin(targetRoot, targetApps) ? 'benchmark' : 'product'
  }

  let runId: string | null = null
  let runsRoot: string
  if (profile === 'product') {
    runId = env.SCANNER_RUN_ID || null
    if (runId !== null && !RUN_ID_RE.test(runId)) {
      throw new Error(`[run-context] SCANNER_RUN_ID has unsafe characters: '${runId}'`)
    }
    if (env.SCANNER_RUNS_ROOT) {
      runsRoot = resolve(cwd, env.SCANNER_RUNS_ROOT)
    } else if (runId) {
      runsRoot = join(targetRoot, PRODUCT_DIRNAME, 'runs', runId)
    } else {
      throw new Error(
        '[run-context] a product run needs SCANNER_RUN_ID (run.sh generates one) or SCANNER_RUNS_ROOT',
      )
    }
  } else {
    runsRoot = env.SCANNER_RUNS_ROOT ? resolve(cwd, env.SCANNER_RUNS_ROOT) : BENCHMARK_RUNS_ROOT
  }

  return {
    profile,
    targetRoot,
    runsRoot,
    runId,
    resume: profile === 'product' && env.SCANNER_RESUME === '1',
  }
}

let cached: RunContext | null = null

/** The context for this process, resolved once from process.env. */
export function getRunContext(): RunContext {
  if (!cached) cached = resolveRunContext()
  return cached
}

export function isBenchmark(ctx: RunContext = getRunContext()): boolean {
  return ctx.profile === 'benchmark'
}

/** Plain-object form for meta.json. */
export function describeRunContext(ctx: RunContext = getRunContext()): Record<string, unknown> {
  return {
    profile: ctx.profile,
    target_root: ctx.targetRoot,
    runs_root: ctx.runsRoot,
    run_id: ctx.runId,
    resume: ctx.resume,
  }
}
