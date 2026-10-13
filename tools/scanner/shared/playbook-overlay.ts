/** Additive class overlays. No model calls; safe to import in deterministic stages. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPath, type Provider } from './run-paths.js'
import { assertUpstream } from './meta.js'

export const PLAYBOOK_STAGE = 'stage-playbook-agent' as const
export const CLASS_SELECTION_FILE = 'class-selection.json'
export interface ClassEntry { playbook: string; codes: string[] }
export type ClassRegistry = Record<string, ClassEntry>
export interface SignalClassMap { floor: string[]; signals: Record<string, string[]> }
export interface OverlayEntry extends ClassEntry {
  signals: string[]
  framework: string
  model: string
  sha256: string
}
export type ClassesOverlay = Record<string, OverlayEntry>
/** The agent's complete class set for a run: selected built-ins plus additional classes. */
export interface ClassSelection {
  schema: 'secscan.class-selection/1'
  created_at: string
  model: string
  builtin: string[]
  added: string[]
  classes: string[]
}

export function assertSlug(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(value)) {
    throw new Error(`Invalid ${label}: expected a lowercase kebab-case identifier`)
  }
}

/** Every class carries at least one code; code text is free-form (non-blank, single-line, at most 100 chars) and kept as written. */
export function validateOverlay(overlay: ClassesOverlay, builtins: ClassRegistry, map: SignalClassMap): void {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw new Error('Invalid classes overlay')
  for (const [id, entry] of Object.entries(overlay)) {
    assertSlug(id, 'class id')
    if (Object.hasOwn(builtins, id)) throw new Error(`Overlay cannot replace built-in class ${id}`)
    if (!entry || entry.playbook !== id) throw new Error(`Overlay playbook must equal class id ${id}`)
    assertSlug(entry.framework, 'framework')
    if (!Array.isArray(entry.codes) || !entry.codes.length ||
        entry.codes.some(c => typeof c !== 'string' || !c.trim() || c.length > 100 || /[\n\r\u2028\u2029]/.test(c))) {
      throw new Error(`Invalid codes for ${id}`)
    }
    if (!Array.isArray(entry.signals) || !entry.signals.length ||
        entry.signals.some(s => !Object.hasOwn(map.signals, s))) throw new Error(`Unknown or missing signals for ${id}`)
    if (typeof entry.model !== 'string' || !entry.model.trim() || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Missing model or text hash for ${id}`)
    }
  }
}

export function mergeClassTables<T extends SignalClassMap>(
  builtins: ClassRegistry, map: T, overlay: ClassesOverlay | null,
): { registry: ClassRegistry; signalMap: T } {
  // Preserve order, references and serialisation when no overlay exists.
  if (!overlay || Object.keys(overlay).length === 0) return { registry: builtins, signalMap: map }
  validateOverlay(overlay, builtins, map)
  const registry = { ...builtins }
  const signalMap = { ...map, signals: Object.fromEntries(Object.entries(map.signals).map(([s, ids]) => [s, [...ids]])) }
  for (const [id, entry] of Object.entries(overlay).sort(([a], [b]) => a.localeCompare(b))) {
    registry[id] = { playbook: entry.playbook, codes: [...entry.codes] }
    for (const signal of new Set(entry.signals)) signalMap.signals[signal].push(id)
  }
  return { registry, signalMap }
}

export function readClassesOverlay(provider: Provider): ClassesOverlay | null {
  const file = join(runPath(provider, PLAYBOOK_STAGE), 'classes-overlay.json')
  if (!existsSync(file)) return null
  assertUpstream(provider, PLAYBOOK_STAGE)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function validateClassSelection(sel: ClassSelection, builtins: ClassRegistry, overlay: ClassesOverlay | null): void {
  if (!sel || sel.schema !== 'secscan.class-selection/1') throw new Error('Invalid class selection schema')
  if (![sel.builtin, sel.added, sel.classes].every(Array.isArray)) throw new Error('Invalid class selection')
  for (const id of sel.builtin) if (!Object.hasOwn(builtins, id)) throw new Error(`Selected built-in class ${id} is not a built-in`)
  for (const id of sel.added) {
    if (Object.hasOwn(builtins, id) || !overlay || !Object.hasOwn(overlay, id)) throw new Error(`Selected additional class ${id} is not in the overlay`)
  }
  const all = [...sel.builtin, ...sel.added]
  if (new Set(all).size !== all.length) throw new Error('Duplicate class in selection')
  if (JSON.stringify(sel.classes) !== JSON.stringify([...all].sort())) throw new Error('Selection classes must be the sorted union of builtin and added')
}

export function readClassSelection(provider: Provider): ClassSelection | null {
  const file = join(runPath(provider, PLAYBOOK_STAGE), CLASS_SELECTION_FILE)
  if (!existsSync(file)) return null
  assertUpstream(provider, PLAYBOOK_STAGE)
  const sel: ClassSelection = JSON.parse(readFileSync(file, 'utf8'))
  const builtins: ClassRegistry = JSON.parse(readFileSync(new URL('./vuln-classes.json', import.meta.url), 'utf8'))
  validateClassSelection(sel, builtins, readClassesOverlay(provider))
  return sel
}
