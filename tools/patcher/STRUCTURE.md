# `tools/patcher/` — what every file is, and why it sits where it does

The map of this directory. `README.md` says what the architecture is and why;
`ARCHITECTURE.md` is the loop specification; this file is the index that tells
you which of the 25 modules to open.

Blind-safe. Everything below describes the harness's own source. No challenge
identifier, target file, line, reference fix or oracle title appears here.

**Read this first if the directory looks like more files than it should be.**
It is not three copies of a patcher. It is one substrate — the agent boundary,
the work tree, the gates, the blind boundary — with three orchestrators layered
on top of it. Nine of the modules below are used by all three tracks.

---

## 1. The two axes

Every module sits at the intersection of a **layer** (what job it does) and a
**track** (which orchestrator generation needs it). The directory is laid out
flat, so the layer is not visible from the filename — that is what §3 is for.

| Track | Entry point | Orchestrator's role | Status |
|---|---|---|---|
| **v1** | `src/run_patcher.py` | runs one task at a time; runs every gate itself and decides when a task is done | load-bearing |
| **v2** | `src/run_patcher.py` (wave mode) | computes a wave plan at runtime, runs a wave concurrently, gates the merge | load-bearing |
| **v3** | `src/run_patcher_v3.py` | dispatches chunks against a checked-in plan; runs **no** patcher gate at all | current |

v3 is not a rewrite. It imports v1's inner loop, v1's work tree, v1's gates,
v1's prompts and v2's integrator. Deleting either older track breaks it — see §5.

---

## 2. The tree

```
tools/patcher/
├── README.md                    what the architecture is, and why
├── ARCHITECTURE.md              the loop: phases, gates, dispositions, outputs
├── STRUCTURE.md                 this file
│
├── src/                         ── 25 modules, flat + one v3/ package
│   ├── run_patcher.py           ENTRYPOINT · v1 tasks and v2 waves
│   ├── run_patcher_v3.py        ENTRYPOINT · v3 chunk dispatch
│   │
│   ├── agent.py                 L1 · agent runtime boundary
│   ├── prompts.py               L1 · every dispatched prompt
│   ├── task_loop.py             L1 · the five phases, for one bug
│   │
│   ├── grouping.py              L2 · bug → unit granularity
│   ├── wave_plan.py             L2 · v2 runtime plan from the import graph
│   │
│   ├── wave_runner.py           L3 · v2 wave execution
│   │
│   ├── verify.py                L4 · the gates the orchestrator runs itself
│   ├── testmap.py               L4 · changed file → existing tests
│   ├── antioracle.py            L4 · tests that cannot survive a correct fix
│   │
│   ├── workspace.py             L5 · the work tree
│   ├── integrator.py            L5 · v2 wave fold
│   │
│   ├── blind_guard.py           L6 · input scrub + post-run audit
│   │
│   ├── state.py                 L7 · v1/v2 checkpoint and resume
│   ├── report.py                L7 · task records → patcher-report.json
│   ├── archive_run.py           L7 · run → repo aggregate + private detail
│   │
│   └── v3/                      the dispatcher track
│       ├── __init__.py               sys.path bootstrap for flat imports
│       ├── chunk_map.py         L2 · load and validate the offline plan
│       ├── boundary.py          L2 · owned / shared / never-writable / read-denied
│       ├── dispatcher.py        L3 · spawn, monitor, merge, advance
│       ├── merge_queue.py       L5 · v3 serial apply/build/conflict queue
│       └── run_store.py         L7 · durable per-chunk run store
│
├── hooks/
│   └── sandbox_guard.py         L6 · PreToolUse hard denial, invoked by the CLI
│
├── contracts/                   JSON Schemas — the input and output contracts
├── config/                      run configs; every knob with its default
├── inputs/                      bug reports and playbooks, master + per subset
├── plan/                        the offline chunk-map generator and its output
├── docs/                        PARALLELISATION.md — the v2 design note
└── tests/                       24 files, FakeRunner-driven, no model, no cost
```

---

## 3. The layer view

### L1 · Agent work — one agent, one bug

What the patcher agent is told, how it is invoked, and the loop it runs inside.
This is the layer to read if the question is *what does the agent actually do*.

