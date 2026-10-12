# Task 2a: round-1 inputs, GPT-6 Luna default, exclusions in recon, spend ledger, estimate, budget gate, tier and concurrency

Approved by the owner on 2026-10-12, items A, B, C, D, E, F, G, H and K of the
input-and-budget design. Local npm package only.

Out of scope, do not build: the playbook agent, the round-2 class review
screen, GitHub Actions, the report stage.

## Standing constraints (every subagent)

- **Never search for, read, or reference any answer-key or ground-truth material
  anywhere on this machine** (`/home/user/juice-shop-answer-key`,
  `/home/user/harness-private`, `benchmark_ground_truth`, anything similar).
- No model id, endpoint or credential variable name in code. They live in
  `tools/scanner/shared/models.json` and are read through `shared/models.ts` /
  `shared/provider.ts`. `shared/guard.test.ts` checks new code for registry
  literals.
- Never make a real model API call and never print an API key value. Tests use
  injected fake clients or a local fake server.
- Lab (benchmark profile) stays as it is: `default_provider` stays `luna`;
  Stage 1's `budget-plan-v2.json` stays identical apart from `generated_at`; a
  target without the new registry fields behaves exactly as before (no
  `service_tier` sent, no long-context or regional multiplier).
- `shared/guard.test.ts` is append-only. `docs/benchmarking-results.md` and
  `results/eval-history/` are not touched.
- Edit only the files you own (below). If you need a change in a file you do
  not own, stop and say so in your report instead of making it.
- Tests are small unit tests proving each feature works. No full scanner run.
- Match the surrounding code: comment density, naming, idiom.

## The approved design, in one place

### Prices and tiers (registry data)
GPT-6 Luna, from the official model and pricing pages (2026-10-12): per 1M
tokens, Standard, prompt <= 272K: input $0.10, cached $0.01, cache write
$0.125, output $0.50. Prompt over 272K: input and cache x2, output x1.5, for the
whole request. Service tiers: `default` (Standard) 1x, `flex` 0.5x, `batch`
0.5x, `priority` and `fast` 2x (Priority was renamed Fast on 2026-07-30; which
string the API returns is unverified, so both are listed). Ultrafast has no
published price, so it and any other tier string are unpriced. Regional
(data-residency) endpoints +10%. Web search $10 per 1,000 calls.

### Actual cost of one call (live)
```
fresh = prompt_tokens - cached_tokens - cache_write_tokens
cost  = tier x region x [ ctx_in x (fresh x in + cached x cached_in + written x cache_write)
                        + ctx_out x completion_tokens x out ] / 1,000,000
        + web_searches x web_search_usd_per_call
```
- `tier`: multiplier of the tier the response's `service_tier` reports.
  Missing field: 1. Unknown string: unpriced (the run stops cleanly).
- `region`: `regional_uplift` when the base URL host matches the target's
  `regional_endpoint_pattern`, else 1.
- `ctx_in`, `ctx_out`: the target's `long_context` multipliers when
  `prompt_tokens` > threshold, else 1.
- Completion tokens include reasoning tokens.
- Usage shapes, both verified on gpt-6-luna:
  - Chat Completions: `prompt_tokens`, `completion_tokens`,
    `prompt_tokens_details.{cached_tokens, cache_write_tokens}`,
    `completion_tokens_details.reasoning_tokens`.
  - Responses: `input_tokens`, `output_tokens`,
    `input_tokens_details.{cached_tokens, cache_write_tokens}`,
    `output_tokens_details.reasoning_tokens`.

### The ledger
One append-only JSONL file per run per model:
`<runsRoot>/<provider>/spend-ledger.jsonl`. Every model call made by recon or
the hunt appends one entry, and resumes append to the same file. A call that
returns no usage is booked at a reservation (see U). The run's spend is the sum
of the entries. In the benchmark profile, recon starts a fresh ledger; in the
product profile the ledger is never truncated (each run has its own folder).

### Estimate before the scan
```
I     = sum over admitted files and chunks: first-call prompt tokens x (1 + (k - 1) x 1.19)
C_in  = I x upper_input_rate / 1M          (upper rate = max(input, cache_write); $0.125 on GPT-6 Luna)
C_out = I x R x out / 1M                   (R = output tokens per input token)
scan  = (C_in + C_out) x tier x region
Total = spent so far (ledger) + scan
```
- `k`: calls per chunk (the trace loop makes 2). 1.19 is the measured
  follow-up input multiplier already in Stage 1.
