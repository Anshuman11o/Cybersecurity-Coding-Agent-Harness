# Model benchmark — run plan

Scores inference models against the same corpus, the same scanner tree and the
same prompts, so the only variable is the model.

Written to be executed by a session with no prior context. Read
`../../CLAUDE.md` first — its rules take precedence over everything here —
then `running-a-scan.md` for the single-run mechanics this plan repeats.

**Status as of 2026-08-02: the active pair is complete — `glm52` and
`gemini36flash` are both measured, alongside `luna` run 6. Four models remain on
hold. Results are recorded in `../benchmarking-results.md`. Both new runs lost a
first attempt to container reclamation — read §9.0 before launching anything,
and §9.4 before launching any Gemini target.**

---

## 1. Scope

### Active

| Model | Registry key | State |
|---|---|---|
| GLM-5.2 | `glm52` | **done — 2026-08-02, tree `aac8c00`** |
| Gemini 3.6 Flash | `gemini36flash` | **done — 2026-08-02, tree `2a4bf04`** |

`glm52` results, rebased to the 97 reachable entries:

| Metric | glm52 | luna (run 6) |
|---|---|---|
| Recall (file + line + category) | 65/97 = **67.0%** | 69/97 = 71.1% |
| Recall, category-blind | 77/97 = 79.4% | 77/97 = 79.4% |
| Localization (±15) | 83/97 = **85.6%** | 86/97 = 88.7% |
| File-level | 97/97 = 100% | 97/97 = 100% |
| Precision proxy, category-aware | **7.8%** | 12.5% |
| Hedging (classes/finding) | 1.459 | 1.418 |
| Findings | 892 | 553 |
| Input / output tokens | 7,265,980 / 2,402,317 | 7,174,088 / 2,444,855 |
| Cost | **$17.01** | $4.37 |
| Wall clock | ~18.5 min — **see caveat** | 13m04s |
| Model size | no public record | no public record |
| Distinct lines cited | 4,577 | 3,597 |
| Mean trace steps | 6.64 | 8.74 |

Execution was clean: 541/541 lanes, all stages exit 0, `degraded: false`, 0
blocked reads, 0 lanes missing measurement, 1,082 calls = exactly 2 per lane.

**Three things must be carried with these numbers:**

1. **The recall gap is not a result.** 65 vs 69 is 4 entries against a ±7-entry
   nondeterminism floor (§9.5). These two models are indistinguishable on recall
   from one run each. Do not report a ranking.
2. **The wall clock is not compliant.** It was measured at C=32 against
   GLM-5.2's documented in-flight limit of **10** (§3a.3) — 3.2x over. 10% of
   calls were throttled, costing 321s of cumulative backoff. A compliant run at
   C=10 would take roughly **50 minutes**, estimated from the observed ~58s mean
   lane. Cite the runtime as "~18.5 min at C=32, above the vendor limit", or
   re-measure at C=10. Recall, localization, precision, tokens and cost are
   unaffected — a 429 is rejected before generation, so no lane was lost and no
   throttled call was billed.
3. **The trace-length confound favours glm52 here.** It cited 4,577 distinct
   lines across 892 findings against run 6's 3,597 across 553 — more line budget
   and more shots on goal — and still did not score higher. Its number is
   flattered by the confound (§9.1), not penalised by it.

Cost landed 12% under the $19.32 projection because 45% of input was served from
Z.ai's prefix cache: $3.73 of cached input against an uncached $20.74. The
`price_asof` / `cached_input` schema is what made that visible.

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
| Qwen 3.7 Plus | `qwen37` | on hold; also has an unresolved blocker (§9.6) |
| Claude Sonnet 5 | `sonnet5` | on hold |
| Claude Opus 5 | `opus5` | on hold |
| Gemini 3.1 Pro | `gemini31pro` | on hold |

All four stay registered, priced and preflight-passing. Nothing needs undoing
to bring them back — remove the hold and they are runnable, except `qwen37`,
which needs §9.6 resolved first.

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

