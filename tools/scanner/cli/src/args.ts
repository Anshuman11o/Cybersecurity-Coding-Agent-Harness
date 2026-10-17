/**
 * Command-line parsing for `secscan`. No dependencies: the flag set is small,
 * and every value is validated by the same parsers the stages use.
 */
import {
  parseCost, parsePositiveInt, parseSize, parseDuration, normalizeScopePath, compileGlob,
  type RunLimits,
} from '../../stage1-budget-governor/src/limits.js'

export interface ModelFlags {
  /** A registry key or alias — or, with baseUrl, the endpoint's model id. */
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  /** "input/output" USD per MTok, for the custom endpoint. */
  price?: string
  modelsFile?: string
}

/** Missing arrays inherit config; supplied arrays replace that config array. */
export interface ClassEdits {
  drop?: string[]
  add?: string[]
}

export interface ScanArgs extends ModelFlags {
  command: 'scan'
  target: string
  targetProvided: boolean
  limits: Partial<RunLimits>
  yes: boolean
  configPath?: string
  noConfig: boolean
  resume?: string | true
  out?: string
  classes?: ClassEdits
  /** Do not open report.html in the browser when the run ends. */
  noOpen: boolean
}

export interface ModelsArgs extends ModelFlags {
  command: 'models'
  all: boolean
}

/** `secscan report [run-id]`: rebuild a run's report from what is on disk. */
export interface ReportArgs {
  command: 'report'
  /** Default: the newest run in the reports folder. */
  runId?: string
  /** Reports folder; default ./.secscan */
  out?: string
  noOpen: boolean
}

/** `secscan help [command]`, `secscan <command> --help`. No topic means every command. */
export interface HelpArgs {
  command: 'help'
  topic?: CommandName
}

export type Args = ScanArgs | ModelsArgs | ReportArgs | HelpArgs | { command: 'version' }

export class UsageError extends Error {}

// ── The command definition ──────────────────────────────────────────────────
//
// Every command and option parseArgs() accepts, described once. usage() renders
// it for the terminal and help-doc.ts renders it as the README's command guide,
// so the two cannot disagree; help.test.ts checks that each spelling handled by
// parseArgs() is described here and that each one described here parses.
// Text marks code with backticks: Markdown keeps them, the terminal drops them.
// Nothing here names a model, an endpoint or a credential: the custom
// endpoint's default key variable is registry data and is passed in.

export const PACKAGE_NAME = '@anshuman11o/secscan'
export const PRODUCT_URL = 'https://github.com/anshuman11o/secscan'

export type CommandName = 'scan' | 'models' | 'report' | 'help' | 'version'
export const COMMAND_NAMES: readonly CommandName[] = ['scan', 'models', 'report', 'help', 'version']

/**
 * Whether this install lets the user choose a model. The npm package ships one
 * fixed model (models.json `product_models`), so it has no `models` command and
 * no Model options; the harness registry offers many. Decided from the registry
 * on disk by registry.ts cliMode(); `model` names the fixed one for the help.
 */
export interface CliMode {
  modelChoice: boolean
  model?: { label: string; apiKeyEnv: string }
}
export const FULL_MODE: CliMode = { modelChoice: true }

/** The commands this install has. */
export const commandNames = (mode: CliMode = FULL_MODE): readonly CommandName[] =>
  mode.modelChoice ? COMMAND_NAMES : COMMAND_NAMES.filter(c => c !== 'models')

/** Spellings that only exist where a model can be chosen. */
const MODEL_FLAGS = new Set(['--model', '--base-url', '--api-key-env', '--price', '--models-file', '--all'])

export interface OptionDef {
  /** The spelling help shows: '--budget'. */
  name: string
  /** A one-dash spelling shown before the name: '-y'. */
  short?: string
  /** Other long spellings parseArgs accepts: '--max-cost'. */
  aliases?: string[]
  /** Value placeholder; absent for a switch. */
  value?: string
  /** The value may be left out (`--resume [run-id]`). */
  optionalValue?: boolean
  repeatable?: boolean
  description: string
  default?: string
  /** The commands that accept it. */
  commands: readonly CommandName[]
}

export interface OptionGroup {
  title: string
  options: OptionDef[]
}

export interface Example {
  command: string
  note: string
  /** Also shown in the overall help and the README guide. */
  featured?: boolean
}