- First-call prompt tokens: the exact prompt text the hunt will send (built by
  the hunt's own prompt builder) divided by chars-per-token.
- **Chars-per-token:** recon's own calls this run (sum of chars sent / sum of
  prompt_tokens), else the calibration file, else the registry calibration,
  else 4.
- **R:** the calibration file (same model and effort, from earlier runs in
  this reports folder), else the registry calibration, else 0.341.
- **Accuracy band** by admitted file count (90%, resampled from run 6): >= 300
  files ±7%, >= 100 ±15%, >= 40 ±27%, >= 10 ±78%; under 10, no band (show "can
  vary widely").

### Reservation unit U and the gate
- **One number per run**, computed once at planning: the worst case of one
  chunk. Calls i = 0..k-1, with B the largest first-call prompt in bytes over
  the admitted chunks (a token is at least one byte), T the follow-up
  instruction template in bytes, and cap the output cap:
  - input bound of call i: `B + i x (2 x cap + T) + 32 x (2i + 1)` tokens;
  - output bound: `cap` tokens.
  - Each call is priced at the upper input rate and the output rate, with the
    long-context multipliers when its input bound passes the threshold.
  - U = tier x region x the sum over the k calls.
- **Gate rule:** a file with c chunks starts only if
  `spent + reserved_in_flight + c x U <= budget`, where `spent` is the ledger
  total (recon and earlier passes included).
  - Doesn't fit and files are in flight: wait. Doesn't fit and nothing is in
    flight: stop, INCOMPLETE, `max_cost`.
  - When a file finishes, its reservation is released; its calls are already
    in the ledger at actual cost.
- **A retry** asks for one more U under the same rule. If that doesn't fit, the
  file ends unscanned with reason `max_cost` and the run stops there.
- No budget: the gate always starts (unchanged).

### Calls
- One retry layer: SDK `maxRetries: 0`; at most 3 attempts per call; every
  attempt is booked in the ledger.
- **Empty answer** (no content) or **cut-off answer** (`finish_reason`
  "length"): a failed attempt, so retry. After 3 failed attempts the file is
  marked failed, never "no findings".
- **Quota or spend-limit error** (`insufficient_quota`,
  `project_spend_limit_exceeded`, `organization_spend_limit_exceeded`, or a 429
  whose code/type says quota or billing): no retry; the run stops cleanly,
  INCOMPLETE, `provider_quota`.
- **Rate-limit 429:**
  - step concurrency down once, x0.75, floor, at least 1;
  - one step per event: further 429s within 60 s of a step do not step again;
  - never climb back;
  - wait Retry-After or the reset header (at most 60 s) and retry within the 3
    attempts.
- **Transient** (5xx, network): backoff and retry within the 3 attempts.
- **3 files fail in a row** (completion order): the run stops, INCOMPLETE,
  `provider_failing`.
- **Unpriced tier** in any response: the run stops, INCOMPLETE,
  `unpriced_service_tier`.

### Tier and concurrency, set after recon
- **Tier:** recon's first model call sends no `service_tier` (the project
  setting decides). Recon records the served tier in `api-profile.json` and
  sends it explicitly on its later calls; the hunt sends it on every call.
  This applies only to targets whose registry entry declares `service_tiers`.
- **Concurrency from rate limits:** recon records `x-ratelimit-limit-tokens`
  and `x-ratelimit-limit-requests` from its first response in
  `api-profile.json`. Stage 1 sets:
  - per-slot TPM = (avg prompt tokens per call + avg output tokens per call) x
    60 / seconds per call, where avg prompt = I / calls, avg output =
    R x avg prompt, and seconds per call comes from the registry calibration
    (default 23.2);
  - concurrency = min(32, vendor ceiling, floor(0.7 x TPM / per-slot),
    floor(0.7 x RPM x seconds per call / 60), lane count), at least 1;
  - fixed for the run, except the step-down above.
  - An explicit `--concurrency` wins. No headers: 8.

### Round-1 inputs (CLI)
`npx secscan` (no subcommand) scans. Header:
`secscan · model GPT-6 Luna · OPENAI_API_KEY found`, with the key variable
name taken from the registry. Then, in order:
```
Scan this repository?  <path>  (git <branch> @ <short sha>)
                       [Enter] yes   [c] change   [q] quit
Save reports to?       <target>/.secscan/   (kept out of git)
                       [Enter] yes   [c] change
Exclude anything?      none  (.secscanignore not found)
                       [Enter] no    [c] add files or folders
Budget in USD?         >
```
- **Missing key:** interactive, ask once with hidden input, set it in this
  process's environment for the stages, never write it anywhere.
  Non-interactive: error as today.
