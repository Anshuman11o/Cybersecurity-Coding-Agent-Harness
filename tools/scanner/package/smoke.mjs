#!/usr/bin/env node
/**
 * Pre-publish smoke test for the npm package (Task 1e). Packs the package,
 * installs the tarball into a temporary prefix the way a user would, and runs
 * the INSTALLED `secscan` (through npm's bin link, so the shebang, the bin
 * symlink or .cmd shim and the entry guard are all exercised):
 *
 *   --version  --help  models (refused: one fixed model)  scan <tiny dir> --yes --budget 0.01 (no key)
 *
 * Never needs an API key and never spends: every credential variable the
 * registry names is removed from the scan step's environment, so the scan must
 * stop at input validation, before any stage is launched. Prints PASS or FAIL
 * per step and exits non-zero on any FAIL.
 *
 *   node smoke.mjs [--keep]      --keep leaves the temp directory for inspection
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const WIN = process.platform === 'win32'
const keep = process.argv.includes('--keep')
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))

/** Quote for cmd.exe; only used on Windows, where .cmd shims need a shell. */
const q = s => /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s

function run(cmd, args, opts = {}) {
  const r = WIN
    ? spawnSync([cmd, ...args].map(q).join(' '), { shell: true, encoding: 'utf8', ...opts })
    : spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.status, signal: r.signal, out: r.stdout ?? '', err: r.stderr ?? '', error: r.error }
}

const results = []
function step(name, fn) {
  let detail
  let ok
  try {
    detail = fn()
    ok = true
  } catch (e) {
    ok = false
    detail = e?.message ?? String(e)
  }
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${String(detail).split('\n').join('\n      ')}` : ''}`)
  return ok
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg) }
const tail = s => s.trim().split('\n').slice(-8).join('\n')
/** A Node or V8 stack frame: what a user must never see for an expected error. */
const STACK = /^\s+at .+(\(.*:\d+:\d+\)|:\d+:\d+)$/m

const tmp = mkdtempSync(join(tmpdir(), 'secscan-smoke-'))
const prefix = join(tmp, 'prefix')
const fixture = join(tmp, 'tiny-app')
let tgz = null
let bin = null
let installedRegistry = null

