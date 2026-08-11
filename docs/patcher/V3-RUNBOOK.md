# Running a subset under v3

How the v3 dispatcher actually executes a run, and what a driver must do to
start one. Companion to `ARCHITECTURE-V3.md`, which says *why* v3 is shaped this
way; this document says *what happens*, in execution order, with the code that
does it.

Blind-safe. No challenge identifier and no found/not-found status appears here.

**Status.** Every component named below exists and is unit-tested. What does not
exist is a **driver** — the ~100 lines that load the inputs, construct a
`Dispatcher`, call `run()` and write the result down. §8 specifies it exactly.
Until it exists, no v3 run can start; once it does, nothing else is missing.

---

## 1. The three layers

```
  OFFLINE          plan/subsets/subset-0N.chunk-map.json     checked in, no model
     |                                                        involved, reviewable
     v
  DISPATCHER       src/v3/dispatcher.py                      spawn, monitor, merge,
     |                                                        advance. Judges nothing.
     v
  CHUNK AGENT      one invocation per task, in its own tree  characterise, fix,
                                                              verify, reconcile, attest
```

The split is the whole of v3. v1 and v2 computed the plan at runtime and the
orchestrator ran the gates; v3 reads a checked-in plan and the *agent* runs the
gates inside its own turn budget. Everything in §7 that v3 cannot report follows
from that second move.

## 2. Vocabulary

| Term | What it is | Where |
|---|---|---|
| **bracket** | An ordering unit — `A` core, `B` frontend/contracts, `C` handlers/seed, `D` wiring. Brackets are scheduled into phases. | `chunk_map.Bracket` |
| **phase** | A set of brackets that may run at the same time. Phases are strictly ordered; a barrier sits at the end of each. | `chunk_map.phase_order()` |
| **chunk** | An **ownership** unit. One agent, one tree, one exclusive set of files, for the duration. | `chunk_map.Chunk` |
| **task** | **One bug.** Ordered within its chunk, run strictly in sequence. | `dispatcher.Assignment.tasks` |

A chunk is not a directory — it is the set of files one agent owns.
`files[]` lists only files that carry a bug.

## 3. The run, top down

### `Dispatcher.run(phases=None)` — `dispatcher.py:1112`

Walks `cmap.phase_order()` in order, calling `run_phase` on each. After the last
one — and **only** if every phase ran — it calls `_run_final_suite()`. Passing an
explicit `phases=` subset deliberately suppresses the suite, so a partial run
cannot publish itself as a finished one.

Returns one dict carrying `mode: 'v3-dispatch'`, every phase record, the
disposition histogram, the `disposition_basis` split, spend, wall time and the
trunk's `tree_digest`.

### `Dispatcher.run_phase(phase_no)` — `dispatcher.py:1007`

Four steps, in order:

1. **Snapshot the trunk** as the phase base (`workspace.snapshot`). This is the
   common ancestor every three-way merge in this phase uses.
2. **Run every chunk in the phase concurrently** —
   `ThreadPoolExecutor(max_workers=workers)` where
   `workers = max(1, min(cmap.concurrency_for_phase(phase_no), len(chunks)))`.
   A chunk that raises does **not** take the phase down: it is caught, its tasks
   are recorded `blocked` via `_unreached_record`, and it stays in the
   denominator.
3. **Drain one serial merge queue** over the phase's results, sorted by
   `chunk_id` for determinism. The barrier is per *phase*, not per bracket — two
   brackets in one phase are declared independent, so one queue gives one
   deterministic order over the whole phase.
4. **Apply merge verdicts** and discard the base snapshot.

### `Dispatcher.run_chunk(a)` — `dispatcher.py:655`

Seeds the chunk's own tree from the trunk, then runs its tasks **strictly in
sequence**. The docstring is explicit about why:

> *Parallelism in v3 exists only ACROSS chunks. Two tasks in one chunk may share
> a file — that is the normal case, since a chunk is a group of files and their
> bugs — so running them at once would reintroduce exactly the intra-file
> collision the ownership map exists to remove.*

