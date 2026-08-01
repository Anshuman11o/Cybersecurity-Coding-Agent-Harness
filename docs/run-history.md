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

## Where this stands after run 6

Run 6 (2026-08-01) is the current best and the current architecture: recall
**71.1%**, localization **88.7%**, on the shipped `HUNT_LOOP=trace` +
`reasoning_effort: high` arm. Its entry is immediately below; the run-1-to-5
table further down is the history it improved on.

Two things to carry when reading any row in this file:

- **Recall is monotone in trace length.** Run 6 cites 3.6x the lines run 5 did,
  and a budget-matched mechanical null accounts for +16.5 of its +27.8 points.
  Rows before run 6 all sit at a similar low line budget and are comparable to
  each other; comparing any of them to run 6 without the null is not.
- **The nondeterminism floor is ±7 entries** on byte-identical prompts. Nothing
  smaller than that is a result on its own.

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

**Superseded 2026-08-01: run 6 now exists and is recorded below.** This
paragraph previously read "No run 6 exists": the 2026-07-29 full-pipeline
combined-fix attempt was launched and died on `no credits remaining`, and the
`terra` and `luna-fixed` full manifests were left staged for whenever credits
returned. Credits did return, and the run that eventually took the name went a
different way — Stage 2's agent loop on `luna` rather than a model-tier change
on `terra`. The original attempt is left recorded here because a run that died
is part of the history; what changed is only that the gap it left is now filled.

`terra`, `luna-fixed` and `sol` remain **unmeasured on the full corpus**, all
three for the same billing reason rather than any capability one. An earlier
note attributing `sol`'s failure to rate limiting was wrong — all 248 of its
429s carried `no credits remaining`.

**2. Every scored run used the cheapest tier of its model family.** `luna` was
chosen on cost as "the smallest step up" from `qwen`. A 129-lane arm on `terra`,
same prompts and same shared Stage 0, scored **50/82 = 61.0% recall against luna's
36/82 = 43.9%** — +17.1 points, the largest measured effect in the project's
history. That arm completed cleanly (0 retries, 0 fatal) before credits ran out, so
it stands; it is a 129-lane result, not a full run. Four runs of playbook and labelling work were tuned against a model that
was itself the binding constraint.

### Run 6 — 2026-08-01T19:19Z, `stage1-2-v2-perfile-trace-loop`, `luna`, `20889d4`

**The shipped arm on the full corpus: recall 69/97 = 71.1%, localization
88.7%.** Both are the best recorded by a wide margin, and recall is above the
60–70% band the arm was selected for.

Stages 0 and 0.5 were carried over from run 3 unchanged — the same artifacts
run 5 used — so the lane manifest and per-lane class assignments are identical
and this is single-variable against run 5 in Stage 2's arm.

| Metric | Run 5 | **Run 6** | Target |
|---|---|---|---|
| Recall (file + exact line + category) | 42/97 = 43.3% | **69/97 = 71.1%** | ≥90% |
| Localization (±15 lines) | 78/97 = 80.4% | **86/97 = 88.7%** | ≥90% |
| File-level (any line) | 97/97 = 100% | 97/97 = 100% | — |
| Precision proxy (category-aware) | 12.5% | 12.5% | ≥95% |
| Hedging | 1.518 | **1.418** | baseline 1.000 |
| Recall, category-blind | 55/97 = 56.7% | **77/97 = 79.4%** | — |
| Localization, category-blind | 87/97 = 89.7% | **93/97 = 95.9%** | — |
| Precision proxy, category-blind | 19.1% | 22.4% | — |
| Findings | 392 | 553 | — |
| Lanes emitting ≥1 finding | 244/541 = 45.1% | 268/541 = 49.5% | — |
| Max classes on one finding | 3 | 4 | — |
| Tokens | 3,786,720 | **9,618,943** | — |
| Cost | $5.73 | **$21.84** | — |
| Wall clock | 4m38s @ C=16 | 13m04s @ C=32 | — |
| Retries / fatal | 0 / 0 | **0 / 0** | — |

| Bucket | Run 5 | Run 6 | Δ |
|---|---|---|---|
| HIT | 42 | **69** | **+27** |
| CATEGORY_MISS | 13 | 8 | −5 |
| LINE_MISS_NEAR | 28 | **14** | **−14** |
| LINE_MISS_FAR | 12 | 5 | −7 |
| FILE_ONLY | 2 | 1 | −1 |
| NOT_FOUND | 0 | 0 | 0 |