## 3a. MANDATORY per-model pre-run checks

**Every model must clear both of these before it is launched. Neither is
optional, and neither is visible in a run that has already gone wrong — both
failure modes surface as "the model found nothing".**

### 3a.1 Reasoning effort must be set to `high`, explicitly

Every benchmark target must declare `"sampling": { "reasoning_effort": "high" }`
in `models.json`. A target that declares nothing does not run at "no effort" —
it runs at *the endpoint's own default*, which is unrecorded, may differ per
vendor, and can change under you.

This is not hypothetical. Runs 1–5 sent no effort parameter at all and
therefore ran at the endpoint default for four rounds of playbook tuning. When
it was finally set on `luna`, high effort alone moved recall 53.6% → 63.9%.

Two things follow, and they matter for how results are written up:

- **Set it on every target**, so no model runs with an unrecorded variable.
- **Do not assume it does the same thing everywhere.** On `luna` the uplift is
  measured and large. On `glm52` the parameter is *honoured* — setting
  `minimal` drives reasoning tokens to 0 — but `high` is not measurably
  different from that endpoint's default (three samples each: baseline
  935/924/652, high 1042/540/586, fully overlapping). Set it for consistency;
  do not report it as an uplift for a model where it has not been measured.

Before launching a model, confirm it:

```bash
node -e "const t=require('./tools/scanner/shared/models.json').targets['<key>'];
console.log(t.sampling)"   # must show reasoning_effort: high
```

If a vendor rejects `reasoning_effort`, the run will 400 on the first call.
Test it against the live endpoint before launching, not during.

### 3a.2 Token caps must be registry-driven, not hardcoded

`max_output_tokens` in the registry is only effective where the stage actually
reads it. **Reasoning tokens are counted against this cap before any content is
emitted**, so a cap tuned on a model that barely reasons silently truncates one
that reasons heavily — and a truncated JSON body is recorded downstream as a
lane that found nothing, not as an error.

This bit the first non-luna run attempted. `stage0-recon/src/llm-probe.ts`
hardcoded caps of 500 and 5000 regardless of target. `glm-5.2` spends ~11,800
reasoning tokens on the category probe and needs ~14,100 in total:

| Cap | finish_reason | reasoning | completion | parses? |
|---|---|---|---|---|
| 5,000 (hardcoded) | `length` | 4,151 | 5,000 truncated | **no** |
| 64,000 (registry) | `stop` | 11,793 | 14,109 | yes |

Stage 0 correctly refused to continue rather than substitute deterministic
analysis — but `luna` had passed the same probe for six runs, because it spends
far fewer reasoning tokens. **The defect was invisible until a second model ran.**

Fixed 2026-08-02: both sites now read `outputTokenCap(PROVIDER, …)`, with the
old literals kept as the fallback for a target declaring no cap.

**Before adding any new model, re-audit.** A hardcoded cap anywhere in a live
stage is a latent failure for the next model that reasons more than the last:

```bash
cd tools/scanner
grep -rn "tokenLimitParam(" --include=*.ts \
  stage0-recon stage05-lane-selector-perfile stage1-budget-governor \
  stage2-hunt-lanes-perfile shared | grep -v outputTokenCap
```

Every hit must pass a value derived from `outputTokenCap()`. As of 2026-08-02
the live v2 stages are clean: Stage 2 was always registry-driven, Stage 0 now
is, and stages 0.5 and 1 make no LLM calls.

A cap is a ceiling, not a spend — billing is per token generated — so headroom
costs nothing on a model that does not use it.

### 3a.3 Vendor concurrency limits must be checked before setting HUNT_CONCURRENCY

`HUNT_CONCURRENCY` is capped by the **vendor's published in-flight request
limit**, which is a different thing from RPM/TPM and is often far smaller. Most
endpoints in this benchmark publish no rate-limit headers, so the limit is not
discoverable at runtime — it has to be read off the vendor's docs before the
run, not inferred from whether the run survived.

