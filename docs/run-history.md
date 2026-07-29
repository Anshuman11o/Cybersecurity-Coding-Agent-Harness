# Run history

Every scored run, newest first. Aggregate metrics only — no per-entry detail, by
`protocols/blind-development.md`. Full artifacts, logs and eval JSON are archived
in the answer-key repo under `runs/<timestamp>__<variant>__<provider>__<sha>/`.

A run not listed here either was not scored or was not blind. Both cases are
recorded, because an unmarked non-blind number gets cited later as if it were a
baseline.

## The denominator is 97

One of the answer key's 98 entries sits in a file on `SEED_DENYLIST`. Stage 0.5
gives that file a `skip` lane and `readCorpusFile()` refuses it, so **no finding
can ever cite it** — it is unreachable by construction, a cost of the
blind-development boundary rather than a scanner failure. Scoring it as a miss
understated every run by ~1 point and put an unattainable point between the
scanner and the ≥90% target.

**Every ground-truth-denominated metric below is over the 97 reachable entries.**
Hits are unchanged; only the denominator moved. Runs 1 and 2 are restated on the
same basis so the columns compare. Per-finding metrics — precision proxy, hedging,
class distribution — are untouched, since their denominator is findings. The only
per-class denominator that shifts is `insecure-design` (13 → 12).

Nothing in the harness changed: `score_scanner.py` still reads all 98 and the
re-base is applied at recording time. `analysis/rebase-97.py` in the answer-key
repo does the conversion. `scanner.jsonl` keeps its original lines and adds
`*-rebased97` re-score lines, per the never-rewrite rule. See
`protocols/eval-howto.md`.

## ⚠ Recall to date is understated by 3 entries — and the model tier was never tested

Two findings from the 2026-07-29 run-6 investigation
(`analysis/2026-07-29-run6-investigation.md`) change how every row below should be
read.

**1. A line-number bug cost 3 exact-line hits in every run.**
`sanitizePemPrivateKey()` changed a file's line count, so the numbers shown to the
model drifted 2 above the numbers the scorer reads. Re-scoring run 5 with the
shift corrected gives **recall 45/97 = 46.4%** against the published 43.3%, with
localization unchanged — a 2-line shift is invisible to a ±15 window and fatal to
exact-line recall. Fixed on 2026-07-29 with 7 regression tests. Runs 1–5 are left
as published; add ~3 entries when comparing any of them to a post-fix run.

**2. Every scored run used the cheapest tier of its model family.** `luna` was
chosen on cost as "the smallest step up" from `qwen`. A 129-lane arm on `terra`,
same prompts and same shared Stage 0, scored **50/82 = 61.0% recall against luna's
36/82 = 43.9%** — +17.1 points, the largest measured effect in the project's
history. Four runs of playbook and labelling work were tuned against a model that
was itself the binding constraint.

## Scored runs, v2 per-file

| Metric | Run 1 · `0c5c907` | Run 2 · `e3307ec` | Run 3 · `c9e3e94` | Run 4 · `bab0ad2` | Run 5 · `c9c2cf0` | Target |
|---|---|---|---|---|---|---|
| Recall (file + exact line + category) | 37/97 = 38.1% | 32/97 = 33.0% | **49/97 = 50.5%** | 29/97 = 29.9% | 42/97 = 43.3% | ≥90% |
| Localization (±15 lines) | 65/97 = 67.0% | 57/97 = 58.8% | 73/97 = 75.3% | 48/97 = 49.5% | **78/97 = 80.4%** | ≥90% |
| File-level (any line) | 93/97 = 95.9% | 97/97 = 100% | **97/97 = 100%** | 96/97 = 99.0% | **97/97 = 100%** | — |
| Precision proxy (category-aware) | 15.4% | 11.9% | 11.8% | 12.2% | **12.5%** | ≥95% |
| Hedging | 1.462 classes/finding | 1.240 | 1.538 | 1.312 | 1.518 | baseline 1.000 |

**Run 5 has the best localization; run 3 still has the best headline recall.**
Those two facts have one cause, and it is not detection — see the hot-line
table below before comparing any two runs in this file.

### ⚠ Three lines carry 24 of the 97 entries

Whether 24 entries score turns on whether one finding at each of three
ground-truth locations carries one class. Which lines they are is located
evidence and lives in the answer-key repo.

