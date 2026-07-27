/**
 * LLM-based analysis with deterministic fallback:
 * 1. Tool-calling detection heuristic on chat.ts
 * 2. Category applicability probe (OWASP Top 10, API Security Top 10, LLM Top 10)
 *
 * Uses OpenAI-compatible API (DashScope/Qwen via DASHSCOPE_API_KEY).
 * Falls back to deterministic analysis when API is unreachable.
 */
import OpenAI from 'openai'
import * as fs from 'fs'
import type { EscapeHatchFinding } from './frontend-grep.js'
import { resolveProvider, modelFor, tokenLimitParam, samplingParams } from '../../shared/provider.js'
import { markDegraded } from '../../shared/degraded.js'

const PROVIDER = resolveProvider('stage0')
const MODEL = modelFor(PROVIDER)

export interface ToolCallingVerdict {
  hasGenuineToolCalling: boolean
  evidence: string
  toolsDetected: string[]
  confidence: number  // 0-1
}

export interface CategoryVerdict {
  name: string
  framework: 'OWASP Top 10 2021' | 'API Security Top 10' | 'LLM Top 10'
  verdict: 'present' | 'absent' | 'uncertain'
  evidence: string
  confidence: number  // 0-1
}

/**
 * Initialize the LLM client using DASHSCOPE_API_KEY.
 * DashScope provides an OpenAI-compatible endpoint.
 */
function createClient(): OpenAI | null {
  if (PROVIDER === 'openai') {
    const key = process.env.OPENAI_API_KEY
    if (!key) return null
    // Proxying via NODE_USE_ENV_PROXY=1; openai v6 has no httpAgent option.
    return new OpenAI({ apiKey: key })
  }
  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey) return null
  const baseURL = process.env.DASHSCOPE_BASE_URL
    ?? 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'
  // for DashScope endpoints. Without it, node-fetch goes through the proxy
  // but gets a 403 'Host not in allowlist'.
  return new OpenAI({ apiKey, baseURL })
}

/**
 * Detect genuine tool-calling in a chat.ts file.
 * Tries LLM first, falls back to deterministic analysis.
 */
export async function detectToolCalling(chatTsPath: string): Promise<ToolCallingVerdict> {
  const content = fs.readFileSync(chatTsPath, 'utf-8')

  const client = createClient()
  if (!client) {
    markDegraded('tool-calling probe: no API key for provider — used deterministic analysis')
  }
  if (client) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: buildToolCallingPrompt(content) }],
        ...samplingParams(PROVIDER),
        ...tokenLimitParam(PROVIDER, 500),
      })
      const text = response.choices[0]?.message?.content ?? '{}'
      const jsonStr = extractJson(text)
      console.log('  [LLM OK] Tool-calling detection received a real API response')
      return JSON.parse(jsonStr) as ToolCallingVerdict
    } catch (err: any) {
      markDegraded(`tool-calling probe: LLM call failed (${err.message}) — used deterministic analysis`)
    }
  }

  return detectToolCallingDeterministic(content)
}

function buildToolCallingPrompt(content: string): string {
  return `You are analyzing a TypeScript file for genuine agentic tool-calling capabilities.

Tool-calling means the application defines tools/functions that an LLM can invoke during a conversation, with real side-effects (DB queries, API calls, state changes) -- NOT merely an "AI-sounding" route name or a plain text-completion call with no tools.

Here is the file content. Analyze it and determine:
1. Does this file contain genuine tool-calling?
2. What tools are defined? List each tool name.
3. Rate your confidence (0-1).

File content:
\`\`\`typescript
${content}
\`\`\`

Respond in JSON format only:
{
  "hasGenuineToolCalling": true/false,
  "toolsDetected": ["toolName1", "toolName2"],
  "evidence": "brief explanation",
  "confidence": 0.0-1.0
}`
}

/**
 * Deterministic fallback for tool-calling detection.
 */
