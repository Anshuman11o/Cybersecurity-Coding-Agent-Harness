# Run history

Every scored run, newest first. Aggregate metrics only — no per-entry detail, by
`protocols/blind-development.md`. Full artifacts, logs and eval JSON are archived
in the answer-key repo under `runs/<timestamp>__<variant>__<provider>__<sha>/`.

A run not listed here either was not scored or was not blind. Both cases are
recorded, because an unmarked non-blind number gets cited later as if it were a
baseline.

## Scored runs, v2 per-file

| Metric | Run 1 · `0c5c907` | Run 2 · `e3307ec` | Target |
|---|---|---|---|
| Recall (file + exact line + category) | 37/98 = 37.8% | **32/98 = 32.7%** | ≥90% |
| Localization (±15 lines) | 65/98 = 66.3% | **57/98 = 58.2%** | ≥90% |
| File-level (any line) | 93/98 = 94.9% | **97/98 = 99.0%** | — |
| Precision proxy (category-aware) | 15.4% | **11.9%** | ≥95% |
| Hedging | 1.462 classes/finding | **1.240** | baseline 1.000 |

Category-blind, and the emission diagnostics:

| | Run 1 | Run 2 |
|---|---|---|
| Recall, category-blind | 40.8% | **48.0%** |
| Localization, category-blind | 80.6% | **85.7%** |
| Findings | 247 | 354 |
| Lanes emitting ≥1 finding | 182/541 = 33.6% | **228/541 = 42.1%** |
| Findings below confidence 0.7 | 0 | 109 (min 0.28) |
| Max classes on one finding | 2 (capped) | 3 |
| Tokens | 3,338,328 | 4,022,526 |
| Cost | $4.64 | **$5.82** |

---

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