| run | entries won from those three lines | recall | recall **excluding** them |
|---|---|---|---|
| Run 2 | 6/24 | 33.0% | 35.6% |
| Run 3 | **24/24** | 50.5% | 34.2% |
| Run 4 | 6/24 | 29.9% | 31.9% |
| Run 5 | 16/24 | 43.3% | **35.6%** |

Run 3 drew all 24 and run 5 drew 16; that −8 is the whole recall delta between
them. **Excluding those lines, run 3's recall (34.2%) is no better than run 2's
(35.6%), and run 5 matches run 2 while localizing far better:**

| run | localization **excluding** the three lines |
|---|---|
| Run 2 | 58.9% |
| Run 3 | 67.1% |
| Run 4 | 58.3% |
| Run 5 | **74.0%** |

Read the excluding-them columns when comparing architecture changes. The
headline carries ~10 points of run-to-run variance from three labels.

As published on the old 98 basis, for anyone re-reading an earlier report:

| Metric | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Recall | 37/98 = 37.8% | 32/98 = 32.7% | 49/98 = 50.0% |
| Localization | 65/98 = 66.3% | 57/98 = 58.2% | 73/98 = 74.5% |
| File-level | 93/98 = 94.9% | 97/98 = 99.0% | 97/98 = 99.0% |

Category-blind, and the emission diagnostics:

| | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|---|---|---|---|---|---|
| Recall, category-blind | 40/97 = 41.2% | 47/97 = 48.5% | 52/97 = 53.6% | 50/97 = 51.5% | **55/97 = 56.7%** |
| Localization, category-blind | 79/97 = 81.4% | 84/97 = 86.6% | 86/97 = 88.7% | 79/97 = 81.4% | **87/97 = 89.7%** |
| Precision proxy, category-blind | 22.3% | 20.3% | 18.4% | 22.5% | 19.1% |
| Findings | 247 | 354 | **407** | 311 | 392 |
| Lanes emitting ≥1 finding | 182/541 = 33.6% | 228/541 = 42.1% | **250/541 = 46.2%** | 202/541 = 37.3% | 244/541 = 45.1% |
| Utilisation (emitted ÷ assigned classes) | — | — | **0.310** | 0.267 | 0.303 |
| Findings below confidence 0.7 | 0 | 109 (min 0.28) | 131 (min 0.28) | 94 | 117 |
| Max classes on one finding | 2 (capped) | 3 | **4** | 4 | 3 |
| Tokens | 3,338,328 | 4,022,526 | 3,558,386 | 3,908,988 | 3,786,720 |
| Cost | $4.64 | $5.82 | **$5.48** | $6.46 | $5.73 |
| Wall clock | — | — | 17m12s @ C=4 | 19m23s @ C=4 | **4m38s @ C=16** |
| Retries / fatal | — | — | 54 / 0 | 27 / 0 | **0 / 0** |

---

### Run 5 — 2026-07-29T16:55Z, `stage1-2-v2-perfile-playbooks`, `luna`, `c9c2cf0`

Stages 1 and 2 only; Stage 0 and 0.5 carried over from run 3 unchanged, so the
lane manifest and per-lane class assignments are identical and the comparison is
single-variable.