- **Flags:**
  - `--yes` skips every prompt and requires `--budget`, except on
    `--resume`, where the previous budget is kept.
  - `--budget N` (alias of `--max-cost`), `--out DIR`, `--exclude PATH`
    (repeatable).
  - `--resume [run-id]`: no id means the latest INCOMPLETE run in the
    reports folder. It asks for a new budget, or takes `--budget`.
- Flags pre-fill the answers; a question whose answer came from a flag is
  shown as decided, not asked.
- **Model:** the product CLI uses the registry's `product_default_provider`
  (GPT-6 Luna). The Task 1c model flags (`--model`, `--models-file`,
  `--base-url`, `--api-key-env`, `--price`) keep working and are listed under
  "Lab options" in help.
- **Stale message:** "Recon makes up to two small model calls" becomes "up to
  five", and it says they count against the budget.

### Budget runs out (CLI)
Interactive, when the hunt stopped on `max_cost`:
```
Budget reached: $X spent. N of M files done, K left.
At this run's average ($A per file), finishing needs about $B more.
New budget, or Enter to stop: >
```
- X is the ledger total. A is the hunt's ledger spend / N. B = K x A. When
  N = 0, A is the plan's estimate per file.
- A new budget (must exceed X) continues the same run in place. Enter stops
  (INCOMPLETE). `--yes` or no terminal: no prompt.

### Reports folder
- **Default `<target>/.secscan/`**, gitignored (`*`).
- **Layout:**
  - runs: `<reports>/runs/<run-id>/`;
  - calibration: `<reports>/calibration.json`;
  - with `--out DIR`, the reports folder is DIR.
- **Stages are told** via `SCANNER_REPORTS_ROOT` and `SCANNER_RUNS_ROOT`.
- **Excluded from reading:** when inside the target, the whole reports folder
  is excluded from recon's walk and from the read guard (earlier runs' findings
  must never be read back).

## Shared interfaces (Phase 1 defines; Phase 2 uses, never redefines)

Phase 1 must export exactly these names, with these behaviours. Small
additions are fine; renames are not.

`shared/pricing.ts`
- `NormalizedUsage { prompt_tokens, cached_tokens, cache_write_tokens, completion_tokens, reasoning_tokens }` (each `number | null`)
- `normalizeUsage(raw): NormalizedUsage | null`: both API shapes; null when there is no usage or no token counts.
- `TierInfo { tier: string | null; label: string; multiplier: number | null }`
- `tiersManaged(provider): boolean`: the target declares `service_tiers`.
- `tierInfo(provider, servedTier): TierInfo`:
  - target without `service_tiers`: multiplier 1, label "Standard";
  - missing tier: 1;
  - unknown tier: null.
- `regionMultiplier(provider, baseURL): number`
- `upperInputRatePerMTok(provider): number | null`
- `CallCost { cost_usd: number | null; reason: null | 'unpriced_model' | 'unpriced_service_tier' | 'no_usage'; tier: TierInfo; long_context: boolean }`
- `callCostUsd(provider, usage, { servedTier?, baseURL?, webSearches? }): CallCost`
- `reservationUnitUsd(provider, { callsPerUnit, maxPromptBytes, followUpTemplateBytes, outputCap, servedTier?, baseURL? }): number | null`
- `worstCaseCallUsd(provider, { promptBytes, outputCap, servedTier?, baseURL? }): number | null`: one call's bound (used when a recon call returns no usage).
- `scanCostUsd(provider, { inputTokens, ratioR, servedTier?, baseURL? }): { input_usd, output_tokens, output_usd, scan_usd } | null`
- `estimateBandPct(files): number | null`
- `FOLLOW_UP_INPUT_MULTIPLIER = 1.19` (moved from Stage 1, which then imports it; the value does not change)

`shared/ledger.ts`
- `LEDGER_FILE = 'spend-ledger.jsonl'`, `LEDGER_SCHEMA = 'secscan.ledger/1'`
- `LedgerEntry { schema, at, source: 'recon' | 'hunt', stage, label, lane_id, attempt, model, served_tier, usage: NormalizedUsage | null, chars_sent, cost_usd, basis: 'actual' | 'reservation', note? }`
- `ledgerPathFor(runsRoot, provider): string`
- `class SpendLedger { constructor(path); append(entry without schema/at): LedgerEntry; total(): number; totals(): LedgerTotals; reset(): void }`: the constructor loads existing entries; append is one `appendFileSync` line.
- `LedgerTotals { total_usd, by_source: Record<string, number>, calls, reserved_calls, prompt_tokens, completion_tokens, chars_sent, prompt_tokens_with_chars }`
- `readLedgerTotals(path): LedgerTotals`: a missing file gives zeros; a partial last line is ignored.

