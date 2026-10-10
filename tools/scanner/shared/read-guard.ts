/**
 * Corpus read guard.
 *
 * Two call sites in the scanner read a file path that a MODEL produced:
 *   - stage2 readSeedFiles()        (lane manifest seed_files)
 *   - stage2 scope expansion        (LLM scope_requests, orchestrator-approved)
 *
 * Both must go through readCorpusFile(). It is an ALLOWLIST confined to
 * the target-app corpus, so it fails closed: anything not explicitly permitted
 * is denied without needing a new denylist entry. This is what keeps prior-run
 * artifacts under tools/scanner/runs/, scored results under results/, and the
 * repo's own source out of model context.
 *
 * ── What "the corpus" is depends on the run profile (run-context.ts) ────────
 *
 *   benchmark  The two Juice Shop trees under target-apps/, with the seed
 *              denylist below layered on top. Identical to the guard as it was
 *              before run profiles existed: same roots, same list, same
 *              raw-string denylist match. The lab's blind-development guarantee
 *              must not move because a product mode was added beside it.
 *
 *   product    The user's target root and nothing else. No seed denylist — it
 *              names Juice Shop bookkeeping files a user's repo does not have.
 *              Instead, directories INSIDE the target that are not the user's
 *              source are carved back out:
 *                <target>/.secscan/  this scanner's own prior run artifacts.
 *                                    The benchmark keeps those outside the
 *                                    corpus by construction (tools/scanner/runs/
 *                                    is not under target-apps/); in product they
 *                                    sit inside the target, so without this a
 *                                    lane could read the last run's findings and
 *                                    "rediscover" them.
 *                <target>/.git/      history and config, possibly credentials in
 *                                    remote URLs. Not source, never needed.
 *                ctx.runsRoot        the same reasoning as .secscan/, for a run
 *                                    whose SCANNER_RUNS_ROOT moved the artifact
 *                                    tree somewhere else inside the target.
 *
 * The module-level readCorpusFile()/isCorpusReadable() are the guard for this
 * process's context (getRunContext()). makeReadGuard() builds one for an
 * explicit context, which is how the tests exercise a product run without
 * mutating process.env.
 *
 * Pipeline-internal reads of upstream stage artifacts do NOT come through here
 * — they use readUpstreamArtifact() in meta.ts, which is only ever given
 * hardcoded filenames.
 *
 * Zero dependencies (node builtins only).
 */
import { readFileSync, existsSync, realpathSync, statSync } from 'fs'
import { resolve, join, sep } from 'path'
import { REPO_ROOT, PRODUCT_DIRNAME, getRunContext, type RunContext } from './run-context.js'

/** Benchmark profile: the only directories a model-supplied path may resolve into. */
const BENCHMARK_CORPUS_ROOTS = [
  'target-apps/juice-shop',
  'target-apps/juice-shop-blind',
] as const

/**
 * Second layer, retained from stage05-lane-selector: internal bookkeeping
 * files inside the corpus that reference real challenge names for legitimate
 * structural reasons and must never reach a hunting lane.
 *
 * Benchmark profile only; activeDenylist() is the profile-aware accessor.
 * Kept as a literal array of repo-relative strings: tools/patcher parses it out
 * of this file by regex rather than copying it, so it must stay a plain list.
 */
export const SEED_DENYLIST: readonly string[] = [
  'target-apps/juice-shop-blind/models/challenge.ts',
  'target-apps/juice-shop-blind/lib/antiCheat.ts',
  'target-apps/juice-shop-blind/data/datacreator.ts',
  'target-apps/juice-shop/models/challenge.ts',
  'target-apps/juice-shop/lib/antiCheat.ts',
  'target-apps/juice-shop/data/datacreator.ts',
]

const NO_DENYLIST: readonly string[] = Object.freeze([])

function within(absPath: string, dir: string): boolean {
  return absPath === dir || absPath.startsWith(dir + sep)
}

/**
 * The seed denylist in force for a context: the list above in the benchmark,
 * empty in product. Stage 0.5 imports this rather than SEED_DENYLIST so that a
 * product run does not carry Juice Shop paths around as if they meant anything.
 */
export function activeDenylist(ctx: RunContext = getRunContext()): readonly string[] {
  return ctx.profile === 'benchmark' ? SEED_DENYLIST : NO_DENYLIST
}

/** Absolute directories a model-supplied path may resolve into, for a context. */
export function corpusRoots(ctx: RunContext = getRunContext()): string[] {
  return ctx.profile === 'benchmark'
    ? BENCHMARK_CORPUS_ROOTS.map((r) => resolve(REPO_ROOT, r))
    : [ctx.targetRoot]
}

/**
 * Directories inside the corpus that are nevertheless denied. Empty in the
 * benchmark, where the corpus roots already exclude every artifact tree.
 *
 * ctx.runsRoot is added only when it lies inside the target. A runs root that
 * is an ANCESTOR of the target (SCANNER_RUNS_ROOT=/work for a target /work/app)
 * keeps its artifacts beside the target, not in it, and excluding it would
 * deny every read — the silent all-lanes-blocked run that run-context.ts was
 * introduced to end, reached from the other side.
 */
