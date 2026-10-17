/**
 * The package README's command guide, rendered as Markdown from cliDefinition()
 * in args.ts, the same definition `secscan help` prints. The README keeps it
 * between two markers, and help.test.ts fails when that block differs from
 * what this file renders. After changing a command or an option, rewrite it:
 *
 *   npx tsx src/help-doc.ts --write [README]   (default: ../package/README.md)
 *   npx tsx src/help-doc.ts --check [README]   exit 1 when the block is stale
 *   npx tsx src/help-doc.ts                    print the guide
 *
 * The custom endpoint's default key variable is read from the registry, as
 * `secscan help` reads it.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  COMMAND_NAMES, cliDefinition, optionText,
  type CliDefinition, type CliMode, type OptionDef, type OptionGroup,
} from './args.js'
import { genericNames, shippedCliMode } from './registry.js'
import { isEntryPoint } from '../../shared/entry.js'

export const GUIDE_START = '<!-- commands:start -->'
export const GUIDE_END = '<!-- commands:end -->'
export const DEFAULT_README = join(dirname(fileURLToPath(import.meta.url)), '../../package/README.md')

/**
 * Markdown-safe text. Outside code spans, characters Markdown would read as
 * markup or HTML are escaped (`<dir>` would otherwise vanish as a tag); in a
 * table cell a pipe is escaped everywhere, as GFM requires.
 */
function md(text: string, cell = false): string {
  return text.split(/(`[^`]*`)/).map(part => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return cell ? part.replace(/\|/g, '\\|') : part
    return part.replace(/[\\<>*_[\]|]/g, c => (c === '|' && !cell ? c : `\\${c}`))
  }).join('')
}

const code = (text: string): string => `\`${text}\``
const plain = (text: string): string => text.replace(/`/g, '')

function table(head: string[], rows: string[][]): string[] {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ]
}

/** "Also works with `secscan models`." for the commands beyond scan that take a group's options. */
function alsoWith(group: OptionGroup): string[] {
  const lines: string[] = []
  for (const command of COMMAND_NAMES.filter(c => c !== 'scan')) {
    const taken = group.options.filter(o => o.commands.includes(command))
    if (!taken.length) continue
    lines.push(taken.length === group.options.length
      ? `Also works with ${code(`secscan ${command}`)}.`
      : `${taken.map(o => code(o.name)).join(', ')} also work${taken.length === 1 ? 's' : ''} with ${code(`secscan ${command}`)}.`)
  }
  return lines.length ? [lines.join(' '), ''] : []
}

/** `-y`, `--yes` / `--resume [run-id]`. */
const label = (o: OptionDef): string =>
  [o.short, o.value ? `${o.name} ${o.value}` : o.name].filter((s): s is string => Boolean(s)).map(code).join(', ')

function optionRows(group: OptionGroup): string[][] {
  return group.options.map(o => [label(o), md(optionText(o, false), true), o.default ? md(o.default, true) : ''])
}

function guideFrom(def: CliDefinition): string {
  const commandOptions = def.commands.flatMap(c => c.options ?? [])
  const examples = def.commands.flatMap(c => (c.examples ?? []).filter(e => e.featured))
  const lines = [
    '### Commands',
    '',
    ...table(['Command', 'What it does'], def.commands.map(c => [
      code(`secscan ${c.synopsis}`),
      md(c.summary, true),
    ])),
    '',
    ...(commandOptions.length ? [
      ...table(['Option', 'What it does', 'Command'], commandOptions.map(o => [
        label(o),
        md(optionText(o, false), true),
        o.commands.map(c => code(`secscan ${c}`)).join(', '),
      ])),
      '',
    ] : []),
    ...def.groups.flatMap(g => [
      `### ${md(g.title)}`,
      '',
      ...alsoWith(g),
      ...table(['Option', 'What it does', 'Default'], optionRows(g)),
      '',
    ]),
    '### Examples',
    '',
    '```sh',
    ...examples.flatMap((e, i) => [...(i ? [''] : []), `# ${plain(e.note)}`, e.command]),
    '```',
    '',
    '### Exit codes',
    '',
    ...table(['Code', 'Meaning'], def.exitCodes.map(e => [code(String(e.code)), md(e.meaning, true)])),
  ]
  return lines.join('\n')
}

/**
 * The README's command guide: the Markdown between the markers. The README is
 * the package's, so the guide documents the package's mode (one fixed model,
 * no model options) unless another mode is passed.
 */
export function renderCommandGuide(customKeyDefault: string, mode: CliMode = shippedCliMode()): string {
  return guideFrom(cliDefinition(customKeyDefault, mode))
}

/** The guide with its markers, exactly as the README holds it. */
export function guideBlock(guide: string): string {
  return `${GUIDE_START}\n\n${guide}\n\n${GUIDE_END}`
}

/** The README with its guide block replaced. Throws unless each marker appears once, in order. */
export function replaceGuide(readme: string, guide: string): string {
  const start = readme.indexOf(GUIDE_START)
  const end = readme.indexOf(GUIDE_END)
  if (start < 0 || end < start || readme.indexOf(GUIDE_START, start + 1) >= 0 || readme.indexOf(GUIDE_END, end + 1) >= 0) {
    throw new Error(`the README needs exactly one ${GUIDE_START} followed by one ${GUIDE_END}`)
  }
  return readme.slice(0, start) + guideBlock(guide) + readme.slice(end + GUIDE_END.length)
}

if (isEntryPoint(import.meta.url)) {
  const [mode, path] = process.argv.slice(2)
  const guide = renderCommandGuide(genericNames().api_key_env_default)
  if (mode !== '--write' && mode !== '--check') {
    process.stdout.write(guide + '\n')
  } else {
    const readmePath = resolve(path ?? DEFAULT_README)
    if (!existsSync(readmePath)) {
      process.stderr.write(`help-doc: ${readmePath} does not exist\n`)
      process.exit(2)
    }
    const before = readFileSync(readmePath, 'utf-8')
    const after = replaceGuide(before, guide)
    if (mode === '--check') {
      if (after !== before) {
        process.stderr.write(`help-doc: the command guide in ${readmePath} is stale; run: npx tsx src/help-doc.ts --write\n`)
        process.exit(1)
      }
      process.stdout.write(`help-doc: ${readmePath} is current\n`)
    } else {
      if (after !== before) writeFileSync(readmePath, after)
      process.stdout.write(`help-doc: ${after === before ? 'already current' : 'rewrote the command guide in'} ${readmePath}\n`)
    }
  }
}
