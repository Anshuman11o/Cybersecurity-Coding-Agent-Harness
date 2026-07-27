# Stage 1 — Budget Governor

`tools/scanner/stage1-budget-governor/src/budget-governor.ts`

Arithmetic only — no model call.

## Input
`lane-manifest.json` plus on-disk sizes of each lane's seed files.

## Output
`output/budget-plan.json`: per lane `token_ceiling`, `wall_clock_ceiling`,
`model_tier`, `escalation_flag` and the reason it was set. Ceilings derive from
each lane's own seed footprint; escalation flags when a lane sits in the top
quartile by bytes or file count.

## Design intent
Per-lane ceilings, deliberately not one global cap, so a single expensive lane
cannot starve the others. This is a direct response to a benchmarked tool that
died when one org-wide spend cap was hit mid-run.

## Status in the v2 path
The per-file architecture deliberately does **not** enforce ceilings. It
measures instead: predicted cost comes from `tools/eval/cost-model.py` and
actual usage is recorded per lane for comparison. No lane is ever cut off for
cost.