**What changed:** three playbook edits (PR #22), all acting on one mechanism —
which class a finding is labelled with.

1. `injection` declared it covers A03 "all variants" and contained no
   cross-site-scripting content at all. OWASP 2021 merged XSS into A03
   (CWE-79). Added reflected, stored and DOM-based XSS, with stored XSS
   reported at the persistence point, since the render sink is usually in
   another file the lane cannot see.
2. `ssrf` covered A10 but was written entirely around outbound requests. Added
   open redirect and weak destination allow-listing, and corrected the
   false-positive rule that treated any allow-list as a valid control.
3. `crypto-auth` described defects *in* authentication mechanisms only. Added
   an authentication-outcome anchor: a defect of another class sitting on an
   authentication path also establishes A07.

**Execution.** Clean single pass: 541/541 lanes, **0 retries, 0 fatal**, 0
blocked reads, 4m38s at `HUNT_CONCURRENCY=16`. The org TPM ceiling for this
model rose 200,000 → 2,000,000, so 16 sits at ~41% of ceiling; run 3 needed 54
retries at concurrency 4 because 4 already saturated the old limit. All three
accounting sources agree exactly at 3,786,720 tokens.

Stage 1 projected 3,040,003 input tokens against run 3's 2,764,390 — **+10.0%**,
the cost of the longer playbooks. An earlier estimate of "~0.2%" in
`analysis/2026-07-29-localization-investigation.md` was wrong and is corrected
there.

| Bucket | Run 3 | Run 5 | Δ |
|---|---|---|---|
| HIT | 49 | 42 | −7 |
| CATEGORY_MISS | 3 | 13 | +10 |
| LINE_MISS_NEAR | 24 | 28 | +4 |
| LINE_MISS_FAR | 8 | 12 | +4 |
| FILE_ONLY | 13 | **2** | **−11** |
| NOT_FOUND | 1 | 1 | 0 |

**What worked.** Localization 75.3% → **80.4%**, the best recorded, while
hedging *fell* 1.538 → 1.518 — the gain is better aim, not a wider net. The
`FILE_ONLY` bucket, which the change targeted, collapsed 13 → 2.
`injection`-class localization reached 18/18 and `ssrf`-class 3/3, exactly as
the pre-run subset arm predicted. Category-blind localization 88.7% → 89.7%.

**What did not.** Headline recall fell 50.5% → 43.3%. This is hot-line
variance, not a detection regression: run 3 won 24/24 of the three-line pool and
run 5 won 16/24, and that −8 accounts for the whole delta. Excluding those
lines, recall is flat (34.2% → 35.6%) and localization rose 67.1% → 74.0%.

The `crypto-auth` anchor is **more effective than the headline suggests**, and
the earlier reading of this run — "it held two of three hot lines" — misattributed
the cause. On the line it appeared to lose, both runs produced the same two
findings with the same classes; the `crypto-auth` finding's trace cited the
benchmark line in run 3 and a line 3 away in run 5, while the
`logging-monitoring` finding cited the benchmark line instead. The class is on
the right finding in both runs, and `crypto-auth` localization is **identical at
23/25**. What moved was trace-step selection, not class attribution.

Consequence for reading any bucket table here: **`CATEGORY_MISS` does not mean
"not localized"**. It takes precedence on an exact-line non-match, so an entry
can be `CATEGORY_MISS` and localized simultaneously — 8 of run 5's 13 are.
Had that one finding's trace included the benchmark line, run 5's recall would
have been 50/97 = 51.5%, above run 3's 50.5%.

**Projections were too optimistic.** The investigation projected localization
≈86.6% and recall ≈56.7%; measured 80.4% and 43.3%. The localization projection
counted arm C's +11 gained without its offsetting losses (the run gained 11 and
lost 6, net +5); the recall projection assumed the anchor would hold ~22/24
hot-line entries where it held 16/24.

---

### Run 4 — 2026-07-29T02:23Z, `stage0-2-v2-perfile-F3`, `luna`, `bab0ad2`

**A clean negative result. F3 is to be reverted.**

541/541 lanes in a single pass, 0 failures, 27 retries, 19m23s at
`HUNT_CONCURRENCY=4`. Stages 0 and 0.5 were reused from run 3 unchanged
(md5-verified before launch); only Stages 1 and 2 ran. `rollup`, `lanes[]` and
`legacy_entries` all total 3,908,988.

**One change: F3.** A `class_sweep` array declared *before* `findings` in the
strict schema, a prompt procedure requiring one verdict per assigned class before
any finding is written, and five mechanical invariants recorded per lane in a new
`class-sweep.json` artifact.

**The mechanism worked and the hypothesis was still false.** Sweep conformance
was perfect: **541/541 lanes, 3005/3005 lane-class pairs swept (100%)**, and zero
`missing`, `offlist`, `duplicate`, `inconsistent` or `found_without_finding`
across the whole run. **`FILE_ONLY` did not move: 13 → 13.** Driving per-class
coverage from an implicit ~17% to an explicit 100% converted *nothing*. The
premise — that `FILE_ONLY` is a sweep-coverage failure — is falsified.

| Bucket | Run 3 | Run 4 | Δ |
|---|---|---|---|
| HIT | 49 | 29 | **−20** |
| CATEGORY_MISS | 3 | 21 | **+18** |
| LINE_MISS_NEAR | 24 | 18 | −6 |
| LINE_MISS_FAR | 8 | 15 | +7 |
| FILE_ONLY | 13 | **13** | **0** |
| NOT_FOUND | 0 | 1 | +1 |

**Why it regressed — two mechanisms, both evidenced.**