| File | Lines | Owns | Entry points | Tracks |
|---|---|---|---|---|
| `agent.py` | 361 | the runtime boundary. `AgentRunner` is narrow on purpose so the loop never learns which runtime it is talking to. Usage is **measured** from the runtime's own JSON, never estimated. Carries `FakeRunner`, which drives the whole state machine for free. | `build_runner`, `ClaudeCliRunner`, `FakeRunner`, `Invocation`, `validate_agent_settings` | all |
| `prompts.py` | 553 | every prompt the patcher dispatches, in one file, so the blind-safety property can be checked across all of them at once. Each phase gets a fresh process, so each prompt is self-contained. | `build_characterise`, `build_fix`, `build_reconcile`, `STANDING_CONSTRAINT`, `HOUSE_RULES` | all |
| `task_loop.py` | 505 | the inner `while`. CHARACTERISE → FIX → VERIFY → RECONCILE → close out, with the exit condition in Python rather than in a prompt. Owns the seven dispositions and the revert-on-exhaustion policy. | `run_task`, `TaskContext`, `REVERT_DISPOSITIONS` | v1, v2; v3 uses `_normalise_attestation` |

### L2 · Planning — parallelisation, and dividing the work

Who may run at the same time as whom. v2 answers this at runtime; v3 answers it
offline and checks the answer in.

| File | Lines | Owns | Entry points | Tracks |
|---|---|---|---|---|
| `grouping.py` | 115 | task granularity. One task per bug characterises the same file once per bug in it; grouping by file makes intra-file collision impossible rather than merely mitigated. | `group`, `unit_id_for_file`, `describe` | v1, v2 |
| `wave_plan.py` | 317 | v2's runtime planner. Deterministic: same report + same tree ⇒ same plan, byte for byte, no model involved. Units, edges from real imports, condense cycles, layer, isolate hubs. | `plan`, `import_graph`, `iter_source`, `render` | v2, and `plan/build_chunk_map.py` |
| `v3/chunk_map.py` | 528 | loads and validates the checked-in map. Refuses anything that would make a run's numbers unreadable — every check exists because the failure it prevents is silent. | `load`, `parse`, `validate`, `validate_against_report`, `ChunkMap`, `Chunk`, `Task` | v3 |
| `v3/boundary.py` | 218 | the write boundary: owned, shared-extension, never-writable, read-denied. Deliberately not a plain deny list — a correct cross-file fix must stay possible, or the run measures only what happens to be locally patchable. | `WriteBoundary`, `BoundaryReview`, `normalise`, `matches` | v3 |

### L3 · Orchestration — who runs what, and when

| File | Lines | Owns | Entry points | Tracks |
|---|---|---|---|---|
| `run_patcher.py` | 591 | **entry point.** The outer loop, config loading, preflight, checkpoint/resume. `--check` validates inputs, tree, toolchain and hook and spends nothing. | `main`, `load_config`, `preflight`, `config_digest` | v1, v2; v3 reuses the loaders |
| `wave_runner.py` | 288 | v2 execution: snapshot the integrated tree, seed one tree per chain, run chains concurrently, fold back serially, gate the merged tree. `wave_plan` decides *what*; this decides *how*. | `run_waves`, `chains`, `chain_id` | v2 |
| `run_patcher_v3.py` | 373 | **entry point.** Load, validate, dispatch, checkpoint, audit, report. Separate from `run_patcher.py` on purpose — wiring v3 in would mean editing the file that runs v1 and v2. | `main`, `load_config`, `preflight` | v3 |
| `v3/dispatcher.py` | 1276 | the dispatcher, and deliberately the least intelligent component in the system: spawn one agent per chunk with the same generic prompt, hand it its slice, monitor liveness/timeout/cost, own the merge queue, advance the phase. Runs no patcher gate. | `Dispatcher`, `assignments`, `ChunkResult`, `disposition_counts` | v3 |

### L4 · Measurement — the gates the orchestrator runs itself

Nothing in this layer asks the agent anything. The agent's own account is
collected separately as an attestation and scored as calibration.

