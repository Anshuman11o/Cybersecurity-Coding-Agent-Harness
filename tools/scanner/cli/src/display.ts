/**
 * Formatting shared by the confirmation screen, the progress line, the models
 * listing and the end-of-run summary.
 */
import type { ModelInfo } from './registry.js'

/**
 * Display names for Stage 0's language keys (stage0-recon/src/recon.ts,
 * SOURCE_EXTENSIONS). Task 1b's recon v3 will widen Stage 0's language list;
 * a key missing here is shown as Stage 0 spells it rather than dropped.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', ruby: 'Ruby', go: 'Go',
  rust: 'Rust', java: 'Java', kotlin: 'Kotlin', scala: 'Scala', php: 'PHP', csharp: 'C#',
  solidity: 'Solidity', vue: 'Vue', svelte: 'Svelte', sql: 'SQL', shell: 'Shell',
  c: 'C', cpp: 'C++', swift: 'Swift', dart: 'Dart',
}

/**
 * Stage 0 keys that are markup, styling or data rather than code. They are
 * left out of the language shares: "JSON 12%" says nothing about what the
 * scanner's measured results apply to.
 */
const NOT_CODE = new Set(['yaml', 'json', 'toml', 'html', 'css', 'docker', 'protobuf', 'graphql', 'markdown', 'xml'])

export function languageName(key: string): string {
  return LANGUAGE_NAMES[key] ?? key
}

export interface LanguageShare {
  key: string
  name: string
  files: number
  share: number
  /** True when the selected model has a lab result in this language. */
  measured: boolean
}

export function languageShares(
  byLanguage: Record<string, { count: number }> | undefined,
  measuredLanguages: readonly string[],
): LanguageShare[] {
  const entries = Object.entries(byLanguage ?? {}).filter(([k, v]) => !NOT_CODE.has(k) && v.count > 0)
  const total = entries.reduce((s, [, v]) => s + v.count, 0)
  return entries
    .map(([key, v]) => ({
      key,
      name: languageName(key),
      files: v.count,
      share: total > 0 ? v.count / total : 0,
      measured: measuredLanguages.includes(key),
    }))
    .sort((a, b) => b.files - a.files || a.key.localeCompare(b.key))
}

export function usd(n: number | null | undefined, digits = 2): string {
  return n == null ? 'unpriced' : `$${n.toFixed(digits)}`
}

export function int(n: number): string {
  return n.toLocaleString('en-US')
}

export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KiB`
  return `${n} B`
}

/** "src/ api/ workers/" — the most common top-level directories, most files first. */
export function topDirs(files: readonly string[], max = 6): string[] {
  const counts = new Map<string, number>()
  for (const f of files) {
    const i = f.indexOf('/')
    const d = i < 0 ? '(root files)' : f.slice(0, i) + '/'
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d)
  return sorted.length > max ? [...sorted.slice(0, max), `+${sorted.length - max} more`] : sorted
}

export function measuredLabel(m: ModelInfo): string {
  if (!m.benchmark) return 'unmeasured'
  return `measured: recall ${m.benchmark.recall}, localization ${m.benchmark.localization} on Juice Shop (${usd(m.benchmark.cost_usd)}, ${m.benchmark.run})`
}

/** Where `secscan models` sends the reader for what the measured figures mean. */
export const MODELS_README = 'https://github.com/anshuman11o/secscan/blob/main/USAGE.md#models-and-cost'

/**
 * `secscan models`. Lab-only entries (models.json `lab_only`) and lab
 * transports are hidden unless `all`. The npm package ships without the
 * lab-only entries, so there `--all` adds nothing.
 */
export function renderModels(models: ModelInfo[], all: boolean): string {
  const shown = models.filter(m => all || (!m.labOnly && m.transport === 'openai'))
  const rows = shown.map(m => [
    (m.isDefault ? '* ' : '  ') + m.key,
    m.model,
    m.price ? `$${m.price.input} / $${m.price.output}` + (m.priceAsOf ? ` (${m.priceAsOf})` : '') : 'unpriced',
    m.measured ? `measured (${m.benchmark!.recall} recall, ${m.benchmark!.localization} localized)` : 'unmeasured',
    m.transport === 'openai' ? `${m.apiKeyEnv} ${m.keyPresent ? 'found' : 'not set'}` : `lab transport: ${m.transport}`,
    m.origin === 'registry' ? '' : m.origin,
  ])
  const head = ['  KEY', 'MODEL', 'PRICE in / out per MTok', 'STATUS', 'CREDENTIAL', 'SOURCE']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  const hidden = models.length - shown.length
  return [
    line(head),
    ...rows.map(line),
    '',
    '* default. Measured = scored by the lab on OWASP Juice Shop (TypeScript), 97 known vulnerabilities;',
    `  recall is exact line + class, localization is within 15 lines. What the figures mean: ${MODELS_README}`,
    '  Every other model, every --models-file entry and every --base-url endpoint is unmeasured.',
    ...(hidden ? [`  ${hidden} lab-only model(s) hidden; --all shows them.`] : []),
  ].join('\n')
}
