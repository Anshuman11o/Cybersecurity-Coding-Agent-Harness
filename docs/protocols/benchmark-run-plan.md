# Six-model benchmark — run plan

Scores six inference models against the same corpus, the same scanner tree and
the same prompts, so the only variable is the model.

Written to be executed by a session with no prior context. Read
`../../CLAUDE.md` first — its rules take precedence over everything here —
then `running-a-scan.md` for the single-run mechanics this plan repeats six
times.

**Status: not yet launched. Two issues are open and one of them is a hard
blocker for `qwen37`.** See §9. Everything else in this document is settled.

---

## 1. What is being measured

| Decided | Value |
|---|---|
| Models | 6 (§2) |
| Pipeline | v2 per-file, stages 0 → 0.5 → 1 → 2 → reconcile-v2 (§3) |
| Metrics | 8 (§8) |
| Isolation | one git worktree per model (§5) |
| Batching | 2 batches of 3 (§6) |
| Concurrency | 8–32, per model (§6) |

Stage 3 (`stage3-validate`) is **not part of this benchmark**. It is not in the
v2 pipeline and must not be run. The scored artifact is Stage 2's output.

---

## 2. Models

All six are registered in `tools/scanner/shared/models.json` and verified
reachable — model id resolves, plain completion returns content, `json_schema`
strict honoured. Preflight passed 6/6 on 2026-08-01.

| Registry key | Model id | $/MTok in | out | Cap | Credential env |
|---|---|---|---|---|---|
| `luna` | `gpt-5.6-luna` | 0.20 | 1.20 | 64000 | `OPENAI_API_KEY` |
| `qwen37` | `qwen3.7-plus` | 0.40 | 1.60 | 64000 | `DASHSCOPE_API_KEY` |
| `glm52` | `glm-5.2` | 1.40 | 4.40 | 64000 | `ZAI_API_KEY` |
| `sonnet5` | `claude-sonnet-5` | 2.00 | 10.00 | 64000 | `SCANNER_ANTHROPIC_API_KEY` |
| `gemini31pro` | `gemini-3.1-pro-preview` | 2.00 | 12.00 | 64000 | `GEMINI_API_KEY` |
| `opus5` | `claude-opus-5` | 5.00 | 25.00 | 64000 | `SCANNER_ANTHROPIC_API_KEY` |

Notes that will bite if ignored:

- **The Anthropic credential is `SCANNER_ANTHROPIC_API_KEY`, not
  `ANTHROPIC_API_KEY`.** The Claude Code harness strips the latter from the
  container, so it arrives unset wherever it is configured. Same reason the base
  URL var is `SCANNER_ANTHROPIC_BASE_URL`: the ambient `ANTHROPIC_BASE_URL` is
  set without the `/v1` suffix and would resolve every call to a 404 path.
- **Do not set `OPENAI_MODEL`, `QWEN_MODEL` or `ANTHROPIC_MODEL`.** Each is
  shared by every target in its vendor family, so setting one silently
  overrides several targets at once and collapses the comparison into a single
  model. Same for the global `SCANNER_MODEL`.
- `sonnet5`'s rate is **introductory and expires 2026-08-31**. From 2026-09-01
  it is 3.00/15.00, which takes a full run from ~$44 to ~$66. If the benchmark
  slips past that date, update `models.json` before running or the cost metric
  is wrong by a third.

---

## 3. Pipeline

Run exactly these, in order, per model:

```
stage0-recon
stage05-lane-selector-perfile
stage1-budget-governor-perfile
stage2-hunt-lanes-perfile
reconcile-v2
```

This is `STAGES_V2` in `tools/scanner/run.sh`. Invoke with:

```bash
tools/scanner/run.sh <provider> all-v2
```

The scored artifact is:

```
tools/scanner/runs/<provider>/stage2-hunt-lanes-perfile/candidate-findings.json
```

`reconcile-v2` is a second pass over the v2 governor and writes into
`runs/<provider>/stage1-budget-governor-perfile/`. It reconciles projected
against actual consumption; it does not produce findings.

Loop mode: leave at the default. `DEFAULT_LOOP_MODE` is `trace` with
`DEFAULT_LOOP_PASSES = 1`. **Do not set `HUNT_LOOP` or
`HUNT_LOOP_STRICT_TRACE`.** The default is the arm with a measurement behind
it; `HUNT_LOOP_STRICT_TRACE=1` was measured and made recall *worse*
(66.0% → 52.6%). Every model must run the same arm or the comparison is void.