1. **The sweep became a gate rather than a check.** `inconsistent_classes` and
   `found_without_finding` are both 0 across all 541 lanes, i.e. verdicts and
   labels moved in perfect lockstep. The prompt required that any class in a
   finding must have been swept `found`, so a cheap early "absent" became a hard
   block on labelling that class later. The sweep did not add a pass — it
   **replaced** the model's richer implicit consideration with a cheaper explicit
   one and then locked in the result. Only 372 of 3005 pairs (12.4%) were swept
   `found`, against run 3's 503 (16.7%) actually emitted: the explicit pass is
   *more* conservative than the implicit one it displaced. `CATEGORY_MISS` 3 → 21
   and `crypto-auth` 19/25 → 1/25 are the visible damage.
2. **F3 also removed emission pressure.** The prompt's anti-suppression nudge
   ("*Most files in a real application do contain something…*") was replaced with
   text legitimising empty output. Findings fell 407 → 311, producing lanes
   250 → 202. This was a second variable inside a change billed as single-variable
   — a self-inflicted confound, and the reason part of the regression cannot be
   attributed to the sweep alone.

**What to keep.** The instrumentation is sound and worth retaining: 100%
conformance, five working invariants, and a per-lane record of what was
considered. If kept it must be **non-binding** — drop the "any class in a finding
must have been swept `found`" rule so the sweep observes without gating — and the
emission nudge must come back.

**`LINE_MISS_NEAR` 24 → 18 is not a gain.** Of run 3's 24, only 1 improved to
HIT; 6 fell to `LINE_MISS_FAR` and 2 to `FILE_ONLY`. Run 4's 18 includes 2 that
fell from HIT. Whole-benchmark movement run 3 → run 4 is **3 improved, 64
unchanged, 30 worsened**.

**Cost of the experiment:** $6.46, the most expensive run so far, for a negative
result. Worth it: it eliminates the most plausible remaining explanation for
`FILE_ONLY` and redirects the next attempt.

**Reverted 2026-07-29.** Source restored to run 3's (`c9e3e94`) byte-for-byte and
`runs/luna/` restored to run 3's archived artifacts. Run 3 is the baseline for
architecture and results alike. Run 4's artifacts, logs and `class-sweep.json`
remain archived in the answer-key repo.

### Run 3 — 2026-07-28T23:07Z, `stage0-2-v2-perfile`, `luna`, `c9e3e94`

541/541 lanes in a single pass, 0 failures, 54 retries all recovered. 17m12s at
`HUNT_CONCURRENCY=4`. `rollup`, `lanes[]` and `legacy_entries` all total
3,558,386, so the `laneRecordsV2` gap does not apply.

**One change: F1.** The `## Distinguishing From Adjacent Classes` section was
deleted from all 14 playbooks (49,137 → 38,061 chars) and the executor's
class-selection prompt was strengthened to say classes are not mutually
exclusive. The isolation was verified rather than assumed: Stage 0.5's `lanes[]`
payload is **byte-identical** to run 2's — same lanes, same dispositions, same
per-lane classes, zero flips — and Stage 1's only per-lane deltas are the
playbook token estimates, down 18.6%.

**F1's own success criteria are met.** Hedging rose 1.240 → 1.538, co-label
share rose in 10 of 12 classes, and scored recall converged on category-blind
recall: the gap closed from 15.3 points to 3.1. The backlog's revert condition
(hedging rises, recall does not) did not trigger.

**But the headline is location-concentrated, and F1 was not label-only.** Two
qualifications, both of which matter more than the +17:

1. The 49 hits span **23 distinct locations**, against run 2's 32 hits over 24.
   A single 11-entry location went from 1/11 to 11/11 and accounts for **10 of
   the 17-point gain**. Excluding it, recall rose 31/86 → 38/86 (+8.2 points).
   That residual is the honest broad-based figure. `crypto-auth` recovering
   0/25 → 19/25 is predominantly the same location.
2. F1 was predicted to add no detection, which would have pinned category-blind
   recall at run 2's level (47 entries). It did not: category-blind recall rose
   47 → 52 entries, findings
   354 → 407, producing lanes 228 → 250. The reason is that F1 **as shipped**
   deleted 22% of playbook content rather than rewording the closer as
   originally proposed, so it changed what the model hunts for as well as how it
   labels. Any claim that this measured a pure labelling change is wrong.

