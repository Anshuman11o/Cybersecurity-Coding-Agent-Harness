# Stage 2 v2 (per-file) under `luna` — run notes

**Run 3**, 2026-07-28T23:07Z, `c9e3e94`. Complete: **541/541 hunt lanes**, 324
skip, **407 candidate findings**, 0 guard blocks, 0 blocked reads.

These notes describe the artifacts currently in this directory. Earlier runs are
archived; see `docs/run-history.md` for the comparison table.

## A clean single pass

| | |
|---|---|
| Wall clock | 17m12s (23:07:30Z → 23:24:42Z) |
| Concurrency | `HUNT_CONCURRENCY=4` |
| Lanes | 541/541, **0 fatal**, 54 retries all recovered |
| Tokens | 3,558,386 — 3,175,058 in / 383,328 out |
| Cost | **$5.48** at $1.00/M input, $6.00/M output |

Because this was a single pass, the `laneRecordsV2` checkpoint defect that
qualified run 1 does **not** apply here. All three accounting sources agree
exactly:

| Source | Total tokens |
|---|---|
| `rollup` | 3,558,386 |
| `lanes[]` (541 entries, no duplicate `lane_id`, none `failed`) | 3,558,386 |
| `legacy_entries` (865 entries, 0 `ceiling_hit`) | 3,558,386 |

## What this run measured

One change since run 2: **F1** — the `## Distinguishing From Adjacent Classes`
section was deleted from all 14 playbooks, and the executor's class-selection
prompt was strengthened to state that classes are not mutually exclusive.

The upstream stages confirm the change was isolated to Stage 2's prompt: Stage
0.5's `lanes[]` payload is **byte-identical** to run 2's, so lane count,
dispositions and per-lane class assignments are unchanged. Stage 1's only
per-lane deltas are `estimated_playbook_tokens` and `projected_input_tokens`,
which fell 3,394,521 → 2,764,390 (−18.6%) with the 22% smaller playbooks.

## Schema warnings

46 findings named a `justified_by_step` beyond their trace length and were
clamped to 0 (run 2 had the same class of warning). This is a model output
conformance issue, not a lane failure — the finding is retained with a clamped
step index. Worth tracking if it grows.
