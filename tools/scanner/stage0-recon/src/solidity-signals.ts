/** Generic lexical Solidity surfaces. No target names or vulnerability labels.
 * Each pass is linear in source/token count; delimiters are paired once.
 */
import type { Signal } from './signal-detector.js'

// Pragma eligibility and arithmetic are separate scans, never a whole-file
// wildcard after every pragma. These bounds also cap malformed-token work.
export const SOLIDITY_ARITHMETIC = /\+\+|--|[+*-]=|(?<![\w$])[A-Za-z_$][\w$]{0,127}[ \t]{0,16}[+*-][ \t]{0,16}[\w$(]/m

function tokens(source: string): string[] {
  const out: string[] = []
  for (let i = 0; i < source.length;) {
    const c = source[i], next = source[i + 1]
    if (/\s/.test(c)) { i++; continue }
    if (c === '/' && next === '/') {
      i += 2
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i = Math.min(i + 2, source.length)
    } else if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
      i++
      out.push('""')
    } else if (/[\w$]/.test(c)) {
      const start = i++
      while (i < source.length && /[\w$.]/.test(source[i]) &&
        (source[i] !== '.' || /\d/.test(c))) i++
      out.push(source.slice(start, i))
    } else {
      const pair = c + next
      if (['++', '--', '+=', '-=', '*=', '/=', '%=', '==', '!=', '>=', '<=', '=>', '||', '&&', '**'].includes(pair)) {
        out.push(pair); i += 2
      } else { out.push(c); i++ }
    }
  }
  return out
}

function allowsBefore(t: string[], minor: number): boolean {
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 'pragma' || t[i + 1] !== 'solidity') continue
    let lower = 0, sawVersion = false
    for (i += 2; i < t.length && ![';', '{', '}'].includes(t[i]); i++) {
      if (t[i] === '||') {
        if (sawVersion && lower < minor) return true
        lower = 0; sawVersion = false
      }
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(t[i])
      if (!match) continue
      sawVersion = true
      if (t[i - 1] !== '<' && t[i - 1] !== '<=') {
        lower = Math.max(lower, Number(match[1]) === 0 ? Number(match[2]) : Infinity)
      }
    }
    if (sawVersion && lower < minor) return true
  }
  return false
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const QUALIFIERS = new Set(['public', 'external', 'internal', 'private', 'payable', 'view', 'pure', 'constant', 'virtual', 'override'])
const TYPE = /^(?:u?int\d*|bytes\d*|address|bool|string|mapping)$/
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '++', '--'])

