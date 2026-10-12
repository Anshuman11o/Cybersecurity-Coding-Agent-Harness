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
 * Two runtime additions extend the shipped registry without editing it, both
 * for users bringing their own provider (productization plan §2.5):
 *
 *   SCANNER_MODELS_FILE   path to a user models.json overlay: `targets` (and
 *                         optionally `aliases`) in the same format as here. An
 *                         overlay may add keys but never redefine a shipped
 *                         one, never claim a `benchmark` result, and never use a
 *                         lab transport.
 *   generic endpoint      `generic_openai_compatible` in models.json names the
 *                         env vars (model, base URL, credential variable, price)
 *                         that, when set, materialise one more target. The CLI's
 *                         --base-url/--model/--api-key-env flags set them.
 *
 * Both are always unmeasured. Measured means a lab benchmark row exists, and
 * only a shipped entry can carry one.
 *
 * Zero dependencies (node builtins only) so it can be imported across stage
 * package boundaries without its own node_modules.
 */
import { readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
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
   * How calls reach the model. Absent means `openai` — an HTTP call through the
   * OpenAI-compatible SDK, which is what every target used before this field
   * existed and what they all still do.
   *
   * `claude-cli` spawns the local Claude Code binary in headless mode instead,
   * so a Claude model can be measured against a subscription rather than a
   * metered key. It is a property of the target, not of any stage, for the same
   * reason the endpoint is: a stage that branched on a provider name here would
   * break the rule that adding a model is a data change.
   *
   * The transport is NOT free of consequences for comparability — it changes
   * the sandbox, the structured-output mechanism and the effort parameter — so
   * a target using it must be recorded as its own row, never merged with a row
   * measured over `openai`. See docs/protocols/benchmark-run-plan.md.
   */
  transport?: 'openai' | 'claude-cli'
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
  /**
   * USD per million tokens, input and output.
   *
   * Here rather than in a stage for the same reason the model id is: it is a
   * property of the target, and a stage that hardcodes it is wrong the moment a
   * second target exists. Optional — a target with no price simply produces no
   * cost projection rather than a wrong one.
   *
   * Output dominates on a reasoning model: at `reasoning_effort: high` the
   * output leg is ~68% of a run's bill, because reasoning tokens are billed as
   * output. A projection that models only input is not a cost projection.
   */
  price_per_mtok?: { input: number; cached_input?: number; cache_write?: number; output: number } | null
  /**
   * The date the prices above were read off the vendor's pricing page.
   *
   * Load-bearing, not decoration. A stale price is invisible: it produces a
   * plausible number that reconciles with older runs and disagrees only with
   * the bill. This registry once carried luna at $1.00/$6.00 — figures copied
   * from the repo's own prose, correct when written and 5x high by 2026-08-01 —
   * and a full run was reported at $21.84 when it cost $4.37. Re-read the page
   * when this date is old, and never take a price from a doc.
   */
  price_asof?: string
  /**
   * Which column of the vendor's price list these rates came from. Standard
   * service tier at short context is what this scanner is billed at; Batch and
   * Flex are half, Fast mode is double, and long context is double again. A
   * rate without its tier is not checkable.
   */
  price_tier?: string
  /**
   * A vendor-documented ceiling on concurrent in-flight requests, where the
   * vendor publishes one. Optional. The auto-derived concurrency never exceeds
   * it; an explicit --concurrency / HUNT_CONCURRENCY still can, and is warned.
   */
  max_concurrency?: number
  /**
   * The lab benchmark result that makes this target MEASURED. Copied from
   * docs/benchmarking-results.md, which is the record; guard.test.ts fails if
   * the two disagree. Absent means unmeasured — the plan labels every such
   * model that way in the CLI and the report.
   */
  benchmark?: BenchmarkRecord
  /** Free text: quirks, endpoint requirements, why a field is set as it is. */
  notes?: string
}

/** A lab result, as recorded in docs/benchmarking-results.md. */
export interface BenchmarkRecord {
  /** The repository and denominator the result was scored on. */
  corpus: string
  /** Stage 0 language keys of that corpus; other languages stay unmeasured. */
  languages: string[]
  /** Exact-line recall as the ledger states it, e.g. "69/97". */
  recall: string
  /** Localization (±15 lines) as the ledger states it. */
  localization: string
  /** Total cost of that run in USD. */
  cost_usd: number
  run: string
  /** Where in the ledger the row lives. */
  source: string
}

/** Where a target came from. Only `registry` targets can be measured. */
export type TargetOrigin = 'registry' | 'overlay' | 'generic'

/**
 * Template for the generic OpenAI-compatible target. Every *_env field names an
 * environment variable; none holds a model id, endpoint or credential itself.
 */
interface GenericTemplate {
  key: string
  label: string
  model_env: string
  base_url_env: string
  /** Names the variable that names the credential variable. */
  api_key_env_env: string
  api_key_env_default: string
  /** "input/output" USD per MTok. */
  price_env: string
  token_limit_param: TokenLimitParam
  sampling: Record<string, number | string>
  max_output_tokens?: number
  notes?: string
}

