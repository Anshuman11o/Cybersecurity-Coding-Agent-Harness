/**
 * Provider preflight — verify credentials, model access, and parameter shape
 * before spending money on a real stage run.
 *
 *   cd tools/scanner/stage3-validate
 *   SCANNER_PROVIDER=luna npx tsx ../shared/preflight.ts
 *
 * Costs a few tokens. Exits non-zero on failure so it can gate a pipeline.
 */
import { createClient } from '../stage3-validate/src/llm-client.js'
import {
  resolveProvider,
  modelFor,
  labelFor,
  apiKeyEnvFor,
  tokenLimitParam,
  samplingParams,
} from './provider.js'

async function main() {
  const provider = resolveProvider('preflight')
  const model = modelFor(provider)

  console.log(`provider : ${provider} (${labelFor(provider)})`)
  console.log(`model    : ${model}`)
  console.log(`params   : ${JSON.stringify({ ...samplingParams(provider), ...tokenLimitParam(provider, 16) })}`)

  const keyVar = apiKeyEnvFor(provider)
  if (!process.env[keyVar]) {
    console.error(`\nFAIL: ${keyVar} is not set`)
    process.exit(1)
  }
  console.log(`key      : ${keyVar} present (${process.env[keyVar]!.length} chars)`)

  let client
  try {
    client = createClient(provider)
  } catch (e: any) {
    console.error(`\nFAIL: client construction — ${e?.message}`)
    process.exit(1)
  }

  // 1. Plain completion — proves auth + model access.
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      ...samplingParams(provider),
      ...tokenLimitParam(provider, 16),
    } as any)
    console.log(`\n[1/2] completion : ${JSON.stringify(r.choices[0]?.message?.content)}`)
    console.log(`      usage      : ${JSON.stringify(r.usage)}`)
  } catch (e: any) {
    console.error(`\nFAIL [1/2] completion — status ${e?.status}: ${String(e?.message).slice(0, 400)}`)
    process.exit(1)
  }

  // 2. Structured output — the scanner depends on json_schema strict mode.
  //    A failure here is not fatal: hunt-executor/validator fall back to
  //    json_object automatically. But it is worth knowing up front.
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Return {"ok": true}' }],
      ...samplingParams(provider),
      ...tokenLimitParam(provider, 64),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'preflight',
          strict: true,
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      },
    } as any)
    console.log(`[2/2] json_schema: ${JSON.stringify(r.choices[0]?.message?.content)}`)
  } catch (e: any) {
    console.warn(`[2/2] json_schema: NOT SUPPORTED (${e?.status}) — stages will fall back to json_object`)
  }

  console.log('\nPASS')
}

main()
