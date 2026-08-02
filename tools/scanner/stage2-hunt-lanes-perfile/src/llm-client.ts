/**
 * LLM client — provider-aware, same pattern as v1.
 *
 * The endpoint and credential come from the model registry
 * (tools/scanner/shared/models.json), so this file names no model and no
 * vendor. See docs/architecture/multi-model-architecture.md.
 *
 * No HttpsProxyAgent: openai SDK v6 routes through fetch/undici and has no
 * httpAgent option. Proxying is handled by NODE_USE_ENV_PROXY=1, exported by
 * run.sh, which makes Node honour HTTPS_PROXY natively. Passing an agent here
 * was inert under v6 and does not even typecheck.
 */
import OpenAI from 'openai'
import {
  clientConfigFor,
  apiKeyEnvFor,
  transportFor,
  modelFor,
  samplingParams,
  type Provider,
} from '../../shared/provider.js'
import { createClaudeCliClient } from '../../shared/claude-cli-client.js'

export function createClient(provider: Provider): OpenAI {
  // Transport branch, not a model branch: the value comes from the registry, so
  // another CLI-backed target needs no change here. Must come before the
  // credential check — the CLI transport authenticates through its own session
  // and declares no usable api_key_env.
  if (transportFor(provider) === 'claude-cli') {
    const effort = samplingParams(provider).reasoning_effort
    return createClaudeCliClient({
      model: modelFor(provider),
      effort: typeof effort === 'string' ? effort : undefined,
    }) as unknown as OpenAI
  }
  const { apiKey, baseURL } = clientConfigFor(provider)
  if (!apiKey) throw new Error(`${apiKeyEnvFor(provider)} is not set`)
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
}

/**
 * Extract JSON from an LLM response that may contain markdown fencing or prose.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return trimmed
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1].trim()
  const openBrace = trimmed.indexOf('{')
  const openBracket = trimmed.indexOf('[')
  let start = -1
  if (openBrace >= 0 && openBracket < 0) start = openBrace
  else if (openBracket >= 0 && openBrace < 0) start = openBracket
  else if (openBrace >= 0 && openBracket >= 0) start = Math.min(openBrace, openBracket)
  if (start >= 0) return trimmed.slice(start)
  throw new Error('No JSON found in response')
}