Recall transitions: **28 gained, 1 lost.**

**The gain is broad-based, and this is the number that says so.** Run 6's 69
hits span **40 of the 66 distinct ground-truth locations**, against run 5's 42
hits over 23. Every previous headline in this file carried the caveat that
recall is location-weighted and a single crowded line can swing it by 11 points;
this run nearly doubles the distinct locations covered, which no amount of
hot-line luck produces.

`LINE_MISS_NEAR` — the dominant residual pool since run 5, and the one the
`trace` loop was built to target — **halved, 28 → 14**. That is the intervention
working on the mechanism it was designed for.

**Execution.** 541/541 hunt lanes, **0 retries, 0 fatal, 0 blocked reads**,
`degraded: false`, single clean pass. 1,082 model calls — exactly 2 per lane, so
the loop fired on every one. All three token accounting sources agree at
9,618,943 with no duplicate `lane_id` and no failed lane. Actual cost $21.84
against Stage 1's $23.11 projection, **5.5% under**.

#### ⚠ How much of this is detection, and how much is cited lines

Every ground-truth-denominated metric is monotone in trace length, so this must
be reported with its line budget and a budget-matched null — see
`protocols/eval-howto.md` §3. Run 6 cites **881 distinct lines across the
benchmark-bearing lanes, 20.8% of their 4,245 lines**, against run 5's 244
(5.7%). Inflating run 5's own findings mechanically to the same 881-line budget,
with no model involved:

| | recall | localization | blind loc |
|---|---|---|---|
| Run 5 | 43.3% | 80.4% | 89.7% |
| **Run 6** | **71.1%** | **88.7%** | **95.9%** |
| Null, matched to 881 lines | 59.8% | 83.5% | 94.8% |
| Null, fill every span (1,812 lines) | 73.2% | 83.5% | 92.8% |

So of the +27.8 recall points, **+16.5 is line count and +11.3 is
attributable**; of the +8.3 localization points, +3.1 is line count and **+5.2
is attributable**. Category-blind localization is almost entirely line count.
Run 6's 71.1% sits just under the 73.2% a purely mechanical span-fill reaches.

**Read the attributable figures when comparing architectures, and the headline
when reporting what the scanner produced.** Both are true; neither alone is.

Other qualifications: one arm against a **±7-entry nondeterminism floor** (the
28-gained/1-lost shape is far outside it, but the exact figure is not
reproducible to the entry); precision has no Stage 3 validator in v2 to recover
it; and `ai-llm-agency` remains 0/4, unchanged across every run to date.

Archived at `runs/2026-08-01T19-19Z__stage1-2-v2-perfile-trace-loop__luna__20889d4/`
in the answer-key repo.

---

## 2026-08-01 — Stage 2 per-lane agent loop, and the output cap

Seven arms on the 40-lane benchmark-bearing platform, `luna`, **$11.88 total**.
No full 541-lane run: the platform measures recall and localization *exactly*
(§2 of `analysis/2026-07-29-run6-investigation.md`), and the budget for this
investigation bought seven contrasts rather than two full runs. Full-run cost is
projected, not measured, and is labelled as such.

Architecture and the reasoning behind each turn's wording:
`architecture/stage2-lane-loop.md`. Located evidence: answer-key repo,
`analysis/2026-08-01-loop-located.md`.

**Shipped as a result of this investigation:** `HUNT_LOOP=trace` is now Stage 2's
default, paired with the registry's `reasoning_effort: high` and 24,000-token
cap — the `trace-high` row below, at 67.0% recall and 85.6% localization. That
was the user's call, made against the two qualifications stated in full here:
the loop's recall increment over high effort alone is not distinguishable from
its extra cited lines, and the pairing costs 91% more than either half on its
own for +1 entry over the loop alone and +3 over the effort alone. Both halves
reach the 60–70% band separately and more cheaply. `HUNT_LOOP=none` with
`SCANNER_REASONING_EFFORT=` and `SCANNER_MAX_OUTPUT_TOKENS=8000` still
reproduces runs 1–5 byte-for-byte.

**Role note.** CLAUDE.md reserves scanner source edits for Qwen. `acpx qwen` is
not installed in this environment and the user directed this investigation
directly, so that split is suspended here, as it was for the run-6
investigation. Every claim below is verified against artifacts.

### Platform validation, before any arm was cited

