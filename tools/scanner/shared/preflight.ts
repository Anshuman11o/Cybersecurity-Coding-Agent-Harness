/**
 * Provider preflight — verify credentials, model access, and parameter shape
 * before spending money on a real stage run.
 *
 *   cd tools/scanner/shared
 *   SCANNER_PROVIDER=luna npx tsx preflight.ts
 *
 * Costs a few tokens. Exits non-zero on failure so it can gate a pipeline.
 *
 * Two things this file learned the hard way on 2026-08-01, both of which it
 * previously got wrong:
 *
 * 1. It probed with a 16-token cap and only checked that the call did not
 *    throw. On a reasoning model the thinking budget consumes the cap before
 *    any content is emitted, so the call returns HTTP 200 with an EMPTY body
 *    and finish_reason "length" — and preflight printed PASS. Two targets
 *    (gemini31pro, glm52) passed that way while returning nothing at all.
 *    A gate that cannot tell a working model from a silent one is worse than
 *    no gate, because the run that follows attributes the emptiness to the
 *    scanner's reasoning rather than to the probe. Both probes now use the
 *    target's real registry cap and assert on the body.
 *
 * 2. It imported its client from stage3-validate, a stage no longer in the
 *    pipeline, so preflight could only run from that directory and died with
 *    ERR_MODULE_NOT_FOUND when that stage's deps were absent. It now builds
 *    its own client from the registry and depends on no stage at all.
 */
import OpenAI from 'openai'
import { createClaudeCliClient } from './claude-cli-client.js'
import {
  resolveProvider,
  modelFor,
  labelFor,
  apiKeyEnvFor,
  clientConfigFor,
  transportFor,
  tokenLimitParam,
  samplingParams,
  outputTokenCap,
  pricingFor,
} from './provider.js'

/**
 * Cap used for both probes. The registry value is what a real stage will send,
 * and it is the thing under test: a cap that truncates here truncates there.
 * Falls back to 4096 only for a target that declares none — well above any
 * observed thinking budget for a two-token answer, and still trivially cheap.
 */
const PROBE_FALLBACK_CAP = 4096

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`)
  process.exit(1)
}

async function main() {
  const provider = resolveProvider('preflight')
  const model = modelFor(provider)
  const cap = outputTokenCap(provider, PROBE_FALLBACK_CAP)

  console.log(`provider : ${provider} (${labelFor(provider)})`)
  console.log(`model    : ${model}`)
  console.log(`params   : ${JSON.stringify({ ...samplingParams(provider), ...tokenLimitParam(provider, cap) })}`)

  const transport = transportFor(provider)
  console.log(`transport: ${transport}`)

  // A CLI-backed target authenticates through the local Claude Code session and
  // declares no usable credential env var, so the key and endpoint checks below
  // do not apply to it. The two live calls that follow are the real preflight
  // either way — they are what proves the target can emit content and honour a
  // schema, and they run identically over both transports.
  let client: OpenAI
  if (transport === 'claude-cli') {
    console.log(`key      : (n/a — authenticates through the Claude Code session)`)
    console.log(`endpoint : (n/a — local CLI, no HTTP endpoint)`)
    const price = pricingFor(provider)
    console.log(`price    : ${price ? `$${price.input}/$${price.output} per MTok` : '(unpriced — runs will report no cost)'}`)
    const effort = samplingParams(provider).reasoning_effort
    client = createClaudeCliClient({
      model,
      effort: typeof effort === 'string' ? effort : undefined,
    }) as unknown as OpenAI
  } else {
    const keyVar = apiKeyEnvFor(provider)
    if (!process.env[keyVar]) fail(`${keyVar} is not set`)
    console.log(`key      : ${keyVar} present (${process.env[keyVar]!.length} chars)`)

    const { apiKey, baseURL } = clientConfigFor(provider)
    console.log(`endpoint : ${baseURL ?? '(SDK default)'}`)

    const price = pricingFor(provider)
    console.log(`price    : ${price ? `$${price.input}/$${price.output} per MTok` : '(unpriced — runs will report no cost)'}`)

    try {
      client = new OpenAI({ apiKey: apiKey!, ...(baseURL ? { baseURL } : {}) })
    } catch (e: any) {
      fail(`client construction — ${e?.message}`)
    }
  }

  // 1. Plain completion — proves auth, model access, and that the target can
  //    actually emit content under its own configured cap.
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      ...samplingParams(provider),
      ...tokenLimitParam(provider, cap),
    } as any)

    const choice = r.choices?.[0]
    const content = choice?.message?.content
    console.log(`\n[1/2] completion : ${JSON.stringify(content)}`)
    console.log(`      finish     : ${choice?.finish_reason}`)
    console.log(`      usage      : ${JSON.stringify(r.usage)}`)

    // The check the old version was missing. An empty body is the exact shape
    // a truncated reasoning response takes, and downstream it is recorded as a
    // lane that found nothing rather than as an error.
    if (!content || content.trim() === '') {
      fail(
        `[1/2] completion returned an EMPTY body (finish_reason=${choice?.finish_reason}) ` +
          `at a ${cap}-token cap. The model is reachable but emitted no content — ` +
          `usually the thinking budget consuming the whole cap. Raise ` +
          `max_output_tokens for this target in models.json.`,
      )
    }
    if (choice?.finish_reason === 'length') {
      fail(
        `[1/2] completion was TRUNCATED (finish_reason=length) at a ${cap}-token cap ` +
          `on a two-token answer. Any real stage prompt will truncate far worse. ` +
          `Raise max_output_tokens for this target in models.json.`,
      )
    }
  } catch (e: any) {
    fail(`[1/2] completion — status ${e?.status}: ${String(e?.message).slice(0, 400)}`)
  }

  // 2. Structured output — the scanner depends on json_schema strict mode.
  //    A failure here is not fatal: hunt-executor/validator fall back to
  //    json_object automatically. But it is worth knowing up front, and a
  //    body that comes back unparseable must be reported as unsupported
  //    rather than as success — that was the second half of the false PASS.
  let schemaOk = false
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Return {"ok": true}' }],
      ...samplingParams(provider),
      ...tokenLimitParam(provider, cap),
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

    const content = r.choices?.[0]?.message?.content
    let parsed: any
    try {
      parsed = JSON.parse(content ?? '')
    } catch {
      parsed = undefined
    }

    if (parsed?.ok === true) {
      schemaOk = true
      console.log(`[2/2] json_schema: ${JSON.stringify(content)} — honoured`)
    } else {
      console.warn(
        `[2/2] json_schema: NOT HONOURED — returned ${JSON.stringify(content)}, ` +
          `which does not parse to the requested schema. Stages will fall back ` +
          `to json_object.`,
      )
    }
  } catch (e: any) {
    console.warn(
      `[2/2] json_schema: NOT SUPPORTED (${e?.status}) — stages will fall back to json_object`,
    )
  }

  console.log(`\nPASS${schemaOk ? '' : ' (with json_object fallback — see [2/2] above)'}`)
}

main()