| File | Lines | Owns | Entry points | Tracks |
|---|---|---|---|---|
| `verify.py` | 306 | V1 typecheck, V2 workflow, V3 probe, V4 regression, V5 blast radius. Gate order is not cosmetic: a tree that will not compile makes every later gate meaningless, so V1 short-circuits. | `verify`, `typecheck`, `run_probe`, `run_test_file`, `collect_outcomes`, `compare_outcomes`, `run_full_suite` | v1, v2; v3 uses `typecheck` and `run_full_suite` only |
| `testmap.py` | 126 | the per-task regression net: which existing tests exercise the code a task touched. Two sources unioned — what the agent named in its characterisation, and a static scan of the test corpus. | `select`, `scan`, `list_test_files`, `env_for` | all |
| `antioracle.py` | 115 | tests that assert an attack payload was *acted upon*, and therefore cannot survive a correct fix. Left in the regression net they charge a correct fix with damage and the orchestrator reverts it. Not a hypothesis — measured on a real run. | `detect`, `filter_regressions` | v1, v2 (via `verify`) |

### L5 · The work tree — and where two agents' edits meet

| File | Lines | Owns | Entry points | Tracks |
|---|---|---|---|---|
| `workspace.py` | 421 | build, snapshot, revert, diff, hash. One cumulative tree: task N works on what task N−1 left behind. The tree is the run's only durable product, so this module is deliberately boring and deliberately defensive. | `prepare`, `snapshot`, `restore`, `tree_digest`, `changed_files`, `diff_against_snapshot`, `diff_stats`, `harvest_scratch` | all |
| `integrator.py` | 476 | v2's fold: combine a wave's unit trees into one. The only place in a parallel run where two agents' work meets, and therefore the only honest place to attribute a collision. | `integrate`, `post_wave_gate`, `changed_by_unit`, `claims`, `out_of_assignment`, `gate_concurrency` | v2; v3's merge queue reuses it |
| `v3/merge_queue.py` | 292 | the one serial point in a v3 run, and the only test the orchestrator may run. Asks exactly the three questions merging raises — does it apply, does it build, does it conflict — and nothing else, because re-judging the patch would put the verifier back in the loop. | `MergeQueue`, `Submission`, `typecheck_gate` | v3 |

### L6 · The blind boundary

Three independent mechanisms, none of which depend on the agent cooperating.
Prompt text asking the agent not to look is the fourth and weakest layer.

| File | Lines | Owns | Entry points | Tracks |
|---|---|---|---|---|
| `blind_guard.py` | 660 | the bookends. **Before:** validate and scrub the bug report and playbook — an input carrying a reference fix hands over the thing the run exists to measure, in the prompt, where no runtime hook will ever see it. **After:** replay every guard decision and tool call, emit `blind-audit.json`; one answer-key denial marks the run contaminated. | `load_bug_report`, `load_playbook`, `validate_bug_report`, `validate_playbook`, `scrub`, `select_entry`, `audit_run`, `seed_denylisted` | all |
| `hooks/sandbox_guard.py` | 647 | **during:** a `PreToolUse` hook returning a hard `deny`. Blocks any path resolving outside the work tree, any write under the frozen test paths, all network egress, and the answer-key pattern set. Loaded by path, not imported — the CLI invokes it as an external hook. | `evaluate`, `check_path`, `check_bash`, `deny`, `Decision`, `main` | all |

### L7 · Durability, records and outputs

| File | Lines | Owns | Entry points | Tracks |
|---|---|---|---|---|
| `state.py` | 95 | run state, flushed after every task, atomic write with `fsync`. Strict on resume: a resumed run against a drifted tree would silently attribute someone else's edits to the patcher. | `RunState` (`flush`, `load`) | v1, v2 |
| `v3/run_store.py` | 306 | the same guarantee for v3, per chunk. `Dispatcher` holding results in a returned dict is fine for a unit test and catastrophic for a paid run — one run was scored and then lost exactly that way. | `RunStore` | v3 |
| `report.py` | 280 | task records → `patcher-report.json`. Encodes the reporting rules rather than leaving them to the reader: `fixed` and `fixed_workflow_only` are never summed, every rate carries its denominator, `rounds_to_green` is a distribution and not a mean. | `aggregate`, `write`, `render_summary`, `DISPOSITIONS` | all |
| `archive_run.py` | 429 | archives a finished run: **aggregate** row to `results/eval-history/patcher.jsonl`, **located detail** to the private store. Refuses a row containing a bug id, a challenge key, a `file:line` or a source path. Invoked by the `archive-patch-run` skill. | `main`, `build_row`, `assert_publishable`, `append_row`, `copy_run` | all |