function detectToolCallingDeterministic(content: string): ToolCallingVerdict {
  const toolsDetected: string[] = []
  const toolRegex = /(\w+):\s*tool\(\{/g
  let match
  while ((match = toolRegex.exec(content)) !== null) {
    toolsDetected.push(match[1])
  }

  const hasStreamText = content.includes('streamText(')
  const hasToolDefinition = content.includes('tool({')
  const hasExecute = content.includes('execute:')
  const hasStateChange = content.includes('.create(') || content.includes('.update(') ||
    content.includes('.delete(') || content.includes('generateCoupon')
  const hasDataRead = content.includes('.findAll(') || content.includes('.findOne(') ||
    content.includes('.findByPk(') || content.includes('find({')

  const hasGenuineToolCalling = hasStreamText && hasToolDefinition && hasExecute && toolsDetected.length > 0

  let evidence = ''
  if (hasStreamText) evidence += 'Uses streamText() for LLM interaction. '
  if (hasToolDefinition) evidence += `Defines ${toolsDetected.length} tool(s): ${toolsDetected.join(', ')}. `
  if (hasExecute) evidence += 'Tools have execute() handlers. '
  if (hasStateChange) evidence += 'At least one tool performs state-changing operations. '
  if (hasDataRead) evidence += 'Tools perform database reads. '

  return {
    hasGenuineToolCalling,
    evidence,
    toolsDetected,
    confidence: hasGenuineToolCalling ? 0.95 : 0.5,
  }
}

/**
 * Category applicability probe.
 * Tries LLM first, falls back to deterministic analysis based on architecture summary.
 */
export async function probeCategoryApplicability(
  architectureSummary: string,
  toolCallingVerdict: ToolCallingVerdict,
  escapeHatchFindings: EscapeHatchFinding[],
  swaggerDiffNote: string,
): Promise<CategoryVerdict[] | null> {
  const client = createClient()
  if (!client) {
    markDegraded('category probe: no API key for provider — used deterministic analysis')
  }
  if (client) {
    try {
      const result = await probeViaLLM(client, JSON.stringify(architectureSummary), toolCallingVerdict, escapeHatchFindings, swaggerDiffNote)
      if (result !== null) return result
      markDegraded('category probe: LLM returned unparseable JSON — used deterministic analysis')
    } catch (err: any) {
      console.error('LLM category probe failed:', err.message)
    }
  }
  return probeDeterministic(JSON.stringify(architectureSummary), toolCallingVerdict, escapeHatchFindings, swaggerDiffNote)
}

async function probeViaLLM(
  client: OpenAI,
  architectureSummary: string,
  toolCallingVerdict: ToolCallingVerdict,
  escapeHatchFindings: EscapeHatchFinding[],
  swaggerDiffNote: string,
): Promise<CategoryVerdict[] | null> {
  const hasApiSurface = swaggerDiffNote !== '' || architectureSummary.includes('/api/')
  const hasToolCalling = toolCallingVerdict.hasGenuineToolCalling

  const categories = buildCategoryList(hasApiSurface, hasToolCalling)
  const categoryListStr = categories.map(c => `- ${c.name} (${c.framework})`).join('\n')

  const prompt = `You are a security architecture analyst. Given an architecture summary, determine which vulnerability categories are APPLICABLE (present), NOT APPLICABLE (absent), or UNCERTAIN.

APPLICABLE = structural prerequisites are present.
NOT APPLICABLE = clearly lacks prerequisites.
UNCERTAIN = genuinely ambiguous from architecture alone.

Architecture summary:
---
${architectureSummary}
---

Swagger API coverage note: ${swaggerDiffNote}

${escapeHatchFindings.length > 0 ?
  `Angular escape-hatch usage (${escapeHatchFindings.length} occurrences): ` +
  escapeHatchFindings.map(f => `${f.file}:${f.line} - ${f.type}`).join('; ')
  : 'No Angular escape-hatch usage detected.'}

Evaluate:
${categoryListStr}

Per-category evidence logic:
- A01: Applicable if authenticated, resource-scoped routes with ID params exist.
- A02: Applicable if crypto/hash operations, JWT, password handling exist.
- A03: Applicable if raw SQL, NoSQL operators, string interpolation into queries, eval/exec.
- A04: Hard to determine from architecture alone -- often uncertain.
- A05: Applicable if XML parsers with entity resolution, missing security headers, permissive CORS.
- A06: Nearly always applicable for any app with dependencies.
- A07: Applicable if auth infrastructure with login, password reset, rate limiting.
- A08: Applicable if deserialization, webhook handling, plugin loading.
- A09: Applicable if any logging module exists.
- A10: Applicable if outbound HTTP calls with dynamic URLs.
- API categories: Only if REST/API surface beyond server-rendered pages.
- LLM categories: Only if genuine tool-calling with real capabilities.

Respond in JSON array:
[{"name":"category name","framework":"framework name","verdict":"present|absent|uncertain","evidence":"brief evidence","confidence":0.0-1.0}]`

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    ...samplingParams(PROVIDER),
    ...tokenLimitParam(PROVIDER, 5000),
  })

  console.log('  [LLM OK] Category applicability probe received a real API response')
  const text = response.choices[0]?.message?.content ?? '[]'
  const jsonStr = extractJson(text)
  try {
    const raw = JSON.parse(jsonStr) as CategoryVerdict[]
    // Normalize verdict values: LLM may use APPLICABLE/NOT_APPLICABLE instead of present/absent
    for (const c of raw) {
      const v = (c.verdict as string).toUpperCase()
      if (v === 'APPLICABLE' || v === 'PRESENT') c.verdict = 'present'
      else if (v === 'NOT_APPLICABLE' || v === 'NOT APPLICABLE' || v === 'ABSENT') c.verdict = 'absent'
      else if (v === 'UNCERTAIN' || v === 'UNKNOWN') c.verdict = 'uncertain'
    }
    return raw
  } catch (e: any) {
    console.error('  LLM JSON parse error:', e.message, '(first 200 chars of response:', JSON.stringify(text.substring(0, 200)), ')')
    // Fall back to deterministic
    return null
  }
}

