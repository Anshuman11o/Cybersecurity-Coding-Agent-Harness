/**
 * The CLI's view of the model registry (plan §2.5).
 *
 * The registry module resolves overlays and the generic endpoint from the
 * environment once, when it is first imported — exactly as each stage does. So
 * the CLI writes the model flags into the environment FIRST and only then
 * imports it, and every stage it launches inherits the same environment. The
 * CLI and the stages therefore see one registry, built by one loader.
 *
 * The generic endpoint's variable names are read from models.json as data; this
 * file names no model, endpoint or credential.
 */
import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { ModelFlags } from './args.js'

const SHARED = join(dirname(fileURLToPath(import.meta.url)), '../../shared')

interface GenericNames {
  key: string
  model_env: string
  base_url_env: string
  api_key_env_env: string
  api_key_env_default: string
  price_env: string
}

export function genericNames(): GenericNames {
  const raw = JSON.parse(readFileSync(join(SHARED, 'models.json'), 'utf-8'))
  const g = raw.generic_openai_compatible
  if (!g) throw new Error('models.json has no generic_openai_compatible template, so --base-url is unavailable')
  return g
}

/**
 * Put the model flags into `env`. Returns the registry key the flags select,
 * or undefined to leave the choice to the config file or the default.
 */
export function applyModelFlags(flags: ModelFlags, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (flags.modelsFile) env.SCANNER_MODELS_FILE = resolve(flags.modelsFile)
  if (flags.baseUrl) {
    const g = genericNames()
    env[g.base_url_env] = flags.baseUrl
    env[g.model_env] = flags.model!
    if (flags.apiKeyEnv) env[g.api_key_env_env] = flags.apiKeyEnv
    if (flags.price) env[g.price_env] = flags.price
    return g.key
  }
  return flags.model
}

export interface ModelInfo {
  key: string
  label: string
  model: string
  origin: 'registry' | 'overlay' | 'generic'
  transport: 'openai' | 'claude-cli'
  apiKeyEnv: string
  keyPresent: boolean
  baseUrl: string | null
  price: { input: number; cached_input?: number; cache_write?: number; output: number } | null
  priceAsOf: string | null
  measured: boolean
  benchmark: {
    corpus: string
    languages: string[]
    recall: string
    localization: string
    cost_usd: number
    run: string
    source: string
  } | null
  maxConcurrency: number | null
  isDefault: boolean
}

export type Registry = Awaited<ReturnType<typeof loadRegistryModules>>

/** Import the registry. Call only after applyModelFlags(). */
export async function loadRegistryModules() {
  const models = await import('../../shared/models.js')
  const provider = await import('../../shared/provider.js')

  const info = (raw: string): ModelInfo => {
    const key = models.assertProvider(raw, 'model')
    const t = models.targetFor(key)
    const cfg = provider.clientConfigFor(key)
    return {
      key,
      label: t.label,
      model: provider.modelFor(key),
      origin: models.targetOrigin(key),
      transport: provider.transportFor(key),
      apiKeyEnv: t.api_key_env,
      // Presence only: the key's value never leaves this check.
      keyPresent: Boolean(process.env[t.api_key_env]),
      baseUrl: cfg.baseURL ?? null,
      price: provider.pricingFor(key),
      priceAsOf: provider.priceAsOf(key),
      measured: provider.isMeasured(key),
      benchmark: models.benchmarkFor(key),
      maxConcurrency: provider.maxConcurrencyFor(key),
      isDefault: key === models.defaultProvider('product'),
    }
  }

  return {
    info,
    list: (): ModelInfo[] => models.listProviders().map(info),
    defaultKey: (): string => models.defaultProvider('product'),
    costUsd: provider.costUsd,
  }
}