interface Registry {
  default_provider: string
  product_default_provider?: string
  aliases: Record<string, string>
  targets: Record<string, ModelTarget>
  origins: Record<string, TargetOrigin>
  generic: GenericTemplate | null
}

/**
 * Validate one target entry. A malformed entry would otherwise surface as a
 * confusing API error hundreds of calls into a paid run.
 */
function validateTarget(key: string, t: ModelTarget, where: string): void {
  for (const field of ['label', 'model', 'model_env', 'api_key_env'] as const) {
    if (!t[field]) {
      throw new Error(`${where}: target "${key}" is missing "${field}"`)
    }
  }
  if (t.token_limit_param !== 'max_tokens' && t.token_limit_param !== 'max_completion_tokens') {
    throw new Error(
      `${where}: target "${key}" has token_limit_param "${t.token_limit_param}"; ` +
        `expected "max_tokens" or "max_completion_tokens"`,
    )
  }
  if (t.sampling == null || typeof t.sampling !== 'object') {
    throw new Error(`${where}: target "${key}" has a non-object "sampling"`)
  }
  if (t.transport != null && t.transport !== 'openai' && t.transport !== 'claude-cli') {
    throw new Error(
      `${where}: target "${key}" has transport "${t.transport}"; ` +
        `expected "openai" or "claude-cli"`,
    )
  }
  if (t.max_output_tokens != null &&
      (!Number.isInteger(t.max_output_tokens) || t.max_output_tokens <= 0)) {
    throw new Error(
      `${where}: target "${key}" has max_output_tokens ` +
        `"${t.max_output_tokens}"; expected a positive integer`,
    )
  }
  if (t.max_concurrency != null &&
      (!Number.isInteger(t.max_concurrency) || t.max_concurrency <= 0)) {
    throw new Error(
      `${where}: target "${key}" has max_concurrency "${t.max_concurrency}"; expected a positive integer`,
    )
  }
  if (t.price_per_mtok != null) {
    const p = t.price_per_mtok
    if (typeof p !== 'object' || !(p.input >= 0) || !(p.output >= 0) ||
        (p.cached_input != null && !(p.cached_input >= 0))) {
      throw new Error(
        `${where}: target "${key}" has a malformed price_per_mtok; ` +
          `expected { input: number, output: number }`,
      )
    }
  }
  if (t.benchmark != null) {
    const b = t.benchmark
    if (typeof b !== 'object' || !b.corpus || !Array.isArray(b.languages) ||
        !/^\d+\/\d+$/.test(String(b.recall)) || !/^\d+\/\d+$/.test(String(b.localization)) ||
        !(b.cost_usd >= 0) || !b.run || !b.source) {
      throw new Error(
        `${where}: target "${key}" has a malformed benchmark; expected ` +
          `{ corpus, languages[], recall: "n/d", localization: "n/d", cost_usd, run, source }`,
      )
    }
  }
}

/** "0.5/1.5" -> { input: 0.5, output: 1.5 }. */
export function parsePricePair(raw: string, what: string): { input: number; output: number } {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*\/\s*([0-9]*\.?[0-9]+)\s*$/.exec(raw)
  if (!m) throw new Error(`${what}="${raw}" is not "input/output" USD per million tokens, e.g. "0.5/1.5"`)
  return { input: Number(m[1]), output: Number(m[2]) }
}

/**
 * The registry for an environment: the shipped file, then an overlay, then the
 * generic endpoint. Exported for tests; stages use the module-level REGISTRY.
 */