export interface CommandDef {
  name: CommandName
  /** The command as listed: 'report [run-id]'. */
  synopsis: string
  /** Full command lines for `secscan help <command>`. */
  usage: string[]
  summary: string
  /** Paragraphs for `secscan help <command>`. */
  about: string[]
  /** Options only this command takes; shared ones live in the groups. */
  options?: OptionDef[]
  examples?: Example[]
}

export interface HelpNote {
  title: string
  text: string
  commands: readonly CommandName[]
}

export interface CliDefinition {
  description: readonly [string, string]
  quickstart: Example[]
  quickstartNote: string
  commands: CommandDef[]
  groups: OptionGroup[]
  notes: HelpNote[]
  exitCodes: { code: number; meaning: string }[]
}

const SCAN: readonly CommandName[] = ['scan']
const SCAN_MODELS: readonly CommandName[] = ['scan', 'models']
const SCAN_REPORT: readonly CommandName[] = ['scan', 'report']

export function cliDefinition(customKeyDefault: string, mode: CliMode = FULL_MODE): CliDefinition {
  const def = fullDefinition(customKeyDefault)
  if (mode.modelChoice) return def
  const m = mode.model
  return {
    ...def,
    quickstartNote: m
      ? `Needs Node 20 or later and your API key for ${m.label} in \`${m.apiKeyEnv}\`.`
      : 'Needs Node 20 or later and the model\'s API key in your environment.',
    commands: def.commands.filter(c => c.name !== 'models'),
    groups: def.groups.filter(g => g.title !== 'Model'),
  }
}