---

## 4. Directories that are not `src/`

| Path | Holds | Owner |
|---|---|---|
| `contracts/` | `bug-report`, `playbook` (inputs); `task-record`, `patcher-report` (outputs). Blind-safe by construction. | authored |
| `config/` | `run-config.example.json` documents every knob with its default and why. `subset4` runs v1/v2; `subset5` declares `chunk_map` and runs v3. | authored |
| `inputs/` | `bug-report.json` + `playbook.json` are the master set; `subset3/`, `subset4/`, `subset5/` are the per-run slices. The master pair is read by `plan/`, and three tests pin it. | generated upstream |
| `plan/` | `build_chunk_map.py` (437 lines) is the offline generator; it imports `wave_plan.import_graph()` rather than reimplementing it, because two copies of "what imports what" would drift invisibly. `chunk-map.json` is the full map; `subsets/` holds the per-run maps v3 consumes. | generator + output |
| `docs/PARALLELISATION.md` | the v2 design note: per-file units, deterministic division, wave serialisation, and the measured numbers behind each. | authored |
| `tests/` | 24 files. `FakeRunner`-driven — no network, no model, no money. `conftest.py` puts `src/` and `hooks/` on `sys.path`, which is what makes the flat imports work. | authored |

---

## 5. The import graph

The reason no track can be deleted. Arrows point at what a module imports.

```
  run_patcher.py ──┬──> agent, blind_guard, report, state, grouping,
   (v1 + v2)       │     integrator, task_loop, verify, wave_plan,
                   │     wave_runner, workspace
                   │
  run_patcher_v3.py ──┬──> run_patcher  (load_config, preflight, config_digest)
   (v3)               ├──> agent, blind_guard, report, workspace
                      └──> v3.chunk_map, v3.dispatcher, v3.merge_queue, v3.run_store

  task_loop ────> antioracle, blind_guard, prompts, testmap, verify, workspace
  wave_runner ──> integrator, task_loop, workspace
  wave_plan ────> grouping
  integrator ───> verify, workspace
  verify ───────> antioracle

  v3/dispatcher ──> blind_guard, prompts, task_loop, testmap, verify, workspace
  v3/merge_queue ─> integrator, verify, workspace

  plan/build_chunk_map.py ──> wave_plan
```

Three consequences worth stating plainly:

1. **v3 depends on v1.** `v3/dispatcher.py` imports `task_loop`, `prompts`,
   `workspace`, `verify`, `testmap` and `blind_guard`, and `run_patcher_v3.py`
   imports `run_patcher` itself for config loading and preflight.
2. **v3 depends on v2.** `v3/merge_queue.py` imports `integrator`, and the
   offline planner under `plan/` imports `wave_plan`.
3. **The flat namespace is load-bearing.** `src/` modules import each other by
   bare name (`import workspace`). `v3/__init__.py` inserts `src/` into
   `sys.path` so the same style works one level down, and `tests/conftest.py`
   does the same for the suite. Moving a module into a package means rewriting
   every one of those call sites.

---

## 6. Where to start reading

| You want to… | Open, in this order |
|---|---|
| Understand the loop at all | `README.md` §1 → `ARCHITECTURE.md` §2–3 → `task_loop.py` |
| Understand what v3 changed | `docs/patcher/ARCHITECTURE-V3.md` §0 → `v3/dispatcher.py` docstring |
| Understand the parallelisation | `docs/PARALLELISATION.md` → `wave_plan.py` → `plan/README.md` → `v3/chunk_map.py` |
| Know what the agent is told | `prompts.py` — all of it is in that one file |
| Know how a claim gets checked | `verify.py` → `testmap.py` → `antioracle.py` |
| Know how blindness is enforced | `README.md` §3 → `hooks/sandbox_guard.py` → `blind_guard.py` |
| Change a knob | `config/run-config.example.json` — every one is documented inline |
| Add a model or runtime | `agent.py` `AgentRunner` — the loop never learns which runtime it holds |
| Record a finished run | the `archive-patch-run` skill → `archive_run.py` |

