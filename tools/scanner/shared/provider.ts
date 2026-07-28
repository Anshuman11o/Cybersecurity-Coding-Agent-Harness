/**
 * Provider resolution — which model/API a run uses.
 *
 * A provider is selected at runtime, never by forking the code. Every provider
 * executes byte-identical scanner logic against a byte-identical corpus; the
 * only permitted differences are the model id, the endpoint and the credential,
 * all of which are declared as data in `models.json`.
 *
 * Resolution order (first match wins):
 *   1. SCANNER_PROVIDER_<STAGE>   per-stage override, e.g. SCANNER_PROVIDER_STAGE3
 *   2. SCANNER_PROVIDER           global
 *   3. models.json default_provider
 *
 * Zero dependencies: this module resolves configuration only. Client
 * construction stays in each stage's llm-client.ts, because that needs the
 * `openai` package which is installed per stage package.
 */
import {
  assertProvider,
  defaultProvider,
  targetFor,
  listProviders,
  listProviderSpellings,
  type Provider,
  type ModelTarget,
} from './models.js'

export type { Provider, ModelTarget }
export { listProviders, listProviderSpellings, defaultProvider, targetFor }

/**
 * @param stageKey short key for the per-stage override env var,
 *                 e.g. 'stage3' -> SCANNER_PROVIDER_STAGE3
 */
export function resolveProvider(stageKey: string): Provider {
  const raw =
    process.env[`SCANNER_PROVIDER_${stageKey.toUpperCase()}`] ??
    process.env.SCANNER_PROVIDER ??
    defaultProvider()

  return assertProvider(raw, 'SCANNER_PROVIDER')
}

/**
 * True when the provider was chosen explicitly via env, rather than falling
 * back to the registry default. Used to decide whether a degraded run should be
 * a hard failure: if someone deliberately selected a provider, silently
 * substituting deterministic analysis would corrupt their results.
 */
export function isProviderExplicit(stageKey: string): boolean {
  return Boolean(
    process.env[`SCANNER_PROVIDER_${stageKey.toUpperCase()}`] ??
      process.env.SCANNER_PROVIDER,
  )
}

/**
 * Model id for a provider.
 *
 * Override order: the target's own env var (e.g. OPENAI_MODEL) beats the global
 * SCANNER_MODEL, which beats the registry default. The global exists so a
 * comparison can be pinned to one snapshot without editing models.json.
 */
export function modelFor(provider: Provider): string {
  const t = targetFor(provider)
  return process.env[t.model_env] ?? process.env.SCANNER_MODEL ?? t.model
}

/** Human label for a provider, for reports and logs. */
export function labelFor(provider: Provider): string {
  return targetFor(provider).label
}

/** Name of the env var holding this provider's credential. */
export function apiKeyEnvFor(provider: Provider): string {
  return targetFor(provider).api_key_env
}

/**
 * Everything an OpenAI-compatible SDK client needs, resolved from the registry.
 *
 * `apiKey` is null when the credential is absent — callers that must fail hard
 * throw, callers with a deterministic fallback call markDegraded() instead.
 * Keeping that decision at the call site is why this returns null rather than
 * throwing here.
 */
export function clientConfigFor(
  provider: Provider,
): { apiKey: string | null; baseURL?: string } {
  const t = targetFor(provider)
  const apiKey = process.env[t.api_key_env] ?? null
  const baseURL =
    (t.base_url_env ? process.env[t.base_url_env] : undefined) ?? t.base_url ?? undefined
  return baseURL ? { apiKey, baseURL } : { apiKey }
}

/**
 * Output-token limit parameter name differs by provider, so it is declared per
 * target rather than branched on here. GPT-5.x reasoning models reject
 * `max_tokens` with a 400 and require `max_completion_tokens`; DashScope/Qwen
 * accepts only `max_tokens`.
 */
export function tokenLimitParam(
  provider: Provider,
  n: number,
): Record<string, number> {
  return { [targetFor(provider).token_limit_param]: n }
}

/**
 * Sampling parameters, declared per target. Models that are inconsistent about
 * accepting non-default sampling values declare `{}` and are steered through
 * the prompt instead.
 */
export function samplingParams(provider: Provider): Record<string, number> {
  return { ...targetFor(provider).sampling }
}
