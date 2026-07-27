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

export interface RunMeta {
  provider: Provider
  model: string
  stage: Stage
  git_sha: string
  started: string
  ended: string
  exit_code: number
  blocked_reads?: number
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