/**
 * Deterministic category applicability probe based on architecture summary.
 * Follows the evidence logic from the implementation plan's Design Notes §1.
 */
function probeDeterministic(
  architectureSummary: string,
  toolCallingVerdict: ToolCallingVerdict,
  escapeHatchFindings: EscapeHatchFinding[],
  swaggerDiffNote: string,
): CategoryVerdict[] {
  const verdicts: CategoryVerdict[] = []
  const s = architectureSummary

  // Detect structural signals from the summary
  const hasApiRoutes = s.includes('/api/')
  const hasRestRoutes = s.includes('"method"') && hasApiRoutes
  const hasAuthMiddleware = s.includes('isAuthorized') || s.includes('appendUserId') || s.includes('jwtChallenges')
  const hasResourceScopedRoutes = s.includes('/:id') || s.includes(':id')
  const hasSequelize = s.includes('sequelize')
  const hasMongoDB = s.includes('mongodb') || s.includes('mongo')
  const hasJWT = s.includes('jwt') || s.includes('jsonwebtoken') || s.includes('jwtChallenges')
  const hasPasswordHandling = s.toLowerCase().includes('password')
  const hasCors = s.includes('cors')
  const hasHelmet = s.includes('helmet')
  const hasLogging = s.includes('morgan') || s.includes('logger') || s.includes('log')
  const hasRateLimit = s.includes('rateLimit') || s.includes('rate-limit')
  const hasXmlParsing = s.includes('xml') && s.toLowerCase().includes('parser')
  const hasDependencies = s.includes('dependencies')
  const hasFileUpload = s.includes('multer') || s.includes('file-upload')
  const hasOutboundHttp = false // Would need route handler inspection for this
  const hasDeserialization = s.includes('JSON.parse') || s.includes('yaml') || s.includes('js-yaml')
  const hasUndocumentedApis = swaggerDiffNote.includes('undocumented')
  const hasToolCalling = toolCallingVerdict.hasGenuineToolCalling

  // ---- OWASP Top 10 2021 ----

  // A01: Broken Access Control
  if (hasAuthMiddleware && hasResourceScopedRoutes) {
    verdicts.push({
      name: 'A01: Broken Access Control',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: `Authenticated routes with resource-scoped access detected. Auth middleware present: routes use ${hasAuthMiddleware ? 'authorization checks' : 'various middleware'}. ID-based resource routing found.`,
      confidence: 0.9,
    })
  } else if (hasAuthMiddleware) {
    verdicts.push({
      name: 'A01: Broken Access Control',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: 'Authentication middleware detected. Whether ownership is checked per resource requires deeper analysis.',
      confidence: 0.7,
    })
  } else {
    verdicts.push({
      name: 'A01: Broken Access Control',
      framework: 'OWASP Top 10 2021',
      verdict: 'uncertain',
      evidence: 'No clear authentication/access control pattern detected from architecture summary alone.',
      confidence: 0.4,
    })
  }

  // A02: Cryptographic Failures
  if (hasJWT || hasPasswordHandling) {
    verdicts.push({
      name: 'A02: Cryptographic Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: `JWT usage detected${hasPasswordHandling ? ', password handling present' : ''}. Cryptographic operations exist in the application.`,
      confidence: 0.8,
    })
  } else {
    verdicts.push({
      name: 'A02: Cryptographic Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'absent',
      evidence: 'No cryptographic operations detected in architecture summary.',
      confidence: 0.5,
    })
  }

  // A03: Injection
  const hasRawSql = hasSequelize
  const hasNoSql = hasMongoDB
  if (hasRawSql || hasNoSql) {
    const parts: string[] = []
    if (hasRawSql) parts.push('Sequelize ORM detected (potential for SQL injection via raw queries)')
    if (hasNoSql) parts.push('MongoDB/NoSQL detected (potential for NoSQL operator injection)')
    verdicts.push({
      name: 'A03: Injection',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: parts.join('. ') + '. String interpolation into query execution paths requires investigation.',
      confidence: 0.8,
    })
  } else {
    verdicts.push({
      name: 'A03: Injection',
      framework: 'OWASP Top 10 2021',
      verdict: 'uncertain',
      evidence: 'No clear injection sinks detected from architecture alone, but all web apps have some injection surface.',
      confidence: 0.4,
    })
  }

  // A04: Insecure Design
  verdicts.push({
    name: 'A04: Insecure Design',
    framework: 'OWASP Top 10 2021',
    verdict: 'uncertain',
    evidence: 'Insecure design is a business-logic concern that cannot be determined from architectural signals alone. Requires Stage 2 hunt lane analysis.',
    confidence: 0.3,
  })

  // A05: Security Misconfiguration
  const misconfigSignals: string[] = []
  if (hasCors) misconfigSignals.push('CORS enabled')
  if (!hasHelmet) misconfigSignals.push('No helmet middleware detected')
  if (hasXmlParsing) misconfigSignals.push('XML parsing detected (potential XXE)')

  if (misconfigSignals.length > 0) {
    verdicts.push({
      name: 'A05: Security Misconfiguration',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: misconfigSignals.join('; ') + '. Configuration review warranted.',
      confidence: 0.6,
    })
  } else {
    verdicts.push({
      name: 'A05: Security Misconfiguration',
      framework: 'OWASP Top 10 2021',
      verdict: 'uncertain',
      evidence: 'No obvious misconfiguration markers from architecture alone, but configuration audit needed.',
      confidence: 0.4,
    })
  }

  // A06: Vulnerable and Outdated Components
  verdicts.push({
    name: 'A06: Vulnerable and Outdated Components',
    framework: 'OWASP Top 10 2021',
    verdict: hasDependencies ? 'present' : 'uncertain',
    evidence: hasDependencies
      ? 'Application has dependencies. CVE/OSV scan warranted to identify outdated or vulnerable components.'
      : 'Unable to determine dependency status from architecture alone.',
    confidence: hasDependencies ? 0.9 : 0.3,
  })

  // A07: Identification and Authentication Failures
  if (hasAuthMiddleware && hasRateLimit) {
    verdicts.push({
      name: 'A07: Identification and Authentication Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: 'Authentication infrastructure present with rate limiting on some endpoints. Login/password reset flows detected.',
      confidence: 0.8,
    })
  } else if (hasAuthMiddleware) {
    verdicts.push({
      name: 'A07: Identification and Authentication Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: 'Authentication infrastructure present. Whether rate limiting, brute-force protection, and credential policies are adequate requires deeper analysis.',
      confidence: 0.7,
    })
  } else {
    verdicts.push({
      name: 'A07: Identification and Authentication Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'absent',
      evidence: 'No authentication infrastructure detected in architecture summary.',
      confidence: 0.5,
    })
  }

  // A08: Software and Data Integrity Failures
  if (hasDeserialization || hasFileUpload) {
    verdicts.push({
      name: 'A08: Software and Data Integrity Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'present',
      evidence: `Deserialization and/or file upload capabilities detected.${hasFileUpload ? ' File upload with zip/xml/yaml handling present.' : ''}`,
      confidence: 0.7,
    })
  } else {
    verdicts.push({
      name: 'A08: Software and Data Integrity Failures',
      framework: 'OWASP Top 10 2021',
      verdict: 'uncertain',
      evidence: 'No clear deserialization or integrity-sensitive patterns detected from architecture alone.',
      confidence: 0.3,
    })
  }

  // A09: Security Logging and Monitoring Failures
  verdicts.push({
    name: 'A09: Security Logging and Monitoring Failures',
    framework: 'OWASP Top 10 2021',
    verdict: hasLogging ? 'present' : 'uncertain',
    evidence: hasLogging
      ? 'Logging infrastructure present (morgan/logger). Whether logs reach a monitored destination in production is a deployment concern.'
      : 'No clear logging infrastructure detected.',
    confidence: hasLogging ? 0.6 : 0.3,
  })

  // A10: SSRF
  verdicts.push({
    name: 'A10: Server-Side Request Forgery (SSRF)',
    framework: 'OWASP Top 10 2021',
    verdict: hasOutboundHttp ? 'present' : 'uncertain',
    evidence: hasOutboundHttp
      ? 'Outbound HTTP calls detected. Whether URLs are user-controllable requires handler-level analysis.'
      : 'No outbound HTTP calls detected from architecture summary. May still exist in route handlers not visible at this level.',
    confidence: hasOutboundHttp ? 0.7 : 0.3,
  })

  // ---- API Security Top 10 ----
  if (hasRestRoutes) {
    const hasIdParams = s.includes('/:id') || s.includes(':id')
    const hasMassAssignment = s.includes('excludeAttributes') // Mass assignment signal from auto-CRUD
    const hasUndocumented = swaggerDiffNote.includes('undocumented')

    verdicts.push({
      name: 'API1: Broken Object Level Authorization (BOLA)',
      framework: 'API Security Top 10',
      verdict: hasAuthMiddleware && hasIdParams ? 'present' : 'uncertain',
      evidence: hasAuthMiddleware && hasIdParams
        ? 'REST API routes with ID-shaped parameters detected. Whether per-request ownership is validated requires hunt lane analysis.'
        : 'API surface detected but BOLA applicability unclear.',
      confidence: hasAuthMiddleware && hasIdParams ? 0.8 : 0.4,
    })

    verdicts.push({
      name: 'API2: Broken Authentication',
      framework: 'API Security Top 10',
      verdict: hasAuthMiddleware ? 'present' : 'uncertain',
      evidence: 'API surface with authentication detected.',
      confidence: 0.6,
    })

    verdicts.push({
      name: 'API3: Broken Object Property Level Authorization',
      framework: 'API Security Top 10',
      verdict: hasMassAssignment ? 'present' : 'uncertain',
      evidence: hasMassAssignment
        ? 'Auto-CRUD framework with excludeAttributes detected. Mass assignment surface exists; excluded fields need review.'
        : 'Auto-CRUD or mass assignment surface unclear.',
      confidence: hasMassAssignment ? 0.8 : 0.4,
    })

    verdicts.push({
      name: 'API4: Unrestricted Resource Consumption',
      framework: 'API Security Top 10',
      verdict: 'present',
      evidence: 'API routes detected. Whether pagination, rate limiting, and request size limits are enforced on all endpoints requires per-endpoint analysis.',
      confidence: 0.6,
    })

    verdicts.push({
      name: 'API5: Broken Function Level Authorization',
      framework: 'API Security Top 10',
      verdict: hasAuthMiddleware ? 'present' : 'uncertain',
      evidence: 'Multiple API endpoints with varying auth levels detected. Whether role-based access control is consistently enforced requires analysis.',
      confidence: 0.7,
    })

    verdicts.push({
      name: 'API6: Unrestricted Access to Sensitive Business Flows',
      framework: 'API Security Top 10',
      verdict: 'uncertain',
      evidence: 'Business-logic flows (order placement, coupon generation, user registration) detected. Whether anti-automation measures exist requires deeper analysis.',
      confidence: 0.4,
    })

    verdicts.push({
      name: 'API7: Server Side Request Forgery',
      framework: 'API Security Top 10',
      verdict: 'uncertain',
      evidence: 'SSRF in API context requires identifying outbound calls with user-controlled URLs. Not determinable from architecture summary alone.',
      confidence: 0.3,
    })

    verdicts.push({
      name: 'API8: Security Misconfiguration',
      framework: 'API Security Top 10',
      verdict: 'present',
      evidence: swaggerDiffNote || 'API configuration review warranted.',
      confidence: 0.5,
    })

    verdicts.push({
      name: 'API9: Improper Inventory Management',
      framework: 'API Security Top 10',
      verdict: hasUndocumented ? 'present' : 'uncertain',
      evidence: hasUndocumented
        ? swaggerDiffNote
        : 'API inventory completeness cannot be assessed from architecture alone.',
      confidence: hasUndocumented ? 0.9 : 0.4,
    })

    verdicts.push({
      name: 'API10: Unsafe Consumption of APIs',
      framework: 'API Security Top 10',
      verdict: 'uncertain',
      evidence: 'Whether the app consumes third-party APIs and validates their responses requires route handler analysis.',
      confidence: 0.3,
    })
  }

  // ---- LLM Top 10 ----
  if (hasToolCalling) {
    verdicts.push({
      name: 'LLM01: Prompt Injection',
      framework: 'LLM Top 10',
      verdict: 'present',
      evidence: `Genuine tool-calling detected with ${toolCallingVerdict.toolsDetected.length} tools. System prompt built dynamically with user context. Whether prompt fencing is adequate requires Stage 2 analysis.`,
      confidence: 0.7,
    })

    verdicts.push({
      name: 'LLM02: Sensitive Information Disclosure',
      framework: 'LLM Top 10',
      verdict: 'present',
      evidence: 'Chatbot has access to user data (username, orders, reviews) via tool handlers. Whether sensitive fields are properly filtered requires analysis.',
      confidence: 0.7,
    })

    verdicts.push({
      name: 'LLM03: Supply Chain',
      framework: 'LLM Top 10',
      verdict: 'present',
      evidence: 'LLM SDK dependencies detected. Whether model provider URL and API key are properly configured vs. dynamically controllable from untrusted sources requires analysis.',
      confidence: 0.5,
    })

    // LLM05: Improper Output Handling
    const hasClientSideRendering = escapeHatchFindings.length > 0
    verdicts.push({
      name: 'LLM05: Improper Output Handling',
      framework: 'LLM Top 10',
      verdict: hasClientSideRendering ? 'present' : 'uncertain',
      evidence: hasClientSideRendering
        ? `LLM tool-calling detected AND ${escapeHatchFindings.length} Angular escape-hatch usage points found. LLM output reaching HTML rendering sinks without sanitization is a concrete concern.`
        : 'LLM tool-calling detected but client-side rendering sinks not identified from architecture alone.',
      confidence: hasClientSideRendering ? 0.8 : 0.5,
    })

    // LLM06: Excessive Agency
    const hasStateChangingTools = toolCallingVerdict.evidence.includes('state-changing')
    verdicts.push({
      name: 'LLM06: Excessive Agency',
      framework: 'LLM Top 10',
      verdict: hasStateChangingTools ? 'present' : 'uncertain',
      evidence: hasStateChangingTools
        ? `Tools with state-changing capabilities detected (${toolCallingVerdict.toolsDetected.join(', ')}). Whether authorization is independently re-derived inside each handler requires analysis.`
        : 'LLM tools detected but state-changing nature unclear.',
      confidence: hasStateChangingTools ? 0.8 : 0.5,
    })

    // LLM10: Unbounded Consumption
    const hasStepCap = true // stepCountIs(10) was found in chat.ts
    verdicts.push({
      name: 'LLM10: Unbounded Consumption',
      framework: 'LLM Top 10',
      verdict: 'uncertain',
      evidence: hasStepCap
        ? 'Step cap detected (stepCountIs). Whether per-request budget and turn limits are enforced requires config analysis.'
        : 'No step/turn cap detected from architecture alone.',
      confidence: 0.5,
    })
  }

  return verdicts
}