Before each task it checks the cost ceiling and the chunk timeout; tripping
either records every remaining task as unreached and breaks, rather than
silently truncating. Afterwards it collects the boundary review, changed files
and declarations.

## 4. Where the parallelism is — and is not

| Level | Concurrent? |
|---|---|
| Phases | **No.** Strictly ordered, barrier between. |
| Chunks within a phase | **Yes.** Up to `concurrency_for_phase`. |
| Tasks within a chunk | **No.** Strictly sequential, one tree, one agent. |
| Merges | **No.** One serial queue per phase. |

`concurrency_for_phase` (`chunk_map.py:197`) takes the phase's own `concurrency`
if it declares one, else the widest bracket in it — *"a phase-level cap is the
box's limit; a bracket's is the planner's view of how much of that bracket may
safely run at once."*

**Consequence worth internalising: peak concurrency is bounded by the number of
chunks in the widest phase, never by the number of bugs.** A subset whose bugs
concentrate in few files cannot be made parallel by asking for more workers.

## 5. Trees and snapshots

| Tree | What | Lifetime |
|---|---|---|
| **trunk** | The run's integration tree. Every accepted merge lands here. | whole run |
| **chunk tree** | `trees_root/<chunk_id>`, seeded from trunk at chunk start. The agent's cwd. | one chunk |
| **phase base snapshot** | Trunk as it was before the phase. The merge ancestor. | one phase |
| **task snapshot** | Chunk tree before this task. | one task |

The task snapshot does two jobs: `diff_stats` describes *this* bug rather than
everything the chunk has done, and a failed invocation's half-edit can be taken
back out of the tree the next task inherits.

## 6. The agent loop inside one task — `_run_task`, `dispatcher.py:709`

Same steps as `ARCHITECTURE.md`, same order. What changed is that the middle
three happen inside **one** invocation instead of three.

### 6.1 Characterise

Skipped when an earlier task in this chunk already characterised this file and
`reuse_characterisation` is on. Otherwise one invocation, **source read-only**,
producing `workflow.test.ts`, `exploit.probe.ts` and `characterisation.json` in
the task's scratch directory.

**The reuse rule, and it matters more than it looks.** `reused_from` is set from
the file's earlier characterisation:

```python
reused_from = characterised.get(rel_file) if self.reuse_characterisation else None
task_id     = task_id_for(a.chunk_id, reused_from or bug_id)
```

Two consequences follow, both deliberate:

- A reused oracle was authored for a *different* defect in the same file, so its
  `PROVEN` says nothing about this one. `probe_proven_pre_fix` is forced to
  `False` with a note naming the origin bug (`dispatcher.py:761-765`).
- Because the probe cannot demonstrate *this* defect, a successful fix on a
  reused characterisation lands as **`fixed_workflow_only`**, never `fixed`.

**And a third that is not deliberate:** reused tasks share a `task_id`, hence a
scratch directory (necessary — that is where the reused artefacts live) *and* a
patch-log path `logs/{task_id}-patch.json` (not necessary). Later transcripts
overwrite earlier ones, and `attestation.json` is read from that shared
directory — so a fix invocation that returns without writing one can be graded
against the **previous** task's attestation. See §10.

### 6.2 The regression net

Resolved *before* the patch prompt is built, by `testmap.select(tree, [rel_file],
char.related_test_files)` — the agent's named files unioned with a static scan.

> *v3 runs no per-task net of its own, so what goes into this prompt is the only
> per-task check for collateral damage that exists.*

This is the mechanism `RUN-HISTORY.md` names as the common cause of both subset-4
failure modes, and its open item 1 ("vet the patcher's regression net") is still
open.

### 6.3 Fix

One invocation, source writable within the boundary, gate artefacts and `test/`
frozen. The agent runs V1–V4 itself and loops internally up to
`loop.reconcile_rounds` (default 4). The orchestrator watches liveness and the
diff, nothing else.

### 6.4 Disposition — `_post_fix_disposition`, `dispatcher.py:910`