function fullDefinition(customKeyDefault: string): CliDefinition {
  return {
    description: [
      'secscan finds security vulnerabilities in your code with your own AI API key.',
      'It asks for a budget, shows the plan and its cost, then writes an HTML report.',
    ],
    quickstart: [
      { command: 'cd my-repo', note: 'the repository to scan' },
      { command: `npx ${PACKAGE_NAME}`, note: 'scan it without installing anything' },
      { command: 'secscan', note: `the same, after \`npm install -g ${PACKAGE_NAME}\`` },
    ],
    quickstartNote: 'Needs Node 20 or later and the model\'s API key in your environment. `secscan models` shows the variable each model reads and whether it is set.',
    commands: [
      {
        name: 'scan',
        synopsis: 'scan [dir]',
        usage: ['secscan [options]', 'secscan scan [dir] [options]'],
        summary: 'Scan the repository in `dir`, or the current directory. The default command.',
        about: [
          'Before anything is spent, secscan asks you to confirm the target, the reports folder, exclusions and a budget in USD.',
          'Recon and class selection then run: a few model calls, counted against the budget. The plan screen shows the vulnerability classes, the files and the cost estimate, and the hunt starts only when you choose to start it (or with `--yes`).',
        ],
        examples: [
          { command: 'secscan', note: 'Scan the current directory; prompts confirm each choice.', featured: true },
          { command: 'secscan scan ./my-app --budget 5 --exclude vendor', note: 'Cap total spend at $5 and skip the vendor folder.', featured: true },
          { command: 'secscan scan . --yes --budget 10', note: 'No prompts, for CI: `--yes` needs `--budget`.', featured: true },
          { command: 'secscan scan --resume', note: 'Continue the latest INCOMPLETE run.', featured: true },
        ],
      },
      {
        name: 'models',
        synopsis: 'models [--all]',
        usage: ['secscan models [--all] [options]'],
        summary: 'List the models with price, measured or unmeasured, and whether the API key is set.',
        about: [
          'The default model is marked `*`. Measured means scored by the research harness on its benchmark; every other model, every `--models-file` entry and every `--base-url` endpoint is unmeasured. Makes no model calls.',
        ],
        options: [
          { name: '--all', description: 'Also list lab-only models, hidden by default.', commands: ['models'] },
        ],
        examples: [
          { command: 'secscan models', note: 'Show the models and which API keys are set.', featured: true },
        ],
      },
      {
        name: 'report',
        synopsis: 'report [run-id]',
        usage: ['secscan report [run-id] [options]'],
        summary: 'Rebuild a run\'s `report.html` and `findings.json` from what the run wrote. Default: the newest run.',
        about: [
          'Makes no model calls. Use it when a report is missing, for example after the CLI was killed.',
        ],
        examples: [
          { command: 'secscan report --out ./reports', note: 'Rebuild the newest run\'s report in another reports folder.' },
        ],
      },
      {
        name: 'help',
        synopsis: 'help [command]',
        usage: ['secscan help [command]', 'secscan <command> --help'],
        summary: 'Show help for every command, or for one.',
        about: [],
      },
      {
        name: 'version',
        synopsis: 'version',
        usage: ['secscan version', 'secscan --version'],
        summary: 'Print the version.',
        about: [],
      },
    ],
    groups: [
      {
        title: 'Scope',
        options: [
          { name: '--paths', value: '<p,...>', repeatable: true, commands: SCAN, default: 'the whole repository',
            description: 'Scan only these files or folders, relative to the target. Comma-separated.' },
          { name: '--include', value: '<glob>', repeatable: true, commands: SCAN,
            description: 'Scan only files matching this glob.' },
          { name: '--exclude', value: '<glob>', repeatable: true, commands: SCAN,
            description: 'Skip files or folders matching this path or glob, on top of `.gitignore` and `.secscanignore`.' },
          { name: '--max-file-size', value: '<size>', commands: SCAN,
            description: 'Skip files larger than this: bytes, or `200k`, `1m`. Recon always skips files over 1,000,000 bytes.' },
        ],
      },
      {
        title: 'Budget & limits',
        options: [
          { name: '--budget', aliases: ['--max-cost'], value: '<usd>', commands: SCAN, default: 'asked before the scan',
            description: 'Total spend cap in USD, including recon and class selection. Also `--max-cost`.' },
          { name: '--max-files', value: '<n>', commands: SCAN,
            description: 'Scan at most n files; the rest are recorded as not scanned.' },
          { name: '--timeout', value: '<time>', commands: SCAN,
            description: 'Start no new file after this long: seconds, or `90s`, `30m`, `1h`. Each resume starts a new window.' },
          { name: '--concurrency', value: '<n>', commands: SCAN, default: 'derived from the model\'s rate limits',
            description: 'Files scanned at once.' },
        ],
      },
      {
        title: 'Model',
        options: [
          { name: '--model', value: '<key>', commands: SCAN_MODELS, default: 'the model marked `*` in `secscan models`',
            description: 'A model key or alias from `secscan models`. With `--base-url`, the endpoint\'s own model id.' },
          { name: '--base-url', value: '<url>', commands: SCAN_MODELS,
            description: 'Use an OpenAI-compatible endpoint instead, with `--model`. A scan needs its Responses API with web search.' },
          { name: '--api-key-env', value: '<VAR>', commands: SCAN_MODELS, default: `\`${customKeyDefault}\``,
            description: 'The variable holding that endpoint\'s API key.' },
          { name: '--price', value: '<in/out>', commands: SCAN_MODELS,
            description: 'That endpoint\'s price in USD per million input/output tokens, e.g. `0.5/1.5`. Needed for a budget.' },
          { name: '--models-file', value: '<path>', commands: SCAN_MODELS,
            description: 'Your own `models.json` overlay. Adds models; never replaces shipped ones.' },
        ],
      },
      {
        title: 'Classes',
        options: [
          { name: '--drop-class', value: '<id>', repeatable: true, commands: SCAN,
            description: 'Remove a selected vulnerability class before the hunt.' },
          { name: '--add-class', value: '<text>', repeatable: true, commands: SCAN,
            description: 'Add a class by id, number, OWASP code or name. Free text costs a model call to resolve.' },
        ],
      },
      {
        title: 'Run control',
        options: [
          { name: '--yes', short: '-y', commands: SCAN,
            description: 'Skip every prompt. Needs `--budget`, except with `--resume`.' },
          { name: '--resume', value: '[run-id]', optionalValue: true, commands: SCAN, default: 'the latest INCOMPLETE run',
            description: 'Continue a stopped run with its model, spend and finished files.' },
          { name: '--config', value: '<path>', commands: SCAN, default: '`<dir>/secscan.config.json`',
            description: 'Read settings from this file.' },
          { name: '--no-config', commands: SCAN,
            description: 'Ignore `secscan.config.json`.' },
        ],
      },
      {
        title: 'Output',
        options: [
          { name: '--out', value: '<dir>', commands: SCAN_REPORT, default: '`<dir>/.secscan`, or `./.secscan` for `report`',
            description: 'Reports folder.' },
          { name: '--no-open', commands: SCAN_REPORT,
            description: 'Do not open `report.html` in the browser at the end.' },
        ],
      },
    ],
    notes: [
      {
        title: 'Reports',
        commands: SCAN_REPORT,
        text: 'Each run writes `report.html` and `findings.json` to `<reports>/runs/<run-id>/`, and `<reports>/index.html` lists every run with a report. The reports folder keeps itself out of git.',
      },
      {
        title: 'Stopping',
        commands: SCAN,
        text: 'A limit or Ctrl-C ends the run cleanly: files in flight finish, the run is recorded INCOMPLETE with the list of what was not scanned, and `--resume` continues it. Press Ctrl-C twice to abandon the files in flight.',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'complete, or cancelled at a prompt' },
      { code: 1, meaning: 'failure' },
      { code: 2, meaning: 'usage error' },
      { code: 3, meaning: 'incomplete: a limit or a stop; `--resume` continues it' },
      { code: 130, meaning: 'interrupted' },
    ],
  }
}

