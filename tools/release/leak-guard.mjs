#!/usr/bin/env node
/**
 * Leak guard for everything that leaves this harness (Task 1e): the exported
 * product repository and the npm tarball. The design is
 * docs/architecture/npm-packaging-plan.md, "Export and leak guard".
 *
 * The harness exists to measure a scanner blind, so the code that ships must
 * carry none of what makes the measurement possible: answer-key and private
 * store markers, lab paths, tests and fixtures, lab-only models, credentials.
 *
 *   path rules     on every file's path, relative to the tree or the tarball's
 *                  package/ root
 *   content rules  on every file's bytes
 *
 * If it fires, change what is shipped; never loosen a rule to make it pass
 * (the same rule as tools/patcher/src/archive_run.py). Zero dependencies.
 *
 *   node leak-guard.mjs <dir | file.tgz> [...]     exits 1 on any violation
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

// ── Path rules ─────────────────────────────────────────────────────────────

/** Path segments that only exist in the lab. Matched against whole segments. */
export const LAB_SEGMENTS = [
  'target-apps', 'results', 'runs', 'prompts', 'docs',
  'eval', 'scan-benchmark', 'blind-development', 'patcher',
  // The v1 stages; their v2 successors (-perfile) are what ships.
  'stage05-lane-selector', 'stage2-hunt-lanes',
]

/** Reasons a path may not ship. `tarball`: node_modules is refused too. */
export function checkPath(rel, { tarball = false } = {}) {
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  const name = parts[parts.length - 1] ?? ''
  const reasons = []
  for (const seg of parts) {
    if (LAB_SEGMENTS.includes(seg)) reasons.push(`lab path segment "${seg}"`)
    if (/answer[-_]?key|ground[-_]?truth|harness-private/i.test(seg)) reasons.push(`answer-key or private-store name "${seg}"`)
    if (seg === 'fixtures') reasons.push('fixtures directory')
    if (tarball && seg === 'node_modules') reasons.push('node_modules in the tarball')
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(name)) reasons.push('test file')
  else if (/^test-[\w.-]+\.[cm]?[jt]s$/i.test(name)) reasons.push('test helper')
  if (/^fixtures\.[cm]?[jt]s$/i.test(name)) reasons.push('test fixture module')
  if (/^\.env(\..*)?$/i.test(name)) reasons.push('.env file')
  if (name === '.npmrc') reasons.push('.npmrc (may hold a registry token)')
  return reasons
}

// ── Content rules ──────────────────────────────────────────────────────────

/**
 * Each rule: a name and a global regex. A hit's text is never echoed whole:
 * a key-shaped literal is reported by its first characters only.
 *
 * answer-key-repo: the answer key as a repository or directory name
 * (`juice-shop-answer-key`, `answer-key/`). Prose that mentions "the answer
 * key" (space) is not a location and does not match; the shipped stages
 * explain the blind boundary in those words.
 */
export const CONTENT_RULES = [
  { rule: 'ground-truth-marker', re: /benchmark_ground_truth/gi },
  { rule: 'private-store', re: /harness-private/gi },
  { rule: 'answer-key-repo', re: /-answer-key\b|\banswer-key[\\/]/gi },
  { rule: 'lab-only-model', re: /["']?\blab_only["']?\s*:\s*true\b/g },
  {
    rule: 'private-key-block',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/]{16,}={0,2}\r?\n)+/g,
    secret: true,
  },
  { rule: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g, secret: true },
  { rule: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, secret: true },
  { rule: 'github-token', re: /\bghp_[A-Za-z0-9]{36}\b/g, secret: true },
  { rule: 'slack-token', re: /\bxox[baprs]-/g, secret: true },
]

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** Content violations in one file's text, as { rule, detail }. */
export function checkContent(rel, text) {
  const hits = []
  for (const { rule, re, secret } of CONTENT_RULES) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const shown = secret ? `${m[0].slice(0, 6)}… (${m[0].length} chars)` : JSON.stringify(m[0])
      hits.push({ rule, detail: `line ${lineOf(text, m.index)}: ${shown}` })
    }
  }
  // A registry that still carries a lab-only target, however it is spelled.
  if (basename(rel) === 'models.json') {
    try {
      const reg = JSON.parse(text)
      for (const [k, t] of Object.entries(reg?.targets ?? {})) {
        if (t?.lab_only) hits.push({ rule: 'lab-only-model', detail: `target "${k}" is lab_only` })
        else if ((t?.transport ?? 'openai') !== 'openai') hits.push({ rule: 'lab-only-model', detail: `target "${k}" uses lab transport "${t.transport}"` })
      }
    } catch (e) {
      hits.push({ rule: 'lab-only-model', detail: `models.json does not parse (${e.message}), so it cannot be checked` })
    }
  }
  return hits
}

