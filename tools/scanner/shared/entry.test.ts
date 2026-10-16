/**
 * isEntryPoint() and readBuildInfo() (entry.ts). The symlink case is the npm
 * bin link; the win32 case is run here on any OS by passing the platform, which
 * is the only thing that decides whether the comparison is case-folded.
 *
 *   npx tsx --test entry.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { isEntryPoint, readBuildInfo, BUILD_INFO_FILE } from './entry.js'

function fixture(): { dir: string; file: string; url: string; done: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'secscan-entry-')))
  mkdirSync(join(dir, 'pkg', 'src'), { recursive: true })
  const file = join(dir, 'pkg', 'src', 'Main.js')
  writeFileSync(file, '')
  return { dir, file, url: pathToFileURL(file).href, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the file Node was started with is the entry point; any other file is not', () => {
  const f = fixture()
  try {
    assert.equal(isEntryPoint(f.url, f.file, 'linux'), true)
    const other = join(f.dir, 'pkg', 'src', 'other.js')
    writeFileSync(other, '')
    assert.equal(isEntryPoint(f.url, other, 'linux'), false)
    assert.equal(isEntryPoint(f.url, undefined, 'linux'), false)
    assert.equal(isEntryPoint(f.url, '', 'linux'), false)
  } finally { f.done() }
})

test('a symlink to the module (npm\'s bin link) is the entry point', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.dir, 'bin'))
    const link = join(f.dir, 'bin', 'secscan')
    symlinkSync(f.file, link)
    assert.equal(isEntryPoint(f.url, link, 'linux'), true)
    // A link to the directory above it, as a global prefix can produce.
    const dirLink = join(f.dir, 'linked-pkg')
    symlinkSync(join(f.dir, 'pkg'), dirLink)
    assert.equal(isEntryPoint(f.url, join(dirLink, 'src', 'Main.js'), 'linux'), true)
  } finally { f.done() }
})

test('a relative argv[1] resolves against the working directory', () => {
  const f = fixture()
  try {
    assert.equal(isEntryPoint(f.url, relative(process.cwd(), f.file), 'linux'), true)
  } finally { f.done() }
})

test('win32 compares case-insensitively; other platforms do not', () => {
  const f = fixture()
  try {
    // The differently-cased spelling does not exist on a case-sensitive disk,
    // so this also covers the fallback from realpath to a plain resolve.
    const shouted = f.file.toUpperCase()
    const lower = f.file.toLowerCase()
    assert.equal(isEntryPoint(f.url, shouted, 'win32'), true)
    assert.equal(isEntryPoint(f.url, lower, 'win32'), true)
    if (shouted !== f.file) assert.equal(isEntryPoint(f.url, shouted, 'linux'), false)
    if (lower !== f.file) assert.equal(isEntryPoint(f.url, lower, 'darwin'), false)
  } finally { f.done() }
})

test('a URL that is not a file: URL is never the entry point', () => {
  assert.equal(isEntryPoint('data:text/javascript,0', fileURLToPath(import.meta.url), 'linux'), false)
})

test('this test file is not mistaken for the module under test', () => {
  // Under `tsx --test` argv[1] is the test runner's file, not entry.ts.
  assert.equal(isEntryPoint(pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), 'entry.ts')).href), false)
})

test('readBuildInfo: absent in a checkout, read in a package, ignored when malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secscan-build-info-'))
  try {
    assert.equal(readBuildInfo(dir), null)
    const info = { name: '@anshuman11o/secscan', version: '0.1.0', harness_commit: 'abc1234', built_at: '2026-10-16T00:00:00.000Z' }
    writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify(info))
    assert.deepEqual(readBuildInfo(dir), info)
    writeFileSync(join(dir, BUILD_INFO_FILE), '{"version": "0.1.0"}')
    assert.equal(readBuildInfo(dir), null, 'no harness_commit')
    writeFileSync(join(dir, BUILD_INFO_FILE), '{not json')
    assert.equal(readBuildInfo(dir), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  // The harness itself has no build-info.json at its root.
  assert.equal(readBuildInfo(), null)
})