try {
  console.log(`secscan smoke: ${pkg.name}@${pkg.version} (temp ${tmp})\n`)

  step('npm pack (runs prepack: the build)', () => {
    const r = run(WIN ? 'npm.cmd' : 'npm', ['pack', '--json', '--pack-destination', tmp], { cwd: PKG_DIR, timeout: 300_000 })
    expect(r.code === 0, `npm pack exited ${r.code}\n${tail(r.err || r.out)}`)
    // prepack's build log shares stdout with the JSON; the JSON starts at a line holding only "[".
    const json = JSON.parse(r.out.slice(r.out.search(/^\[\s*$/m)))
    tgz = join(tmp, json[0].filename)
    expect(existsSync(tgz), `no tarball at ${tgz}`)
    return `${json[0].filename}: ${json[0].entryCount} files, ${(json[0].size / 1024).toFixed(1)} KiB packed, ` +
      `${(json[0].unpackedSize / 1024).toFixed(1)} KiB unpacked`
  })

  if (tgz) step('install the tarball into a temp prefix', () => {
    mkdirSync(prefix, { recursive: true })
    const r = run(WIN ? 'npm.cmd' : 'npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', tgz], { timeout: 600_000 })
    expect(r.code === 0, `npm install exited ${r.code}\n${tail(r.err || r.out)}`)
    bin = join(prefix, 'node_modules', '.bin', WIN ? 'secscan.cmd' : 'secscan')
    expect(existsSync(bin), `no ${bin}`)
    const root = join(prefix, 'node_modules', ...pkg.name.split('/'))
    installedRegistry = JSON.parse(readFileSync(join(root, 'dist/tools/scanner/shared/models.json'), 'utf8'))
    return bin
  })

  if (bin) {
    // Every credential variable the shipped registry knows, so no step can spend.
    const keyVars = new Set(Object.values(installedRegistry.targets).map(t => t.api_key_env))
    const g = installedRegistry.generic_openai_compatible
    if (g) for (const v of [g.api_key_env_default, g.model_env, g.base_url_env, g.api_key_env_env, g.price_env]) keyVars.add(v)
    const env = { ...process.env }
    for (const v of keyVars) delete env[v]
    for (const k of Object.keys(env)) if (k.startsWith('SCANNER_')) delete env[k]
    const secscan = (...args) => run(bin, args, { cwd: tmp, env, timeout: 120_000 })

    step('secscan --version', () => {
      const r = secscan('--version')
      expect(r.code === 0, `exit ${r.code}\n${tail(r.err || r.out)}`)
      const v = r.out.trim()
      expect(v.startsWith(pkg.version), `printed "${v}", expected it to start with ${pkg.version}`)
      expect(/\(harness [^)]+\)/.test(v), `printed "${v}", expected "(harness <commit>)" from build-info.json`)
      return v
    })

    step('secscan --help', () => {
      const r = secscan('--help')
      expect(r.code === 0, `exit ${r.code}\n${tail(r.err || r.out)}`)
      expect(/secscan/.test(r.out) && /\bscan\b/.test(r.out), 'help text does not mention scan')
      // One fixed model: the help offers no way to choose one.
      for (const flag of ['--model', '--base-url', '--models-file']) expect(!r.out.includes(flag), `help still offers ${flag}`)
      const def = installedRegistry.targets[installedRegistry.product_default_provider]
      expect(r.out.includes(def.label) && r.out.includes(def.api_key_env), `help does not name ${def.label} and ${def.api_key_env}`)
      return `${r.out.trim().split('\n').length} lines`
    })

    step('one fixed model: secscan models and --model are refused', () => {
      const shipped = Object.keys(installedRegistry.targets)
      expect(shipped.length === 1 && shipped[0] === installedRegistry.product_default_provider,
        `the installed registry ships ${shipped.join(', ')}; expected only ${installedRegistry.product_default_provider}`)
      expect(!installedRegistry.generic_openai_compatible, 'the installed registry still carries the custom endpoint template')
      for (const args of [['models'], ['scan', '.', '--model', 'x', '--yes', '--budget', '1']]) {
        const r = secscan(...args)
        const text = `${r.out}\n${r.err}`
        expect(r.code === 2, `secscan ${args.join(' ')} exited ${r.code}, expected 2\n${tail(text)}`)
        expect(/unknown (command|option)/.test(text) && !STACK.test(text), `secscan ${args.join(' ')}: ${tail(text)}`)
      }
      return `only ${shipped[0]}; models and --model refused`
    })

    step('secscan scan <tiny dir> --yes --budget 0.01 with no key: clean refusal, no stage launched', () => {
      mkdirSync(join(fixture, 'src'), { recursive: true })
      writeFileSync(join(fixture, 'package.json'), '{ "name": "tiny-app", "version": "1.0.0" }\n')
      writeFileSync(join(fixture, 'src', 'index.js'), "const http = require('http')\nhttp.createServer((req, res) => res.end('ok')).listen(3000)\n")
      const r = secscan('scan', fixture, '--yes', '--budget', '0.01')
      const text = `${r.out}\n${r.err}`.trim()
      expect(r.code === 1 || r.code === 2, `exit ${r.code ?? r.signal}, expected 1 or 2\n${tail(text)}`)
      expect(text.length > 0, 'no message at all')
      expect(!STACK.test(text), `a stack trace reached the user:\n${tail(text)}`)
      const def = installedRegistry.targets[installedRegistry.product_default_provider]
      expect(text.includes(def.api_key_env), `the message does not name ${def.api_key_env}:\n${tail(text)}`)
      // No stage may have started: stage directories appear only once one launches.
      const stageDirs = []
      const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { if (/^stage/.test(e.name)) stageDirs.push(join(d, e.name)); walk(join(d, e.name)) } }
      walk(fixture)
      expect(stageDirs.length === 0, `stage output exists: ${stageDirs.join(', ')}`)
      return `exit ${r.code}: ${text.split('\n').join(' / ')}`
    })
  }
} finally {
  if (keep) console.log(`\nkept ${tmp}`)
  else rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
const expected = 6
console.log(`\n${results.length - failed.length}/${expected} passed${results.length < expected ? ` (${expected - results.length} not reached)` : ''}`)
process.exit(failed.length || results.length < expected ? 1 : 0)