/** Path and content violations for one file. */
export function checkFile(rel, bytes, opts = {}) {
  const out = []
  for (const reason of checkPath(rel, opts)) out.push({ file: rel, kind: 'path', rule: reason, detail: '' })
  // latin1 keeps every byte, so a marker inside a binary is still found.
  for (const h of checkContent(rel, Buffer.from(bytes).toString('latin1'))) out.push({ file: rel, kind: 'content', ...h })
  return out
}

// ── Trees ──────────────────────────────────────────────────────────────────

/**
 * Every file under `dir`, skipping .git (history, not content) and
 * node_modules (installed dependencies, never part of the export).
 */
export function listTree(dir) {
  const out = []
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const abs = join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else out.push(relative(dir, abs).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

export function scanTree(dir) {
  const files = listTree(dir)
  const violations = files.flatMap(rel => checkFile(rel, readFileSync(join(dir, rel))))
  return Object.assign(violations, { scanned: files.length })
}

// ── Tarballs ───────────────────────────────────────────────────────────────

/**
 * Entries of a .tgz as { path, type, data }. Minimal ustar reader: regular
 * files, directories, pax extended headers ('x', for long paths) and GNU long
 * names ('L'), which covers what `npm pack` and common tar tools write.
 */
export function readTarball(tgz) {
  const buf = gunzipSync(readFileSync(tgz))
  const entries = []
  const str = (b, s, n) => b.subarray(s, s + n).toString('utf8').replace(/\0[\s\S]*$/, '')
  let off = 0
  let longName = null
  let pax = {}
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every(b => b === 0)) break
    const size = parseInt(str(h, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(h[156] || 48)
    const magic = str(h, 257, 6)
    const prefix = magic.startsWith('ustar') ? str(h, 345, 155) : ''
    let path = (prefix ? `${prefix}/` : '') + str(h, 0, 100)
    const data = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      pax = {}
      for (const rec of data.toString('utf8').split('\n')) {
        const m = /^\d+ ([^=]+)=(.*)$/.exec(rec)
        if (m) pax[m[1]] = m[2]
      }
      continue
    }
    if (type === 'g') continue
    if (type === 'L') { longName = data.toString('utf8').replace(/\0[\s\S]*$/, ''); continue }
    if (longName) { path = longName; longName = null }
    if (pax.path) path = pax.path
    pax = {}
    entries.push({ path, type: type === '5' ? 'dir' : type === '0' || type === '\0' || type === '7' ? 'file' : `type-${type}`, data })
  }
  return entries
}

export function scanTarball(tgz) {
  const entries = readTarball(tgz).filter(e => e.type !== 'dir')
  const violations = []
  for (const e of entries) {
    // npm packs everything under package/; the rules apply below it.
    const rel = e.path.replace(/^package\//, '')
    if (e.type !== 'file') violations.push({ file: rel, kind: 'path', rule: `unexpected tar entry ${e.type} (links are not shipped)`, detail: '' })
    violations.push(...checkFile(rel, e.data, { tarball: true }))
  }
  return Object.assign(violations, { scanned: entries.length })
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function scan(target) {
  return statSync(target).isDirectory() ? scanTree(target) : scanTarball(target)
}

export function formatViolation(v) {
  return `${v.kind === 'path' ? 'PATH   ' : 'CONTENT'}  ${v.file}  ${v.rule}${v.detail ? `  ${v.detail}` : ''}`
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const targets = process.argv.slice(2)
  if (targets.length === 0) {
    console.error('usage: node leak-guard.mjs <dir | file.tgz> [...]')
    process.exit(2)
  }
  let total = 0
  for (const t of targets) {
    let v
    try { v = scan(t) } catch (e) {
      console.error(`leak-guard: cannot scan ${t}: ${e?.message ?? e}`)
      process.exit(2)
    }
    total += v.length
    console.log(`leak-guard: ${t}: ${v.scanned} files, ${v.length} violation(s)`)
    for (const x of v) console.log(`  ${formatViolation(x)}`)
  }
  process.exit(total ? 1 : 0)
}
