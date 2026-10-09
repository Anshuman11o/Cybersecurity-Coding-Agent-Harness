/**
 * Provider-scoped run paths.
 *
 * Every artifact a scanner stage writes, and every upstream artifact it reads,
 * resolves through here. Provider identity is baked into the path, so a run
 * under one provider is structurally incapable of writing into another's tree.
 *
 * The root those paths hang off is decided by the run context (run-context.ts),
 * not here:
 *
 *   benchmark  <repo>/tools/scanner/runs/<provider>/<stage>/
 *              The lab's historical tree, exactly the path it was before
 *              run profiles existed — committed artifacts stay where they are.
 *
 *   product    <target>/.secscan/runs/<run-id>/<provider>/<stage>/
 *              Inside the user's repo, one directory per run, so a second scan
 *              never overwrites the first and nothing lands in this repo.
 *
 * SCANNER_RUNS_ROOT overrides either. RUNS_ROOT is resolved once, at import:
 * each stage is its own process, and a misconfigured context should stop the
 * stage before it writes anything rather than at its first artifact.
 *
 * Zero dependencies (node builtins only) so this file can be imported across
 * stage package boundaries without needing its own node_modules.
 */
import { join } from 'path'
import { assertProvider, type Provider } from './models.js'
import { REPO_ROOT as CONTEXT_REPO_ROOT, getRunContext } from './run-context.js'

/**
 * Repo root, from tools/scanner/shared/. Re-exported from run-context.ts so
 * there is exactly one definition; stages have always imported it from here.
 */
export const REPO_ROOT: string = CONTEXT_REPO_ROOT

/** Where all provider-scoped run artifacts live, for this process's run context. */
export const RUNS_ROOT: string = getRunContext().runsRoot

export type { Provider }

/**
 * Every stage that owns run artifacts.
 *
 * v1 and v2 are separate stage keys, not separate directories under one key:
 * both tracks are load-bearing and may be run under the same provider, so their
 * artifacts must not overwrite each other.
 */
export const STAGES = [
  // v1 — category-themed lanes
  'stage0-recon',
  'stage05-lane-selector',
  'stage1-budget-governor',
  'stage2-hunt-lanes',
  // v2 — one lane per file. Shares stage0-recon with v1.
  'stage05-lane-selector-perfile',
  'stage1-budget-governor-perfile',
  'stage2-hunt-lanes-perfile',
] as const

export type Stage = (typeof STAGES)[number]

/**
 * Directory holding one stage's artifacts for one provider.
 *   runPath('luna', 'stage2-hunt-lanes-perfile')
 *     -> <repo>/tools/scanner/runs/luna/stage2-hunt-lanes-perfile           (benchmark)
 *     -> <target>/.secscan/runs/<run-id>/luna/stage2-hunt-lanes-perfile     (product)
 *
 * The provider key is validated here rather than trusted. Path centralisation
 * only prevents a mix-up if an unknown key is a crash instead of a new,
 * plausible-looking directory nobody notices.
 */
export function runPath(provider: Provider, stage: Stage): string {
  return join(RUNS_ROOT, assertProvider(provider), stage)
}

/** Full path to a single artifact file inside a stage's run directory. */
export function runFile(provider: Provider, stage: Stage, file: string): string {
  return join(runPath(provider, stage), file)
}

/** Log directory for a stage run. Gitignored — see .gitignore. */
export function logPath(provider: Provider, stage: Stage): string {
  return join(runPath(provider, stage), 'logs')
}
