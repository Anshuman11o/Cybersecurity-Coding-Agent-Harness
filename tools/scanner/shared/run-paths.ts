/**
 * Provider-scoped run paths.
 *
 * Every artifact a scanner stage writes, and every upstream artifact it reads,
 * resolves through here. Provider identity is baked into the path, so a run
 * under one provider is structurally incapable of writing into another's tree.
 *
 * Zero dependencies (node builtins only) so this file can be imported across
 * stage package boundaries without needing its own node_modules.
 */
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Repo root, from tools/scanner/shared/ */
export const REPO_ROOT = join(__dirname, '../../..')

/** Where all provider-scoped run artifacts live. */
export const RUNS_ROOT = join(REPO_ROOT, 'tools/scanner/runs')

export type Provider = 'qwen' | 'openai'

export const STAGES = [
  'stage0-recon',
  'stage05-lane-selector',
  'stage1-budget-governor',
  'stage2-hunt-lanes',
  'stage3-validate',
] as const

export type Stage = (typeof STAGES)[number]

/**
 * Directory holding one stage's artifacts for one provider.
 *   runPath('qwen', 'stage3-validate')
 *     -> <repo>/tools/scanner/runs/qwen/stage3-validate
 */
export function runPath(provider: Provider, stage: Stage): string {
  return join(RUNS_ROOT, provider, stage)
}

/** Full path to a single artifact file inside a stage's run directory. */
export function runFile(provider: Provider, stage: Stage, file: string): string {
  return join(runPath(provider, stage), file)
}

/** Log directory for a stage run. Gitignored — see .gitignore. */
export function logPath(provider: Provider, stage: Stage): string {
  return join(runPath(provider, stage), 'logs')
}
