/**
 * Provider resolution — which model/API a run uses.
 *
 * A provider is selected at runtime, never by forking the code. Both providers
 * execute byte-identical scanner logic against a byte-identical corpus; the
 * only permitted differences are the model id and the credential.
 *
 * Resolution order (first match wins):
 *   1. SCANNER_PROVIDER_<STAGE>   per-stage override, e.g. SCANNER_PROVIDER_STAGE3
 *   2. SCANNER_PROVIDER           global
 *   3. 'qwen'                     default — preserves pre-existing behaviour
 *
 * Zero dependencies: this module resolves configuration only. Client
 * construction stays in each stage's llm-client.ts, because that needs the
 * `openai` package which is installed per stage package.
 */
import type { Provider } from './run-paths.js'

export type { Provider }

const VALID: readonly Provider[] = ['qwen', 'openai']

/**
 * @param stageKey short key for the per-stage override env var,
 *                 e.g. 'stage3' -> SCANNER_PROVIDER_STAGE3
 */
export function resolveProvider(stageKey: string): Provider {
  const raw =
    process.env[`SCANNER_PROVIDER_${stageKey.toUpperCase()}`] ??
    process.env.SCANNER_PROVIDER ??
    'qwen'

  if (!VALID.includes(raw as Provider)) {
    throw new Error(
      `Unknown SCANNER_PROVIDER "${raw}". Expected one of: ${VALID.join(', ')}`,
    )
  }
  return raw as Provider
}

/** Model id for a provider. Overridable for pinning a specific snapshot. */
export function modelFor(provider: Provider): string {
  return provider === 'openai'
    ? (process.env.OPENAI_MODEL ?? 'gpt-5.6-luna')
    : (process.env.QWEN_MODEL ?? 'qwen-plus')
}

/**
 * Output-token limit parameter name differs by provider.
 * GPT-5.x reasoning models reject `max_tokens` and require
 * `max_completion_tokens`; DashScope/Qwen only accepts `max_tokens`.
 */
export function tokenLimitParam(
  provider: Provider,
  n: number,
): Record<string, number> {
  return provider === 'openai'
    ? { max_completion_tokens: n }
    : { max_tokens: n }
}

/**
 * Sampling parameters. GPT-5.x reasoning models are inconsistent about
 * accepting non-default sampling values, so we omit them on that path and
 * steer via prompting instead.
 */
export function samplingParams(provider: Provider): Record<string, number> {
  return provider === 'openai' ? {} : { temperature: 0.1 }
}
