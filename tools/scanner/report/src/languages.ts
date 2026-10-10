/**
 * File extension -> language, for the coverage section (plan §4.1.3).
 *
 * Only programming languages count toward "code lines"; markup, styles and
 * data are listed under their own names but excluded from the code-line
 * ratio, so a repo full of JSON fixtures does not read as poorly covered.
 */
import { basename, extname } from 'path'

const CODE: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala',
  '.go': 'Go', '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.fs': 'F#', '.vb': 'Visual Basic',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.hh': 'C++',
  '.rs': 'Rust', '.swift': 'Swift', '.m': 'Objective-C', '.mm': 'Objective-C', '.dart': 'Dart',
  '.lua': 'Lua', '.pl': 'Perl', '.pm': 'Perl', '.r': 'R', '.ex': 'Elixir', '.exs': 'Elixir',
  '.erl': 'Erlang', '.clj': 'Clojure', '.hs': 'Haskell', '.sol': 'Solidity', '.vue': 'Vue',
  '.svelte': 'Svelte', '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.ps1': 'PowerShell',
  '.sql': 'SQL', '.tf': 'Terraform', '.groovy': 'Groovy',
}

const OTHER: Record<string, string> = {
  '.html': 'HTML', '.htm': 'HTML', '.ejs': 'HTML template', '.hbs': 'HTML template', '.pug': 'HTML template',
  '.css': 'CSS', '.scss': 'CSS', '.sass': 'CSS', '.less': 'CSS',
  '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML', '.xml': 'XML', '.toml': 'TOML', '.ini': 'INI',
  '.md': 'Markdown', '.txt': 'Text', '.svg': 'SVG', '.env': 'Env',
}

const BY_NAME: Record<string, string> = {
  Dockerfile: 'Dockerfile', Makefile: 'Makefile', Jenkinsfile: 'Groovy', Gemfile: 'Ruby', Rakefile: 'Ruby',
}

export function languageOf(path: string): { language: string; code: boolean } {
  const name = basename(path)
  if (BY_NAME[name]) return { language: BY_NAME[name], code: name !== 'Makefile' && name !== 'Dockerfile' }
  const ext = extname(name).toLowerCase()
  if (CODE[ext]) return { language: CODE[ext], code: true }
  if (OTHER[ext]) return { language: OTHER[ext], code: false }
  return { language: ext ? ext.slice(1) : 'other', code: false }
}
