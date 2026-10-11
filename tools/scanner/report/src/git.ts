/**
 * Repository facts for the report header and for permalinks (plan §4.1.1, §4.4).
 *
 * A permalink is pinned to a commit so it never drifts, but a pinned link is
 * only correct if the file at that commit is the file the report read. So a
 * permalink is emitted only for a file that is unchanged from HEAD in the
 * working copy; a modified or untracked file gets its local path:line alone.
 * The excerpts are read from disk, and a link that disagreed with them would be
 * worse than none.
 */
import { execFileSync } from 'child_process'
import { basename } from 'path'
import type { RepoInfo } from './types.js'

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\n$/, '')
  } catch {
    return null
  }
}

/**
 * owner/repo from a GitHub remote URL, or null for any other host.
 * Accepts https, ssh and scp-style spellings, with or without `.git`.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
    .exec(url.trim())
  return m ? { owner: m[1], repo: m[2] } : null
}

/** Paths in `git status --porcelain -z` output, relative to the work tree top. */
function porcelainPaths(out: string): string[] {
  const paths: string[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    paths.push(entry.slice(3))
    // A rename or copy carries its source path as the next NUL field.
    if (code[0] === 'R' || code[0] === 'C') i++
  }
  return paths
}

export function repoInfo(root: string, env: NodeJS.ProcessEnv = process.env): RepoInfo {
  const top = git(root, ['rev-parse', '--show-toplevel'])
  if (top === null) {
    return {
      root, name: basename(root), branch: null, commit: null, github: null,
      prefix: '', dirty: new Set(), isGit: false, statusKnown: false,
    }
  }
  const prefix = git(root, ['rev-parse', '--show-prefix']) ?? ''
  const commit = git(root, ['rev-parse', 'HEAD'])
  const branchRaw = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : (env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null)

  // In GitHub Actions the checkout's origin is GitHub by construction, but the
  // environment states it outright and survives a checkout without a remote.
  let github: RepoInfo['github'] = null
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')
  if (env.GITHUB_REPOSITORY && /^[^/]+\/[^/]+$/.test(env.GITHUB_REPOSITORY)) {
    const [owner, repo] = env.GITHUB_REPOSITORY.split('/')
    github = { server, owner, repo }
  } else {
    const origin = git(root, ['remote', 'get-url', 'origin'])
    const parsed = origin ? parseGithubRemote(origin) : null
    if (parsed) github = { server: 'https://github.com', ...parsed }
  }

  // Dirty paths relative to the TARGET root, since that is what lanes cite.
  const dirty = new Set<string>()
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'])
  if (status === null) {
    // Unknown working-copy state: no file can be shown to match HEAD, so no
    // permalinks at all.
    return { root, name: github?.repo ?? basename(top), branch, commit, github, prefix, dirty, isGit: true, statusKnown: false }
  }
  for (const p of porcelainPaths(status)) {
    if (p.startsWith(prefix)) dirty.add(p.slice(prefix.length))
  }

  return { root, name: github?.repo ?? basename(top), branch, commit, github, prefix, dirty, isGit: true, statusKnown: true }
}

/**
 * Commit-pinned GitHub permalink for a target-relative path and line, or null
 * when the repo is not on GitHub, the commit is unknown, or the file differs
 * from HEAD.
 */
export function permalink(repo: RepoInfo, path: string, line: number): string | null {
  if (!repo.github || !repo.commit || !/^[0-9a-f]{40}$/.test(repo.commit)) return null
  if (!repo.statusKnown) return null
  if (repo.dirty.has(path)) return null
  const encoded = (repo.prefix + path).split('/').map(encodeURIComponent).join('/')
  return `${repo.github.server}/${repo.github.owner}/${repo.github.repo}/blob/${repo.commit}/${encoded}#L${line}`
}
