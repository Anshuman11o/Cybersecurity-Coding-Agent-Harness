import { EXTENSION_LANGUAGES } from '../stage0-recon/src/recon-contract.js'

/** Huntable v2 languages, shared by recon and lane selection. No runtime side effects. */
export const EXECUTABLE_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript', 'javascript', 'python', 'ruby', 'java', 'go',
  'rust', 'c', 'cpp', 'csharp', 'php', 'kotlin', 'swift',
  'scala', 'solidity', 'dart', 'r', 'perl', 'lua', 'shell',
  'docker', 'graphql',
  // Declarative infrastructure has security effects; key files can embed secrets.
  // Both are huntable, so neither belongs in NON_EXECUTABLE_LANGUAGES/SKIP_REASONS.
  'terraform', 'key-material',
])

/**
 * Agent-added class framework -> file languages (Stage 0.5 agent mode). An
 * agent-added class whose `framework` resolves here is put on every hunt lane
 * in those languages, besides its signal routing; any other framework keeps
 * signal-only routing. A framework that is itself a language Stage 0 assigns
 * (EXTENSION_LANGUAGES) maps to itself; the aliases below cover the rest.
 */
export const FRAMEWORK_LANGUAGE_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  android: ['kotlin', 'java'],
  'c/c++': ['c', 'cpp'],
  'c++': ['c', 'cpp'],
  evm: ['solidity'],
  ethereum: ['solidity'],
})

const FILE_LANGUAGES: ReadonlySet<string> = new Set(Object.values(EXTENSION_LANGUAGES))

/** The file languages an agent-added class's framework covers; [] when it names no language. */
export function frameworkLanguages(framework: string): string[] {
  const key = String(framework ?? '').toLowerCase().trim()
  if (Object.hasOwn(FRAMEWORK_LANGUAGE_ALIASES, key)) return [...FRAMEWORK_LANGUAGE_ALIASES[key]]
  return FILE_LANGUAGES.has(key) ? [key] : []
}