Known limits, per vendor documentation:

| Target | Vendor concurrency limit | Source |
|---|---|---|
| `glm52` | **10** | Z.ai rate-limits page, per-model in-flight cap |
| `luna` | not published as a concurrency cap; 5,000 RPM / 2M TPM | response headers |
| `opus5`, `sonnet5` | not published as a concurrency cap; 10,000 RPM / 12M TPM | response headers |
| `gemini36flash`, `gemini31pro` | **unknown** — no headers, plus spend-based limits (§9.3) | — |
| `qwen37` | **unknown** — no headers | — |

**This was learned the hard way.** The glm52 run was launched at C=32 against a
documented limit of 10 — 3.2x over. It completed correctly (the backoff absorbed
every 429, no lane was lost), but 10% of calls were throttled and the run
consumed 321s of cumulative backoff. Exceeding a published limit is not made
acceptable by the retry path succeeding.

Two consequences, and the second is the one that matters for the benchmark:

- **Set `HUNT_CONCURRENCY` at or below the documented limit.** For `glm52` that
  is 10. Where no limit is published, start at 8 and treat sustained 429s as the
  signal to come down, not to retry harder.
- **A runtime measured above the limit is not a runtime the model can deliver.**
  See §8 — glm52's wall clock is recorded with that qualification.

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
6. **§3a cleared.** Reasoning effort declared `high`, hardcoded-cap audit
   clean, and `HUNT_CONCURRENCY` at or below the vendor's published in-flight
   limit (§3a.3). See §3a — both failure modes look like "found
   nothing" rather than like errors.
7. **Disk.** Two worktrees plus two sets of `node_modules` plus two run trees.
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
| 1 | `glm52` | **32** | 8 was tried and the ~2h window lost the run to container reclamation (§9.0); no rate-limit headers, so 8 was caution rather than a measured constraint |
| 2 | `gemini36flash` | **8 — do not raise** | measured: C=16 peaks at 82% of the 2M TPM ceiling and collapses (§9.4) |

Concurrency exists to avoid a sequential crawl, not to be maximised. Do not
exceed 32. `glm52` ran at 32; note §3a.3, which documents that this was above
GLM-5.2's in-flight limit of 10 and cost 321s of cumulative backoff without
losing a lane.

**`gemini36flash` is the exception: 8 is a measured ceiling, not a starting
point.** Raising it to 16 cost 53 lanes — see §9.4.

Rate limits. `luna`, `opus5` and `sonnet5` are read from live response headers
(2026-08-01/02); the Gemini figures are read from the Google AI Studio rate-limit
console (2026-08-02), which is where they are published — those endpoints do not
return them in headers, and the earlier "not published" row was wrong about where
to look rather than about the limits existing.

| Target | RPM | TPM | RPD |
|---|---|---|---|
| `luna` (done) | 5,000 | 2,000,000 | — |
| `opus5`, `sonnet5` (held) | 10,000 | 12,000,000 | — |
| **`gemini36flash`** | **1,000** | **2,000,000** | **10,000** |
| `gemini31pro` (held) | 25 | 2,000,000 | 250 |
| `glm52`, `qwen37` | not published in headers | — | — |

Console peak usage over 28 days, which is this project's usage and nobody
else's: `gemini36flash` **232 RPM, 1.63M TPM, 2.36K RPD**. The TPM peak is
**82% of the ceiling**, reached at `HUNT_CONCURRENCY=16` — against
`running-a-scan.md`'s standing instruction to target 40–50%, never 90%, because
lanes do not arrive uniformly and a batch of large files landing together spikes
well above the mean. That run collapsed; see §9.3.

Deriving the right value the way `running-a-scan.md` says to, from measurement
rather than by copying a number: C=16 produced ~1.63M TPM, so **~102k TPM per
unit of concurrency** on this target — six times `luna`'s ~16k at the same
reasoning effort, because Gemini's prompts tokenize larger and its lanes complete
faster. At a 2M ceiling and a 45% target:

    C = 900,000 / 102,000 ≈ 8.8    →    8