- Restricting run 5's committed findings to the 40 lanes reproduces its
  published metrics to the entry: 42/97 recall, 78/97 localization, 87/97 blind.
- Rebuilding each arm lane's prompt and comparing to run 5's recorded
  `prompt_breakdown.total_chars`: **38 of 40 byte-identical**. The two that
  differ are exactly the two documented post-run-5 changes — the PEM
  line-count fix (+1 char, on the one file carrying a private key) and
  `renderRegistrarRouteContext()` (+14,176 chars, on the file that declares
  routes). No unexplained drift.

### Results

All recall and localization figures are over the same 97 reachable entries and
are therefore directly comparable to every run in the table below.

| arm | loop | effort | recall | localization | blind loc | lines cited | arm $ | projected 541-lane $ |
|---|---|---|---|---|---|---|---|---|
| `ctl-def` | none | default | 52/97 = 53.6% | 77.3% | 89.7% | 254 | 0.74 | **5.73** |
| `ctl-high` | none | high | 62/97 = 63.9% | 81.4% | 93.8% | 365 | 1.93 | 12.59 |
| `trace-def` | trace | default | **64/97 = 66.0%** | **84.5%** | 92.8% | 632 | 1.61 | 12.45 |
| `reflect-def` | reflect | default | 64/97 = 66.0% | 77.3% | 90.7% | 608 | 1.65 | 12.70 |
| `trace-high` | trace | high | **65/97 = 67.0%** | **85.6%** | 93.8% | 691 | 3.56 | 23.75 |
| `trace-def-v2` | trace, strict wording | default | 51/97 = 52.6% | 71.1% | 90.7% | 489 | 1.51 | 12.3 |

The cost projection reproduces run 5's published $5.73 exactly on the `ctl-def`
row, which is what makes the other rows trustworthy. It scales the input and
output legs separately against run 5's own per-lane records, because the
benchmark-bearing lanes are output-heavy — 1,664 output tokens per lane against
663 across all 541 — and a flat 541/40 scaling overstates a full run by ~2x.

### ⚠ Read every row against its budget-matched null, not against the control

Every ground-truth-denominated metric is monotone non-decreasing in trace
length. A loop that asks for more trace steps **must** raise recall to some
degree whether or not it understood anything. Inflating the loop-free control's
own traces mechanically — no model involved — to each arm's exact line budget,
nearest-already-cited-line first:

| contrast | arm recall | matched null | attributable to the change |
|---|---|---|---|
| `ctl-high` vs `ctl-def` @ 365 lines | 63.9% | 55.7% | **+8.2** |
| `trace-def` vs `ctl-def` @ 632 lines | 66.0% | 58.8% | **+7.2** |
| `trace-high` vs `ctl-def` @ 691 lines | 67.0% | 59.8% | **+7.2** |
| `trace-high` vs **`ctl-high`** @ 691 lines | 67.0% | **68.0%** | **≈ 0** |
| `trace-def-v2` vs `ctl-def` @ 489 lines | 52.6% | 56.7% | **−4.1** |

**The loop and the reasoning effort are substitutes, not complements.** Each is
worth about +7 to +8 null-adjusted points on its own; together they are worth
the same +7.2 as either alone. Stacking them costs 91% more and buys one entry.

Localization is the metric padding cannot fake — a ±15 window barely moves when
lines are added next to lines already cited, and in every null it moves by at
most a point. `trace-def` raised it 77.3% → 84.5% and `trace-high` to 85.6%,
which is a change in *which* lines are cited, not how many.

### The wording of the completion instruction is the largest single effect measured

`trace-def-v2` is `trace-def` with a stricter completion instruction: each added
line must be justified in its own description, and an already-complete trace may
be re-emitted unchanged. It was written in response to a correct review finding
— nothing in the original wording stops the model padding a trace.

It does not merely remove the padding. Recall **66.0% → 52.6%**, localization
**84.5% → 71.1%**, and the arm lands *below* a mechanical inflation of the
control to the same line budget. Suppressing the padding suppressed the
completion the loop exists to produce. The default keeps the measured wording;
the strict variant is retained behind `HUNT_LOOP_STRICT_TRACE=1` and documented
as measured-worse, because the concern is real and the right wording is
probably between the two.

### Nondeterminism floor: ±7 entries, and read the asymmetry

Re-running the loop-free control on prompts verified byte-identical to run 5's
moved **17 of 84 entries — 12 gained, 5 lost, net +7**. That is the noise on
identical input.

