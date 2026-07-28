# Stage 2 v2 (per-file) under `luna` — run notes

Complete: **541/541 hunt lanes**, 324 skip, 247 candidate findings, 0 guard blocks.

## It took two passes

| Pass | Lanes | Concurrency | Outcome |
|---|---|---|---|
| 1 — 2026-07-28T04:42Z | 541 attempted | 8 | 489 succeeded, **52 failed** on TPM rate limits |
| 2 — 2026-07-28T05:0xZ | 52 retried | 3 | all 52 succeeded, 0 retries needed |

Pass 1's 52 failures were OpenAI tokens-per-minute limits on `gpt-5.6-luna`,
after the executor's 3 retries were spent. Not model behaviour. Ten of the
ninety-eight ground-truth entries sat in those lanes, so pass 1 alone was not
scoreable; the figures reported for this run come from the union of both passes.

Mixed concurrency is a property of this run: 489 lanes ran 8-way, 52 ran 3-way.
Concurrency affects scheduling only — prompts, playbooks and lane definitions
were byte-identical across both passes, because Stage 2 reads
`lane-assignments.json` and never regenerates it.

## Known gap in this directory's `budget-consumption.json`

`legacy_entries` is complete and correct: 865 entries, no duplicates, summing to
**3,338,328** tokens across the whole run.

`lanes[]` (the per-chunk v2 detail) and `rollup` cover **only pass 2's 52 lanes**.
`laneRecordsV2` is rebuilt from empty on every invocation and is not restored
from the checkpoint, so a resumed run silently reports only its final pass in
that section. Reading `rollup` as the run total understates it by ~6x.

True split, reconstructed from both passes and cross-checked against
`legacy_entries` (exact match):

| | input | output | total |
|---|---|---|---|
| pass 1 (489 lanes) | 2,625,901 | 223,754 | 2,849,655 |
| pass 2 (52 lanes) | 452,859 | 35,814 | 488,673 |
| **run total** | **3,078,760** | **259,568** | **3,338,328** |

Pass 1's full per-chunk detail is preserved in the private run archive.