| Disposition | Reached when | Basis |
|---|---|---|
| `agent_failed` | invocation didn't return, or wrote no parseable attestation | **measured** |
| `abandoned` | attested `fixed` but changed nothing; or reported `not_fixed` and changed nothing; or its chunk was rejected at the merge queue | **measured** |
| `fixed` | attested fixed **and** its own probe demonstrated the defect pre-fix | attested |
| `fixed_workflow_only` | attested fixed but the probe never proved the defect — including every reused-oracle task | attested |
| `fixed_workflow_red` | as `fixed`, but `attestation.json → workflow_red` lists workflow assertions the agent left failing. Reporting only: no gate, no revert, no adjudication of its anti-oracle claims | attested |
| `partial` | reported `not_fixed`, work retained | attested |
| `already_remediated` | probe won't fire **and** an earlier task in this chunk already changed this `file:line` **and** `reused_from is None` | attested |
| `blocked` | no characterisation after retries, or the chunk stopped before this task | measured |

`fixed`, `fixed_workflow_only` and `fixed_workflow_red` are **counted in separate
buckets and never summed**, at task, chunk, phase and run level.

`attestation_delta` records the agent's claim against what the dispatcher could
see — `overclaim` when it said fixed and the disposition disagrees — and is
**recorded, never used to alter the disposition**. `fixed_workflow_red` is not an
overclaim: it is derived from the agent's own report, so nothing contradicted the
claim and no delta is written.

**Note the interaction that decides subset 5's numbers:** `already_remediated`
requires `reused_from is None`. With reuse on, the second and later bugs in a
file always have a non-`None` `reused_from`, so that branch is unreachable and
they land in `fixed_workflow_only` instead. Reuse and `already_remediated` are
mutually exclusive by construction.

## 7. The merge queue — `src/v3/merge_queue.py`

One queue per phase, built on that phase's base snapshot. For each submission in
`chunk_id` order:

1. Capture the trunk state of the files this chunk changed.
2. **Three-way merge** each file against the phase base. Conflict markers ⇒
   rejected.
3. Run the **build gate** on the merged trunk.
4. If the gate fails, **roll back byte for byte** and mark rejected.

Submissions whose boundary review sets `merge_last` (a write into the shared
extension zone) are ordered last.

**The build gate already exists** — `merge_queue.typecheck_gate(cfg)`
(`merge_queue.py:83`) returns a real gate running the target's own typecheck. It
is *not* the default: `Dispatcher.__init__` falls back to
`merge_queue.always_ok`, whose docstring reads *"No build gate. For a dry run."*
**A driver that does not pass `build_gate=` merges every chunk without ever
compiling it.**

A rejected chunk's tasks are re-disposed `abandoned` with basis **measured** —
the queue observed the rollback — and their pre-merge disposition is preserved
in `disposition_before_merge`.

## 8. Running any subset under v3 — the driver contract

Everything below exists. The driver is the wiring.

### 8.1 Inputs

| Input | Loader |
|---|---|
| Bug report | `blind_guard.load_bug_report(path)` — refuses a report carrying withheld keys |
| Playbook | `blind_guard.load_playbook(path)` |
| Chunk map | `v3.chunk_map.load(path)` → `validate(cmap)` → `validate_against_report(cmap, bugs)` |
| Config | `run_patcher.load_config(path)` |

### 8.2 The sequence

```python
cfg      = load_config(args.config)
report,_ = blind_guard.load_bug_report(cfg['inputs']['bug_report'])
playbook,_ = blind_guard.load_playbook(cfg['inputs']['playbook'])

cmap = chunk_map.load(cfg['inputs']['chunk_map'])
chunk_map.validate(cmap)
chunk_map.validate_against_report(cmap, report['bugs'])   # every bug assigned or excluded

workspace.prepare(cfg['target']['base_tree'], cfg['target']['work_tree'],
                  cfg['target'].get('node_modules'), force=args.force)

runner = agent.build_runner(cfg, os.path.join(run_dir, 'sandbox'), runner_kind)

d = v3.Dispatcher(
    cmap, bugs=report['bugs'], playbook=playbook, runner=runner,
    trunk=cfg['target']['work_tree'], run_dir=run_dir, cfg=cfg,
    build_gate=merge_queue.typecheck_gate(cfg),          # NOT optional
    reuse_characterisation=<decide, see §9.3>,
)
result = d.run()
```

