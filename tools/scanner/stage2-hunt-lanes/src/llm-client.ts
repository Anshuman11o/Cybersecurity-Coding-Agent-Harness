/**
 * LLM client — provider-aware.
 *
 * Selects between DashScope/Qwen and OpenAI at runtime via SCANNER_PROVIDER.
 * Both providers run byte-identical scanner logic; only the model id and the
 * credential differ. See docs/dual-model-architecture.md.
 *
 *   qwen   -> DASHSCOPE_API_KEY, DashScope OpenAI-compatible endpoint
 *   openai -> OPENAI_API_KEY, api.openai.com (no baseURL override)
 */
import OpenAI from 'openai'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { resolveProvider, type Provider } from '../../shared/provider.js'

export function createClient(provider: Provider): OpenAI {
  const proxyUrl = process.env.HTTPS_PROXY ?? 'http://127.0.0.1:39707'
  const httpAgent = new HttpsProxyAgent(proxyUrl)

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
    // No baseURL — defaults to https://api.openai.com/v1
    return new OpenAI({ apiKey, httpAgent })
  }

  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not set')
  const baseURL = process.env.DASHSCOPE_BASE_URL
    ?? 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'
  return new OpenAI({ apiKey, baseURL, httpAgent })
}

export { resolveProvider }

export function extractJson(text: string): string {
  const trimmed = text.trim()
  // Try direct parse first
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return trimmed
  }
  // Look for fenced code block (json or not)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1].trim()
  // Last resort: find the first { or [ and take everything from there
  const openBrace = trimmed.indexOf('{')
  const openBracket = trimmed.indexOf('[')
  let start = -1
  if (openBrace >= 0 && openBracket < 0) start = openBrace
  else if (openBracket >= 0 && openBrace < 0) start = openBracket
  else if (openBrace >= 0 && openBracket >= 0) start = Math.min(openBrace, openBracket)
  if (start >= 0) return trimmed.slice(start)
  throw new Error('No JSON found in response')
}