So no net difference under ~7 entries is a result on its own. What separates
these arms from noise is the *shape* of their transitions, not the net:

| arm, vs `ctl-def` | gained | lost |
|---|---|---|
| noise floor (identical prompts) | 12 | 5 |
| `ctl-high` | 10 | **0** |
| `trace-def` | 13 | 1 |
| `trace-high` | 14 | 1 |
| `trace-def-v2` | 6 | 7 |

Noise moves entries in both directions at roughly 2:1. `ctl-high` and
`trace-def` do not. `trace-def-v2` does — it is indistinguishable from the
control.

### The output-token cap: it is a truncation risk, not a cost control

The user's separate question. Reasoning tokens are billed as output *and*
counted against `max_completion_tokens`, and Stage 2 records an unparseable body
as a lane that found nothing rather than as a failure — so a binding cap looks
exactly like a model with nothing to say.

Measured completion tokens per call:

| arm | mean | p90 | max | calls ≥ 8000 | calls ≥ 16000 |
|---|---|---|---|---|---|
| default effort, no loop | 1,664 | 2,616 | 3,546 | 0% | 0% |
| default effort, `trace` loop | 1,863 | 3,080 | 4,112 | 0% | 0% |
| **effort `high`, no loop** | 6,637 | 11,938 | 14,584 | **42%** | 0% |
| effort `high`, `trace` loop | 5,878 | 12,083 | 13,766 | 29% | 0% |

Dropping every lane whose first call would have been truncated, computed from
the arm's own measurements:

| cap at effort `high` | lanes truncated | recall |
|---|---|---|
| 24,000 (shipped) | 0 | 63.9% |
| 16,000 | 0 | 63.9% |
| 12,000 | 3 | 55.7% |
| **8,000 (runs 1–5)** | **17 of 40** | **37.1%** |

**Three conclusions.** The registry's 8,000 → 24,000 move alongside
`reasoning_effort: high` was load-bearing, not housekeeping — at 8,000 the
high-effort arm would have scored *below* the default-effort control while
costing 2.6x more, and nothing in the logs would have said why. Raising the cap
**cannot** buy further recall: the ceiling is 14,584 against a 24,000 cap, so
16,000 would do and 24,000 is already slack. And at default effort the cap is
irrelevant — the loop adds only ~200 output tokens per call and stays an order
of magnitude clear of 8,000.

### What is not measured

- **No full 541-lane run.** Every recall figure is exact; every cost figure
  beyond the arm is projected.
- **The shipped combination — measured wording plus the corrected merge — has
  no full-arm number.** The merge defects below were found in review *after*
  the arms ran. A 20-lane paired validation of the shipped default gained 6 and
  lost 0 against the control on the same lanes, the same one-sided shape as
  `trace-def`, so it does not regress; but 40-lane recall for that exact
  combination is inferred, not measured.
- **`sweep` mode is implemented and unmeasured.** Do not claim it works.
- **One arm per configuration.** Against a ±7 noise floor, treat any single row
  as ±7 and lean on the transition asymmetry instead.

### Defects found and fixed during the investigation

All found by review, all before any of them reached a shipped default:

1. **A class added by a follow-up turn never reached `categories[]`**, which is
   what category-aware scoring reads — so the loop could correctly notice a
   second class and the OWASP codes would not follow it. The arms above ran with
   this defect; it can only have understated them.
2. **The merge could *shrink* a trace.** It deduplicated by line and line-sorted
   the whole trace, deleting repeated lines and reordering causal ones —
   affecting the ~14% of findings that repeat a line and the ~15% whose trace
   runs backwards. Now only genuinely new lines are added and every existing
   step keeps its line, kind and position.
3. **A distinct defect sharing one line and one class was absorbed** into an
   existing finding, losing its own sink and title while reporting that nothing
   was added — the exact shape `gap` mode produces. Identity now requires a kept
   title or two shared lines.
4. `chunk_count` counted turns rather than chunks, which would have made
   `buildRunLevelRollup` bill every follow-up turn as re-sent boilerplate.
5. `findings_emitted` was written on `none` runs too, so a reproduction of an
   archived run no longer matched it byte-for-byte.
6. Failed follow-up and sweep calls left no consumption record.
7. `parseInt` accepted `"1e5"` as a cap of 1 — a truncation of every response,
   which reads downstream as an empty findings array.
8. `meta.json` did not record the loop arm, and the arm is an env var, so
   `git_sha` could not tell two arms of one tree apart.

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
