/**
 * LLM client — provider-aware.
 *
 * The endpoint and credential come from the model registry
 * (tools/scanner/shared/models.json), so this file names no model and no
 * vendor. Every provider runs byte-identical scanner logic; only the model id,
 * the base URL and the credential differ.
 * See docs/architecture/multi-model-architecture.md.
 */
import OpenAI from 'openai'
import { resolveProvider, clientConfigFor, apiKeyEnvFor, type Provider } from '../../shared/provider.js'

export function createClient(provider: Provider): OpenAI {
  // Proxying is handled by NODE_USE_ENV_PROXY=1 (exported by run.sh), which
  // makes Node honour HTTPS_PROXY natively. openai SDK v6 routes through
  // fetch/undici and has no httpAgent option at all -- passing one was inert
  // and does not even typecheck.
  const { apiKey, baseURL } = clientConfigFor(provider)
  if (!apiKey) throw new Error(`${apiKeyEnvFor(provider)} is not set`)
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
}

export { resolveProvider }

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
