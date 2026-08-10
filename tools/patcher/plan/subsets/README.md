# Subset chunk maps

A **chunk map** is the parallelisation plan for a patcher run: which files each
agent owns, which agents may run at the same time, and in what order the results
merge. The full map — `tools/patcher/plan/chunk-map.json` — covers the whole bug
report. A **subset map** in this directory covers one slice of it.

Both use the same schema, `"map_id": "chunk-map/v1"`. Anything that reads one
reads the other.

## Why subsets exist

A full run is long and expensive. A subset run is the same machinery over a
smaller bug report, so it can be used to shake out the plan, the gates and the
merge order before the full run is paid for. That is only useful if the two are
*comparable*, which is what the rules below are for.

## The rules that make a subset comparable to the full map

1. **Chunk ids are inherited, never reassigned.** If the full map calls
   `routes/metrics.ts` chunk `C09`, the subset map calls it `C09` too — even
   when it holds one task here and four there. A chunk id names a *set of files*
   and its place in the merge order, not a workload. Renumbering
   `C09, C11 -> C01, C02` would make the subset read as its own plan and every
   later comparison would silently be against different chunks.
2. **Task lists are filtered, not rebuilt.** A chunk's `tasks[]` in a subset map
   is the full map's task list for that chunk, intersected with this subset's
   bug report. Nothing is added.
3. **Chunks with zero tasks are dropped, and so are brackets left empty.**
   Subset 4 has no bugs in bracket B, so bracket B is absent from
   `subset-04.chunk-map.json` entirely — not present with an empty `chunks[]`.
   Phases renumber to close the gap, so a subset's `phase` values are dense
   (`0, 1, 2`) and need not equal the full map's phase numbers for the same
   bracket. The **bracket order** is preserved; only the numbering compacts.
4. **`files[]` lists only files that carry a confirmed vulnerability.** A file
   that is part of a chunk's dependency reasoning but has no bug in this subset
   is named in `reason`, not in `files`. `models/user.ts` in chunk `A01` is the
   worked example: it closes the import cycle that forces `lib/insecurity.ts`
   and `models/feedback.ts` into one chunk, and it is described in the reason
   text, but no agent is handed it because there is nothing in it to fix.
5. **`excluded_bugs` records deliberate omissions, not absences.** A bug that is
   not in the subset's bug report at all is simply not here. `excluded_bugs` is
   for a bug that *is* in the report and was left unplanned, with the reason. It
   is `[]` for subset 4: all 10 bugs are planned.
6. **The boundary lists are copied verbatim.** `shared_extension_zone`,
   `never_writable` and `read_denylist` are properties of the target tree and
   the blind-development boundary, not of the slice. They do not shrink because
   the subset is smaller. `read_denylist` in particular is load-bearing: those
   three files leak challenge keys, and a per-file plan that hands one to an
   agent puts its whole content into a prompt.

## How a chunk map is derived

Brackets come from the import graph of the target tree, not from taste:

- **A / core** — modules that most of the application imports, and any import
  cycle they sit in. A cycle cannot be ordered, so every file in it belongs to
  one chunk owned by one agent, patched sequentially.
- **B / models and data** — schema and data-layer files below the handlers.
- **C / handlers** — route handlers. These are leaves: nothing imports them, so
  disjoint handler chunks run concurrently.
- **D / wiring** — `server.ts` and friends, which import everything. Patched
  last and alone, so the change is measured against a tree in which every
  earlier bracket has already landed.

`tools/patcher/src/wave_plan.py` computes exactly this from the tree
(`wave_plan.plan(bugs, tree)` prints the waves, the cycles and the max
parallelism). Use it as the check on a hand-written map: if the map's phases and
the planner's waves disagree, one of them is wrong.

## Deriving the next subset

1. Put the subset's `bug-report.json` and `playbook.json` under
   `tools/patcher/inputs/subsetN/`.
2. Run `wave_plan.plan(bugs, 'target-apps/juice-shop-blind')` and read the
   waves, the cycle annotations and the max-parallel figure.
3. Take the full map, drop every task whose bug id is not in the subset report,
   then drop the emptied chunks and brackets. Keep every surviving chunk id.
4. Renumber phases densely, preserving bracket order, and set each phase's
   `concurrency` to that phase's chunk count.
5. Write `subset-0N.chunk-map.json` here, generating every task's `file`, `line`
   and `class` **from the bug report** rather than typing them — a map that
   disagrees with the report about a line number sends an agent to the wrong
   place.
6. Copy `tools/patcher/config/subset4.run-config.json`, point it at the new
   inputs, set `run_id`, and set `loop.task_concurrency` to the map's peak
   phase concurrency. Run `run_patcher.py --check` before spending anything.
7. Add a test alongside `tools/patcher/tests/test_subset04_map.py` that asserts
   the map and the bug report still agree.

## What is here

| File | Bugs | Files | Chunks | Peak concurrency |
|---|---|---|---|---|
| `subset-04.chunk-map.json` | 10 | 5 | 4 (`A01`, `C09`, `C11`, `D01`) | 2 |

The runbook for subset 4 is `docs/patcher/SUBSET-04-RUN.md`.
