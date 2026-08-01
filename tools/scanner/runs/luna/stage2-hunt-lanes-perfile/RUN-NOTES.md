# Stage 2 v2 (per-file) under `luna` — run notes

**Run 6**, 2026-08-01T19:06Z, `20889d4`. Complete: **541/541 hunt lanes**, 324
skip, **553 candidate findings**, 0 guard blocks, 0 blocked reads.

These notes describe the artifacts currently in this directory. Earlier runs are
archived; see `docs/run-history.md` for the comparison table.

## The arm

This is the first run of the **per-lane agent loop**: `HUNT_LOOP=trace` with one
follow-up turn, at `reasoning_effort: high` with a 24,000-token output cap. All
four are registry or code defaults, so a plain
`run.sh luna stage2-hunt-lanes-perfile` reproduces it and `meta.json` records
which arm ran — the loop is selected by env var, so the git sha alone does not
identify it.

Stages 0 and 0.5 were carried over from run 3 unchanged, the same artifacts run
5 used, which makes this single-variable against run 5 in Stage 2's arm alone.

## A clean single pass

| | |
|---|---|
| Wall clock | 13m04s (19:06:39Z → 19:19:43Z) |
| Concurrency | `HUNT_CONCURRENCY=32` |
| Lanes | 541/541, **0 fatal, 0 retries** |
| Calls | **1,082** — exactly 2 per lane, so the loop fired on every one |
| Tokens | 9,618,943 — 7,174,088 in / 2,444,855 out |
| Cost | **$4.37** at $0.20/M input, $1.20/M output |

Concurrency 32 was derived from this arm's own throughput, ~16,000 TPM per unit
at high reasoning effort, against the ~51,700 the runbook's default-effort
calibration gives. That put the run at ~26% of the 2,000,000 TPM ceiling —
deliberately under the runbook's 40–50% target, buying reliability with time.
Zero retries confirms the headroom.

All three accounting sources — `rollup`, `lanes[]` and `legacy_entries` — agree
at 9,618,943, with no duplicate `lane_id` and no lane marked failed. Because
this was a single pass, the `laneRecordsV2` checkpoint defect that qualified run
1 does not apply.

## Results

Recall **69/97 = 71.1%**, localization **86/97 = 88.7%**, both the best
recorded. `LINE_MISS_NEAR` — the pool the trace loop was built to target —
halved, 28 → 14. Hits span 40 of the 66 distinct ground-truth locations against
run 5's 23.

**Read the headline with its line budget.** Every ground-truth metric is
monotone in trace length and this arm cites 3.6x the lines run 5 did; a
budget-matched mechanical null accounts for +16.5 of the +27.8 recall points.
`docs/run-history.md` carries the decomposition and it is not optional reading.

## Cost figures here are at the verified rate

$0.20/$1.20 per MTok, read off the vendor's price list on 2026-08-01 and
recorded in `models.json` with a `price_asof` date. This run was first published
at $21.84 under $1.00/$6.00 — a rate that had entered the repo as prose. Token
counts never changed.