export function loadRegistry(
  env: Record<string, string | undefined> = process.env,
  registryPath: string = join(__dirname, 'models.json'),
): Registry {
  const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as Registry & Record<string, unknown>

  const targets: Record<string, ModelTarget> = { ...(raw.targets ?? {}) }
  if (Object.keys(targets).length === 0) {
    throw new Error('models.json: `targets` is empty — no model can be selected')
  }
  for (const [key, t] of Object.entries(targets)) validateTarget(key, t, 'models.json')

  if (!targets[raw.default_provider]) {
    throw new Error(
      `models.json: default_provider "${raw.default_provider}" is not a target. ` +
        `Known: ${Object.keys(targets).join(', ')}`,
    )
  }
  if (raw.product_default_provider && !targets[raw.product_default_provider]) {
    throw new Error('models.json: product_default_provider is not a target')
  }

  const aliases: Record<string, string> = { ...(raw.aliases ?? {}) }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (targets[alias]) {
      throw new Error(`models.json: alias "${alias}" collides with a target key`)
    }
    if (!targets[canonical]) {
      throw new Error(`models.json: alias "${alias}" points at unknown target "${canonical}"`)
    }
  }

  const origins: Record<string, TargetOrigin> = {}
  for (const key of Object.keys(targets)) origins[key] = 'registry'

  // A name already taken, by a target or an alias, cannot be reused: a user's
  // entry silently replacing a measured one would carry its measured label.
  const taken = (k: string) => Boolean(targets[k]) || Boolean(aliases[k])

  // ── User overlay ──────────────────────────────────────────────────────────
  const overlayPath = env.SCANNER_MODELS_FILE
  if (overlayPath) {
    const where = `models overlay ${overlayPath}`
    let overlay: { targets?: Record<string, ModelTarget>; aliases?: Record<string, string> }
    try {
      overlay = JSON.parse(readFileSync(resolve(overlayPath), 'utf-8'))
    } catch (err: any) {
      throw new Error(`${where}: cannot read it as JSON (${err?.message ?? err})`)
    }
    const known = new Set(['targets', 'aliases', '_comment'])
    for (const k of Object.keys(overlay ?? {})) {
      if (!known.has(k)) throw new Error(`${where}: unknown top-level field "${k}" (expected targets, aliases)`)
    }
    for (const [key, t] of Object.entries(overlay.targets ?? {})) {
      if (taken(key)) {
        throw new Error(`${where}: "${key}" is already a shipped model or alias — pick a new key`)
      }
      if (t.benchmark != null) {
        throw new Error(`${where}: target "${key}" declares a benchmark — only shipped, lab-measured entries can`)
      }
      if (t.transport != null && t.transport !== 'openai') {
        throw new Error(`${where}: target "${key}" uses transport "${t.transport}" — overlays support "openai" only`)
      }
      validateTarget(key, t, where)
      targets[key] = t
      origins[key] = 'overlay'
    }
    for (const [alias, canonical] of Object.entries(overlay.aliases ?? {})) {
      if (taken(alias)) throw new Error(`${where}: alias "${alias}" is already taken`)
      if (origins[canonical] !== 'overlay') {
        throw new Error(`${where}: alias "${alias}" must point at one of the overlay's own targets`)
      }
      aliases[alias] = canonical
    }
  }

  // ── Generic OpenAI-compatible endpoint ────────────────────────────────────
  const g = (raw as any).generic_openai_compatible as GenericTemplate | undefined
  const generic = g ?? null
  if (g && env[g.model_env] && env[g.base_url_env]) {
    if (taken(g.key)) {
      throw new Error(`models.json: generic key "${g.key}" collides with an existing model or alias`)
    }
    const priceRaw = env[g.price_env]
    const t: ModelTarget = {
      label: g.label,
      // The model id is read from model_env by modelFor(); this is only the
      // value it would fall back to, and it is the environment's own.
      model: env[g.model_env]!,
      model_env: g.model_env,
      api_key_env: env[g.api_key_env_env] || g.api_key_env_default,
      base_url: null,
      base_url_env: g.base_url_env,
      token_limit_param: g.token_limit_param,
      sampling: { ...g.sampling },
      ...(g.max_output_tokens != null ? { max_output_tokens: g.max_output_tokens } : {}),
      price_per_mtok: priceRaw ? parsePricePair(priceRaw, g.price_env) : null,
      ...(priceRaw ? { price_asof: 'user-supplied', price_tier: 'user-supplied' } : {}),
      notes: g.notes,
    }
    validateTarget(g.key, t, 'generic endpoint')
    targets[g.key] = t
    origins[g.key] = 'generic'
  }

  return { default_provider: raw.default_provider, product_default_provider: raw.product_default_provider, aliases, targets, origins, generic }
}

const REGISTRY: Registry = loadRegistry()

/** Every canonical provider key, sorted. */
export function listProviders(): Provider[] {
  return Object.keys(REGISTRY.targets).sort()
}

/** Every accepted spelling, canonical keys and aliases alike, sorted. */
export function listProviderSpellings(): string[] {
  return [...Object.keys(REGISTRY.targets), ...Object.keys(REGISTRY.aliases)].sort()
}

/** The provider used when nothing selects one explicitly. */
export function defaultProvider(profile: string | undefined = process.env.SCANNER_PROFILE): Provider {
  return profile === 'product' ? REGISTRY.product_default_provider ?? REGISTRY.default_provider : REGISTRY.default_provider
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

/** Where a target came from: the shipped registry, a user overlay, or the generic endpoint. */
export function targetOrigin(provider: Provider): TargetOrigin {
  return REGISTRY.origins[assertProvider(provider)]
}

/** The lab result that makes a target measured, or null when it is unmeasured. */
export function benchmarkFor(provider: Provider): BenchmarkRecord | null {
  const key = assertProvider(provider)
  // Only a shipped entry can be measured; loadRegistry() already refuses an
  // overlay that claims otherwise, and this keeps the rule in one more place.
  return REGISTRY.origins[key] === 'registry' ? REGISTRY.targets[key].benchmark ?? null : null
}

/** The env var names the generic endpoint is configured through, or null. */
export function genericEndpointEnv(): {
  key: string
  model_env: string
  base_url_env: string
  api_key_env_env: string
  api_key_env_default: string
  price_env: string
} | null {
  const g = REGISTRY.generic
  if (!g) return null
  return {
    key: g.key,
    model_env: g.model_env,
    base_url_env: g.base_url_env,
    api_key_env_env: g.api_key_env_env,
    api_key_env_default: g.api_key_env_default,
    price_env: g.price_env,
  }
}
