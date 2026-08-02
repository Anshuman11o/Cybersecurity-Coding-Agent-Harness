/**
 * Claude Code CLI transport.
 *
 * Presents the same surface a stage already uses — `.chat.completions.create()`
 * returning an OpenAI-shaped response — but satisfies it by spawning the local
 * `claude -p` binary instead of making an HTTP call. Selected by a registry
 * field (`"transport": "claude-cli"`), never by a provider name, so adding a
 * CLI-backed target stays a data change.
 *
 * Why this exists: it lets a Claude model run the benchmark against a
 * subscription rather than a metered API key, while keeping the measured
 * quantities real. Token counts come from the CLI's own `modelUsage` block,
 * which reports actual usage per invocation; cost is computed downstream from
 * those counts against the registry's rates. The CLI's own `costUSD` field is
 * NOT used — it prices Sonnet 5 at the post-2026-08-31 rate and disagrees with
 * the registry.
 *
 * ── The sandbox is the blind-development boundary ────────────────────────────
 *
 * A `claude -p` process is an agent harness, not a completion endpoint: left to
 * its own defaults it carries a full system prompt, every CLAUDE.md in scope,
 * and the Read/Bash tool set. Any one of those would let the scanner see the
 * answer key sitting one directory above the corpus.
 *
 * SANDBOX_FLAGS closes all three, and is passed on EVERY invocation.
 *
 * The resume path is the trap. Measured 2026-08-02: a session created with
 * `--tools ""` and then resumed WITHOUT re-passing it regains the full tool set
 * and will read an arbitrary file off disk. Since the trace loop's second turn
 * is a resume, omitting the flags there would have handed every lane's turn 2
 * unrestricted filesystem access. Re-pass them always; `guard.test.ts` asserts
 * both paths.
 *
 * Zero npm dependencies (node builtins only), matching the rest of `shared/`,
 * so it can be imported across stage package boundaries.
 */
import { spawn } from 'child_process'
import { randomUUID, createHash } from 'crypto'
import { appendFileSync } from 'fs'

/** Resolved binary. Overridable for testing; defaults to the installed path. */
const CLI_BIN = process.env.CLAUDE_CLI_PATH ?? '/opt/claude-code/bin/claude'

/**
 * The flags that constitute the sandbox. Exported so the guard test asserts
 * against this exact array rather than a copy that could drift from it.
 *
 * - `--safe-mode`           no CLAUDE.md, skills, plugins, hooks or agents
 * - `--tools ""`            no tools at all: no Read, no Bash, no filesystem
 * - `--strict-mcp-config`   ignore ambient MCP servers (no --mcp-config passed)
 * - `--disable-slash-commands`  no skills, which can carry their own context
 *
 * `--safe-mode` is the one that is easy to omit and expensive to omit.
 * Measured 2026-08-02, identical prompt, `--system-prompt ''` already set:
 *
 *     run from a neutral cwd         175 input tokens
 *     run from inside this repo    3,134 input tokens
 *     run from inside, --safe-mode   175 input tokens
 *
 * Those 2,959 tokens are this repository's CLAUDE.md, auto-discovered because
 * the scanner necessarily runs inside the repo. It names the denylisted files
 * (including the one that is a literal array of every challenge key), states
 * where the answer key lives, and explains the blind-development scheme the
 * scanner is being measured under — into every one of a run's 1,082 prompts.
 * Not the answer key itself, but unambiguously contamination, and precisely the
 * class of leak this project has been bitten by before.
 *
 * `--add-dir` must never appear anywhere in this file.
 */
export const SANDBOX_FLAGS: readonly string[] = Object.freeze([
  '--safe-mode',
  '--tools', '',
  '--strict-mcp-config',
  '--disable-slash-commands',
])

/** Per-invocation record appended to the usage ledger. */
export interface CliUsageRecord {
  ts: string
  lane_hint: string
  session_id: string
  resumed: boolean
  duration_ms: number | null
  num_turns: number | null
  stop_reason: string | null
  is_error: boolean
  /** Per-model usage exactly as the CLI reported it, all models included. */
  model_usage: Record<string, unknown>
}

/**
 * Where per-call usage is appended, as JSONL. Set by the stage to a path inside
 * its own run tree. When unset nothing is written and only the returned usage
 * is available — acceptable for a probe, not for a scored run.
 */
let usageLedgerPath: string | null = null
export function setUsageLedgerPath(path: string | null): void {
  usageLedgerPath = path
}

/**
 * Maps a conversation to the CLI session that holds it.
 *
 * A stage calls `create()` with the whole message array each time. The first
 * call for a lane carries one user message; a follow-up turn carries
 * [user, assistant, user, ...]. The first user message therefore identifies the
 * conversation, and its hash is the key. On a follow-up only the newest user
 * message is sent — the CLI session already holds the rest, and holds the
 * assistant turn as genuinely its own output, which is what the trace loop
 * depends on.
 */
const sessionByConversation = new Map<string, string>()

function conversationKey(firstUserContent: string): string {
  return createHash('sha256').update(firstUserContent).digest('hex')
}

/** Extract the JSON schema from an OpenAI-style response_format, if present. */
function schemaFrom(params: any): Record<string, unknown> | null {
  const rf = params?.response_format
  if (rf?.type === 'json_schema' && rf.json_schema?.schema) return rf.json_schema.schema
  return null
}

interface CliResult {
  is_error: boolean
  result: string
  session_id: string
  num_turns: number | null
  stop_reason: string | null
  duration_ms: number | null
  modelUsage: Record<string, {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }>
}

