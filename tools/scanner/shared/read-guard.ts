/**
 * Corpus read guard.
 *
 * Three call sites in the scanner read a file path that a MODEL produced:
 *   - stage2 readSeedFiles()        (lane manifest seed_files)
 *   - stage2 scope expansion        (LLM scope_requests, orchestrator-approved)
 *   - stage3 readCitedFiles()       (trace steps emitted by the stage2 model)
 *
 * All three must go through readCorpusFile(). It is an ALLOWLIST confined to
 * the target-app corpus, so it fails closed: anything not explicitly permitted
 * is denied without needing a new denylist entry. This is what keeps prior-run
 * artifacts under tools/scanner/runs/, scored results under results/, and the
 * repo's own source out of model context.
 *
 * Pipeline-internal reads of upstream stage artifacts do NOT come through here
 * — they use readUpstreamArtifact() in meta.ts, which is only ever given
 * hardcoded filenames.
 *
 * Zero dependencies (node builtins only).
 */
import { readFileSync, existsSync, realpathSync } from 'fs'
import { resolve, sep } from 'path'
import { REPO_ROOT } from './run-paths.js'

/** The only directories a model-supplied path may resolve into. */
const CORPUS_ROOTS = [
  'target-apps/juice-shop',
  'target-apps/juice-shop-blind',
] as const

/**
 * Second layer, retained from stage05-lane-selector: internal bookkeeping
 * files inside the corpus that reference real challenge names for legitimate
 * structural reasons and must never reach a hunting lane.
 */
export const SEED_DENYLIST: readonly string[] = [
  'target-apps/juice-shop-blind/models/challenge.ts',
  'target-apps/juice-shop-blind/lib/antiCheat.ts',
  'target-apps/juice-shop-blind/data/datacreator.ts',
  'target-apps/juice-shop/models/challenge.ts',
  'target-apps/juice-shop/lib/antiCheat.ts',
  'target-apps/juice-shop/data/datacreator.ts',
]

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

function withinCorpus(absPath: string): boolean {
  return CORPUS_ROOTS.some((r) => {
    const root = resolve(REPO_ROOT, r)
    return absPath === root || absPath.startsWith(root + sep)
  })
}

/**
 * Read a file whose path came from a model. Returns null (never throws) if the
 * path is outside the corpus, denylisted, or missing — a blocked read should
 * degrade the run, not crash it.
 */
export function readCorpusFile(relPath: string): string | null {
  // resolve() normalises '..' segments before any prefix check.
  let abs = resolve(REPO_ROOT, relPath)
  if (!withinCorpus(abs)) return deny(relPath, 'out-of-corpus path')

  if (!existsSync(abs)) return deny(relPath, 'file not found')

  // Re-check after resolving symlinks: a symlink inside the corpus could
  // otherwise point anywhere on disk.
  try {
    abs = realpathSync(abs)
  } catch {
    return deny(relPath, 'unresolvable path')
  }
  if (!withinCorpus(abs)) return deny(relPath, 'symlink escapes corpus')

  if (SEED_DENYLIST.includes(relPath)) return deny(relPath, 'denylisted file')

  return readFileSync(abs, 'utf-8')
}

/** True if a path would be readable. Does not read or count as an attempt. */
export function isCorpusReadable(relPath: string): boolean {
  const abs = resolve(REPO_ROOT, relPath)
  return withinCorpus(abs) && existsSync(abs) && !SEED_DENYLIST.includes(relPath)
}
