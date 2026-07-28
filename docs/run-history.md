# Run history

Every scored run, newest first. Aggregate metrics only — no per-entry detail, by
`protocols/blind-development.md`. Full artifacts, logs and eval JSON are archived
in the answer-key repo under `runs/<timestamp>__<variant>__<provider>__<sha>/`.

A run not listed here either was not scored or was not blind. Both cases are
recorded, because an unmarked non-blind number gets cited later as if it were a
baseline.

## Scored runs, v2 per-file

| Metric | Run 1 · `0c5c907` | Run 2 · `e3307ec` | Run 3 · `c9e3e94` | Target |
|---|---|---|---|---|
| Recall (file + exact line + category) | 37/98 = 37.8% | 32/98 = 32.7% | **49/98 = 50.0%** | ≥90% |
| Localization (±15 lines) | 65/98 = 66.3% | 57/98 = 58.2% | **73/98 = 74.5%** | ≥90% |
| File-level (any line) | 93/98 = 94.9% | 97/98 = 99.0% | **97/98 = 99.0%** | — |
| Precision proxy (category-aware) | 15.4% | 11.9% | **11.8%** | ≥95% |
| Hedging | 1.462 classes/finding | 1.240 | **1.538** | baseline 1.000 |

Category-blind, and the emission diagnostics:

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Recall, category-blind | 40.8% | 48.0% | **53.1%** |
| Localization, category-blind | 80.6% | 85.7% | **87.8%** |
| Precision proxy, category-blind | 22.3% | 20.3% | **18.4%** |
| Findings | 247 | 354 | **407** |
| Lanes emitting ≥1 finding | 182/541 = 33.6% | 228/541 = 42.1% | **250/541 = 46.2%** |
| Findings below confidence 0.7 | 0 | 109 (min 0.28) | **131 (min 0.28)** |
| Max classes on one finding | 2 (capped) | 3 | **4** |
| Distinct locations behind the recall hits | — | 24 | **23** |
| Tokens | 3,338,328 | 4,022,526 | **3,558,386** |
| Cost | $4.64 | $5.82 | **$5.48** |

---

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
   the 17-point gain**. Excluding it, recall rose 31/87 → 38/87 (+8.1 points).
   That residual is the honest broad-based figure. `crypto-auth` recovering
   0/25 → 19/25 is predominantly the same location.
2. F1 was predicted to add no detection, which would have pinned category-blind
   recall at 48.0%. It did not: category-blind recall rose 47 → 52, findings
   354 → 407, producing lanes 228 → 250. The reason is that F1 **as shipped**
   deleted 22% of playbook content rather than rewording the closer as
   originally proposed, so it changed what the model hunts for as well as how it
   labels. Any claim that this measured a pure labelling change is wrong.

**The foreseen regression landed.** `misconfiguration` 58.8% → 47.1% and
`insecure-design` 38.5% → 30.8% — the two classes that improved in run 2 and
whose targeted adjacency bullets F1 deleted. Their category-blind localization
did not fall, so the defects are still found and positioned; they are labelled
differently. Per F1's own instruction, those bullets carried real guidance and
should return without the singular closer.

**Cost of the emission increase.** Precision proxy fell 20.3% → 18.4%
category-blind. v2 still has no Stage 3 validator, so nothing recovers it.

Also in force: 46 findings named a `justified_by_step` beyond their trace length
and were clamped to 0 — model output conformance, not a lane failure. And this
run was executed directly by Claude at the operator's instruction rather than
dispatched to Qwen, so the `CLAUDE.md` execute/verify split did not hold.

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
from 26/87 to 31/87.

**Removing the class cap did the opposite of what was predicted.** Hedging fell
1.462 → 1.240 and the share of findings naming ≥2 classes fell 46.2% → 22.9%. The
cap was never the binding constraint. Most likely interaction: the adjacent-class
disambiguation sections teach the model to tell neighbouring classes apart, which
pushes toward one well-argued label rather than several. Two changes pulled
against each other.

Attributable per-class movement, the two classes with targeted changes:

| Class | Run 1 | Run 2 |
|---|---|---|
| misconfiguration | 41.2% | **58.8%** |
| insecure-design | 15.4% | **38.5%** |

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
