# Running a subset under v3

How the v3 dispatcher actually executes a run, and what a driver must do to
start one. Companion to `ARCHITECTURE-V3.md`, which says *why* v3 is shaped this
way; this document says *what happens*, in execution order, with the code that
does it.

Blind-safe. No challenge identifier and no found/not-found status appears here.

**Status.** Every component named below exists and is unit-tested, the driver
included: `src/run_patcher_v3.py` loads the inputs, validates the map, constructs
a `Dispatcher` with a real build gate and a durable `RunStore`, calls `run()`,
audits the guard logs and writes `patcher-report.json`. §8 is the contract it
satisfies, kept because it is what a second driver would have to satisfy too.

---

## 1. The three layers

```
  OFFLINE          plan/subsets/subset-0N.chunk-map.json     checked in, no model
     |                                                        involved, reviewable
     v
  DISPATCHER       src/v3/dispatcher.py                      spawn, monitor, merge,
     |                                                        advance; drive the fix
     |                                                        loop's round boundary
     |                                                        and measure V1-V4 there.
     |                                                        Decides no fix.
     v
  CHUNK AGENT      characterise, then 1..N fix/reconcile     writes the oracle, writes
                   invocations in its own tree                the patch, self-checks,
                                                              attests
```

The split is the whole of v3: v1 and v2 computed the plan at runtime, v3 reads a
checked-in one. The gates did not move with it — since 2026-08 the fix phase runs
through `task_loop.run_fix_loop`, so the orchestrator invokes the agent, measures
V1–V4 against the tree it left, hands the failure back, and stops on green, the
round budget or the wall clock. The agent also runs those commands inside its own
turn; that is its self-check, not this gate.

**Runs before that date did not have the loop wired up** — it was prompt text
with nothing driving it, so `rounds_used` was the agent's own number and every
fix-phase disposition was recorded `attested`. That was an under-implementation
of v3's architecture, not a different architecture. Do not read a pre-2026-08 v3
row and a later one as one trend.

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

### `Dispatcher.run(phases=None)` — `dispatcher.py:1773`

Walks `cmap.phase_order()` in order, calling `run_phase` on each. After the last
one — and **only** if every phase ran — it calls `_run_final_suite()`. Passing an
explicit `phases=` subset deliberately suppresses the suite, so a partial run
cannot publish itself as a finished one.

Returns one dict carrying `mode: 'v3-dispatch'`, every phase record, the
disposition histogram, the `disposition_basis` split, spend, wall time and the
trunk's `tree_digest`.

### `Dispatcher.run_phase(phase_no)` — `dispatcher.py:1610`

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

### `Dispatcher.run_chunk(a)` — `dispatcher.py:972`

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

## 6. The loop inside one task — `_run_task`

Same steps as `ARCHITECTURE.md`, same order, same driver: characterise, then
`task_loop.run_fix_loop` for fix / verify / reconcile, then the disposition. What
is v3-specific is the surroundings — the chunk's tree, its write boundary, and
characterisation reuse.

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
  `False` with a note naming the origin bug (`dispatcher.py:1120-1124`).
- Because the probe cannot demonstrate *this* defect, a successful fix on a
  reused characterisation lands as **`fixed_workflow_only`**, never `fixed`.

**And a third that is not deliberate:** reused tasks share a `task_id`, hence a
scratch directory — necessary, that is where the reused artefacts live. The fix
loop's transcripts no longer collide with it (they go to
`logs/{chunk_id}-{bug_id}/{fix,reconcile}-N.json`, one directory per bug), but
`attestation.json` still lives in that shared scratch, so a fix invocation that
returns without writing one can be read against the **previous** task's
attestation. See §10.

### 6.2 The regression net

Resolved *before* the patch prompt is built, by `testmap.select(tree, [rel_file],
char.related_test_files)` — the agent's named files unioned with a static scan.

These files are used twice: they go into the fix prompt as commands the agent can
run itself, and they are **V4** at every round boundary against the baseline
`_baseline` captured before the fix. Handing them to the agent as well is not
redundant — a round it pre-checks itself is a round it does not have to spend,
and a reconcile round costs a whole fresh invocation.

This is the mechanism `RUN-HISTORY.md` names as the common cause of both subset-4
failure modes, and its open item 1 ("vet the patcher's regression net") is still
open: a net that selects the wrong files is now wrong in the gate as well as in
the prompt.

### 6.3 Fix — the measured loop

`task_loop.run_fix_loop`, the same function v1 uses. Source writable within the
boundary, gate artefacts and `test/` frozen (sandbox phase `fix` on round 0,
`reconcile` after — both freeze the oracle).