`chunk_timeout_s` and `cost_ceiling_usd` need no argument — the constructor
reads them from `cfg['loop']` (`dispatcher.py:613-617`). `reuse_characterisation`
is **constructor-only and cannot be set from a config file**; a driver that wants
it off must pass it.

### 8.3 What the driver must do that the Dispatcher does not

`Dispatcher` writes only the per-chunk guard logs and the runner's transcripts.
Everything else lives in the returned dict. The driver therefore **must**:

1. **Persist task records after every chunk**, not at the end. A ~3 h run that
   loses its session otherwise loses everything — the failure that already cost
   subset 2 its entire record.
2. **Concatenate the per-chunk guard logs** (`run_dir/guard/*.jsonl`) before
   calling `blind_guard.audit_run`, which takes a single path. An unconcatenated
   audit reads absent chunks as clean-because-empty.
3. **Write `patcher-report.json`** into the run dir — `archive_run.py` expects it
   and nothing on the v3 path produces it.
4. **Run `blind_guard.audit_run`** and record the verdict.

### 8.4 Preflight

`run_patcher.preflight` is v2-shaped: `EXECUTION_MODES = ('sequential', 'waves')`
and it hard-couples `waves` to `task_granularity: file`. A v3 config cannot pass
it as written. Either give the v3 driver its own preflight reusing the input,
tree and toolchain checks, or add a mode — but note `ARCHITECTURE-V3.md:513`
deliberately keeps v3 out of `run_patcher.py`, which the change-safety rule
protects.

Reusable as-is: the bug-report/playbook load, the base-tree and `node_modules`
checks, and the built-artefacts check (`build/server.js`,
`frontend/dist/frontend/index.html`) — that last one cost a full 2-task run once.

### 8.5 After the run

Invoke the **`archive-patch-run`** skill, never `archive-run`. Aggregate goes to
`results/eval-history/patcher.jsonl`; located detail goes to the private store.

## 9. Subset 5 — the run plan

### 9.1 Inputs

| Artefact | Path |
|---|---|
| Bug report | `tools/patcher/inputs/subset5/bug-report.json` (10 bugs) |
| Playbook | `tools/patcher/inputs/subset5/playbook.json` (3 entries) |
| Chunk map | `tools/patcher/plan/subsets/subset-05.chunk-map.json` |
| Map test | `tools/patcher/tests/test_subset05_map.py` (34 pass, 1 skip) |

### 9.2 Execution shape

| Phase | Bracket | Chunk | File | Tasks | Workers |
|---|---|---|---|---|---|
| 0 | C | `C01` | `routes/fileServer.ts` | 5 | 2 |
| 0 | C | `C02` | `routes/metrics.ts` | 1 | |
| 1 | D | `D01` | `server.ts` | 4 | 1 |

Peak concurrency **2**, reached only in phase 0. `C01` and `C02` run at the same
time in separate trees; `C01`'s five tasks run one after another inside one.

**Critical path: 5 tasks + 4 tasks = 9.** `C02`'s single task is fully hidden
behind `C01`. Adding workers changes nothing — phase 0 has two chunks and phase 1
has one.

Two merge barriers, each a three-way merge plus a typecheck. `D01` is patched
last and alone, against a trunk where phase 0 has already landed.

### 9.3 The one decision that changes what this run measures

All five `C01` bugs sit at `routes/fileServer.ts:27` and are **one underlying
defect**. How v3 handles that is decided entirely by `reuse_characterisation`:

| | `True` (default) | `False` |
|---|---|---|
| Characterisations paid | 3 | 10 |
| `already_remediated` | **0** — unreachable, `reused_from` is non-`None` | fires for bugs 2-5 of `C01` |
| Likely `C01` outcome | 1 `fixed` + 4 `fixed_workflow_only` | 1 `fixed` + 4 `already_remediated` |
| Shared scratch/log collision | yes (§6.1) | no |
| Cost | lower | +7 characterisation invocations |

**Recommendation: `reuse_characterisation=False`.** The premise of subset 5 is
that five ground-truth entries are one defect. `already_remediated` is the
disposition that *says* that; `fixed_workflow_only` says something different and
weaker ("the remediation axis is unverified"). Under the default, the property
the subset exists to test is the property that cannot be observed — and the
shared-`task_id` collision is live. The extra characterisations are the price of
an interpretable result.

### 9.4 Cost and wall clock

`ARCHITECTURE-V3.md:437` forbids quoting a figure: *"Nobody has measured this. Do
not quote a number for it until a v3 run and a v2 run have been scored with the
same scorer on the same denominator."* Treat the following as shape, not
estimate.

The only anchor is subset 4: **$41.61 over 15 invocations, 2 h 29 m**, under v2
waves. Subset 5 under v3 with reuse off is 10 characterise + 10 fix = 20
invocations, and a v3 fix invocation carries the whole internal reconcile loop,
so it is dearer than a v2 round. Set `loop.cost_ceiling_usd` and
`loop.chunk_timeout_s` in the config and let the ceiling be the answer.

### 9.5 What this run can and cannot establish

**Can:** that the v3 plumbing survives a real model — chunk-tree seeding, the
write boundary, the serial merge queue's three-way merge and byte-for-byte
rollback, phase advance, crash containment. That the seed read-denylist fires
against a live agent. Declared-vs-undeclared out-of-boundary write rates, which
v2 cannot measure. Real cost of the v3 shape.

**Cannot:** produce a number comparable with subset 4's NEFR 0.50. Four
independent reasons, any one sufficient — the bug report contract changed under
`28695a4` and `RUN-HISTORY.md` says no later run is comparable; different subset
and ground truth; v2 dispositions were measured while v3's are attested; and
dependencies are unpinned. It also cannot say much about parallelism: peak
concurrency 2 is what subset 4 already achieved.

**And note the resolution limit.** Five of the ten bugs close or fail together,
so NEFR moves in steps of 0.5. The metric has resolution 2 on this subset, not
10.

## 10. Known defects to weigh before spending

1. **`build_gate` defaults to `always_ok`.** Pass `typecheck_gate(cfg)` or every
   chunk merges uncompiled.
2. **No persistence in `Dispatcher`.** The driver must checkpoint per chunk.
3. **Shared `task_id` on reused characterisations** — one patch-log path for all
   reused tasks (later overwrite earlier) and one `attestation.json` path, so a
   fix invocation that writes none can be graded against the previous task's.
   Avoided entirely by `reuse_characterisation=False`.
4. **No antioracle handling in v3** — `grep antioracle src/v3/` is empty.
   `src/antioracle.py` is v1/v2 only. The measured precedent is an
   attack-dependent test reverting a correct fix.
5. **No per-task regression net.** Damage surfaces at the final suite, where
   attribution costs a bisect.
6. **`task-record.schema.json` rejects v3 records** — `additionalProperties:
   false`, and it knows none of `disposition_basis`, `chunk_id`,
   `merge_verdict`. Nothing validates at runtime today, so this bites at
   archive time rather than run time.
7. **`report.py` cannot see `disposition_basis`.** It would print v3's attested
   greens in the same column as subset 4's measured ones, read
   `probe_proven_pre_fix: null` as falsey and report `probe_coverage 0.0`, and
   emit `rounds_to_green {never: N}`. Fix the reporter before archiving, or the
   row reads as a catastrophic regression on metrics that simply do not exist
   for v3.
8. **No resume.** `run(phases=[n])` is the only checkpoint, and it re-seeds trees
   from trunk each time.

Items 1, 2 and 7 are the ones that turn a paid run into an uninterpretable one.
