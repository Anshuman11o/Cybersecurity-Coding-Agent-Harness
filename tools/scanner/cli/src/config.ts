/**
 * secscan.config.json — a repository's committed scan settings (plan §1.3, §2.7).
 *
 * In CI there is no one to answer the confirmation screen, so the repository
 * says up front what a scan covers and what it may spend. Locally the
 * confirmation screen's [s] writes the same file.
 *
 *   {
 *     "model": "luna",
 *     "paths": ["src", "api"],
 *     "include": ["**\/*.ts"],
 *     "exclude": ["**\/*.test.ts", "vendor"],
 *     "limits": { "max_cost": 5, "max_files": 500, "max_file_size": "200k",
 *                 "timeout": "30m", "concurrency": 8 }
 *   }
 *
 * Every field is optional; command-line flags override the file.
 *
 * What the file may NOT hold, deliberately: an endpoint, a credential variable
 * or a models overlay. The file is repository content, so on a pull request it
 * can be changed by whoever opened it. A config that could point the scan at
 * its own endpoint while naming the real key's variable would ship the code and
 * the key to a stranger on the next CI run. A custom endpoint is a command-line
 * (or workflow) choice, made by whoever holds the key.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import {
  parseCost, parsePositiveInt, parseSize, parseDuration, normalizeScopePath, compileGlob,
  type RunLimits,
} from '../../stage1-budget-governor/src/limits.js'

export const CONFIG_FILENAME = 'secscan.config.json'

export interface SecscanConfig {
  model?: string
  paths?: string[]
  include?: string[]
  exclude?: string[]
  limits?: {
    max_cost?: number | string
    max_files?: number | string
    max_file_size?: number | string
    timeout?: number | string
    concurrency?: number | string
  }
}

/** The config after validation: limits parsed to their canonical units. */
export interface ResolvedConfig {
  model?: string
  limits: Partial<RunLimits>
}

const TOP_KEYS = new Set(['$schema', '_comment', 'model', 'paths', 'include', 'exclude', 'limits'])
const LIMIT_KEYS = new Set(['max_cost', 'max_files', 'max_file_size', 'timeout', 'concurrency'])
const FORBIDDEN: Record<string, string> = {
  base_url: 'an endpoint',
  'base-url': 'an endpoint',
  api_key_env: 'a credential variable',
  'api-key-env': 'a credential variable',
  api_key: 'a credential',
  models_file: 'a models overlay',
  'models-file': 'a models overlay',
}

function stringList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
    throw new Error(`${CONFIG_FILENAME}: "${what}" must be an array of strings`)
  }
  return v as string[]
}

/** Validate a parsed config object. Throws with the field at fault. */
export function validateConfig(raw: unknown, where = CONFIG_FILENAME): ResolvedConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: expected a JSON object`)
  }
  const obj = raw as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN[k]) {
      throw new Error(
        `${where}: "${k}" is not allowed — a committed config cannot name ${FORBIDDEN[k]}, because anyone who ` +
          `can change the file in a pull request could redirect the scan and its key. Pass it on the command line instead.`,
      )
    }
    if (!TOP_KEYS.has(k)) throw new Error(`${where}: unknown field "${k}"`)
  }
  const out: ResolvedConfig = { limits: {} }
  if (obj.model !== undefined) {
    if (typeof obj.model !== 'string' || !obj.model) throw new Error(`${where}: "model" must be a model key string`)
    out.model = obj.model
  }
  if (obj.paths !== undefined) out.limits.paths = stringList(obj.paths, 'paths').map(normalizeScopePath).filter(Boolean)
  if (obj.include !== undefined) {
    out.limits.include = stringList(obj.include, 'include')
    out.limits.include.forEach(compileGlob)
  }
  if (obj.exclude !== undefined) {
    out.limits.exclude = stringList(obj.exclude, 'exclude')
    out.limits.exclude.forEach(compileGlob)
  }
  if (obj.limits !== undefined) {
    const l = obj.limits as Record<string, unknown>
    if (l == null || typeof l !== 'object' || Array.isArray(l)) throw new Error(`${where}: "limits" must be an object`)
    for (const k of Object.keys(l)) {
      if (!LIMIT_KEYS.has(k)) throw new Error(`${where}: unknown limit "${k}" (expected ${[...LIMIT_KEYS].join(', ')})`)
    }
    const s = (k: string) => (l[k] === undefined || l[k] === null ? undefined : String(l[k]))
    if (s('max_cost') !== undefined) out.limits.max_cost_usd = parseCost(s('max_cost')!, `${where} limits.max_cost`)
    if (s('max_files') !== undefined) out.limits.max_files = parsePositiveInt(s('max_files')!, `${where} limits.max_files`)
    if (s('max_file_size') !== undefined) out.limits.max_file_size = parseSize(s('max_file_size')!, `${where} limits.max_file_size`)
    if (s('timeout') !== undefined) out.limits.timeout_seconds = parseDuration(s('timeout')!, `${where} limits.timeout`)
    if (s('concurrency') !== undefined) out.limits.concurrency = parsePositiveInt(s('concurrency')!, `${where} limits.concurrency`)
  }
  return out
}

export interface LoadedConfig {
  path: string
  sha256: string
  config: ResolvedConfig
}

/** Read and validate a config file; null when it does not exist. */
export function loadConfig(path: string): LoadedConfig | null {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf-8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err: any) {
    throw new Error(`${path}: not valid JSON (${err?.message ?? err})`)
  }
  return {
    path,
    sha256: createHash('sha256').update(text).digest('hex'),
    config: validateConfig(raw, path),
  }
}

/** The file [s] writes: the confirmed model, scope and limits, nothing else. */
export function configFromRun(model: string | null, limits: RunLimits): SecscanConfig {
  const cfg: SecscanConfig = {}
  if (model) cfg.model = model
  if (limits.paths.length) cfg.paths = limits.paths
  if (limits.include.length) cfg.include = limits.include
  if (limits.exclude.length) cfg.exclude = limits.exclude
  const l: NonNullable<SecscanConfig['limits']> = {}
  if (limits.max_cost_usd != null) l.max_cost = limits.max_cost_usd
  if (limits.max_files != null) l.max_files = limits.max_files
  if (limits.max_file_size != null) l.max_file_size = limits.max_file_size
  if (limits.timeout_seconds != null) l.timeout = limits.timeout_seconds
  if (limits.concurrency != null) l.concurrency = limits.concurrency
  if (Object.keys(l).length) cfg.limits = l
  return cfg
}

export function writeConfig(path: string, cfg: SecscanConfig): void {
  // Round-trip through the validator, so [s] can never write a file the next
  // run would refuse.
  validateConfig(cfg, path)
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
}
