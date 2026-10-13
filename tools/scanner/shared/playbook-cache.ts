/** Playbooks are data, never executable modules. Cache keys cannot supply paths. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { reportsRoot, type RunContext } from './run-context.js'
import { assertSlug, validateOverlay, type ClassRegistry, type ClassesOverlay, type OverlayEntry, type SignalClassMap } from './playbook-overlay.js'

export interface PlaybookMeta extends OverlayEntry {
  class_id: string
  /** Every URL the research output cited, in order; may be empty. */
  source_urls: string[]
  /** Cited URLs labelled against that call's own search sources. Entries cached before labelling lack both. */
  verified_source_urls?: string[]
  unverified_source_urls?: string[]
  queries: string[]
  created_at: string
}
export interface CachedPlaybook { text: string; meta: PlaybookMeta }
export interface PlaybookRecord {
  class_id: string
  kind: 'builtin' | 'agent'
  source_urls: string[]
  verified_source_urls?: string[]
  unverified_source_urls?: string[]
  source_file: string | null
  sha256: string
  framework: string | null
  model: string | null
  queries: string[]
  created_at: string | null
}

export const textHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export function cacheRoot(ctx?: RunContext): string { return join(reportsRoot(ctx), 'playbooks') }

function modelSegment(model: string): string {
  if (!model.trim() || model === '.' || model === '..') throw new Error('Invalid cache model')
  return encodeURIComponent(model)
}

export function cacheDirectory(root: string, id: string, framework: string, model: string): string {
  assertSlug(id, 'class id')
  assertSlug(framework, 'framework')
  // Check each existing component so a cache entry cannot redirect reads or writes.
  let dir = root
  for (const part of ['', id, framework, modelSegment(model)]) {
    dir = join(dir, part)
    if (existsSync(dir) && (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())) {
      throw new Error(`Cache directory is not a regular directory: ${dir}`)
    }
  }
  return dir
}

export function readCachedPlaybook(root: string, id: string, framework: string, model: string, expectedHash?: string): CachedPlaybook | null {
  const dir = cacheDirectory(root, id, framework, model)
  if (!existsSync(dir)) return null
  for (const name of ['playbook.md', 'meta.json']) {
    const file = join(dir, name)
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`Incomplete or unsafe playbook cache: ${dir}`)
  }
  const text = readFileSync(join(dir, 'playbook.md'), 'utf8')
  const meta: PlaybookMeta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  if (meta.class_id !== id || meta.playbook !== id || meta.framework !== framework || meta.model !== model ||
      textHash(text) !== meta.sha256 || (expectedHash && expectedHash !== meta.sha256)) {
    throw new Error(`Playbook cache identity or sha256 mismatch: ${id}/${framework}/${model}`)
  }
  const strings = (v: unknown) => Array.isArray(v) && v.every(s => typeof s === 'string')
  if (!strings(meta.source_urls) || !Array.isArray(meta.queries) || !Number.isFinite(Date.parse(meta.created_at)) ||
      [meta.verified_source_urls, meta.unverified_source_urls].some(v => v !== undefined && !strings(v))) {
    throw new Error(`Missing provenance for ${id}`)
  }
  return { text, meta }
}

export function writeCachedPlaybook(root: string, text: string, meta: Omit<PlaybookMeta, 'sha256'>): CachedPlaybook {
  const existing = readCachedPlaybook(root, meta.class_id, meta.framework, meta.model)
  if (existing) return existing
  const dir = cacheDirectory(root, meta.class_id, meta.framework, meta.model)
  mkdirSync(dirname(dir), { recursive: true })
  const tmp = mkdtempSync(dir + '.tmp-')
  const entry = { text, meta: { ...meta, sha256: textHash(text) } }
  try {
    writeFileSync(join(tmp, 'playbook.md'), text)
    writeFileSync(join(tmp, 'meta.json'), JSON.stringify(entry.meta, null, 2) + '\n')
    try { renameSync(tmp, dir) } catch (error: any) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
      // Another process published a complete entry first. Never overwrite it.
      return readCachedPlaybook(root, meta.class_id, meta.framework, meta.model)!
    }
    return entry
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

export function listCachedPlaybooks(root: string, model: string): PlaybookMeta[] {
  if (!existsSync(root)) return []
  const entries: PlaybookMeta[] = []
  for (const id of readdirSync(root).sort()) {
    assertSlug(id, 'cached class id')
    const classDir = join(root, id)
    if (!lstatSync(classDir).isDirectory() || lstatSync(classDir).isSymbolicLink()) throw new Error('Unsafe cache class directory')
    for (const framework of readdirSync(classDir).sort()) {
      const entry = readCachedPlaybook(root, id, framework, model)
      if (entry) entries.push(entry.meta)
    }
  }
  return entries
}

export function agentPlaybookRecord(meta: PlaybookMeta): PlaybookRecord {
  return {
    class_id: meta.class_id, kind: 'agent', source_urls: meta.source_urls,
    // Never invented for an entry cached before labelling.
    ...(meta.verified_source_urls ? { verified_source_urls: meta.verified_source_urls } : {}),
    ...(meta.unverified_source_urls ? { unverified_source_urls: meta.unverified_source_urls } : {}),
    source_file: null, sha256: meta.sha256, framework: meta.framework,
    model: meta.model, queries: meta.queries, created_at: meta.created_at,
  }
}

export function builtinPlaybookRecord(classId: string, moduleName: string, text: string): PlaybookRecord {
  return {
    class_id: classId, kind: 'builtin', source_urls: [],
    source_file: `tools/scanner/stage2-hunt-lanes-perfile/src/playbooks/${moduleName}.ts`,
    sha256: textHash(text), framework: null, model: null, queries: [], created_at: null,
  }
}

/** Stage 1 hook: include cached text in deterministic prompt estimates. */
export function addOverlayPlaybookSizes(
  registry: ClassRegistry, sizes: Map<string, number>, overlay: ClassesOverlay | null,
  signals: SignalClassMap, root: string = cacheRoot(),
): void {
  if (!overlay) return
  validateOverlay(overlay, registry, signals)
  for (const [id, entry] of Object.entries(overlay)) {
    const cached = readCachedPlaybook(root, id, entry.framework, entry.model, entry.sha256)
    if (!cached) throw new Error(`Missing cached playbook for ${id}`)
    registry[id] = { playbook: entry.playbook, codes: entry.codes }
    sizes.set(entry.playbook, cached.text.length)
  }
}
