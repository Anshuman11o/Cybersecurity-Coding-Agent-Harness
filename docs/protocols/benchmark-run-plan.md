# Model benchmark — run plan

Scores inference models against the same corpus, the same scanner tree and the
same prompts, so the only variable is the model.

Written to be executed by a session with no prior context. Read
`../../CLAUDE.md` first — its rules take precedence over everything here —
then `running-a-scan.md` for the single-run mechanics this plan repeats.

**Status as of 2026-08-02: two runs outstanding, four models on hold, one
already measured.**

---

## 1. Scope

### Active — run these

| Model | Registry key | State |
|---|---|---|
| GLM-5.2 | `glm52` | **to run** |
| Gemini 3.6 Flash | `gemini36flash` | **to run** |

### Already measured — do not re-run

| Model | Registry key | State |
|---|---|---|
| GPT-5.6 Luna | `luna` | **done — run 6, 2026-08-01** |

Run 6 was `luna` on this exact pipeline and arm. Its artifacts carry every
metric this benchmark collects, verified against
`runs/luna/stage1-budget-governor-perfile/usage-v2.json` on 2026-08-02:

```
input_tokens   7,174,088      lane_count               541
output_tokens  2,444,855      calls                  1,082
total_tokens   9,618,943      lanes_missing_measurement  0
cost_usd       4.3686         price_asof        2026-08-01
```