function excludedDirs(ctx: RunContext): string[] {
  if (ctx.profile === 'benchmark') return []
  const dirs = [join(ctx.targetRoot, PRODUCT_DIRNAME), join(ctx.targetRoot, '.git')]
  if (within(ctx.runsRoot.toLowerCase(), ctx.targetRoot.toLowerCase())) dirs.push(ctx.runsRoot)
  return dirs
}

/** Count of blocked attempts this process, surfaced into meta.json. */
let blockedCount = 0
const blockedPaths: string[] = []

export function guardStats(): { blocked: number; paths: string[] } {
  return { blocked: blockedCount, paths: [...blockedPaths] }
}

function deny(relPath: string, reason: string): null {
  blockedCount++
  if (blockedPaths.length < 50) blockedPaths.push(relPath)
  // stderr, not stdout — stdout may carry structured output in some contexts
  console.error(`  [GUARD] BLOCKED ${reason}: ${relPath}`)
  return null
}

export interface ReadGuard {
  /**
   * Read a file whose path came from a model. Returns null (never throws) if
   * the path is outside the corpus, excluded, denylisted, missing, or not a
   * readable regular file — a blocked read should degrade the run, not crash it.
   */
  readCorpusFile(relPath: string): string | null
  /** True if a path would be readable. Does not read or count as an attempt. */
  isCorpusReadable(relPath: string): boolean
}

/** Build a read guard bound to one run context. */
export function makeReadGuard(ctx: RunContext): ReadGuard {
  const roots = corpusRoots(ctx)
  const denylist = activeDenylist(ctx)
  // Lower-cased because the exclusion is a deny rule: on a case-insensitive
  // filesystem (macOS default) `<target>/.GIT/config` IS `.git/config`, and a
  // case-sensitive comparison would let it through. Over-matching here only
  // ever denies more.
  const excluded = excludedDirs(ctx).map((d) => d.toLowerCase())

  const inRoots = (abs: string) => roots.some((r) => within(abs, r))
  const inExcluded = (abs: string) => {
    const lower = abs.toLowerCase()
    return excluded.some((d) => within(lower, d))
  }

  /**
   * The whole decision, shared by both entry points so they cannot disagree.
   * Returns the resolved path to read, or the reason it is denied.
   */
  function decide(relPath: string): { abs: string } | { reason: string } {
    // resolve() normalises '..' segments before any prefix check. Relative
    // arguments are repo-relative (Stage 2 passes relative(REPO_ROOT, ...)), so
    // a product target outside the repo arrives as '../..'-style or absolute;
    // both resolve to the same absolute path here.
    let abs = resolve(REPO_ROOT, relPath)
    if (!inRoots(abs)) return { reason: 'out-of-corpus path' }
    if (inExcluded(abs)) return { reason: 'excluded path (run artifacts / .git)' }

    if (!existsSync(abs)) return { reason: 'file not found' }

    // Re-check after resolving symlinks: a symlink inside the corpus could
    // otherwise point anywhere on disk — including back into an excluded dir.
    try {
      abs = realpathSync(abs)
    } catch {
      return { reason: 'unresolvable path' }
    }
    if (!inRoots(abs)) return { reason: 'symlink escapes corpus' }
    if (inExcluded(abs)) return { reason: 'symlink into excluded path' }

    if (denylist.includes(relPath)) return { reason: 'denylisted file' }

    // A directory or FIFO inside the corpus would otherwise make readFileSync
    // throw (EISDIR) or block forever; a model can name either.
    try {
      if (!statSync(abs).isFile()) return { reason: 'not a regular file' }
    } catch {
      return { reason: 'unresolvable path' }
    }
    return { abs }
  }

  return {
    readCorpusFile(relPath: string): string | null {
      const d = decide(relPath)
      if ('reason' in d) return deny(relPath, d.reason)
      try {
        return readFileSync(d.abs, 'utf-8')
      } catch {
        // e.g. EACCES on a file in a user's repo. Still a blocked read, not a crash.
        return deny(relPath, 'unreadable file')
      }
    },
    isCorpusReadable(relPath: string): boolean {
      return 'abs' in decide(relPath)
    },
  }
}

/**
 * The guard for this process's context, built on first use. Lazy so that
 * importing this module never resolves the context by itself; in a stage the
 * context has already been resolved (and a misconfiguration already thrown) by
 * run-paths.ts at import time, so this cannot be the first place it fails.
 */
let processGuard: ReadGuard | null = null
function guardForProcess(): ReadGuard {
  if (!processGuard) processGuard = makeReadGuard(getRunContext())
  return processGuard
}

/**
 * Read a file whose path came from a model. Returns null (never throws) if the
 * path is outside the corpus, denylisted, or missing — a blocked read should
 * degrade the run, not crash it.
 */
export function readCorpusFile(relPath: string): string | null {
  return guardForProcess().readCorpusFile(relPath)
}

/** True if a path would be readable. Does not read or count as an attempt. */
export function isCorpusReadable(relPath: string): boolean {
  return guardForProcess().isCorpusReadable(relPath)
}