function runCli(args: string[], prompt: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Inherit the environment, but never leak a scanner credential into a
      // process that authenticates on its own.
      env: { ...process.env },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => {
      // stdin is closed immediately below, but the CLI still prints a warning
      // to stdout in some paths; take the JSON document, not the whole stream.
      const start = out.indexOf('{')
      if (start < 0) {
        reject(new Error(
          `claude CLI produced no JSON (exit ${code}): ${(err || out).slice(0, 400)}`,
        ))
        return
      }
      try {
        resolve(JSON.parse(out.slice(start)) as CliResult)
      } catch (e: any) {
        reject(new Error(`claude CLI emitted unparseable JSON (exit ${code}): ${e.message}`))
      }
    })
    // The CLI waits 3s for stdin and prepends a warning to stdout if it never
    // arrives. Closing it immediately avoids both the delay and the warning.
    child.stdin.end()
  })
}

/**
 * Sum the usage legs for one model id into the OpenAI `usage` shape.
 *
 * `prompt_tokens` is the whole input presented to the model — fresh, cache
 * reads and cache writes together — because that is what the OpenAI field
 * means and what `costUsd()` decomposes again using the details block. Getting
 * this wrong would under-report input by whatever the cache served.
 */
function toOpenAiUsage(mu: CliResult['modelUsage'], modelId: string) {
  const m = mu?.[modelId]
  if (!m) {
    return { prompt_tokens: null, completion_tokens: null, total_tokens: null }
  }
  const fresh = m.inputTokens ?? 0
  const cachedRead = m.cacheReadInputTokens ?? 0
  const cacheWrite = m.cacheCreationInputTokens ?? 0
  const promptTokens = fresh + cachedRead + cacheWrite
  const completionTokens = m.outputTokens ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: cachedRead,
      cache_write_tokens: cacheWrite,
    },
  }
}

export interface ClaudeCliClientOptions {
  /** Model id sent to `--model`. */
  model: string
  /** Reasoning effort for `--effort`, when the target declares one. */
  effort?: string
}

/**
 * Build a client exposing the subset of the OpenAI surface the stages use.
 *
 * Deliberately not an `OpenAI` subclass: it implements exactly
 * `chat.completions.create()` and nothing else, so any stage reaching for
 * another method fails loudly at the call site rather than silently degrading.
 */
export function createClaudeCliClient(opts: ClaudeCliClientOptions) {
  return {
    chat: {
      completions: {
        async create(params: any): Promise<any> {
          const messages: Array<{ role: string; content: string }> = params.messages ?? []
          if (messages.length === 0) throw new Error('claude-cli transport: no messages')

          const firstUser = messages.find(m => m.role === 'user')
          if (!firstUser) throw new Error('claude-cli transport: no user message')

          // The newest user message is what this turn actually sends; anything
          // earlier is already in the CLI session's own transcript.
          const latestUser = [...messages].reverse().find(m => m.role === 'user')!
          const key = conversationKey(firstUser.content)
          const existing = sessionByConversation.get(key)
          const isFollowUp = messages.length > 1 && Boolean(existing)

          // EVERY parameter is re-passed on EVERY invocation, resume included.
          // Nothing is inherited from the session, because measurement says
          // nothing reliably is:
          //
          //   --tools ""       omitted on resume -> full tool set returns, and
          //                    the model reads arbitrary files off disk
          //   --system-prompt  omitted on resume -> turn 2's prompt measured
          //                    10,428 tokens against turn 1's 660, i.e. the
          //                    default Claude Code preamble came back
          //   --json-schema    omitted on resume -> turn 2 answers in prose,
          //                    which the trace loop records as an unparseable
          //                    lane rather than as a failure
          //
          // The two branches therefore differ by exactly one thing: whether the
          // session is being created or continued.
          const args: string[] = ['-p', latestUser.content, ...SANDBOX_FLAGS, '--output-format', 'json']
          args.push('--model', opts.model)
          // The scanner sends no system message; an empty system prompt is the
          // closest equivalent and, critically, REPLACES the CLI's own default
          // system prompt rather than appending to it.
          args.push('--system-prompt', '')
          if (opts.effort) args.push('--effort', opts.effort)
          const schema = schemaFrom(params)
          if (schema) args.push('--json-schema', JSON.stringify(schema))

          let sessionId: string
          if (isFollowUp) {
            sessionId = existing!
            args.push('--resume', sessionId)
          } else {
            sessionId = randomUUID()
            sessionByConversation.set(key, sessionId)
            args.push('--session-id', sessionId)
          }

          const res = await runCli(args, latestUser.content)

          if (usageLedgerPath) {
            const rec: CliUsageRecord = {
              ts: new Date().toISOString(),
              lane_hint: key.slice(0, 12),
              session_id: sessionId,
              resumed: isFollowUp,
              duration_ms: res.duration_ms ?? null,
              num_turns: res.num_turns ?? null,
              stop_reason: res.stop_reason ?? null,
              is_error: Boolean(res.is_error),
              model_usage: res.modelUsage ?? {},
            }
            try {
              appendFileSync(usageLedgerPath, JSON.stringify(rec) + '\n')
            } catch {
              // A ledger write failure must not kill a paid lane. The returned
              // usage still carries this call's counts.
            }
          }

          if (res.is_error) {
            const e: any = new Error(`claude CLI returned is_error: ${String(res.result).slice(0, 300)}`)
            // Surface as retryable when it looks like a limit, so the stage's
            // existing backoff applies rather than losing the lane.
            if (/rate limit|usage limit|429|overloaded/i.test(String(res.result))) e.status = 429
            throw e
          }

          return {
            choices: [{ message: { content: res.result }, finish_reason: res.stop_reason ?? 'stop' }],
            usage: toOpenAiUsage(res.modelUsage, opts.model),
          }
        },
      },
    },
  }
}

/** Clear conversation→session state. For tests, and between lanes if desired. */
export function resetSessions(): void {
  sessionByConversation.clear()
}