---

## 4. Preconditions — check every one before launching

Run these from a clean checkout of `main`. Do not skip: each traces to a real
failure.

1. **Tree, not intent.** `git merge-base HEAD origin/main` and diff the scanner
   source against `main`. Confirm each change you believe is in force by
   grepping the file. A baseline measured from the wrong tree gets cited later
   as if it had been tested.
2. **Guards green.** `cd tools/scanner/shared && npx tsx --test guard.test.ts`
   → must be **206 passed, 0 failed**. This suite enforces the
   blind-development boundary and the pricing schema. A red suite before a
   benchmark means the numbers are not trustworthy.
3. **Dependencies installed.** `tools/scanner/install.sh --check` → must report
   all 8 packages. `node_modules/` is gitignored per package and nothing else
   installs it, so a fresh clone or a **fresh worktree** has zero installed
   packages and every entry point importing `openai` dies with
   `ERR_MODULE_NOT_FOUND` before reaching provider logic.
4. **Preflight all six.**
   `cd tools/scanner/shared && SCANNER_PROVIDER=<key> npx tsx preflight.ts`
   for each. All six must exit 0 and report `json_schema: … — honoured`.
   Preflight fails loudly on an empty or truncated body; a PASS means the target
   actually emits content at its configured cap.
5. **Credentials present.** Preflight covers this, but confirm
   `SCANNER_ANTHROPIC_API_KEY` specifically — it is the one that silently
   vanishes.
6. **Disk.** Six worktrees plus six sets of `node_modules` plus six run trees.
   Check free space before, not after.

---

## 5. Worktrees

**One worktree per model.** This is required, not stylistic: `run.sh` takes a
mutex at `$SCANNER_DIR/.run.lock`, and `SCANNER_DIR` is derived from the
script's own path. Two runs in the same checkout serialise. Separate worktrees
each get their own lock and run genuinely in parallel.

Run artifacts are already provider-namespaced (`runs/<provider>/<stage>/`), so
worktrees are about the lock and about tree isolation, not about artifacts
colliding.

Setup, per model:

```bash
cd /home/user/Cybersecurity-Coding-Agent-Harness
git worktree add ../bench-<provider> <benchmark-branch>
cd ../bench-<provider>
tools/scanner/install.sh            # REQUIRED — see below
tools/scanner/install.sh --check    # expect: all 8 packages installed
```

> **Installing dependencies is a required step for every new worktree.**
> A git worktree does not copy `node_modules/` — it is gitignored, so a fresh
> worktree has none. Skipping `install.sh` produces six identical
> `ERR_MODULE_NOT_FOUND` failures that look like a broken scanner and are not.

All six worktrees must sit on the **same commit**. Record that SHA in the
results. Six models measured against six different trees is not a benchmark.

After a run is archived and pushed, remove the worktree with
`git worktree remove`. Confirm the work is committed and pushed first.

---

## 6. Batches and concurrency

Two batches of three, run sequentially. Within a batch, all three run at once
in their own worktrees.

**Batch 1 — cheap, and where the unknowns get resolved:**
`luna`, `qwen37`, `glm52`

**Batch 2 — expensive:**
`sonnet5`, `opus5`, `gemini31pro`

Batch 1 first because it is ~$30 against batch 2's ~$212, so anything that goes
wrong goes wrong cheaply. `qwen37` is the riskiest target in the set (§9) and
belongs in the first batch regardless of cost order.

Concurrency is set with `HUNT_CONCURRENCY`. Anything from 8 to 32 is
acceptable; it exists to avoid a sequential crawl, not to be maximised. Do not
exceed 32.

| Target | `HUNT_CONCURRENCY` | Basis |
|---|---|---|
| `luna` | 32 | run 6 at C=32: 0 retries, 0 fatal |
| `opus5` | 32 | 10,000 RPM / 12M TPM measured — 6x luna's headroom |
| `sonnet5` | 32 | same limits as opus5 |
| `glm52` | 8, ramp if clean | endpoint returns no rate-limit headers |
| `gemini31pro` | 8 | no headers, **and** spend-based limits (§9) |
| `qwen37` | 8 | no headers, and it is the slow one |

