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
  /** 2: also write report option 2 (report-option-2.html). */
  template?: 2
}

export type Args = ScanArgs | ModelsArgs | ReportArgs | { command: 'help' } | { command: 'version' }

/** The usage text. The custom endpoint's default key variable is registry data, so it is passed in. */
export const usage = (customKeyDefault: string): string => `secscan — find security vulnerabilities in your code with your own model key

Usage:
  secscan [options]                 scan the current directory
  secscan scan [dir] [options]      scan a repository (default: the current directory)
  secscan models [--all]            list models: price, measured or unmeasured, key status
  secscan report [run-id]           rebuild a run's report (default: the newest run in ./.secscan)
                                    --template 2 also writes report option 2, report-option-2.html
  secscan help                      this text

Lab options:
  --model <key>             a model from \`secscan models\` (default: the product registry default)
  --base-url <url>          any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio, ...);
                            --model is then that endpoint's model id
  --api-key-env <VAR>       env var holding the custom endpoint's key (default ${customKeyDefault})
  --price <in/out>          custom endpoint price, USD per million tokens, e.g. 0.5/1.5
  --models-file <path>      your own models.json overlay (adds entries; never replaces shipped ones)

Limits:
  --budget <usd>            total run budget, including recon (alias: --max-cost)
  --max-files <n>           scan at most n files
  --max-file-size <size>    skip larger files (bytes, or 200k / 1m)
  --timeout <time>          no new file starts after this long (600, 90s, 30m, 1h)
  --concurrency <n>         files in flight (default: derived from the model)
  --paths <p,...>           scan only these files or directories (repeatable)
  --include <glob>          scan only files matching (repeatable)
  --exclude <glob>          skip files matching (repeatable)

Classes:
  --drop-class <id>         remove a selected vulnerability class (repeatable)
  --add-class <text>        add a class by name, number or code (repeatable)

Run:
  -y, --yes                 skip prompts; requires --budget unless resuming
  --out <dir>              reports folder (default: <dir>/.secscan)
  --config <path>           settings file (default: <dir>/secscan.config.json)
  --no-config               ignore secscan.config.json
  --resume [run-id]         continue a stopped run (default: latest INCOMPLETE)
  --no-open                 do not open report.html when the run ends

Each run writes report.html and findings.json to <reports>/runs/<run-id>/, and
<reports>/index.html lists every run with a report.

A limit or Ctrl-C ends the run cleanly: files in flight finish, the run is
recorded INCOMPLETE with the list of what was not scanned, and --resume
continues it. Press Ctrl-C twice to abandon the files in flight.

Exit codes: 0 complete, 3 incomplete, 130 interrupted, 2 usage error, 1 failure.
`

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  const args = [...argv]
  const first = args[0]
  if (first === 'help' || first === '--help' || first === '-h') return { command: 'help' }
  if (first === '--version' || first === 'version') return { command: 'version' }
  if (first !== undefined && !first.startsWith('-') && first !== 'scan' && first !== 'models' && first !== 'report') throw new UsageError(`unknown command "${first}"`)
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
  let template: string | undefined
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
      case '--template': template = value(); break
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
    if (scanOnly) throw new UsageError('secscan report takes only [run-id], --out, --no-open and --template')
    if (positional.length > 1) throw new UsageError(`expected one run id, got ${positional.join(' ')}`)
    if (template !== undefined && template !== '1' && template !== '2') throw new UsageError(`--template is 1 or 2, got "${template}"`)
    return { command: 'report', ...(positional[0] ? { runId: positional[0] } : {}), ...(out ? { out } : {}), noOpen, ...(template === '2' ? { template: 2 as const } : {}) }
  }
  if (template !== undefined) throw new UsageError('--template applies to secscan report only')
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