export function solidityStructuralSignals(source: string): Signal[] {
  const t = tokens(source), pairs = new Map<number, number>(), stack: number[] = []
  for (let i = 0; i < t.length; i++) {
    if (['(', '[', '{'].includes(t[i])) stack.push(i)
    else if ([')', ']', '}'].includes(t[i])) {
      const open = stack[stack.length - 1]
      if (open !== undefined && t[open] === ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[t[i]]) {
        stack.pop(); pairs.set(open, i)
      }
    }
  }
  const signals = new Set<Signal>()
  const implicitPublic = allowsBefore(t, 5)
  const legacyArithmetic = allowsBefore(t, 8)

  for (let c = 0; c < t.length; c++) {
    if (!['contract', 'library', 'interface'].includes(t[c])) continue
    let open = c + 1
    while (open < Math.min(t.length, c + 128) && !['{', ';', '}'].includes(t[open])) open++
    const close = pairs.get(open)
    if (t[open] !== '{' || close === undefined) continue
    const storage = new Set<string>()
    const functions: { header: string[]; begin: number; end: number; parameters: string[] }[] = []
    for (let i = open + 1; i < close;) {
      const start = i
      while (i < close && t[i] !== ';' && t[i] !== '{') {
        i = pairs.has(i) ? pairs.get(i)! + 1 : i + 1
      }
      const header = t.slice(start, i)
      if (t[i] === '{') {
        const end = pairs.get(i)
        if (end === undefined) break
        // A historical function named after its contract is a constructor,
        // not an externally callable entry point after deployment.
        if (['function', 'fallback', 'receive'].includes(header[0]) &&
            !(header[0] === 'function' && header[1] === t[c + 1])) {
          const paramStart = t.indexOf('(', start)
          const paramEnd = pairs.get(paramStart)
          if (paramEnd !== undefined && paramEnd < i) functions.push({
            header: t.slice(paramEnd + 1, i), begin: i + 1, end,
            parameters: t.slice(paramStart + 1, paramEnd),
          })
        }
        i = end + 1
      } else {
        if (header.length > 1 && !['event', 'error', 'using', 'function', 'import', 'pragma'].includes(header[0])) {
          // The last identifier before an initializer is the declared member.
          const before = header.slice(0, header.includes('=') ? header.indexOf('=') : header.length)
          const name = before.filter(x => IDENTIFIER.test(x) && !QUALIFIERS.has(x)).pop()
          if (name) storage.add(name)
        }
        i++
      }
    }
    for (const f of functions) {
      let customModifier = false
      for (let i = 0; i < f.header.length; i++) {
        if (['returns', 'override'].includes(f.header[i]) && f.header[i + 1] === '(') {
          let depth = 1
          for (i += 2; i < f.header.length && depth; i++) {
            if (f.header[i] === '(') depth++
            if (f.header[i] === ')') depth--
          }
          i--
        } else if (IDENTIFIER.test(f.header[i]) && !QUALIFIERS.has(f.header[i])) customModifier = true
      }
      const explicit = f.header.find(x => ['public', 'external', 'private', 'internal'].includes(x))
      const callable = explicit ? ['public', 'external'].includes(explicit) : implicitPublic
      if (f.header.some(x => ['view', 'pure', 'constant'].includes(x))) continue
      // A first-statement revert/throw cannot receive value or reach writes.
      const alwaysRejects = t[f.begin] === 'throw' || t[f.begin] === 'revert' ||
        (['require', 'assert'].includes(t[f.begin]) && t[f.begin + 1] === '(' &&
          t[f.begin + 2] === 'false' && t[f.begin + 3] === ')')
      if (alwaysRejects) continue
      let inlineAuth = false
      let hasPrecondition = false
      let rejectsValue = false
      for (let i = f.begin; i < f.end; i++) {
        if (['require', 'assert', 'if'].includes(t[i]) && t[i + 1] === '(' && pairs.has(i + 1)) {
          hasPrecondition = true
          const end = Math.min(pairs.get(i + 1)!, i + 512)
          const after = pairs.get(i + 1)! + 1
          const condition = t.slice(i + 2, end)
          const denial = t[i] !== 'if' || condition.includes('==') || ['throw', 'revert', 'return'].includes(t[after]) ||
            (t[after] === '{' && ['throw', 'revert', 'return'].includes(t[after + 1]))
          if (denial && /\b(?:msg \. sender|tx \. origin)\b/.test(condition.join(' '))) inlineAuth = true
          const check = condition.join(' ')
          if ((t[i] !== 'if' && ['msg . value == 0', '0 == msg . value'].includes(check)) ||
              (t[i] === 'if' && denial && ['msg . value != 0', 'msg . value > 0'].includes(check))) rejectsValue = true
        }
      }
      const unguardedEntry = callable && !customModifier && !inlineAuth
      if (unguardedEntry && !rejectsValue && f.header.includes('payable')) signals.add('route_handler')
      const shadowed = new Set<string>()
      const inputs = new Set<string>()
      const numericInputs = new Set<string>()
      for (const parameter of f.parameters.join(' ').split(',')) {
        const words = parameter.match(/[A-Za-z_$][\w$]*/g) ?? []
        const name = words[words.length - 1]
        if (words.length > 1 && !QUALIFIERS.has(name) && !['memory', 'storage', 'calldata'].includes(name)) {
          inputs.add(name)
          shadowed.add(name)
          if (/^u?int\d*$/.test(words[0])) numericInputs.add(name)
        }
      }
      for (const segment of [f.parameters, t.slice(f.begin, f.end)]) {
        for (let i = 0; i < segment.length - 1; i++) {
          if (!TYPE.test(segment[i]) && !/^[A-Z]/.test(segment[i])) continue
          let end = i + 1
          while (end < Math.min(segment.length, i + 128)) {
            if (segment[end] === '[') {
              while (end < Math.min(segment.length, i + 128) && segment[end] !== ']') end++
              end++
            } else if (['memory', 'storage', 'calldata', 'payable'].includes(segment[end])) end++
            else break
          }
          if (IDENTIFIER.test(segment[end] ?? '') && ['=', ';', ',', ')', undefined].includes(segment[end + 1])) shadowed.add(segment[end])
        }
      }
      for (let i = f.begin; i < f.end; i++) {
        const word = t[i]
        if (unguardedEntry && ['selfdestruct', 'suicide'].includes(word) && t[i + 1] === '(') signals.add('route_handler')
        if (unguardedEntry && word === '.' && ['transfer', 'send'].includes(t[i + 1]) && t[i + 2] === '(' &&
            !(t[i + 3] === '0' && t[i + 4] === ')')) signals.add('route_handler')
        if (unguardedEntry && word === '.' && t[i + 1] === 'call' &&
          ((t[i + 2] === '.' && t[i + 3] === 'value' && !(t[i + 5] === '0' && t[i + 6] === ')')) ||
           (t[i + 2] === '{' && t.slice(i + 3, Math.min(pairs.get(i + 2) ?? i + 3, i + 131)).includes('value')))) signals.add('route_handler')
        if (!storage.has(word) || shadowed.has(word)) continue
        let end = i + 1
        while (end < Math.min(f.end, i + 128)) {
          if (t[end] === '[' && pairs.has(end)) end = pairs.get(end)! + 1
          else if (t[end] === '.' && IDENTIFIER.test(t[end + 1] ?? '')) {
            if (unguardedEntry && ['push', 'pop'].includes(t[end + 1]) && t[end + 2] === '(') signals.add('route_handler')
            end += 2
          } else break
        }
        const mutation = ASSIGN.has(t[end]) || ['++', '--', 'delete'].includes(t[i - 1])
        if (mutation) {
          let rhsEnd = end + 1
          while (rhsEnd < Math.min(f.end, end + 128) && ![';', '}'].includes(t[rhsEnd])) rhsEnd++
          const expression = t.slice(Math.max(f.begin, i - 1), rhsEnd)
          const text = expression.join(' ')
          const externallyFed = expression.some(x => inputs.has(x)) || /\b(?:msg \. (?:sender|value|data)|tx \. origin)\b/.test(text)
          // Prioritize caller-controlled state over constant setters and loop
          // counters. Neither the surface nor its absence proves correctness.
          if (unguardedEntry && externallyFed) {
            signals.add('route_handler')
            // Existing preconditions need analysis by the hunt; do not treat
            // a checked arithmetic path like an assertion-free input boundary.
            const rhs = t.slice(end, rhsEnd)
            const arithmeticOps = new Set(['+', '-', '*', '**', '+=', '-=', '*='])
            // An input used only as a mapping/array key is not an arithmetic
            // operand. Follow direct operands, leaving casts/dataflow to hunt.
            const arithmeticInput = rhs.some((x, index) =>
              (numericInputs.has(x) && rhs[index - 1] !== '.' &&
                (arithmeticOps.has(rhs[index - 1]) || arithmeticOps.has(rhs[index + 1]))) ||
              (x === 'msg' && rhs[index + 1] === '.' && rhs[index + 2] === 'value' &&
                (arithmeticOps.has(rhs[index - 1]) || arithmeticOps.has(rhs[index + 3]))))
            const accumulating = ['+=', '-=', '*='].includes(t[end]) || rhs.slice(1).includes(word)
            if (legacyArithmetic && !hasPrecondition && accumulating && arithmeticInput &&
                SOLIDITY_ARITHMETIC.test(text)) signals.add('model_write')
          }
        }
      }
    }
    c = close
  }
  return [...signals]
}