Rate limits measured from live response headers on this account, 2026-08-01:

| Target | RPM | TPM |
|---|---|---|
| `luna` | 5,000 | 2,000,000 |
| `opus5` | 10,000 | 12,000,000 |
| `sonnet5` | 10,000 | 12,000,000 |
| `gemini31pro`, `glm52`, `qwen37` | not published in headers | — |

Run 6 consumed ~740k tokens/min at C=32, comfortably under luna's 2M TPM.

---

## 7. Launching, and not losing the output

Scans outlive an agent session. Launch detached:

```bash
cd /home/user/bench-<provider>
HUNT_CONCURRENCY=<n> setsid nohup tools/scanner/run.sh <provider> all-v2 \
  > /tmp/bench-<provider>.log 2>&1 < /dev/null &
disown
```

`setsid` matters. A bare `nohup … &` was reaped mid-session during this plan's
own preparation and lost ~25 minutes of probing.

**Immediately after each run finishes, invoke the `archive-run` skill.** The
next run overwrites stage outputs in place; an unarchived run is unrecoverable.
One run has already been lost this way (~3 million tokens).

Artifact safety, concretely:

- Outputs are namespaced `runs/<provider>/<stage>/`, so the six models cannot
  overwrite each other.
- **Re-running the same provider does overwrite.** If a model is run more than
  once — see the repeats question in §9 — archive between every run.
- Archive before removing any worktree.
- Per `CLAUDE.md`, eval output that pairs a challenge with a file and line goes
  to the answer-key repo, never here. The harness keeps aggregates only.

---

## 8. Metrics

Eight metrics. F1 was considered and **dropped**: the repo's precision is a
*proxy* (nothing adjudicates whether an unmatched finding is a true positive
outside ground truth), and at ~12.5% precision an F1 would be almost entirely
precision-driven — it would rank models by proxy artefact rather than by
detection.

| # | Metric | Source |
|---|---|---|
| 1 | Recall (file + exact line + category) | scorer, over the **97 reachable** entries (see `run-history.md`) |
| 2 | Localization (±15 lines) | scorer |
| 3 | Precision proxy | scorer — **always label it a proxy** |
| 4 | Total runtime | wall clock, per model, record concurrency beside it |
| 5 | Total cost (USD) | `usage-v2.json`, which records the rate used |
| 6 | Total tokens | same |
| 7 | Input / output tokens separately | same |
| 8 | Model size | vendor model card where published, otherwise the literal string **"no public record on model size"** — do not estimate |

Report alongside every recall figure, per `eval-howto.md` §3:

- **distinct lines cited**, and as a share of corpus lines in scope;
- a **budget-matched null** (`loop-null-model.py`, answer-key repo);
- localization next to recall.

This is not optional bookkeeping — see §9.

Cost projections, scaled from run 6's actual 7,174,732 / 2,444,211 split by
input and output multipliers measured on identical prompts:

| Target | in (M) | out (M) | Projected |
|---|---|---|---|
| `luna` | 7.17 | 2.44 | **$4.37** |
| `qwen37` | 7.17 | 2.44 | **$6.78** |
| `glm52` | 7.13 | 2.12 | **$19.31** |
| `sonnet5` | 11.36 | 2.12 | **$43.88** |
| `gemini31pro` | 8.83 | 2.44 | **$47.00** |
| `opus5` | 11.36 | 2.57 | **$121.02** |
| | | | **~$242 total** |

Confidence: `luna` solid (derived from a completed run); `opus5`/`sonnet5`/
`glm52` ±30%; `gemini31pro` weak; `qwen37` weakest. The dominant driver is not
price but tokenisation — the identical prompt is 5,297 tokens on `luna` and
8,388 on the Anthropic targets, a 1.58x expansion against the ~30% their docs
cite, and input outweighs output 2.94:1.

---

## 9. Open issues — read before launching

### 9.1 `qwen37` will fail on slow lanes — BLOCKER for that model

Measured on an identical lane-shaped prompt:

| Arm | Streamed | Time | Outcome | Completion tokens |
|---|---|---|---|---|
| default | no | 303.1s | **TIMEOUT** | — |
| streamed | yes | 495.7s | OK | 27,371 |
| thinking off | no | 278.6s | OK | 16,248 |