---

## 7. Where a new file goes

The layer decides the answer, not the track:

- it is what the agent is told or how it is invoked → **L1**, `src/` flat
- it decides what may run alongside what → **L2**
- it decides what runs next → **L3**
- it produces a fact the orchestrator measures → **L4**
- it touches the tree or merges edits → **L5**
- it enforces the blind boundary → **L6**
- it writes something down that must survive the session → **L7**

Two standing rules from the root `CLAUDE.md` apply here specifically:

- **Preserve v1 and v2 exactly when building alongside them.** Both are still
  imported by v3; both are also the only measured baselines that exist.
- **When adding a vN of a component, diff its security-relevant imports against
  vN−1's, not just its behaviour.** The v2 denylist incident was exactly this:
  the guard existed and was correct, and the fork silently never picked it up.

---

## 8. Naming friction, recorded rather than fixed

The layout is flat and the filenames carry the track inconsistently. These are
the names most likely to mislead a reader. They are documented here rather than
renamed, because renaming would touch every import site, the run configs and
roughly twenty references across `docs/`.

| Name | Reads as | Actually is |
|---|---|---|
| `run_patcher.py` | *the* entry point | the **v1/v2** entry point. v3 runs from `run_patcher_v3.py`, and a v3 config passed here is refused |
| `verify.py` | the verifier agent | the **orchestrator's own gates**. No agent runs in it; it is the module written specifically so the agent is never believed |
| `integrator.py` vs `v3/merge_queue.py` | unrelated | the **v2 and v3 answers to the same question** — how two agents' edits are combined. `merge_queue` reuses `integrator`'s primitives |
| `state.py` vs `v3/run_store.py` | unrelated | the **v1/v2 and v3 checkpoint stores**. Same purpose, different granularity (per task vs per chunk) |
| `wave_plan.py` vs `plan/build_chunk_map.py` | duplicates | different questions. `wave_plan` schedules **one run** and moves when the bug list moves; the chunk map partitions the **application** and does not. They share one dependency source of truth |
| `antioracle.py` | something about the answer key | tests in the target corpus that **cannot survive a correct fix**. Nothing to do with the scoring oracles |
| `v3/` | the current version, others obsolete | the **current orchestrator**, sitting on top of v1 and v2 modules it imports directly |

---

## 9. Found while writing this: a v3 config does not fail against the v1 entry point

Recorded here rather than fixed, because this was a documentation pass. It is a
code change and needs its own review.

`config/subset5.run-config.json` states, in its own header comment:

> *"This is a v3 DISPATCH run and is driven by `src/run_patcher_v3.py`, not by
> `src/run_patcher.py`. `run_patcher.py` has no v3 execution mode and would
> refuse it."*

**It would not refuse it.** `run_patcher.py` contains no reference to
`chunk_map` at all, and its mode selection is
`mode = loop.get('execution', 'sequential')` against
`EXECUTION_MODES = ('sequential', 'waves')`. A v3 config declares no
`loop.execution` — deliberately, and its own comment says so — so the lookup
falls through to the default and the config validates cleanly as a **v1
sequential run**. The chunk map, the write boundaries and the bracket ordering
are all silently ignored.

The failure mode is the expensive one. Nothing errors, nothing warns, and the
run produces a well-formed `patcher-report.json`. The only trace that the wrong
architecture executed is the absence of chunk structure in a report nobody has
reason to check for it — and a v1 run on a v3 subset costs hours and tens of
dollars before the discrepancy could surface at scoring.

Two independent fixes, either sufficient, both cheap:

1. `run_patcher.py` refuses any config carrying `inputs.chunk_map`, naming
   `run_patcher_v3.py` in the error. Strict rather than permissive: an unknown
   key in a paid run's config is a reason to stop, not a reason to guess.
2. `preflight` requires `loop.execution` to be present and explicit, removing
   the silent default that makes the misroute look valid.

Until one lands, the guard is operator discipline, which the repository's own
rules are consistent about not trusting. The claim in the config comment should
be corrected in the same change; leaving it as-is is worse than silence,
because it tells the operator a check exists that does not.