`shared/api-profile.ts`
- `API_PROFILE_FILE = 'api-profile.json'`, written to `runPath(provider, 'stage0-recon')`.
- `ApiProfile { schema: 'secscan.api-profile/1', observed_at, provider, model, served_tier, tier_label, tier_multiplier, rate_limits: { requests_per_minute, tokens_per_minute }, recon_calls, chars_per_token }`
- `readApiProfile(path) / writeApiProfile(path, p)`
- `parseRateLimitHeaders(headers): { requests_per_minute, tokens_per_minute }`: accepts a fetch `Headers`, a plain object, or null.
- `parseResetMs(v): number | null`: formats like "12ms", "1s", "6m0s", "1h2m3.5s".
- `CONCURRENCY_CEILING = 32`, `RATE_LIMIT_MARGIN = 0.7`, `STEP_DOWN_FACTOR = 0.75`, `DEFAULT_SECONDS_PER_CALL = 23.2`
- `concurrencyFromRateLimits({ tokensPerMinute, requestsPerMinute, promptTokensPerCall, outputTokensPerCall, secondsPerCall, ceiling?, margin? }): { value, basis } | null`: null when neither limit is known.
- `stepDown(n): number`

`shared/api-errors.ts`
- `classifyApiError(err): 'quota' | 'rate_limit' | 'transient' | 'schema' | 'fatal'`
- `retryAfterMs(err): number | null`: from Retry-After or `x-ratelimit-reset-*` on the error's headers, capped at 60,000.