A non-streaming completion emits no HTTP headers until generation finishes.
`qwen37` is ~3.8x slower than `luna` on identical work, so its generations
cross a ~300s boundary and the request dies. The error carries **no status, no
code, no headers** — a bare `Error: "Request timed out."` at 301.5s — with a
30-minute SDK timeout and `maxRetries: 0` set, which rules out the SDK's own
timeout. The leading hypothesis is undici's default `headersTimeout` of
300,000 ms; a first attempt to confirm by raising it was **inconclusive**
(the model answered briefly that run and never approached the boundary), and
the controlled A/B was stopped before completing. **The root cause is not yet
confirmed.**

Why it is worse than one failed lane: `hunt-executor.ts` classifies `timeout`
as transient and retries 5 times. Each retry dies the same way, so one slow
lane burns ~30 minutes and bills for six discarded generations — the server
completes each one. Downstream this is recorded as a lane that found nothing,
which is indistinguishable from a reasoning result.

Candidate fixes, none applied:

1. **Raise the client timeouts** — smallest change, addresses the cause
   directly if the hypothesis holds. Needs the A/B finished first.
2. **Enable streaming in Stage 2** — proven to work (496s through the same
   proxy). Two call sites, `hunt-executor.ts:888` and `:909`. Add
   `stream: true` + `stream_options: { include_usage: true }`, accumulate
   `delta.content`, take usage from the final chunk. Changes only how bytes
   arrive — same model, prompt, params, cap, schema, text and usage
   accounting. Risk to test first: `json_schema` strict combined with
   streaming is verified on OpenAI but **not** on Z.ai, DashScope or Google's
   compat layer; a provider that rejects the combination falls silently into
   the `json_object` path.
3. **`enable_thinking: false`** — works (278.6s) but produces a *different
   configuration* from the other five, all of which think. It would buy a
   green run at the cost of the comparison. Not recommended.

Decision pending. **Do not launch `qwen37` until it is resolved.** The other
five are unaffected and run fine non-streamed.

### 9.2 Recall is confounded by trace length

From `eval-howto.md` §3: *a finding matches an entry when **some step of its
trace** is on the entry's line*. The trace is scored, not just internal
bookkeeping, so a model that emits longer traces gets more chances to land on a
ground-truth line without being better at security.

The spread across models is large. On identical work: `qwen37` 27,371 output
tokens, `opus5` 31,190, `sonnet5` 25,698, `glm52` 25,765, and **`gemini31pro`
862** — it declined to enumerate and summarised instead.

Measured in committed artifacts, same v2 per-file pipeline:

| Run | Trace loop | Findings | Mean trace steps | Max | Distinct lines cited |
|---|---|---|---|---|---|
| `terra` | off | 221 | 3.31 | 7 | 571 |
| `luna` run 6 | on | 553 | 8.74 | 51 | 3,597 |

`hunt-executor.ts` says so in its own comments: *"every scored metric is
monotone in trace length, so nothing in the default wording stops the model
padding a trace until it hits something."*

Mitigation is the §8 reporting discipline — distinct lines cited, plus a
budget-matched null, per model. Under review; the user is deciding whether
anything stronger is needed before results are published.

### 9.3 The nondeterminism floor is ±7 entries

~±7 points on a denominator of 97, on byte-identical prompts. **One run per
model cannot separate two models closer than that.** Six models at one run each
produces a ranking whose top positions may be noise. Repeats on the leading
contenders would cost roughly 3x. Not yet decided.

### 9.4 `gemini31pro` spend-based limits

Gemini enforces spend-based rate limits (~$10/10min at tier 1) in addition to
RPM/TPM. A ~$47 run cannot complete in under ~45 minutes at that cap regardless
of concurrency, and it may stall without a 429 that looks like rate limiting.
Check the account tier in the Google console before batch 2.

---

## 10. Reporting

Per `CLAUDE.md`: report what happened, including cost and failure. If a run
died, say what was lost. If a metric is qualified by a known defect, state the
defect next to the number. Do not let an infrastructure failure be read later as
a reasoning result — the qwen timeout in §9.1 is exactly that shape.

Record for every model: provider key, model id, commit SHA, concurrency, loop
mode, wall clock, tokens in/out, cost with the rate that produced it, and the
line-budget figures from §8.

Add each run to `run-history.md`. Aggregate metrics only — anything pairing a
challenge identifier with a file, a line, or a found/not-found status goes to
the answer-key repo.
