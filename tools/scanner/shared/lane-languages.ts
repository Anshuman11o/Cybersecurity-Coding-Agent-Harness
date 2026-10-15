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
