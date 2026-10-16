/**
 * The read guard under Windows path rules, run on any OS by passing the
 * platform to makeReadGuard().
 *
 * On Windows the target root and a repo-relative path resolved back against
 * REPO_ROOT can spell the same directory in different case (a lower-case drive
 * letter from the shell, the install's casing for the shared prefix). Here
 * that is simulated with a target root whose case differs from the files on
 * disk: on win32 the guard must still allow the target's own files, and must
 * not let the folding allow anything it denied before.
 *
 *   npx tsx --test portability.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { REPO_ROOT, type RunContext } from './run-context.js'
import { makeReadGuard, writeReadAllowlist } from './read-guard.js'

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'secscan-portability-')))
  const app = join(base, 'app')
  mkdirSync(join(app, 'src'), { recursive: true })
  mkdirSync(join(app, '.git'))
  writeFileSync(join(app, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(app, 'src', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(app, '.git', 'config'), '[core]\n')
  writeFileSync(join(base, 'outside.ts'), 'secret\n')
  symlinkSync(join(base, 'outside.ts'), join(app, 'src', 'escape.ts'))
  // The same directory as the user's shell might have spelled it.
  const ctx: RunContext = {
    profile: 'product', targetRoot: join(base, 'APP'), runsRoot: join(base, 'runs'),
    reportsRoot: join(base, 'reports'), runId: 'r1', resume: false,
  }
  // The form every stage hands the guard: relative to REPO_ROOT.
  const rel = (...p: string[]) => relative(REPO_ROOT, join(app, ...p))
  return { base, app, ctx, rel, done: () => rmSync(base, { recursive: true, force: true }) }
}

test('win32: the target\'s files are readable whatever case the root was spelled in', () => {
  const f = fixture()
  try {
    const win = makeReadGuard(f.ctx, 'win32')
    assert.equal(win.isCorpusReadable(f.rel('src', 'a.ts')), true)
    assert.equal(win.readCorpusFile(f.rel('src', 'a.ts')), 'export const a = 1\n')
    // POSIX keeps the exact comparison: a differently-cased root is another directory.
    assert.equal(makeReadGuard(f.ctx, 'linux').isCorpusReadable(f.rel('src', 'a.ts')), false)
  } finally { f.done() }
})

test('win32: folding allows nothing the guard denies', () => {
  const f = fixture()
  try {
    writeReadAllowlist(f.ctx, ['src/a.ts', 'src/escape.ts'])
    const win = makeReadGuard(f.ctx, 'win32')
    assert.equal(win.isCorpusReadable(f.rel('src', 'a.ts')), true, 'allowlisted, case-folded')
    assert.equal(win.isCorpusReadable(f.rel('src', 'b.ts')), false, 'not in the recon allowlist')
    assert.equal(win.isCorpusReadable(f.rel('.git', 'config')), false, '.git stays excluded')
    assert.equal(win.isCorpusReadable(f.rel('src', 'escape.ts')), false, 'a symlink out of the target stays denied')
    assert.equal(win.isCorpusReadable(relative(REPO_ROOT, join(f.base, 'outside.ts'))), false)
  } finally { f.done() }
})