**C=8 is confirmed by measurement, not by inference: 125 lanes at C=8 with 0
retries, 0 errors and 0 fatals, immediately after 53 lanes had been lost at
C=16.**

Note `gemini31pro`'s **25 RPM and 250 RPD**. A 541-lane run is 1,082 calls, so
that target cannot complete a full run in a day at any concurrency. It is on
hold, but this is the reason it would stay held even if the hold were lifted.

RPD is worth watching on `gemini36flash` too: 2.36K of 10K used across three
attempts. Roughly four more full 541-lane runs fit in a day.

For reference, run 6 consumed ~740k tokens/min at C=32 on `luna` without a
single retry — a `luna` number, and not transferable, as the 102k-vs-16k gap
above shows.

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

### 9.0 A run will not survive an idle container — LAUNCH BLOCKER

**Measured, not theoretical. The first `glm52` attempt died this way on
2026-08-02.**

`setsid nohup` protects a process from being reaped when a *session* ends. It
does not protect anything from the **container being reclaimed**, which this
environment does after a period of inactivity. When that happens the run
vanishes mid-lane: no error, no stack trace, no exit line in the log.

What the failed attempt looked like:

| | |
|---|---|
| Died at | 07:21:09, ~5 minutes into Stage 2 |
| Progress | **92 of 541 lanes** (17%) |
| Findings written | 78 (mean trace 4.86 steps) |
| Stages 0 / 0.5 / 1 | complete, exit 0 |
| `budget-consumption.json` | **0 lanes recorded** |
| Container PID 1 | started 15:54:22 — 8.5 hours *after* the run died |

Two things to take from it:

1. **Token accounting is written at the end of Stage 2, not incrementally.** A
   killed run therefore leaves no usable cost or token record at all, even
   though findings were checkpointed. Cost had to be estimated from the log
   (~1M tokens, order of $2–4) rather than measured. Any interrupted run is
   unmeasurable, not partially measurable.
2. **The partial output is not a partial result.** 92 lanes is whatever sorted
   first, not a sample. It must never be scored, committed into
   `runs/<provider>/`, or compared against run 6. The failed attempt's
   artifacts were moved out of the repo to `/home/user/bench-glm52-failed-run/`
   and deleted from the worktree for exactly this reason.

Mitigations, in the order they should be applied:

- **Shorten the exposure window.** Concurrency is the lever. The failed attempt
  ran at C=8 out of caution — glm52's endpoint publishes no rate-limit headers
  — and projected ~2 hours. C=32 is proven safe on `luna` and is the plan's
  ceiling; it cuts the window by roughly 4x. This is the cheapest change and
  needs no code.
- **Keep the session active** for the duration of a run, so the container is
  not idle.
- **Make Stage 2 resumable** (not implemented). It already checkpoints findings
  incrementally, but a restart re-runs all 541 lanes from scratch. Skipping
  lanes already present in `candidate-findings.json` would make reclamation
  survivable rather than fatal. This is a Stage 2 source change and needs
  sign-off before a run depends on it.

Until at least the first mitigation is in force, **assume any run longer than
about an hour will not finish.**

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

### 9.4 `gemini36flash` rate limiting — RESOLVED 2026-08-02, and it cost a run

**This section previously said Gemini enforces spend-based limits (~$10/10min at
tier 1) that stall a run "without a 429 that looks like rate limiting". That was
wrong on both counts and it misdirected a diagnosis.** The binding limit is
ordinary **TPM**, and it surfaces as a plain `429 status code (no body)`. The
correct numbers are in §6, read from the Google AI Studio rate-limit console:
`gemini36flash` is **1,000 RPM / 2,000,000 TPM / 10,000 RPD** at tier 1.

What happened, so the shape is recognisable next time:

