/**
 * Per-type text for report option 2's "Vulnerability Impact" table, read from
 * what the scanner already wrote. Nothing here goes into findings.json; the
 * page alone combines the two parts:
 *
 *   scope   the playbook's own "Scope:" line: what the type is. Built-in
 *           playbooks live in Stage 2's source; the playbook agent's researched
 *           ones in the reports folder's playbook cache.
 *   reason  why the playbook agent picked the type for this codebase, from the
 *           run's playbook-plan.json.
 *
 * Either part may be missing (a class added by hand at review has no reason);
 * the page shows what there is.
 *
 * Zero dependencies.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { StageName } from './build.js'

export interface ClassImpact {
  scope: string | null
  reason: string | null
}

const CLASS_REGISTRY = fileURLToPath(new URL('../../shared/vuln-classes.json', import.meta.url))
const BUILTIN_PLAYBOOKS = fileURLToPath(new URL('../../stage2-hunt-lanes-perfile/src/playbooks/', import.meta.url))

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

/**
 * Plain prose for the page: the playbook agent's researched text carries
 * markdown citation links and "Source: <url>" tails. Drop those (the cited
 * sources stay in the playbook and the plan) and keep everything said.
 */
export function plainText(text: string): string {
  return text
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s*(?:[A-Za-z]+ )?[Ss]ources?:\s+https?:\/\/\S+(?:(?:,\s*|\s+and\s+|\s+)https?:\/\/\S+)*\.?/g, '')
    .replace(/\s*\(?https?:\/\/[^\s)]+\)?/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim()
}

/** The text after "Scope:" on its line, or null. */
export function scopeLine(text: string): string | null {
  const m = text.match(/^Scope:[ \t]*(.+)$/m)
  return m ? plainText(m[1]) || null : null
}

function safeSegment(s: unknown): string | null {
  return typeof s === 'string' && /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..' ? s : null
}

function readScope(path: string): string | null {
  try {
    return existsSync(path) ? scopeLine(readFileSync(path, 'utf-8')) : null
  } catch {
    return null
  }
}

interface PlanEntry { id?: unknown; reason?: unknown }

export function classImpacts(input: { stageDir: (stage: StageName) => string; reportsRoot: string }): Record<string, ClassImpact> {
  const out: Record<string, ClassImpact> = {}
  const entry = (id: string) => (out[id] ??= { scope: null, reason: null })

  const builtins = readJson<Record<string, { playbook?: unknown }>>(CLASS_REGISTRY) ?? {}
  for (const [id, cls] of Object.entries(builtins)) {
    const file = safeSegment(cls?.playbook ?? id)
    if (file) entry(id).scope = readScope(join(BUILTIN_PLAYBOOKS, `${file}.ts`))
  }

  const agentDir = input.stageDir('stage-playbook-agent')
  const overlay = readJson<Record<string, { playbook?: unknown; framework?: unknown; model?: unknown }>>(join(agentDir, 'classes-overlay.json')) ?? {}
  for (const [id, cls] of Object.entries(overlay)) {
    const playbook = safeSegment(cls?.playbook ?? id)
    const framework = safeSegment(cls?.framework ?? 'generic')
    const model = typeof cls?.model === 'string' && cls.model.trim() && cls.model !== '.' && cls.model !== '..' ? encodeURIComponent(cls.model) : null
    if (playbook && framework && model) {
      const scope = readScope(join(input.reportsRoot, 'playbooks', playbook, framework, model, 'playbook.md'))
      if (scope) entry(id).scope = scope
    }
  }

  const plan = readJson<{ decision?: { builtin_classes?: PlanEntry[]; classes?: PlanEntry[] } }>(join(agentDir, 'playbook-plan.json'))
  for (const e of [...(plan?.decision?.builtin_classes ?? []), ...(plan?.decision?.classes ?? [])]) {
    if (typeof e?.id === 'string' && typeof e.reason === 'string' && e.reason.trim()) entry(e.id).reason = plainText(e.reason) || null
  }
  return out
}
