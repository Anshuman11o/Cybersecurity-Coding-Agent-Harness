# Stage 1 — Budget Governor

`tools/scanner/stage1-budget-governor/src/budget-governor.ts`

Arithmetic only — **no model call, in either track**. One source file serves both
v1 and v2 and both v2 modes, selected by flag:

| Invocation | npm script | Stage key | Writes |
|---|---|---|---|
| *(none)* | `run` | `stage1-budget-governor` | `budget-plan.json` (v1) |
| `--v2 --mode estimate` | `run:v2` | `stage1-budget-governor-perfile` | `budget-plan-v2.json` |
| `--v2 --mode reconcile` | `run:v2-reconcile` | `stage1-budget-governor-perfile` | `usage-v2.json` |

`run.sh` maps the stage keys `stage1-budget-governor-perfile` and `reconcile-v2`
onto this same directory. **Reconcile runs last in the v2 pipeline**, after Stage
2 has produced the consumption it reads.

---

## v2 — estimate

### Input
`stage05-lane-selector-perfile/lane-assignments.json` (hunt lanes only),
`shared/vuln-classes.json`, the on-disk character sizes of the Stage 2 playbook
modules, and the model registry.

### What it computes

Per hunt lane, the prompt is reconstructed segment by segment — boilerplate, the
classes section, a multi-chunk header when the plan has more than one chunk, the
playbook text for each assigned class (deduplicated by module), the file's own
bytes, and a fixed arch-context allowance — and converted to tokens.

**The call count comes from `shared/loop-config.ts`, not from a local constant.**
`callsPerChunk(loopConfig, classCount)` is the same function Stage 2 executes
against, which is exactly why it lives in `shared/`: a plan that does not know a
loop is on projects roughly half the input and none of the extra output, and the
reconcile pass then reports every lane as a large divergence — which reads as
"the budget model is broken" rather than "a loop was on".

Two calibrated constants carry the loop's real shape:

- **`FOLLOW_UP_INPUT_MULTIPLIER = 1.19`** — a follow-up turn does *not* re-send
  the prompt. It continues the conversation, so its input is turn 1's prompt plus
  the assistant's answer plus the new instruction, measured at 1.19× turn 1 on the
  40-lane platform. Counting it as a second full prompt would overstate a looped
  run's input by ~40%.
- **`sweep` is exempt** — it is a fresh prompt per class group, so its input is
  modelled as a full re-send per call.

Output tokens are `projected_calls × OUTPUT_TOKENS_PER_CALL`, where the base is
run 5's measured **718 output tokens per call at the default effort**, scaled by a
per-effort multiplier read from the registry's `sampling.reasoning_effort`. The
basis is written into the artifact as prose, so a plan always states which
measurement it was built on rather than presenting a bare number.

### Output
`budget-plan-v2.json` — per lane: `chunk_count`, `assigned_classes`, the estimated
boilerplate / playbook / file-content token split, projected calls, projected
input and output tokens; plus run-level totals and cost.

Cost comes from the **registry** (`price_per_mtok` and `price_asof` in
`models.json`), and an unpriced target gets **no cost rather than a wrong one**.
This is deliberate: the price previously lived in prose, rotted there, and five
runs published cost figures 5× high. Every cost figure this stage writes travels
next to the rate that produced it.

## v2 — reconcile

### Input
`stage2-hunt-lanes-perfile/budget-consumption.json` — Stage 2's own measurement —
and the plan written by the estimate mode.

### Output
`usage-v2.json` — measured input, cached input, cache-write, output and total
tokens, call count, lane count, `lanes_missing_measurement`, and cost at the
registry rate with its `price_asof`.

It reads the v2 `lanes[]` shape and falls back to the v1 flat array when given
one. **It reports actuals only and does not compare them to the plan** — a gap
between an estimate and a measurement is a fact about the estimate, and the number
wanted afterwards is the cost.

## v1

### Input
`lane-manifest.json` plus the on-disk sizes of each lane's seed files.

### Output
`budget-plan.json`: per lane `token_ceiling`, `wall_clock_ceiling`, `model_tier`,
`escalation_flag` and the reason it was set. Ceilings derive from each lane's own
seed footprint; escalation flags when a lane sits in the top quartile by bytes or
file count.

## Design intent

Per-lane ceilings, deliberately not one global cap, so a single expensive lane
cannot starve the others. This is a direct response to a benchmarked tool that
died when one org-wide spend cap was hit mid-run.

**The v2 path deliberately does not enforce ceilings — it measures.** No lane is
ever cut off for cost. The projection exists so a run's cost is known before it is
spent, and the reconcile pass exists so what was actually spent is recorded next
to it in an artifact rather than in a log.

## Tests
`npm test` in this directory runs `src/test-harness.ts`.