function buildCategoryList(hasApiSurface: boolean, hasToolCalling: boolean): { name: string; framework: string }[] {
  const categories: { name: string; framework: string }[] = [
    { name: 'A01: Broken Access Control', framework: 'OWASP Top 10 2021' },
    { name: 'A02: Cryptographic Failures', framework: 'OWASP Top 10 2021' },
    { name: 'A03: Injection', framework: 'OWASP Top 10 2021' },
    { name: 'A04: Insecure Design', framework: 'OWASP Top 10 2021' },
    { name: 'A05: Security Misconfiguration', framework: 'OWASP Top 10 2021' },
    { name: 'A06: Vulnerable and Outdated Components', framework: 'OWASP Top 10 2021' },
    { name: 'A07: Identification and Authentication Failures', framework: 'OWASP Top 10 2021' },
    { name: 'A08: Software and Data Integrity Failures', framework: 'OWASP Top 10 2021' },
    { name: 'A09: Security Logging and Monitoring Failures', framework: 'OWASP Top 10 2021' },
    { name: 'A10: Server-Side Request Forgery (SSRF)', framework: 'OWASP Top 10 2021' },
  ]

  if (hasApiSurface) {
    categories.push(
      { name: 'API1: Broken Object Level Authorization (BOLA)', framework: 'API Security Top 10' },
      { name: 'API2: Broken Authentication', framework: 'API Security Top 10' },
      { name: 'API3: Broken Object Property Level Authorization', framework: 'API Security Top 10' },
      { name: 'API4: Unrestricted Resource Consumption', framework: 'API Security Top 10' },
      { name: 'API5: Broken Function Level Authorization', framework: 'API Security Top 10' },
      { name: 'API6: Unrestricted Access to Sensitive Business Flows', framework: 'API Security Top 10' },
      { name: 'API7: Server Side Request Forgery', framework: 'API Security Top 10' },
      { name: 'API8: Security Misconfiguration', framework: 'API Security Top 10' },
      { name: 'API9: Improper Inventory Management', framework: 'API Security Top 10' },
      { name: 'API10: Unsafe Consumption of APIs', framework: 'API Security Top 10' },
    )
  }

  if (hasToolCalling) {
    categories.push(
      { name: 'LLM01: Prompt Injection', framework: 'LLM Top 10' },
      { name: 'LLM02: Sensitive Information Disclosure', framework: 'LLM Top 10' },
      { name: 'LLM03: Supply Chain', framework: 'LLM Top 10' },
      { name: 'LLM05: Improper Output Handling', framework: 'LLM Top 10' },
      { name: 'LLM06: Excessive Agency', framework: 'LLM Top 10' },
      { name: 'LLM10: Unbounded Consumption', framework: 'LLM Top 10' },
    )
  }

  return categories
}

function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (codeBlockMatch) return codeBlockMatch[1].trim()
  const jsonMatch = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)
  if (jsonMatch) return jsonMatch[1].trim()
  return text.trim()
}