Recall 71.1%, localization 88.7%, precision proxy 12.5%, wall clock 13m04s at
C=32 — all in `run-history.md`. Distinct lines cited are recoverable from
`candidate-findings.json` (3,597 across all lanes; 881 across benchmark-bearing
lanes, per run 6's entry). **No metric is missing, so luna does not need a
re-run.** Re-use run 6's numbers directly.

The one caveat to carry: run 6's cost was *published* as $21.84 at a rate that
was 5x wrong. The artifact above is already at the corrected rate. Cite $4.37.

### On hold — do not run

| Model | Registry key | Why |
|---|---|---|
| Qwen 3.7 Plus | `qwen37` | on hold; also has an unresolved blocker (§9.1) |
| Claude Sonnet 5 | `sonnet5` | on hold |
| Claude Opus 5 | `opus5` | on hold |
| Gemini 3.1 Pro | `gemini31pro` | on hold |

All four stay registered, priced and preflight-passing. Nothing needs undoing
to bring them back — remove the hold and they are runnable, except `qwen37`,
which needs §9.1 resolved first.

### Settled parameters

| Decided | Value |
|---|---|
| Pipeline | v2 per-file, stages 0 → 0.5 → 1 → 2 → reconcile-v2 (§3) |
| Metrics | 8 (§8) |
| Isolation | one git worktree per model (§5) |
| Concurrency | 8–32, per model (§6) |

Stage 3 (`stage3-validate`) is **not part of this benchmark**. It is not in the
v2 pipeline and must not be run. The scored artifact is Stage 2's output.

## 2. Models

All are registered in `tools/scanner/shared/models.json` and verified reachable
— model id resolves, plain completion returns content, `json_schema` strict
honoured.

| Registry key | Model id | $/MTok in | out | Cap | Credential env | Status |
|---|---|---|---|---|---|---|
| `glm52` | `glm-5.2` | 1.40 | 4.40 | 64000 | `ZAI_API_KEY` | **active** |
| `gemini36flash` | `gemini-3.6-flash` | 1.50 | 7.50 | 64000 | `GEMINI_API_KEY` | **active** |
| `luna` | `gpt-5.6-luna` | 0.20 | 1.20 | 64000 | `OPENAI_API_KEY` | done (run 6) |
| `qwen37` | `qwen3.7-plus` | 0.40 | 1.60 | 64000 | `DASHSCOPE_API_KEY` | on hold |
| `sonnet5` | `claude-sonnet-5` | 2.00 | 10.00 | 64000 | `SCANNER_ANTHROPIC_API_KEY` | on hold |
| `gemini31pro` | `gemini-3.1-pro-preview` | 2.00 | 12.00 | 64000 | `GEMINI_API_KEY` | on hold |
| `opus5` | `claude-opus-5` | 5.00 | 25.00 | 64000 | `SCANNER_ANTHROPIC_API_KEY` | on hold |

`gemini36flash` was added 2026-08-02 and needed no setup beyond one registry
entry — it shares the endpoint and credential of `gemini31pro` and runs the
existing SDK client unchanged. Preflight passed on first attempt: content
returned, `json_schema` strict honoured.

Notes that will bite if ignored:

- **The Anthropic credential is `SCANNER_ANTHROPIC_API_KEY`, not
  `ANTHROPIC_API_KEY`.** The Claude Code harness strips the latter from the
  container, so it arrives unset wherever it is configured. Same reason the base
  URL var is `SCANNER_ANTHROPIC_BASE_URL`: the ambient `ANTHROPIC_BASE_URL` is
  set without the `/v1` suffix and would resolve every call to a 404 path.
- **Do not set `GEMINI_MODEL`, `OPENAI_MODEL`, `QWEN_MODEL` or
  `ANTHROPIC_MODEL`.** Each is shared by every target in its vendor family —
  `GEMINI_MODEL` covers both `gemini36flash` and `gemini31pro` — so setting one
  silently overrides several targets at once and collapses the comparison into a
  single model. Same for the global `SCANNER_MODEL`.
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
   → must be **221 passed, 0 failed**. This suite enforces the
   blind-development boundary and the pricing schema. A red suite before a
   benchmark means the numbers are not trustworthy.
3. **Dependencies installed.** `tools/scanner/install.sh --check` → must report
   all 8 packages. `node_modules/` is gitignored per package and nothing else
   installs it, so a fresh clone or a **fresh worktree** has zero installed
   packages and every entry point importing `openai` dies with
   `ERR_MODULE_NOT_FOUND` before reaching provider logic.
4. **Preflight every model you are about to run.**
   `cd tools/scanner/shared && SCANNER_PROVIDER=<key> npx tsx preflight.ts`
   for `glm52` and `gemini36flash`. Each must exit 0 and report
   `json_schema: … — honoured`.
   Preflight fails loudly on an empty or truncated body; a PASS means the target
   actually emits content at its configured cap.
5. **Credentials present.** Preflight covers this. The active pair needs only
   `ZAI_API_KEY` and `GEMINI_API_KEY`, both present. (If the held models are
   released later, note that `SCANNER_ANTHROPIC_API_KEY` is the one that
   silently vanishes — see §2.)
6. **Disk.** Two worktrees plus two sets of `node_modules` plus two run trees.
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

Every worktree must sit on the **same commit**, and on the same commit run 6
was measured from where that comparison is drawn. Record the SHA in the results.
Models measured against different trees are not comparable.

After a run is archived and pushed, remove the worktree with
`git worktree remove`. Confirm the work is committed and pushed first.

---

## 6. Run order and concurrency

Only two runs are outstanding, so there is no batching to do. Run both at once
in their own worktrees, or one after the other — either is fine.

| Order | Target | `HUNT_CONCURRENCY` | Basis |
|---|---|---|---|
| 1 | `glm52` | 8, ramp if clean | endpoint returns no rate-limit headers |
| 2 | `gemini36flash` | 8 | no headers, **and** spend-based limits (§9.3) |

Both start at 8 because neither endpoint publishes rate-limit headers, so
neither limit is known in advance. Anything from 8 to 32 is acceptable —
concurrency exists to avoid a sequential crawl, not to be maximised. Do not
exceed 32. If a run completes with 0 retries at 8, a later run may go higher.

Rate limits measured from live response headers on this account, 2026-08-01/02:

| Target | RPM | TPM |
|---|---|---|
| `luna` (done) | 5,000 | 2,000,000 |
| `opus5`, `sonnet5` (held) | 10,000 | 12,000,000 |
| `glm52`, `gemini36flash`, `gemini31pro`, `qwen37` | **not published in headers** | — |

For reference, run 6 consumed ~740k tokens/min at C=32 without a single retry.

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

- Outputs are namespaced `runs/<provider>/<stage>/`, so different models cannot
  overwrite each other. In particular `runs/luna/` holds run 6 and must not be
  disturbed — it is the reference this benchmark compares against.
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

Cost projections. Scaled from run 6's **actual** token split
(7,174,088 input / 2,444,855 output, read from `usage-v2.json`) by input and
output multipliers measured on identical prompts:

| Target | in (M) | out (M) | $ in | $ out | Projected |
|---|---|---|---|---|---|
| `glm52` | 7.13 | 2.12 | 9.98 | 9.34 | **$19.32** |
| `gemini36flash` | 8.83 | 2.44 | 13.25 | 18.34 | **$31.58** |
| | | | | | **~$51 new spend** |
| `luna` (already spent, run 6) | 7.17 | 2.44 | 1.43 | 2.93 | $4.37 |

Confidence: `glm52` ±30% — its input multiplier and output multiplier were both
measured directly. `gemini36flash` is **weak**: its input multiplier is borrowed
from `gemini31pro` (same tokenizer family) and its output multiplier is a
placeholder of 1.0, because the only Gemini output measurement available came
from `gemini31pro` *declining* an exhaustive task (862 tokens where peers
emitted 25k–31k). If `gemini36flash` behaves the same way, its real cost will be
well under $31.58 — and its recall will be depressed for the reason in §9.2.

Note the shape: on the active pair, output dominates. `gemini36flash` bills
output at $7.50/MTok against `glm52`'s $4.40, and reasoning tokens count as
output.

---

## 9. Open issues — read before launching

Numbered by relevance to the **active** pair. §9.4 concerns a held model and is
kept so it is not rediscovered later.

### 9.1 Recall is confounded by trace length — affects both active models

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

### 9.2 `gemini36flash` verbosity is unmeasured — and it drives §9.1

The only Gemini output measurement available is from `gemini31pro`, which
**declined** an exhaustive-enumeration task and returned 862 output tokens where
`glm52` returned 25,765 and other peers 25k–31k. Whether `gemini36flash` shares
that behaviour is unknown.

This matters more than a cost estimate. If it summarises rather than enumerates,
it emits short traces, and by §9.1 short traces score lower **whether or not the
model reasons worse**. A low `gemini36flash` recall must not be reported as a
capability result until its distinct-lines-cited figure is compared against
`glm52`'s and against run 6's.

Check this first, from the run's own output — no extra spend needed:

```bash
node -e "const f=require('./candidate-findings.json');
const a=Array.isArray(f)?f:(f.findings||Object.values(f).find(Array.isArray));
const l=a.map(x=>(x.trace||[]).length);const d=new Set();
a.forEach(x=>(x.trace||[]).forEach(s=>d.add(s.file+':'+s.line)));
console.log(a.length+' findings, mean trace '+(l.reduce((p,c)=>p+c,0)/l.length).toFixed(2)+
            ', max '+Math.max(...l)+', '+d.size+' distinct lines');"
```

Reference points from committed artifacts, same pipeline:

| Run | Trace loop | Findings | Mean trace steps | Max | Distinct lines |
|---|---|---|---|---|---|
| `terra` | off | 221 | 3.31 | 7 | 571 |
| `luna` run 6 | on | 553 | 8.74 | 51 | 3,597 |

### 9.3 `gemini36flash` spend-based limits

Gemini enforces spend-based rate limits (~$10/10min at tier 1) on top of
RPM/TPM. A ~$32 run cannot complete in under ~30 minutes at that cap regardless
of concurrency, and it may stall **without a 429 that looks like rate
limiting** — it will just be slow. Check the account tier in the Google console
before launching, and if the run appears to hang rather than fail, suspect this
before suspecting the scanner.

### 9.4 The nondeterminism floor is ±7 entries

~±7 points on a denominator of 97, on byte-identical prompts. **One run per
model cannot separate two models closer than that.** With two new runs plus run 6, any
two results within ~7 points are indistinguishable. Repeats would cost roughly 3x
the ~$51. Not yet decided.

### 9.5 `qwen37` — held, and blocked independently

`qwen37` is on hold, so this does not block anything today. It is recorded
because the hold could be lifted and the blocker would still be there.

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
