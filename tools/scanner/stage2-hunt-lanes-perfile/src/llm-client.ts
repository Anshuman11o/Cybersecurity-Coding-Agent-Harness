/**
 * LLM client — same createClient() pattern as v1.
 * DashScope (Qwen) via DASHSCOPE_API_KEY, with HttpsProxyAgent.
 */
import OpenAI from 'openai'
import { HttpsProxyAgent } from 'https-proxy-agent'

export function createClient(): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is not set')
  }
  const baseURL = process.env.DASHSCOPE_BASE_URL
    ?? 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'
  const proxyUrl = process.env.HTTPS_PROXY ?? 'http://127.0.0.1:39707'
  const httpAgent = new HttpsProxyAgent(proxyUrl)
  return new OpenAI({
    apiKey,
    baseURL,
    httpAgent,
  })
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