Per round: invoke the agent, run V1–V4 against the tree it left, record the
gates, and either stop or hand the structured failure back in the next prompt.
Three exits and only three: **measured green**, the **round budget**
(`loop.reconcile_rounds` reconciles = `reconcile_rounds + 1` total rounds), the
**wall clock** (`loop.max_task_wall_s`, default 5400). An anti-oracle claim in
the attestation is not an exit; it is recorded and acted on by nothing.

Before the loop, the orchestrator runs a **baseline sweep** over the task's
regression net and its workflow test, against the untouched tree. Without it
every already-red row in the net is charged to this task. The workflow verdict
lands in `measured.characterisation.workflow_green_pre_fix`; the failing rows in
`baseline_failures`.

After the loop, the **best round's tree is restored** (`_score`: preservation
outranks remediation) and its snapshot discarded. `measured.final_gates`
describes that round, because it is the tree that will be submitted.

**Cost.** One gate suite per round per task, where v3 previously ran none. A task
that spends its whole budget pays for `reconcile_rounds + 1` of them on top of
its agent time. Re-check `loop.chunk_timeout_s` before a run: a timeout sized for
an ungated fix phase will now stop chunks between tasks.

### 6.4 Disposition — `_post_fix_disposition`

Read off `run_fix_loop`'s label, which is read off the gates on the round whose
tree was kept. Checked first, in this order: `agent_failed`, then "changed
nothing", then the label.

| Disposition | Reached when | Basis |
|---|---|---|
| `agent_failed` | no invocation returned successfully, or none wrote a parseable attestation. Outranks the gates — a green measurement with no attestation is still `agent_failed`, and the reason records the gates being discarded | **measured** |
| `abandoned` | the task changed no source file, whatever the label said; or its chunk was rejected at the merge queue | **measured** |
| `fixed` | label `green`: probe blocked, build + workflow + net clean | **measured** |
| `fixed_workflow_only` | label `workflow_only`: everything clean, but V3 was skipped because the probe never proved the defect pre-fix — including every reused-oracle task | **measured** (over one attested input: the pre-fix probe verdict) |
| `fixed_workflow_red` | label `vuln_only`: probe blocked, workflow or net still red when the budget ran out. Reporting only: no revert, no adjudication of the agent's anti-oracle claims | **measured** |
| `partial` | label `neither`: both axes red after every round, work on disk. Kept — a chunk is submitted whole | **measured** |
| `already_remediated` | probe won't fire **and** an earlier task in this chunk already changed this `file:line` **and** `reused_from is None`. No fix phase is spent | attested |
| `blocked` | no characterisation after retries, or the chunk stopped before this task | measured |

`fixed`, `fixed_workflow_only` and `fixed_workflow_red` are **counted in separate
buckets and never summed**, at task, chunk, phase and run level.

`attestation_delta` records the agent's claim against the measurement —
`overclaim` when it said fixed and the disposition disagrees, `underclaim` when
it said `not_fixed` over green gates — and is **recorded, never used to alter the
disposition**. `fixed_workflow_red` is not counted an overclaim: the measurement
agrees the path is closed, and the disagreement is about a gate the disposition
already names.

`attested.rounds_used` is kept beside `measured.rounds_used`. The first is what
the agent typed; the second is what this process ran. A gap between them is a
finding about the agent, not about the patch.

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

The driver is `src/run_patcher_v3.py`. It is a separate entry point on purpose:
wiring v3 into `run_patcher.py` means editing the file that runs v1 and v2, and
both are load-bearing. Everything below is what it does; it is written as a
contract rather than a description because a second driver would have to satisfy
the same list.

```bash
python3 tools/patcher/src/run_patcher_v3.py --config <cfg> --check   # spends nothing
setsid nohup python3 tools/patcher/src/run_patcher_v3.py --config <cfg> > run.log 2>&1 &
python3 tools/patcher/src/run_patcher_v3.py --config <cfg> --resume  # after a death
```

### 8.1 Inputs

| Input | Loader |
|---|---|
| Bug report | `blind_guard.load_bug_report(path)` — refuses a report carrying withheld keys |
| Playbook | `blind_guard.load_playbook(path)` |
| Chunk map | `v3.chunk_map.load(path)` → `validate(cmap)` → `validate_against_report(cmap, bugs)` |
| Config | `run_patcher_v3.load_config(path)` — `run_patcher.load_config` plus resolving `inputs.chunk_map`, which has no v1/v2 counterpart and would otherwise resolve against the caller's cwd |

### 8.2 The sequence

`run_patcher_v3.main()`, in order:

```python
cfg = load_config(args.config)
problems, notes, report, playbook, cmap = preflight(cfg, runner_kind)   # §8.4
# --check exits here, having spent nothing

store = RunStore.load(run_dir) if args.resume else RunStore(run_dir, meta={...})
if not args.resume:
    workspace.prepare(cfg['target']['base_tree'], trunk,
                      cfg['target'].get('node_modules'), force=args.force)
store.begin()

runner = agent.build_runner(cfg, os.path.join(run_dir, 'sandbox'), runner_kind)
reuse  = bool(cfg['loop'].get('reuse_characterisation', True))   # --no-reuse-characterisation overrides

d = v3.Dispatcher(
    cmap, bugs=report['bugs'], playbook=playbook, runner=runner,
    trunk=trunk, run_dir=run_dir, cfg=cfg, store=store,
    build_gate=merge_queue.typecheck_gate(cfg),          # NOT optional
    reuse_characterisation=reuse,
)
result = d.run(phases=phases)

audit = blind_guard.audit_run(store.merge_guard_logs(), scrub_reports, ...)
store.write_report(report_mod...)                        # patcher-report.json
```

`chunk_timeout_s` and `cost_ceiling_usd` need no argument — the constructor
reads them from `cfg['loop']` (`dispatcher.py:923-928`). `reuse_characterisation`
is constructor-only on `Dispatcher`, but the driver reads it from
`loop.reuse_characterisation` (`run_patcher_v3.py:265`), so a config can set it;
`--no-reuse-characterisation` overrides the config downward and says so in the
log. Preflight notes when the key is unset, because the default is `True` and
that makes `already_remediated` unreachable.

### 8.3 What the driver does that the Dispatcher does not

`Dispatcher` writes only the per-chunk guard logs and the runner's transcripts.
Everything else lives in the returned dict, so a driver **must** do all four of
these; `run_patcher_v3.py` does:

1. **Persist task records after every chunk**, not at the end. A ~3 h run that
   loses its session otherwise loses everything — the failure that already cost
   subset 2 its entire record. Done by passing `store=RunStore(run_dir, …)`: every
   task is streamed as it ends and every phase is written before the next starts,
   and `--resume` picks up at the first phase that never completed. A resume
   re-checks `workspace.tree_digest(trunk)` against the recorded digest and
   **refuses** rather than continuing against a drifted tree.
2. **Concatenate the per-chunk guard logs** (`run_dir/guard/*.jsonl`) before
   calling `blind_guard.audit_run`, which takes a single path. An unconcatenated
   audit reads absent chunks as clean-because-empty. `store.merge_guard_logs()`.
3. **Write `patcher-report.json`** into the run dir — `archive_run.py` expects it
   and nothing inside `Dispatcher` produces it. `store.write_report()`.
4. **Run `blind_guard.audit_run`** and record the verdict — re-loading both
   inputs to recover their `ScrubReport`s, because the default `scrub_reports=()`
   makes the audit's `input_scrub` block assert clean unconditionally.

### 8.4 Preflight

`run_patcher.preflight` is v2-shaped: `EXECUTION_MODES = ('sequential', 'waves')`
and it hard-couples `waves` to `task_granularity: file`. A v3 config cannot pass
it as written, and `ARCHITECTURE-V3.md` §8 deliberately keeps v3 out of
`run_patcher.py`, which the change-safety rule protects. So
`run_patcher_v3.preflight` calls it, **drops the two `loop.execution` /
`loop.task_granularity` problems that do not apply to v3**, and adds v3's own:
the chunk map loads and validates, it covers every bug in the report, it assigns
no read-denylisted file, `commands.typecheck` exists (without it the merge queue's
build gate cannot run), and notes for an unset cost ceiling, chunk timeout or
`reuse_characterisation`.

Reused as-is from `run_patcher.preflight`: the bug-report/playbook load, the
base-tree and `node_modules` checks, and the built-artefacts check
(`build/server.js`, `frontend/dist/frontend/index.html`) — that last one cost a
full 2-task run once.

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

`ARCHITECTURE-V3.md` §6.1 forbids quoting a figure: *"Nobody has measured this. Do
not quote a number for it until a v3 run and a v2 run have been scored with the
same scorer on the same denominator."* Treat the following as shape, not
estimate.

The only anchor is subset 4: **$41.61 over 15 invocations, 2 h 29 m**, under v2
waves. Subset 5 under v3 with reuse off is 10 characterise invocations plus **one
fix invocation per round** — between 10 and `10 × (reconcile_rounds + 1)` = 50,
not the flat 10 an unenforced fix phase would have spent. The floor is the same 20
invocations as before; the ceiling is five times that, and where a run lands
inside it is exactly what `rounds_to_green` will report for the first time.