/** Every spelling of an option. */
export const optionSpellings = (o: OptionDef): string[] => [o.name, ...(o.short ? [o.short] : []), ...(o.aliases ?? [])]

/** The options a command accepts, by group; its own options come first, as a group of their own. */
export function optionsFor(def: CliDefinition, command: CommandName): OptionGroup[] {
  const own = def.commands.find(c => c.name === command)?.options ?? []
  const groups = def.groups
    .map(g => ({ title: g.title, options: g.options.filter(o => o.commands.includes(command)) }))
    .filter(g => g.options.length > 0)
  return own.length ? [{ title: 'Options', options: own }, ...groups] : groups
}

/**
 * What a command other than scan accepts beyond its synopsis, in words:
 * "the Model options", "--out and --no-open". Generated, so it cannot drift.
 */
export function acceptsText(def: CliDefinition, command: CommandName): string {
  const parts: string[] = []
  for (const g of def.groups) {
    const taken = g.options.filter(o => o.commands.includes(command))
    if (!taken.length) continue
    if (taken.length === g.options.length) parts.push(`the ${g.title} options`)
    else parts.push(...taken.map(o => `\`${o.name}\``))
  }
  if (parts.length < 2) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const WIDTH = 80
const COLUMN = 28

const plain = (text: string): string => text.replace(/`/g, '')

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

/** A left cell and wrapped text in the description column. */
function row(left: string, text: string): string[] {
  const body = wrap(plain(text), WIDTH - COLUMN)
  const pad = ' '.repeat(COLUMN)
  const head = `  ${left}`
  if (head.length > COLUMN - 2) return [head, ...body.map(l => pad + l)]
  return [head.padEnd(COLUMN) + (body[0] ?? ''), ...body.slice(1).map(l => pad + l)]
}

function paragraph(text: string, indent = ''): string[] {
  return wrap(plain(text), WIDTH - indent.length).map(l => indent + l)
}

/** The option's left cell: '-y, --yes', '--resume [run-id]'. */
export function optionLabel(o: OptionDef): string {
  return [o.short, o.value ? `${o.name} ${o.value}` : o.name].filter(Boolean).join(', ')
}

/** The option's description with "Repeatable." and, for the terminal, its default. */
export function optionText(o: OptionDef, withDefault: boolean): string {
  let text = o.description
  if (o.repeatable) text += ' Repeatable.'
  if (withDefault && o.default) text += ` Default: ${o.default}.`
  return text
}

function groupLines(groups: OptionGroup[]): string[] {
  return groups.flatMap(g => ['', `${g.title}:`, ...g.options.flatMap(o => row(optionLabel(o), optionText(o, true)))])
}

function exampleLines(examples: Example[]): string[] {
  return examples.length ? ['', 'Examples:', ...examples.flatMap(e => [`  ${e.command}`, ...paragraph(e.note, '      ')])] : []
}

function exitLines(def: CliDefinition): string[] {
  return ['', 'Exit codes:', ...def.exitCodes.flatMap(e => row(String(e.code), e.meaning))]
}

function noteLines(def: CliDefinition, command?: CommandName): string[] {
  return def.notes
    .filter(n => !command || n.commands.includes(command))
    .flatMap(n => ['', `${n.title}:`, ...paragraph(n.text, '  ')])
}

function footer(topic?: CommandName): string[] {
  return ['', ...(topic ? [] : ['Run "secscan help <command>" for one command.']), `Docs: ${PRODUCT_URL}`]
}

/**
 * The help text: every command and option group, or with `topic` one command
 * and the options it takes. The custom endpoint's default key variable is
 * registry data, so it is passed in.
 */
export function usage(customKeyDefault: string, topic?: CommandName, mode: CliMode = FULL_MODE): string {
  const def = cliDefinition(customKeyDefault, mode)
  if (topic) {
    const cmd = def.commands.find(c => c.name === topic)
    if (!cmd) throw new UsageError(`unknown help topic "${topic}"`)
    const lines = [
      ...paragraph(`secscan ${cmd.name}: ${cmd.summary}`),
      '',
      'Usage:',
      ...cmd.usage.map(u => `  ${u}`),
      ...cmd.about.flatMap(p => ['', ...paragraph(p)]),
      ...groupLines(optionsFor(def, cmd.name)),
      ...exampleLines(cmd.examples ?? []),
      ...noteLines(def, cmd.name),
      ...(cmd.name === 'scan' ? exitLines(def) : []),
      ...footer(topic),
    ]
    return lines.join('\n') + '\n'
  }
  const lines = [
    ...def.description.flatMap(d => paragraph(d)),
    '',
    'Quick start:',
    ...def.quickstart.flatMap(q => row(q.command, q.note)),
    ...paragraph(def.quickstartNote, '  '),
    '',
    'Usage: secscan [command] [options]',
    '',
    'Commands:',
    ...def.commands.flatMap(c => {
      const accepts = c.name === 'scan' ? '' : acceptsText(def, c.name)
      return row(c.synopsis, accepts ? `${c.summary} Takes ${accepts}.` : c.summary)
    }),
    ...groupLines(def.groups),
    ...exampleLines(def.commands.flatMap(c => (c.examples ?? []).filter(e => e.featured))),
    ...noteLines(def),
    ...exitLines(def),
    ...footer(),
  ]
  return lines.join('\n') + '\n'
}

const HELP_FLAGS = new Set(['--help', '-h'])

function helpTopic(word: string, mode: CliMode): CommandName {
  const names = commandNames(mode)
  if ((names as readonly string[]).includes(word)) return word as CommandName
  throw new UsageError(`unknown help topic "${word}"; try one of: ${names.join(', ')}`)
}

export function parseArgs(argv: readonly string[], mode: CliMode = FULL_MODE): Args {
  const args = [...argv]
  const first = args[0]
  if (first === 'help' || (first !== undefined && HELP_FLAGS.has(first))) {
    const rest = args.slice(1).filter(a => !HELP_FLAGS.has(a))
    if (rest.length > 1) throw new UsageError(`help takes one command, got ${rest.join(' ')}`)
    return rest.length ? { command: 'help', topic: helpTopic(rest[0], mode) } : { command: 'help' }
  }
  if (first === '--version') return { command: 'version' }
  if (first !== undefined && !first.startsWith('-') && !(commandNames(mode) as readonly string[]).includes(first)) throw new UsageError(`unknown command "${first}"`)
  // `secscan scan --help`: that command's help, whatever else the line holds.
  if (args.some(a => HELP_FLAGS.has(a))) {
    return first !== undefined && !first.startsWith('-') ? { command: 'help', topic: first as CommandName } : { command: 'help' }
  }
  if (first === 'version') return { command: 'version' }
  if (first === 'scan' || first === 'models' || first === 'report') args.shift()

  const model: ModelFlags = {}
  const limits: Partial<RunLimits> = {}
  let yes = false
  let all = false
  let configPath: string | undefined
  let noConfig = false
  let resume: string | true | undefined
  let out: string | undefined
  let classes: ClassEdits | undefined
  let noOpen = false
  const positional: string[] = []

  const push = (key: 'paths' | 'include' | 'exclude', vals: string[]) => {
    limits[key] = [...(limits[key] ?? []), ...vals]
  }

  for (let i = 0; i < args.length; i++) {
    let a = args[i]
    let inline: string | undefined
    if (a.startsWith('--') && a.includes('=')) {
      inline = a.slice(a.indexOf('=') + 1)
      a = a.slice(0, a.indexOf('='))
    }
    const value = (): string => {
      if (inline !== undefined) {
        if (inline === '') throw new UsageError(`${a} needs a value`)
        return inline
      }
      const v = args[++i]
      if (v === undefined || v === '' || (v.startsWith('-') && v !== '-')) throw new UsageError(`${a} needs a value`)
      return v
    }
    const wrap = <T>(f: () => T): T => {
      try { return f() } catch (err: any) { throw new UsageError(err?.message ?? String(err)) }
    }
    // One fixed model: the model flags do not exist here, rather than being ignored.
    if (!mode.modelChoice && MODEL_FLAGS.has(a)) throw new UsageError(`unknown option "${a}"`)
    switch (a) {
      case '--model': model.model = value(); break
      case '--base-url': model.baseUrl = value(); break
      case '--api-key-env': model.apiKeyEnv = value(); break
      case '--price': model.price = value(); break
      case '--models-file': model.modelsFile = value(); break
      case '--budget': case '--max-cost': { const v = value(); limits.max_cost_usd = wrap(() => parseCost(v, a)); break }
      case '--max-files': { const v = value(); limits.max_files = wrap(() => parsePositiveInt(v, '--max-files')); break }
      case '--max-file-size': { const v = value(); limits.max_file_size = wrap(() => parseSize(v, '--max-file-size')); break }
      case '--timeout': { const v = value(); limits.timeout_seconds = wrap(() => parseDuration(v, '--timeout')); break }
      case '--concurrency': { const v = value(); limits.concurrency = wrap(() => parsePositiveInt(v, '--concurrency')); break }
      case '--paths': {
        const v = value()
        push('paths', wrap(() => v.split(',').map(normalizeScopePath).filter(Boolean)))
        break
      }
      case '--include': { const v = value(); wrap(() => compileGlob(v)); push('include', [v]); break }
      case '--exclude': { const v = value(); wrap(() => compileGlob(v)); push('exclude', [v]); break }
      case '--drop-class': case '--add-class': {
        const v = value()
        if (!v.trim()) throw new UsageError(`${a} needs a non-empty value`)
        const key = a === '--drop-class' ? 'drop' : 'add'
        classes ??= {}
        classes[key] = [...(classes[key] ?? []), v]
        break
      }
      case '-y': case '--yes': yes = true; break
      case '--all': all = true; break
      case '--config': configPath = value(); break
      case '--no-config': noConfig = true; break
      case '--out': out = value(); break
      case '--no-open': noOpen = true; break
      case '--resume':
        resume = inline !== undefined ? value() : (args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true)
        break
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option "${a}"`)
        positional.push(a)
    }
  }

  if (model.baseUrl && !model.model) throw new UsageError('--base-url needs --model <the endpoint\'s model id>')
  if (!model.baseUrl && (model.apiKeyEnv || model.price)) {
    throw new UsageError('--api-key-env and --price describe a custom endpoint; they need --base-url')
  }
  if (model.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv)) {
    throw new UsageError(`--api-key-env "${model.apiKeyEnv}" is not an environment variable name`)
  }

  if (first === 'models') {
    if (positional.length) throw new UsageError(`unexpected argument "${positional[0]}"`)
    return { command: 'models', all, ...model }
  }
  if (first === 'report') {
    const scanOnly = Object.keys(limits).length || Object.keys(model).length || yes || all || configPath || noConfig || resume !== undefined || classes
    if (scanOnly) throw new UsageError('secscan report takes only [run-id], --out and --no-open')
    if (positional.length > 1) throw new UsageError(`expected one run id, got ${positional.join(' ')}`)
    return { command: 'report', ...(positional[0] ? { runId: positional[0] } : {}), ...(out ? { out } : {}), noOpen }
  }
  if (positional.length > 1) throw new UsageError(`expected one directory, got ${positional.join(' ')}`)
  if (configPath && noConfig) throw new UsageError('--config and --no-config contradict each other')
  if (yes && resume === undefined && limits.max_cost_usd == null) throw new UsageError('--yes requires --budget (or --max-cost), except with --resume')
  return {
    command: 'scan',
    target: positional[0] ?? '.',
    targetProvided: positional.length > 0,
    limits,
    yes,
    configPath,
    noConfig,
    resume,
    out,
    ...(classes ? { classes } : {}),
    noOpen,
    ...model,
  }
}
