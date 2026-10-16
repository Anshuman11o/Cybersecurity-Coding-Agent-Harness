/**
 * How this process was started: whether a module is the one Node was asked to
 * run, and which build of the scanner it came from.
 *
 * ── Entry points ──────────────────────────────────────────────────────────
 *
 * Every stage is a script and a library at once: the budget governor imports
 * the hunt executor, the CLI imports the class review, the tests import all of
 * them. Each runs its main() only when it IS the process entry, and the guard
 * used to be `process.argv[1] === fileURLToPath(import.meta.url)`. That exact
 * comparison is wrong in two places the npm package reaches:
 *
 *   - npm's bin symlink. `secscan` on PATH is a symlink into the package, so
 *     argv[1] names the link while import.meta.url names the real file. The
 *     CLI would load, do nothing and exit 0.
 *   - Windows, where the same file can be spelled with a different drive-letter
 *     or path case depending on the shell that started it.
 *
 * isEntryPoint() compares realpaths instead, case-folded on win32 (NTFS is
 * case-insensitive). Under tsx nothing changes: argv[1] is already the real,
 * absolute .ts path, so both sides resolve to the string they were before.
 *
 * ── Build provenance ──────────────────────────────────────────────────────
 *
 * The package build writes <REPO_ROOT>/build-info.json; inside the package
 * REPO_ROOT is dist/, because dist/ keeps the tools/scanner/ layout. A harness
 * checkout has no such file, and readBuildInfo() returns null there, so the
 * lab keeps reading its version and commit from package.json and git.
 *
 * Zero dependencies (node builtins only).
 */
import { readFileSync, realpathSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { REPO_ROOT } from './run-context.js'

/** Realpath when the file exists, else the plain resolved path. */
function canonical(p: string, platform: NodeJS.Platform): string {
  let out: string
  try {
    out = realpathSync(p)
  } catch {
    out = resolve(p)
  }
  return platform === 'win32' ? out.toLowerCase() : out
}

/**
 * True when the module whose import.meta.url is `metaUrl` is the script Node
 * was started with. `argv1` and `platform` are parameters only so the tests can
 * cover a symlinked bin and the Windows case rule from one machine.
 */
export function isEntryPoint(
  metaUrl: string,
  argv1: string | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!argv1) return false
  let self: string
  try {
    self = fileURLToPath(metaUrl)
  } catch {
    return false // not a file: URL, so not something Node can have been started with
  }
  return canonical(self, platform) === canonical(argv1, platform)
}

export const BUILD_INFO_FILE = 'build-info.json'

export interface BuildInfo {
  name: string
  version: string
  harness_commit: string
  built_at: string
}

/**
 * The package's build-info.json, or null when there is none (a harness
 * checkout) or it is unreadable. A malformed file is treated as absent rather
 * than trusted: its only readers fall back to package.json and git.
 */
export function readBuildInfo(root: string = REPO_ROOT): BuildInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(root, BUILD_INFO_FILE), 'utf-8'))
    if (typeof info?.version !== 'string' || typeof info?.harness_commit !== 'string') return null
    return info as BuildInfo
  } catch {
    return null
  }
}
