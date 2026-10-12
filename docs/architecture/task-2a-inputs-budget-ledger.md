# Task 2a: inputs, budget ledger and call policy

Task 2a implements round-1 CLI inputs, the product model default, recon
exclusions, a shared spend ledger, estimates, a fixed reservation gate,
served-tier discovery, concurrency and continuation. The approved scope is
[the dispatch brief](../../prompts/dispatch/2026-10-12__task-2a-inputs-budget-ledger.md).
The playbook agent, round-2 class review, GitHub Actions and report stage are
outside this change. The CLI is a local npm package in the checkout.

## Run inputs and paths

With no subcommand, `secscan` scans the current directory. Before stages
start, `cli/src/inputs.ts` collects the target, reports folder, exclusions and
budget, in that order. Flags decide their corresponding answers and
`--yes` skips all prompts. A fresh `--yes` run requires `--budget` (alias
`--max-cost`); a resume may retain its previous cap. A missing credential is
read once with hidden input in an interactive terminal, retained only in
the process environment, and inherited by stages. Non-interactive runs fail
if it is absent.

The registry's `product_default_provider` selects `luna6`, labelled GPT-6
Luna; the lab's `default_provider` remains `luna`. GPT-6 Luna carries no
measurement claim. Model flags and custom-endpoint support remain under
"Lab options". Model identifiers, endpoints, credential names, pricing and
calibration are read from the registry.

The default reports folder is `<target>/.secscan/`; `--out` overrides it.
It contains a `.gitignore` with `*`, `calibration.json` and
`runs/<run-id>/`. The CLI passes `SCANNER_REPORTS_ROOT` and
`SCANNER_RUNS_ROOT` to every stage. The latter names that run's directory,
under which stage artifacts remain provider-isolated through `runPath()`.

Recon applies explicit exclusions and path scope during file selection,
before probing source. `.gitignore` and `.secscanignore` remain supported.
The product run writes `read-allowlist.json`, containing the target-relative
files downstream corpus reads may access. Recon's selection and enrichment
reads are audited in `read-audit.jsonl` as timestamps and paths, without
source text. The reports folder, `.git` and run artifacts inside the target
are excluded from both selection and guarded reads. The guard checks the
resolved path as well, including symlink destinations.

## Ledger and actual pricing

`shared/ledger.ts` owns one append-only JSONL ledger per run and provider:

```text
<runsRoot>/<provider>/spend-ledger.jsonl
```

Each entry has schema `secscan.ledger/1`, timestamp, source (`recon` or
`hunt`), stage, label, lane ID, attempt, model, served tier, normalized usage,
characters sent, cost and basis (`actual` or `reservation`). A single
`appendFileSync` writes each entry. Construction loads existing entries;
resumes append. A partial final line does not count toward totals and is
separated before another append. Product ledgers are never reset. Lab recon
resets its ledger at the start of a fresh run.

`shared/pricing.ts` normalizes both Chat Completions and Responses usage.
Unknown token counts stay null. Completion tokens already include reasoning
tokens; the reasoning breakdown is not added again. Per-call pricing is:

```text
fresh = prompt_tokens - cached_tokens - cache_write_tokens
cost  = tier × region × (
          ctx_in × (fresh × input_rate + cached × cached_rate + written × write_rate)
          + ctx_out × completion_tokens × output_rate
        ) / 1,000,000
        + web_searches × web_search_usd_per_call
```

The multipliers come from the target entry. Missing served tier means 1×;
an unknown declared tier is unpriced and stops the run. The regional
multiplier applies when the endpoint hostname matches the registry pattern.
Long-context multipliers apply to the whole request when prompt tokens
exceed its threshold. Targets without optional fields preserve the existing
1× behaviour.

For GPT-6 Luna the registry rates, dated 2026-10-12, are $0.10 fresh input,
$0.01 cached input, $0.125 cache writes and $0.50 output per million tokens.
Above 272,000 prompt tokens, input/cache rates are 2× and output is 1.5×.
Standard is 1×, Flex/Batch 0.5× and Priority/Fast 2×. Unlisted tiers remain
unpriced. Matching regional endpoints add 10%; web search is $0.01 per call.

Recon calls without usage book a one-call worst-case bound. Hunt attempts
without usage book U. Both mark those entries as reservations, so displayed
spend includes conservative charges rather than silently treating the
attempt as free. The ledger total is authoritative for progress, gating,
continuation and the run record; reconciled usage remains a separate artifact.

## Estimate and calibration

Stage 1 uses the hunt's exported `buildLanePrompts()` to build exactly the
first-call prompt text for each admitted chunk, including architecture,
route context and playbooks. Excluded files are not read for estimation.
For first-call token estimate `p = prompt.length / chars_per_token` and `k`
calls per chunk (two for the trace loop):

```text
I       = Σ p × (1 + (k - 1) × 1.19)
C_input = I × max(input_rate, cache_write_rate) / 1,000,000
C_out   = I × R × output_rate / 1,000,000
scan    = (C_input + C_out) × tier × region
total   = ledger spend so far + scan
```

