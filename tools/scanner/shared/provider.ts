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
export function samplingParams(provider: Provider): Record<string, number | string> {
  const params = { ...targetFor(provider).sampling }

  // SCANNER_REASONING_EFFORT overrides the registry for one invocation. It is
  // configuration, not a model branch: the registry entry stays the shipped
  // value and nothing in a stage learns a model name from it.
  //
  // It exists because reasoning effort is the largest single cost multiplier in
  // a run and had never been varied under measurement — an A/B needs to move it
  // without editing, committing and reverting models.json between arms, which
  // is exactly the kind of uncommitted-tree drift the runbook warns about. Set
  // it to the empty string to send no effort parameter at all, which is what
  // runs 1-5 did.
  const effort = process.env.SCANNER_REASONING_EFFORT
  if (effort !== undefined) {
    if (effort === '') {
      delete params.reasoning_effort
    } else {
      // Validated against the accepted set rather than passed through. An
      // unrecognised value is a 400 several hundred paid calls into a run, and
      // the override exists precisely to be set by hand between arms.
      const accepted = ['low', 'medium', 'high']
      if (!accepted.includes(effort)) {
        throw new Error(
          `SCANNER_REASONING_EFFORT="${effort}" is not one of: ${accepted.join(', ')} ` +
            `(or empty, to send none at all)`,
        )
      }
      params.reasoning_effort = effort
    }
  }
  return params
}

/**
 * Output-token cap for this target, or the caller's default when the registry
 * does not set one.
 *
 * Every target that has run to date omits it and therefore keeps the stage
 * default byte-for-byte. It exists so that a target raising `reasoning_effort`
 * can raise the ceiling in the same registry entry: reasoning tokens are billed
 * as output AND counted against this cap, so a cap tuned at the default effort
 * silently truncates the response body at a higher one — which reads downstream
 * as an empty findings array rather than as a failure.
 */
export function outputTokenCap(provider: Provider, fallback: number): number {
  // SCANNER_MAX_OUTPUT_TOKENS overrides the registry for one invocation, for
  // the same reason SCANNER_REASONING_EFFORT does: the cap and the effort are
  // coupled — reasoning is billed and counted as output — so testing either
  // one means moving both without rewriting the registry between arms.
  const raw = process.env.SCANNER_MAX_OUTPUT_TOKENS
  if (raw !== undefined) {
    // Stricter than parseInt on purpose: parseInt("1e5") is 1, and a cap of 1
    // truncates every response body, which this stage records as a lane that
    // found nothing rather than as a failure. A malformed cap must fail loudly.
    if (!/^[0-9]+$/.test(raw.trim()) || Number(raw.trim()) <= 0) {
      throw new Error(`SCANNER_MAX_OUTPUT_TOKENS="${raw}" is not a positive integer`)
    }
    return Number(raw.trim())
  }
  return targetFor(provider).max_output_tokens ?? fallback
}
