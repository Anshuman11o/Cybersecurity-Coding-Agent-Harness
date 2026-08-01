/**
 * Model registry loader.
 *
 * The registry itself lives in `models.json` rather than in this file, because
 * three different runtimes need the same list: the TypeScript stages (here),
 * and the bash entry points (`run.sh`, `diff.sh`, `seed-upstream.sh`, via
 * `node -e`). A hardcoded bash list would drift the first time a model was
 * added, and the failure mode is silent — run.sh rejecting a target the stages
 * happily accept, or worse, accepting one they do not.
 *
 * Nothing in here knows the name of any particular model. Adding a model is an
 * entry in models.json; no code changes anywhere.
 *
 * Zero dependencies (node builtins only) so it can be imported across stage
 * package boundaries without its own node_modules.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * A provider key. Deliberately `string`: the set of models is configuration,
 * not a compile-time union, so the type cannot enumerate it. Every entry point
 * that accepts one validates it at runtime — see `assertProvider()`, which
 * `resolveProvider()` and `runPath()` both call.
 */
export type Provider = string

/** Output-token cap parameter name. The two OpenAI-compatible dialects. */
export type TokenLimitParam = 'max_tokens' | 'max_completion_tokens'

export interface ModelTarget {
  /** Human label, for reports and preflight output. */
  label: string
  /** Model id sent to the API. */
  model: string
  /** Env var overriding `model` for this target. */
  model_env: string
  /** Env var holding the credential. */
  api_key_env: string
  /** Base URL, or null for the SDK default (api.openai.com). */
  base_url: string | null
  /** Env var overriding `base_url`. */
  base_url_env: string | null
  /** Which output-token cap parameter this API accepts. */
  token_limit_param: TokenLimitParam
  /**
   * Sampling params to send. Empty for models that reject non-defaults.
   *
   * Values may be numbers or strings: the GPT-5.x family takes
   * `reasoning_effort` as one of "low" | "medium" | "high", and it belongs
   * here rather than in stage code for the same reason the model id does —
   * it is a property of the target, not of the hunting logic.
   */
  sampling: Record<string, number | string>
  /**
   * Output-token cap for a stage's model calls. Optional; stages supply their
   * own default when it is absent.
   *
   * It lives here because reasoning tokens are billed and counted as output:
   * a target running at a higher reasoning effort can spend the whole of a cap
   * that was ample at the default effort and return a truncated body, which
   * surfaces as "the model found nothing" rather than as an error. The cap has
   * to move with the effort, and both are properties of the target.
   */
  max_output_tokens?: number
  /** Free text: quirks, endpoint requirements, why a field is set as it is. */
  notes?: string
}

interface Registry {
  default_provider: string
  aliases: Record<string, string>
  targets: Record<string, ModelTarget>
}

const REGISTRY: Registry = (() => {
  const raw = JSON.parse(
    readFileSync(join(__dirname, 'models.json'), 'utf-8'),
  ) as Registry & Record<string, unknown>

  const targets = raw.targets
  if (!targets || Object.keys(targets).length === 0) {
    throw new Error('models.json: `targets` is empty — no model can be selected')
  }

  // Validate up front. A malformed registry entry would otherwise surface as a
  // confusing API error hundreds of calls into a paid run.
  for (const [key, t] of Object.entries(targets)) {
    for (const field of ['label', 'model', 'model_env', 'api_key_env'] as const) {
      if (!t[field]) {
        throw new Error(`models.json: target "${key}" is missing "${field}"`)
      }
    }
    if (t.token_limit_param !== 'max_tokens' && t.token_limit_param !== 'max_completion_tokens') {
      throw new Error(
        `models.json: target "${key}" has token_limit_param "${t.token_limit_param}"; ` +
          `expected "max_tokens" or "max_completion_tokens"`,
      )
    }
    if (t.sampling == null || typeof t.sampling !== 'object') {
      throw new Error(`models.json: target "${key}" has a non-object "sampling"`)
    }
    if (t.max_output_tokens != null &&
        (!Number.isInteger(t.max_output_tokens) || t.max_output_tokens <= 0)) {
      throw new Error(
        `models.json: target "${key}" has max_output_tokens ` +
          `"${t.max_output_tokens}"; expected a positive integer`,
      )
    }
  }

  if (!targets[raw.default_provider]) {
    throw new Error(
      `models.json: default_provider "${raw.default_provider}" is not a target. ` +
        `Known: ${Object.keys(targets).join(', ')}`,
    )
  }

  for (const [alias, canonical] of Object.entries(raw.aliases ?? {})) {
    if (targets[alias]) {
      throw new Error(`models.json: alias "${alias}" collides with a target key`)
    }
    if (!targets[canonical]) {
      throw new Error(`models.json: alias "${alias}" points at unknown target "${canonical}"`)
    }
  }

  return { default_provider: raw.default_provider, aliases: raw.aliases ?? {}, targets }
})()

/** Every canonical provider key, sorted. */
export function listProviders(): Provider[] {
  return Object.keys(REGISTRY.targets).sort()
}

/** Every accepted spelling, canonical keys and aliases alike, sorted. */
export function listProviderSpellings(): string[] {
  return [...Object.keys(REGISTRY.targets), ...Object.keys(REGISTRY.aliases)].sort()
}

/** The provider used when nothing selects one explicitly. */
export function defaultProvider(): Provider {
  return REGISTRY.default_provider
}

/** Map an alias to its canonical key; pass canonical keys through unchanged. */
export function canonicalize(raw: string): string {
  return REGISTRY.aliases[raw] ?? raw
}

export function isProvider(raw: string): boolean {
  return Boolean(REGISTRY.targets[canonicalize(raw)])
}

/** Throw with the full accepted list. Used wherever a provider key crosses in. */
export function assertProvider(raw: string, context = 'provider'): Provider {
  const key = canonicalize(raw)
  if (!REGISTRY.targets[key]) {
    throw new Error(
      `Unknown ${context} "${raw}". Expected one of: ${listProviderSpellings().join(', ')} ` +
        `(see tools/scanner/shared/models.json)`,
    )
  }
  return key
}

/** The full registry entry for a provider. */
export function targetFor(provider: Provider): ModelTarget {
  return REGISTRY.targets[assertProvider(provider)]
}