`shared/metered-call.ts`
- `TierPin { send: string | null }`
- `meteredChatCompletion(client, provider, params, pin): Promise<{ response, headers: Headers | null, usage: NormalizedUsage | null, servedTier: string | null, cost: CallCost, charsSent: number }>`
  - Adds `service_tier: pin.send` only when `tiersManaged(provider)` and `pin.send` is set.
  - Uses `.withResponse()` when the client returns a promise that has it (the lab's claude-cli client does not; then headers are null).
  - Does not retry and does not book the ledger: callers do.
- `promptChars(messages): number`

`shared/calibration.ts`
- `CALIBRATION_FILE = 'calibration.json'`
- `CalibrationRun { run_id, at, model, effort, files, calls, input_tokens, output_tokens, chars_sent, prompt_tokens_for_chars, ratio_R, chars_per_token }`
- `recordCalibration(reportsRoot, run)`: keeps the last 20.
- `calibratedRatios(reportsRoot, model, effort): { ratio_R: number | null, chars_per_token: number | null, runs: number }`: token-weighted.

`shared/run-context.ts`
- `RunContext.reportsRoot: string | null`:
  - product: `SCANNER_REPORTS_ROOT` or `<target>/.secscan`;
  - benchmark: null.
- Product `runsRoot` defaults to `<reportsRoot>/runs/<runId>`, which equals
  today's path when the reports root is the default.

`shared/models.json` / `models.ts` / `provider.ts`
- **New target `luna6`** (label "GPT-6 Luna", model `gpt-6-luna`):
  - fields `model_env`, `api_key_env`, `base_url_env` and `token_limit_param`
    as `luna`;
  - `sampling: { reasoning_effort: "high" }`, `max_output_tokens: 64000`;
  - the prices above, `price_asof: "2026-10-12"`.
- **New optional per-target fields:**
  - `long_context { threshold_tokens, input_multiplier, output_multiplier }`;
  - `service_tiers { <tier>: { multiplier, label } }`;
  - `regional_endpoint_pattern`, `regional_uplift`;
  - `web_search_usd_per_call`;
  - `calibration { output_per_input, chars_per_token, seconds_per_call, source }`.
  - luna6's `calibration` carries run 6's GPT-5.6 Luna values (0.341, 4,
    23.2) and says so in `source`.
  - Validated in `models.ts`.
- **New top-level `product_default_provider: "luna6"`**, with a
  `productDefaultProvider()` accessor. `default_provider` stays `luna`.
- **Accessors** for the new fields go in `provider.ts`.
- No `benchmark` block on luna6: it is unmeasured.

`stage1-budget-governor/src/scan-plan.ts` (types only in Phase 1)
- `ScanPlan.estimate { input_tokens, output_tokens, input_usd, output_usd, scan_usd, spent_before_usd, total_usd, band_pct, files, ratio_R, ratio_source, chars_per_token, chars_per_token_source, served_tier, tier_label, tier_multiplier, region_multiplier } | null`
- `ScanPlan.reservation_unit_usd: number | null`
- `ScanPlan.concurrency` gains `source: 'explicit' | 'rate-limits' | 'default'` and optional `tokens_per_minute`, `requests_per_minute`.

`stage1-budget-governor/src/run-status.ts` (types only in Phase 1)
- `StopReason` gains `'provider_quota' | 'provider_failing' | 'unpriced_service_tier'`.
- `Stage2Progress.spend` gains `ledger_spent_usd: number | null`, and `Stage2Progress` gains `concurrency: { current: number; initial: number }`.
- `Stage2RunStatus` gains `concurrency: { initial: number; final: number; step_downs: number }` and `spend.ledger_spent_usd`.

`stage2-hunt-lanes-perfile/src/hunt-executor.ts` (Phase 1: extraction only)
- `buildLanePrompts(lane, rawContent, classIds, playbooks, archSummarySnippet?, archSummary?): { chunk_index, prompt, breakdown }[]`:
  - the route-context and per-chunk prompt assembly `huntLane` does today,
    moved into a pure exported function that `huntLane` now calls;
  - prompt text byte-identical.
- `followUpTemplateBytes(): number`: the byte length of the follow-up
  instruction with nothing reported so far, computed by calling the existing
  builder, never copied.

## File ownership

| Phase | Owner | Files |
|---|---|---|
| 1 | foundation | `shared/models.json`, `shared/models.ts`, `shared/provider.ts`, `shared/run-context.ts`, new `shared/{pricing,ledger,api-profile,api-errors,metered-call,calibration}.ts`, new `shared/foundation.test.ts`, `shared/package.json` (test script), `stage1-budget-governor/src/scan-plan.ts` and `run-status.ts` (types only), `stage1-budget-governor/src/budget-governor.ts` (import `FOLLOW_UP_INPUT_MULTIPLIER` from shared only), `stage2-hunt-lanes-perfile/src/hunt-executor.ts` (extraction only), `shared/guard.test.ts` (append) |
| 2 | recon | `stage0-recon/src/file-selection.ts` (+ its test), `stage0-recon/src/llm-probe.ts`, `stage0-recon/src/recon.ts`, `shared/read-guard.ts`, new `stage0-recon/src/recon-budget.test.ts` |
| 2 | stage 1 | `stage1-budget-governor/src/budget-governor.ts` (scan-plan path only), `scan-plan.ts`, `limits.ts`, new `stage1-budget-governor/src/estimate.test.ts`, `stage1-budget-governor/package.json` |
| 2 | stage 2 | `stage2-hunt-lanes-perfile/src/hunt-executor.ts` (scheduling, gate, calls, ledger, progress; never prompt or schema text), `stage2-hunt-lanes-perfile/src/llm-client.ts`, new `stage2-hunt-lanes-perfile/src/call-policy.ts` + `call-policy.test.ts`, `stage1-budget-governor/src/spend-gate.ts`, `stage1-budget-governor/src/run-status.ts`, `stage1-budget-governor/src/limits.test.ts` (gate cases only), `stage2-hunt-lanes-perfile/package.json` |
| 2 | cli | `cli/src/*` (new `cli/src/inputs.ts` for round-1 prompts with injectable input/output), `cli/package.json` |
| end | orchestrator | `cli/README.md`, `docs/architecture/`, this file; integration hooks in `run.sh`, `shared/api-profile.ts`, `stage0-recon/src/{recon-contract,ast-extractor,frontend-grep,symbols,signal-detector,swagger-diff}.ts`, and CLI lockfile bin metadata |

## Verification (orchestrator, after each phase)
1. Read every diff.
2. Run all suites:
   - `shared` guard and foundation tests;
   - `cli` tests;
   - Stage 1 (`npm test`);
   - Stage 0 tests;
   - Stage 2 (`loop.test.ts`, `test-breakdown.ts`, `call-policy.test.ts`);
   - `tsc --noEmit` for `cli`, Stage 0, Stage 1 and Stage 2.
3. Lab regression: Stage 1 on the committed luna artifacts, old tree vs new
   tree, gives `budget-plan-v2.json` identical apart from `generated_at`.
4. Drive the round-1 prompts in a pseudo-terminal (quit before recon) and
   check each scenario's message and answer.
