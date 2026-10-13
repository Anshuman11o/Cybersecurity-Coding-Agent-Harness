import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, UsageError } from './args.js'
import { validateConfig, configFromRun, writeConfig, loadConfig } from './config.js'
import { NO_LIMITS } from '../../stage1-budget-governor/src/limits.js'

test('repeatable class flags preserve free text, catalog codes and per-array precedence', () => {
  const args = parseArgs(['scan', '--yes', '--budget', '2', '--drop-class', 'injection',
    '--drop-class=access-control', '--add-class', 'prototype pollution', '--add-class=A01'])
  assert.equal(args.command, 'scan')
  if (args.command !== 'scan') return
  assert.deepEqual(args.classes, { drop: ['injection', 'access-control'], add: ['prototype pollution', 'A01'] })
  const dropOnly = parseArgs(['scan', '--drop-class=injection'])
  if (dropOnly.command !== 'scan') return assert.fail('expected scan')
  const config = validateConfig({ classes: { drop: ['crypto-auth'], add: ['prototype pollution'] } })
  assert.deepEqual({ ...config.classes, ...dropOnly.classes }, { drop: ['injection'], add: ['prototype pollution'] })
  const addOnly = parseArgs(['scan', '--add-class=A01'])
  if (addOnly.command !== 'scan') return assert.fail('expected scan')
  assert.deepEqual({ ...config.classes, ...addOnly.classes }, { drop: ['crypto-auth'], add: ['A01'] })
  const absent = parseArgs([])
  assert.equal(absent.command === 'scan' && absent.classes, undefined)
})

test('class flags reject missing and blank values', () => {
  for (const flag of ['--drop-class', '--add-class']) {
    for (const args of [[flag], [flag, '--budget', '2'], [`${flag}=`], [flag, '   ']]) {
      assert.throws(() => parseArgs(args), UsageError)
    }
  }
})

test('class config validates nested keys and non-empty string arrays', () => {
  assert.deepEqual(validateConfig({ classes: { add: [] } }).classes, { add: [] })
  assert.deepEqual(validateConfig({ classes: {} }).classes, {})
  assert.equal(validateConfig({}).classes, undefined)
  for (const classes of [null, [], 'injection', { update: [] }, { add: 'A01' },
    { drop: [1] }, { add: [''] }, { drop: ['  '] }]) {
    assert.throws(() => validateConfig({ classes }), /classes/)
  }
})

test('saved class edits round trip and preserve explicitly empty arrays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secscan-class-config-'))
  try {
    const path = join(dir, 'secscan.config.json')
    const edits = { drop: ['injection'], add: ['prototype pollution'] }
    const cfg = configFromRun('luna', NO_LIMITS, edits)
    edits.drop.push('crypto-auth')
    writeConfig(path, cfg)
    assert.deepEqual(loadConfig(path)?.config.classes, { drop: ['injection'], add: ['prototype pollution'] })
    writeConfig(path, configFromRun(null, NO_LIMITS, { drop: [], add: [] }))
    assert.deepEqual(loadConfig(path)?.config.classes, { drop: [], add: [] })
    assert.equal(configFromRun(null, NO_LIMITS).classes, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