**The foreseen regression landed.** `misconfiguration` 10/17 = 58.8% → 8/17 =
47.1% and `insecure-design` 5/12 = 41.7% → 4/12 = 33.3% — the two classes that
improved in run 2 and
whose targeted adjacency bullets F1 deleted. Their category-blind localization
did not fall, so the defects are still found and positioned; they are labelled
differently. Per F1's own instruction, those bullets carried real guidance and
should return without the singular closer.

**Cost of the emission increase.** Precision proxy fell 20.3% → 18.4%
category-blind. v2 still has no Stage 3 validator, so nothing recovers it.

Also in force: 46 findings named a `justified_by_step` beyond their trace length
and were clamped to 0 — model output conformance, not a lane failure.

### Run 2 — 2026-07-28T18:23Z, `stage0-2-v2-perfile`, `luna`, `e3307ec`

541/541 lanes in a single pass, 0 failures, 62 retries all recovered. 20m19s at
`HUNT_CONCURRENCY=4`. Because it was a single pass, `rollup` and `legacy_entries`
agree and the `laneRecordsV2` gap does not apply.

Seven changes shipped together — the three dispatched changes run 1 missed
(playbook adjacent-class disambiguation, class-cap removal, misconfiguration /
insecure-design prompt work) plus C1 (drop `general-catchall`), C4 (emission
instruction conflict), C5 (confidence bands), and a retry/backoff fix.

**Detection improved; labelling narrowed.** Every measure independent of the
label rose — category-blind recall +7.2, category-blind localization +5.1,
file-level +4.1, producing lanes +8.5. Scored recall fell because run 1's score
depended on a single hedged finding at the benchmark's most crowded location,
which matched 11 entries at once. Excluding that one location, scored recall rose
from 26/86 to 31/86.

**Removing the class cap did the opposite of what was predicted.** Hedging fell
1.462 → 1.240 and the share of findings naming ≥2 classes fell 46.2% → 22.9%. The
cap was never the binding constraint. Most likely interaction: the adjacent-class
disambiguation sections teach the model to tell neighbouring classes apart, which
pushes toward one well-argued label rather than several. Two changes pulled
against each other.

Attributable per-class movement, the two classes with targeted changes:

| Class | Run 1 | Run 2 |
|---|---|---|
| misconfiguration | 7/17 = 41.2% | **10/17 = 58.8%** |
| insecure-design | 2/12 = 16.7% | **5/12 = 41.7%** |

One class collapsed: `crypto-auth` 44% → 0%, while its category-blind
localization held. The defects are still found; they are no longer labelled
`crypto-auth`. Nearly all of it is the single crowded location.

**Attribution caveat:** seven changes shipped at once. Per-class movement
attributes two of them; nothing attributes the rest.

### Run 1 — 2026-07-28T04:42Z, `stage0-2-v2-perfile`, `luna`, `0c5c907`

The first blind v2 baseline under Luna. 541/541 lanes but **in two passes**: pass
1 at `HUNT_CONCURRENCY=8` lost 52 lanes to TPM limits; pass 2 retried them at
concurrency 3 and all succeeded.

Two defects qualify its numbers:

- `lanes[]` and `rollup` in `budget-consumption.json` cover only pass 2, because
  `laneRecordsV2` is not restored from the checkpoint. Totals were reconstructed
  from `legacy_entries`, which is complete.
- **It ran without three dispatched changes** that had already been committed to
  `main` on another branch. It is a valid baseline for what it measured, but it
  is a *pre-dispatch* number and the run-2 delta covers those three changes
  whether or not anything else changed.

## Not blind — do not cite

| Run | Why |
|---|---|
| `scanner-2026-07-27-a` | v2 lane selector never applied `SEED_DENYLIST`. Three bookkeeping files were assigned as hunt lanes, one of which is 114 of 183 lines a literal array of every challenge key. One lane per file means the executor reads the whole file into the prompt. |
| `scanner-2026-07-27-b` | Same manifest, same defect. |

Fixed in three independent places on 2026-07-28: the selector skips denylisted
files, the executor reads through `readCorpusFile()`, and `guard.test.ts` asserts
no manifest on disk gives a denylisted file a hunt disposition.

## Earlier

`results/archive/2026-07-five-tool-benchmark/` holds a scan-only comparison of
five external tools against the same target, which is where the ≥90% / ≥95%
targets in `protocols/eval-framework.md` come from.