**Wall clock has a second term that did not exist before.** Each round also costs
a gate suite — typecheck, workflow test, probe, and the regression net — run by
the orchestrator against the tree. Subset 4's gates were 79 s across the whole
run because they ran once per unit; here they run once per round per task. Set
`loop.cost_ceiling_usd` and `loop.chunk_timeout_s` in the config, **re-checking
`chunk_timeout_s` against the round budget rather than against a prior run** —
the current value was sized when the fix phase spent one invocation and ran no
gates — and let the ceiling be the answer.

### 9.5 What this run can and cannot establish

**Can:** that the v3 plumbing survives a real model — chunk-tree seeding, the
write boundary, the serial merge queue's three-way merge and byte-for-byte
rollback, phase advance, crash containment. That the seed read-denylist fires
against a live agent. Declared-vs-undeclared out-of-boundary write rates, which
v2 cannot measure. Real cost of the v3 shape.

**Cannot:** produce a number comparable with subset 4's NEFR 0.50. Four
independent reasons, any one sufficient — the bug report contract changed under
`28695a4` and `RUN-HISTORY.md` says no later run is comparable; different subset
and ground truth; and dependencies are unpinned. (The fourth reason used to be
that v3's dispositions were attested and v2's measured. Since the fix loop is
wired up that one is gone — but it applies in full to the three v3 runs made
before it, whose rows must not be read across this line.) It also cannot say much about parallelism: peak
concurrency 2 is what subset 4 already achieved.

**And note the resolution limit.** Five of the ten bugs close or fail together,
so NEFR moves in steps of 0.5. The metric has resolution 2 on this subset, not
10.

## 10. Known defects to weigh before spending

1. **`build_gate` defaults to `always_ok`.** Pass `typecheck_gate(cfg)` or every
   chunk merges uncompiled. `run_patcher_v3.py` passes it; a second driver must.
2. **`chunk_timeout_s` was sized for an ungated fix phase.** The gate suite now
   runs once per round per task, so wall time per task rises by that much and a
   timeout carried over from an earlier config will stop chunks between tasks
   that would otherwise have finished. Re-check it against the round budget
   before every run — §9.4.
3. **Shared `task_id` on reused characterisations** — one `attestation.json`
   path for every task that reuses one oracle, so a fix invocation that writes
   none can be read against the previous task's. (The log collision is gone: the
   fix loop writes to `logs/{chunk_id}-{bug_id}/`.) Avoided entirely by
   `reuse_characterisation=False`.
4. ~~**No antioracle handling in v3**~~ — wired 2026-08. `antioracle.detect` runs
   over the task's net before the fix loop, exactly as v1 does it, and the result
   is passed to `run_fix_loop`; `measured.characterisation.antioracle_tests` and
   `antioracle_detector_available` record what it found. This is *the* excusal
   path, not a second one — `verify` excuses a net row through
   `antioracle.filter_regressions` or not at all, from the test files' own text,
   which are already in the work tree and already readable by the agent. The
   second excusal path this design refuses is the **agent's attestation**, and
   that refusal lives in `run_fix_loop`'s exit conditions regardless.
   **Still open, and it is the residue that matters:** the detector recognises a
   test carrying an attack payload in its own text. The rows that killed a
   correct fix on the subset-4 run carried none — they request an ordinary-looking
   URL — so no text classifier can see them. Such a row still goes red, the label
   is `vuln_only`, the task is `fixed_workflow_red`, and with the gates measured
   every round the loop cannot reach green over it and spends its whole budget
   first. Read that bucket; never sum it away.
5. **No per-task regression net *at the chunk barrier*.** The per-task net now
   runs every round inside the fix loop (V4); what is still absent is v2's
   post-wave re-measurement, so a sibling reopening another chunk's fix surfaces
   only at the final suite, where attribution costs a bisect.
6. ~~**`task-record.schema.json` rejects v3 records**~~ — fixed 2026-08: the
   contract now names `disposition_basis`, `chunk_id`, `merge_verdict`,
   `attested_characterisation` and the measured round fields. Nothing validates
   at runtime, so `test_v3_measured_fix.py` asserts the record's keys against the
   contract instead.
7. **`report.py` cannot see `disposition_basis`.** Less severe than it was — the
   fix phase is measured, so `rounds_to_green` and the per-round table are
   populated and `probe_coverage` is the only metric still reading a v3 null as
   falsey (`probe_proven_pre_fix` stays attested). Check the rendered summary
   before archiving.
8. **Resume is per phase, not per chunk.** `--resume` restarts at the first phase
   that never completed, so a death partway through a phase re-pays for every
   chunk in it. Task and chunk records are streamed as they complete, so nothing
   is *lost*; what is lost is the money already spent on that phase's chunks.

Items 1, 2 and 7 are the ones that turn a paid run into an uninterpretable one.