Chars per token comes from this run's recon calls with measured usage, then
the reports-folder calibration, registry calibration, or 4. `R`, output
tokens per input token, comes from earlier runs in this reports folder with
the same model and reasoning effort, then registry calibration, or 0.341.
`calibration.json` retains the last 20 runs and combines ratios by token
weight. Recording a resumed run replaces its earlier calibration record by
run ID, so the run is not counted twice.

GPT-6 Luna's registry seed explicitly carries earlier GPT-5.6 Luna values:
`R = 0.341`, chars/token 4 and 23.2 seconds/call. These are placeholders for
this model until the reports folder supplies its own observations.

The displayed 90% accuracy band is chosen by admitted file count:

| Files | Band |
|---|---|
| 300 or more | ±7% |
| 100–299 | ±15% |
| 40–99 | ±27% |
| 10–39 | ±78% |
| Fewer than 10 | "can vary widely" |

The bands come from existing Luna calibration, not a new GPT-6 Luna run.
`scan-plan.json` saves the ratios, their sources, prices, tier, region,
spend before the hunt and total estimate alongside the admitted files.

## Fixed reservation unit and gate

The expected estimate does not control file admission. At planning, Stage 1
computes a single worst-case chunk reservation U. With `B` the maximum UTF-8
byte length of an admitted first-call prompt, `T` the hunt's follow-up
template byte length and `cap` its output token cap, call `i = 0..k-1` has:

```text
input_bound(i)  = B + i × (2 × cap + T) + 32 × (2i + 1)
output_bound(i) = cap
```

Every bound uses the greater of the input and cache-write rates plus the
output rate. Its own input bound determines whether long-context
multipliers apply. U is the sum over the calls, multiplied by tier and
region. The byte bound and framing allowance are deliberately conservative.
The prompt and follow-up template come from the hunt builders, not copies.

`spend-gate.ts` admits a file with `c` chunks only if:

```text
ledger total + reservations in flight + c × U <= budget
```

If it does not fit while files are in flight, scheduling waits. If none are
in flight, the run stops INCOMPLETE with `max_cost`. Every retry requires an
additional U; a refused retry ends its file unscanned and stops the run.
Completed files release reservations without charging twice: their calls
are already in the ledger. With no budget the cost gate always admits.
Budget-only continuation retains the original plan and U. The plan also
records the model, endpoint, output cap, sampling and loop settings; the
hunt refuses changed call settings that would invalidate the reservation.

## Served tier, concurrency and call policy

For targets declaring `service_tiers`, recon's first call omits
`service_tier`. The first response supplies the tier and the
`x-ratelimit-limit-tokens` and `x-ratelimit-limit-requests` headers saved in
`stage0-recon/api-profile.json`. Later recon calls and hunt calls send the
observed tier explicitly when present. Targets without tier declarations
send no tier field. Unknown tiers stop with `unpriced_service_tier`. Recon
also stops immediately on quota responses, books the attempt, and records
`provider_quota`. A new recon session refreshes its profile even when it
makes no calls, so old observations cannot configure a new run.

Stage 1 computes expected per-call prompt tokens as `I / calls` and output
tokens as `R × prompt`. Let `s` be registry seconds per call, default 23.2:

```text
per-slot TPM = (prompt + output) × 60 / s
concurrency  = max(1, min(32, vendor ceiling, lane count,
                         floor(0.7 × TPM / per-slot TPM),
                         floor(0.7 × RPM × s / 60)))
```

Absent limits are omitted. With no headers, the default is 8 subject to the
ceilings. Explicit `--concurrency` takes precedence. The initial value is
fixed for the run, except for rate-limit step-downs, which persist on resume.

SDK retries are disabled. `stage2-hunt-lanes-perfile/src/call-policy.ts`
owns the hunt's at-most-three-attempt retry layer and books every attempt.
Empty answers and `finish_reason: "length"` are failed attempts; exhaustion
marks a failed file, never a successful file with no findings. Quota and
provider spend-limit errors stop immediately with `provider_quota`.

A rate-limit 429 reduces concurrency to
`max(1, floor(current × 0.75))` at most once per 60 seconds and waits for
Retry-After or a reset header, capped at 60 seconds. Transient server/network
errors use backoff. Both remain inside the three-attempt limit. Concurrency
never climbs back. Three consecutive file failures in completion order stop
the run with `provider_failing`.

## Continuation and compatibility

An interactive `max_cost` stop displays ledger spend, completed/remaining
files and an approximate additional cost. The average uses hunt ledger
spend per completed file, falling back to the plan's per-file estimate when
none completed. A new total budget must exceed spend so far; it resumes the
hunt in the same run directory. Enter ends INCOMPLETE. `--yes` or no
terminal suppresses this prompt.

`--resume` selects the latest INCOMPLETE run in the chosen reports folder;
`--resume <run-id>` selects one explicitly. Completed files are retained,
the same ledger continues and budget-only resumes reuse the plan. Interactive
resume asks for a budget unless supplied by flag; `--yes` keeps the earlier
budget when no new one is supplied. Changing the recon read scope
(`--paths` or `--exclude`) requires a new scan instead of reusing the old
inventory and allowlist.

The legacy `budget-plan-v2.json` calculation stays separate and unchanged
apart from its timestamp. Existing model entries without the new registry
fields retain their pricing behaviour. This task's validation uses unit
tests and fake clients/local fake servers; it does not require a paid scan
or claim a new quality measurement.
