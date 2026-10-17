import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  COMMAND_NAMES, PRODUCT_URL, UsageError, cliDefinition, optionLabel, optionSpellings, optionsFor, parseArgs, usage,
  type CommandName, type OptionDef,
} from './args.js'
import { DEFAULT_README, GUIDE_END, GUIDE_START, guideBlock, renderCommandGuide, replaceGuide } from './help-doc.js'
import { cliMode, cliModeFor, genericNames, shippedCliMode } from './registry.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY = genericNames().api_key_env_default
const def = cliDefinition(KEY)
const allOptions = (): OptionDef[] => [...def.groups.flatMap(g => g.options), ...def.commands.flatMap(c => c.options ?? [])]

test('the package README carries the generated command guide', () => {
  const readme = readFileSync(DEFAULT_README, 'utf-8')
  assert.equal(readme.split(GUIDE_START).length, 2, 'one start marker')
  assert.equal(readme.split(GUIDE_END).length, 2, 'one end marker')
  assert.ok(readme.includes(guideBlock(renderCommandGuide(KEY))),
    'README command guide is stale; run: npx tsx src/help-doc.ts --write')
})

test('replaceGuide rewrites only the marked block and refuses a README without markers', () => {
  const readme = `# x\n\n${GUIDE_START}\nold\n${GUIDE_END}\n\nafter\n`
  assert.equal(replaceGuide(readme, 'new'), `# x\n\n${guideBlock('new')}\n\nafter\n`)
  assert.throws(() => replaceGuide('# x\n', 'new'))
  assert.throws(() => replaceGuide(`${GUIDE_END}\n${GUIDE_START}\n`, 'new'))
})

test('help takes an optional topic, from `help <command>` or `<command> --help`', () => {
  for (const argv of [['help'], ['--help'], ['-h'], ['help', '--help'], ['--yes', '--help'], ['--budget', '5', '-h']]) {
    assert.deepEqual(parseArgs(argv), { command: 'help' }, argv.join(' '))
  }
  for (const topic of COMMAND_NAMES) {
    assert.deepEqual(parseArgs(['help', topic]), { command: 'help', topic })
    assert.deepEqual(parseArgs(['--help', topic]), { command: 'help', topic })
    // `secscan help --help` is plain help, asserted above.
    if (topic !== 'help') assert.deepEqual(parseArgs([topic, '--help']), { command: 'help', topic })
  }
  assert.deepEqual(parseArgs(['scan', 'app', '--budget', '5', '-h']), { command: 'help', topic: 'scan' })
  assert.deepEqual(parseArgs(['models', '--all', '--help']), { command: 'help', topic: 'models' })
  assert.deepEqual(parseArgs(['report', 'RUN', '--help']), { command: 'help', topic: 'report' })
  for (const argv of [['help', 'bogus'], ['help', 'scan', 'models'], ['bogus', '--help']]) {
    assert.throws(() => parseArgs(argv), UsageError, argv.join(' '))
  }
  // Unchanged: version, and the commands without --help.
  assert.deepEqual(parseArgs(['--version']), { command: 'version' })
  assert.deepEqual(parseArgs(['version']), { command: 'version' })
  assert.equal(parseArgs(['scan']).command, 'scan')
})