| attempt | C | outcome | tokens |
|---|---|---|---|
| 1 | 8 | container reclaimed at 143/541 lanes, **0 retries** | 2,215,620 |
| 2 | **16** | **429 storm** — 361 retries, 53 lanes lost, died at 469 lanes | 7,417,676 |
| 3 (resume) | 8 | **exit 0**, 125/125 lanes, 0 retries, 0 errors, 0 fatals | 1,963,904 |

Console peak for attempt 2 was **1.63M TPM against the 2M ceiling — 82%**, far
past `running-a-scan.md`'s 40–50% target. The first 429 arrived at lane 244,
about eight minutes in, which is what a rolling TPM window looks like once a run
is sustained above the ceiling rather than spiking past it.

**Why it lost lanes instead of merely slowing down.** `hunt-executor.ts` retries
a transient error 5 times with backoff 2+4+8+16+32 ≈ 62s. That ladder was sized
to cross a single 60-second TPM window, and it does — but only when the run
drops back under the ceiling while it waits. At C=16 the other 15 lanes kept
pushing the account over the limit for the whole backoff, so every retry landed
in a still-closed window and the lane died. **A concurrency above the sustainable
rate does not degrade gracefully here; it converts throttling into lost lanes.**

Practical rules:

- **Run `gemini36flash` at `HUNT_CONCURRENCY=8`.** Not "start at 8" — 8.
- **Before relaunching after a 429 storm, check the window has reopened.** One
  throwaway completion costs nothing and tells you whether to wait:

  ```bash
  # GATE OPEN => finish_reason "stop"; GATE CLOSED => 429
  ```

  Attempt 3 was gated this way after an 11-minute idle and ran clean.
- **A 429 with an empty body is the signature.** Count `[RETRY]` as well as
  `[FATAL]` while a run is live; a rising retry count with no fatals yet is the
  last moment to intervene cheaply.
- `gemini31pro`, if ever unheld, is capped at **25 RPM / 250 RPD** — below what
  1,082 calls needs in a day. See §6.

### 9.5 The nondeterminism floor is ±7 entries

~±7 points on a denominator of 97, on byte-identical prompts. **One run per
model cannot separate two models closer than that.** With two new runs plus run 6, any
two results within ~7 points are indistinguishable. Repeats would cost roughly 3x
the ~$51. Not yet decided.

### 9.6 `qwen37` — held, and blocked independently

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

### 9.7 Gemini thinking tokens are billed but not counted — cost metric is understated

Found 2026-08-02 while reconciling the `gemini36flash` run. On Google's
OpenAI-compatibility layer, `usage.total_tokens` exceeds
`prompt_tokens + completion_tokens`; the difference is thinking tokens.
`captureMeasuredTokens()` records the three fields as reported, so thinking lands
in `total_tokens` and in `tokens_used`, but **not** in `total_output_tokens` —
which is the leg `costUsd()` multiplies by the output rate.

Measured on the final pass (125 lanes):

| | tokens |
|---|---|
| `total_input_tokens` | 1,587,996 |
| `total_output_tokens` | 36,141 |
| `total_tokens` | 1,963,904 |
| **unaccounted (thinking)** | **339,767** |

`models.json` states plainly that Gemini's output price includes thinking tokens,
so the billable output for that pass is ~375,908, not 36,141 — **an order of
magnitude**. `reconcile-v2` reported **$2.63**; at $7.50/MTok on the true output
leg it is closer to **$5.18**.

This is not Gemini-specific in principle — any provider reporting reasoning
outside `completion_tokens` hits it — but it is Gemini-specific in practice among
the registered targets. `luna`'s reasoning tokens *are* inside its
`completion_tokens`, which is why run 6's cost needs no such correction.

Until this is fixed, **derive Gemini cost from `total_tokens` minus
`prompt_tokens`, not from the reported output figure**, and label any
`usage-v2.json` cost for a Gemini target as understated. Not fixed here: this
plan does not edit scanner source.

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
