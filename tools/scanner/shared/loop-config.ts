/**
 * Per-lane agent loop configuration.
 *
 * This lives in `shared/` rather than in the Stage 2 executor because Stage 1
 * has to project the same thing Stage 2 executes. A loop turn is a whole extra
 * API call per chunk; a budget plan that does not know the loop is on projects
 * roughly half the input and none of the output, and its reconciliation then
 * reports every lane as a large divergence — which reads as "the budget model
 * is broken" rather than "a loop was on".
 *
 * Two stages resolving the same env vars independently is exactly the shape of
 * defect this repo has been bitten by before: the seed denylist was correct in
 * `shared/` and a v2 component forked before it moved there and silently never
 * picked it up. One resolver, imported by both.
 *
 * Zero dependencies (node builtins only) so it can cross stage package
 * boundaries without its own node_modules.
 */

export type LoopMode = 'none' | 'trace' | 'gap' | 'reflect' | 'sweep'

export const LOOP_MODES: LoopMode[] = ['none', 'trace', 'gap', 'reflect', 'sweep']

/**
 * The shipped arm.
 *
 * `trace` paired with the registry's `reasoning_effort: high` measured 67.0%
 * recall and 85.6% localization on the 40-lane benchmark-bearing platform —
 * the best of either recorded. `none` is what runs 1-5 executed and is
 * preserved exactly; see docs/architecture/stage2-lane-loop.md.
 */
export const DEFAULT_LOOP_MODE: LoopMode = 'trace'

/** Follow-up turns per chunk when a conversational mode is selected. */
export const DEFAULT_LOOP_PASSES = 1

/** Classes per group in `sweep` mode. */
export const DEFAULT_SWEEP_GROUP_SIZE = 3

/**
 * A positive integer from the environment, or the fallback when unset.
 *
 * Deliberately stricter than parseInt: `parseInt("1e5")` is 1, which as an
 * output-token cap silently truncates every response and reads downstream as
 * "the model found nothing" rather than as a misconfiguration. An empty string
 * is a typo, not a request for the default, and is rejected too.
 */
export function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`${name}="${raw}" is not a positive integer`)
  }
  return Number(trimmed)
}

export interface LoopConfig {
  mode: LoopMode
  /** Follow-up turns permitted per chunk. 0 when the mode is `none`. */
  passes: number
  sweepGroupSize: number
  /** The stricter trace-completion wording. Measured worse; off by default. */
  strictTrace: boolean
}

/** Resolve the loop arm from the environment. Identical in every stage. */
export function resolveLoopConfig(): LoopConfig {
  const raw = process.env.HUNT_LOOP
  let mode: LoopMode
  if (raw === undefined || raw === '') {
    mode = DEFAULT_LOOP_MODE
  } else if ((LOOP_MODES as string[]).includes(raw)) {
    mode = raw as LoopMode
  } else {
    throw new Error(`HUNT_LOOP="${raw}" is not one of: ${LOOP_MODES.join(', ')}`)
  }

  return {
    mode,
    passes: mode === 'none' ? 0 : positiveEnvInt('HUNT_LOOP_PASSES', DEFAULT_LOOP_PASSES),
    sweepGroupSize: positiveEnvInt('HUNT_SWEEP_GROUP', DEFAULT_SWEEP_GROUP_SIZE),
    strictTrace: process.env.HUNT_LOOP_STRICT_TRACE === '1',
  }
}

/**
 * How many model calls one chunk costs under a loop arm.
 *
 * `sweep` is the exception: it does not follow up on a conversation, it re-hunts
 * the chunk once per class group, so its call count depends on the lane's class
 * list rather than on `passes`.
 */
export function callsPerChunk(cfg: LoopConfig, assignedClassCount: number): number {
  if (cfg.mode === 'none') return 1
  if (cfg.mode === 'sweep') {
    return 1 + Math.ceil(assignedClassCount / cfg.sweepGroupSize)
  }
  return 1 + cfg.passes
}