test('the definition and parseArgs know the same spellings', () => {
  const source = readFileSync(join(HERE, 'args.ts'), 'utf-8')
  const parsed = new Set([...source.slice(source.indexOf('export function parseArgs')).matchAll(/case '(-[^']+)'/g)].map(m => m[1]))
  const described = new Set(allOptions().flatMap(optionSpellings))
  assert.deepEqual([...described].filter(s => !parsed.has(s)), [], 'described but not parsed')
  assert.deepEqual([...parsed].filter(s => !described.has(s)), [], 'parsed but not described')
})

const SAMPLE: Record<string, string> = {
  '<p,...>': 'src', '<glob>': '*.ts', '<size>': '200k', '<usd>': '5', '<n>': '3', '<time>': '30m',
  '<key>': 'm', '<url>': 'http://localhost:1/v1', '<VAR>': 'MY_KEY', '<in/out>': '1/2', '<path>': 'x.json',
  '<id>': 'injection', '<text>': 'ssrf', '<dir>': 'out',
}
/** Flags an option needs beside it to be valid on its own. */
const COMPANIONS: Record<string, string[]> = {
  '--base-url': ['--model', 'm'],
  '--api-key-env': ['--base-url', 'http://localhost:1/v1', '--model', 'm'],
  '--price': ['--base-url', 'http://localhost:1/v1', '--model', 'm'],
  '--yes': ['--budget', '1'],
}

test('every described spelling parses for each command it lists, and report refuses the rest', () => {
  for (const o of allOptions()) {
    for (const spelling of optionSpellings(o)) {
      const value = o.value && !o.optionalValue ? [SAMPLE[o.value] ?? assert.fail(`no sample for ${o.value}`)] : []
      for (const command of ['scan', 'models', 'report'] as CommandName[]) {
        const argv = [command, spelling, ...value, ...(COMPANIONS[o.name] ?? [])]
        if (o.commands.includes(command)) assert.doesNotThrow(() => parseArgs(argv), argv.join(' '))
        else if (command === 'report') assert.throws(() => parseArgs(argv), UsageError, argv.join(' '))
      }
    }
  }
})

test('help shows every command and option, and a topic shows only its own', () => {
  const full = usage(KEY)
  for (const c of def.commands) assert.ok(full.includes(`  ${c.synopsis}`), c.synopsis)
  for (const g of def.groups) {
    assert.ok(full.includes(`\n${g.title}:\n`), g.title)
    for (const o of g.options) assert.ok(full.includes(`  ${optionLabel(o)}`), optionLabel(o))
  }
  assert.ok(full.includes('npx @anshuman11o/secscan'))
  assert.ok(full.includes(PRODUCT_URL))
  assert.match(full, /Model:\n {2}--model/)
  assert.match(full, /Exit codes:[\s\S]*130/)
  // The facts the old text carried.
  assert.match(full, /report\.html and findings\.json to <reports>\/runs\/<run-id>\//)
  assert.match(full, /Ctrl-C twice/)
  assert.match(full, /--yes[\s\S]{0,40}Needs --budget, except with\s+--resume/)
  assert.ok(full.includes(KEY), 'the custom endpoint key default is shown')

  for (const topic of COMMAND_NAMES) {
    const text = usage(KEY, topic)
    const own = new Set(optionsFor(def, topic).flatMap(g => g.options))
    for (const o of allOptions()) {
      const shown = text.includes(`  ${optionLabel(o)} `) || text.includes(`  ${optionLabel(o)}\n`)
      assert.equal(shown, own.has(o), `${topic}: ${optionLabel(o)}`)
    }
  }
  assert.match(usage(KEY, 'report'), /--out <dir>/)
  assert.doesNotMatch(usage(KEY, 'report'), /--budget/)
  assert.match(usage(KEY, 'models'), /--all/)
})

test('help fits 80 columns and the guide is plain Markdown without em dashes', () => {
  const texts = [usage(KEY), ...COMMAND_NAMES.map(t => usage(KEY, t))]
  for (const text of texts) {
    for (const line of text.split('\n')) assert.ok(line.length <= 80, `too wide: ${line}`)
    assert.ok(!text.includes('—'), 'em dash in help')
  }
  const guide = renderCommandGuide(KEY)
  assert.ok(!guide.includes('—'), 'em dash in the guide')
  const outsideCode = guide.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  assert.doesNotMatch(outsideCode, /(?<!\\)</, 'a bare < would render as an HTML tag')
  assert.doesNotMatch(outsideCode, /<\/?[a-z][^>]*>/i, 'no HTML in the guide')
})

// ── One fixed model (the npm package) ───────────────────────────────────────

test('cliModeFor: one target and no custom endpoint means one fixed model', () => {
  const one = { targets: { m: { label: 'Model M', api_key_env: 'M_KEY' } } }
  assert.deepEqual(cliModeFor(one), { modelChoice: false, model: { label: 'Model M', apiKeyEnv: 'M_KEY' } })
  assert.deepEqual(cliModeFor({ ...one, generic_openai_compatible: {} }), { modelChoice: true })
  assert.deepEqual(cliModeFor({ targets: { ...one.targets, n: { label: 'N', api_key_env: 'N_KEY' } } }), { modelChoice: true })
  // From the harness's full registry, asShipped answers for the package.
  const shipped = shippedCliMode()
  assert.equal(shipped.modelChoice, false)
  assert.ok(shipped.model?.label && shipped.model.apiKeyEnv)
  assert.equal(cliMode().modelChoice, true, 'the harness keeps its model choice')
})

test('one fixed model: no models command, no model options, help names the model', () => {
  const mode = { modelChoice: false, model: { label: 'Model M', apiKeyEnv: 'M_KEY' } }
  for (const argv of [['models'], ['scan', '--model', 'x'], ['--base-url', 'http://x'], ['--models-file', 'f.json'], ['help', 'models']]) {
    assert.throws(() => parseArgs(argv, mode), UsageError, argv.join(' '))
  }
  assert.equal(parseArgs(['scan', '.', '--budget', '2'], mode).command, 'scan')
  const text = usage(KEY, undefined, mode)
  assert.doesNotMatch(text, /--model|--base-url|--models-file|secscan models|^Model:/m)
  assert.match(text, /Model M/)
  assert.match(text, /M_KEY/)
  assert.throws(() => usage(KEY, 'models', mode), UsageError)
  const guide = renderCommandGuide(KEY, mode)
  assert.doesNotMatch(guide, /--model|secscan models/)
})
