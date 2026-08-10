# Subset 4 — patcher run

Ten bugs, five files, four chunks, three phases, peak concurrency 2.

| Artefact | Path |
|---|---|
| Bug report | `tools/patcher/inputs/subset4/bug-report.json` (`bug-report-subset-04`) |
| Playbook | `tools/patcher/inputs/subset4/playbook.json` (`playbook-subset-04`, 7 entries) |
| Chunk map | `tools/patcher/plan/subsets/subset-04.chunk-map.json` |
| Run config | `tools/patcher/config/subset4.run-config.json` (`run_id` `patch-run-subset-04`) |
| Map test | `tools/patcher/tests/test_subset04_map.py` |
| Target tree | `target-apps/juice-shop-blind` @ `abed38f1647fa20cd0ffad3460ec0143cb8c6ca1` |

The bug report states that every entry is a confirmed defect at a verified
location and that it contains no false positives, so no agent time goes on
deciding whether an entry is real.

The playbook's 7 entries cover the 9 distinct classes the 10 bugs carry;
preflight confirms every bug matches an entry (it reports nothing running on
class guidance alone).

## The ten bugs, by bracket

Bug ids, files and classes only. Nothing here names a challenge, and no
challenge name exists anywhere in the subset-4 inputs.

### Bracket A — core (phase 0, chunk `A01`, 1 agent)

| Bug | File | Line | Class |
|---|---|---|---|
| BUG-010 | `lib/insecurity.ts` | 41 | Broken Authentication / Cryptographic Failure |
| BUG-011 | `lib/insecurity.ts` | 55 | Identification and Authentication Failures / JWT Algorithm Confusion |
| BUG-012 | `lib/insecurity.ts` | 55 | Identification and Authentication Failures / JWT Algorithm Confusion |
| BUG-013 | `lib/insecurity.ts` | 135 | Server-Side Request Forgery / Open Redirect |
| BUG-018 | `models/feedback.ts` | 51 | Insecure Design / Missing Input Validation |

`lib/insecurity.ts` and `models/feedback.ts` are **mutually reachable** in the
import graph: `models/feedback.ts` imports `lib/insecurity.ts`, and
`lib/insecurity.ts` reaches back to `models/feedback.ts` through
`models/user.ts`. A cycle cannot be ordered, so neither file can be declared
"after" the other and both must be owned by a single agent, patched in sequence.
`wave_plan.py` reaches the same conclusion independently and annotates the two
units `CYCLE`.

`models/user.ts` is part of that cycle but carries no subset-4 bug. It is
therefore named in the chunk's `reason` and **not** in its `files[]`: this map
lists only files that carry a confirmed vulnerability.

### Bracket B — models and data

No subset-4 bugs. The bracket is absent from this map entirely.

### Bracket C — handlers (phase 1, chunks `C09` and `C11`, 2 agents)

| Chunk | Bug | File | Line | Class |
|---|---|---|---|---|
| `C09` | BUG-062 | `routes/metrics.ts` | 86 | Security Misconfiguration / Information Exposure |
| `C11` | BUG-087 | `routes/updateUserProfile.ts` | 32 | Broken Access Control / CSRF |

Both are leaves — nothing in the subset imports them — and they share no file,
so they run concurrently. Both import `lib/insecurity.ts`, which is why they run
after bracket A rather than beside it.

`C09` and `C11` are the **full map's** ids for those two files. In the full map
each carries four tasks; here each carries one. The id is kept so a subset run
and a full run stay directly comparable.

### Bracket D — wiring (phase 2, chunk `D01`, 1 agent)

| Bug | File | Line | Class |
|---|---|---|---|
| BUG-091 | `server.ts` | 234 | Security Misconfiguration / Improper Input Handling |
| BUG-092 | `server.ts` | 235 | Security Misconfiguration / Sensitive File Exposure |
| BUG-098 | `server.ts` | 674 | Security Misconfiguration / Verbose Error Messages |

`server.ts` imports everything above it, so it is patched last and alone,
against a tree in which every earlier bracket has already landed.

## Phase sequence

| Phase | Bracket | Chunks | Concurrency | Barrier at the end |
|---|---|---|---|---|
| 0 | A | `A01` | 1 | merge + build gate |
| 1 | C | `C09`, `C11` | 2 | merge + build gate |
| 2 | D | `D01` | 1 | merge + build gate + full suite, once |

Peak concurrency is **2**, reached only in phase 1. Phases 0 and 2 hold one
chunk each and run a single agent whatever `task_concurrency` says.

`run_patcher.py` in `waves` mode does the merge and the gate itself, once per
wave: `integrator.integrate(...)` folds the chains back into the seed tree, then
`integrator.post_wave_gate(...)` measures the merged tree and re-runs each unit's
own gate to catch a fix that another chunk's merge broke. The full suite is the
end-of-run global net and runs **once**, after the last wave;
`run_patcher.py` deliberately skips it while waves remain, so a checkpointed
subset run cannot publish a partial tree as a finished one.

## Critical path

Two numbers, because the answer depends on how bugs are batched into tasks:

- **9 tasks, bug-wise.** One task per bug: `A01` runs its 5 sequentially (the
  cycle forbids splitting them across agents), then `C09` or `C11` contributes
  1 — they run in parallel, so only one of them is on the path — then `D01` runs
  its 3. 5 + 1 + 3 = 9.
- **4 tasks, file-batched.** Bugs sharing a file inside a chunk become one task:
  `A01` becomes 2 tasks (`lib/insecurity.ts`, then `models/feedback.ts` — still
  sequential, same agent), phase 1 contributes 1, `D01` becomes 1. 2 + 1 + 1 = 4.

**The config selects the 4-task path.** `loop.task_granularity` is `"file"`,
which is also the only granularity `run_patcher.py`'s preflight accepts in
`waves` mode: waves guarantee that no two agents hold the same file, and that
guarantee comes from grouping by file. Per-bug units would put two agents in
`lib/insecurity.ts` inside one wave.

Total work is 5 file-sized tasks (`grouping` reports `10 task(s), 5 file(s)`);
4 of the 5 are on the critical path, since only `C09`/`C11` overlap.

## Wall clock

**There is no measured wall-clock figure for this subset, and every number
below is extrapolated from configuration ceilings rather than observed.** No
subset-4 run has been executed; nothing in this repository records a measured
per-task duration for the patcher against this tree. Stating a point estimate
would be inventing one.

What the config *bounds*, and therefore the only defensible basis:

- `agent.timeout_s` 2400 — 40 min ceiling per agent invocation.
- `loop.max_task_wall_s` 5400 — 90 min ceiling per task, all rounds included.
- `loop.characterise_rounds` 2 + `loop.reconcile_rounds` 4 — up to 6 agent
  invocations per task.
- `commands.timeout_s.full_suite` 3600 — 1 h ceiling on the single end-of-run
  suite, plus `typecheck` 600 s and `test_file` 900 s per gate invocation.

Upper bound on the critical path, if every task ran to its ceiling:
4 × 90 min + 3 post-wave gates + 1 full suite. That is a ceiling, not a
forecast — a task that reaches green in round 1 costs a fraction of it. Treat
phase 0 of the first run as the measurement that replaces this section, and
record the observed `wall_s` per wave from `wave-run.json` here afterwards.

## Launching

Preflight first; it costs nothing and refuses the whole run rather than half of
it.

```bash
cd /home/user/Cybersecurity-Coding-Agent-Harness
python3 tools/patcher/src/run_patcher.py \
  --config tools/patcher/config/subset4.run-config.json --check
```

A run outlives the session that starts it, so each phase is launched detached
and its wave checkpointed. Make the log directory first — the run directory does
not exist until preflight passes.

```bash
mkdir -p /home/user/patcher-work/logs
```

**Phase 0 — bracket A, chunk `A01`, 1 agent.** No `--resume`: this call builds
the work tree and computes the wave plan.

```bash
setsid nohup python3 tools/patcher/src/run_patcher.py \
  --config tools/patcher/config/subset4.run-config.json \
  --waves 0 \
  > /home/user/patcher-work/logs/subset4-phase0.log 2>&1 &
```

**Phase 1 — bracket C, chunks `C09` and `C11`, 2 agents.**

```bash
setsid nohup python3 tools/patcher/src/run_patcher.py \
  --config tools/patcher/config/subset4.run-config.json \
  --resume patch-run-subset-04 --waves 1 \
  > /home/user/patcher-work/logs/subset4-phase1.log 2>&1 &
```

**Phase 2 — bracket D, chunk `D01`, 1 agent, then the full suite.**

```bash
setsid nohup python3 tools/patcher/src/run_patcher.py \
  --config tools/patcher/config/subset4.run-config.json \
  --resume patch-run-subset-04 --waves 2 \
  > /home/user/patcher-work/logs/subset4-phase2.log 2>&1 &
```

Each phase writes its checkpoint before the next starts, so an interruption
costs the wave that was running and never one already paid for. `run_patcher.py`
refuses to run a wave whose predecessors have not run: a later wave patches on
top of an earlier one, and running it first would characterise against a base
that does not exist yet.

Running all three in one go is `--waves 0-2` on the first (non-`--resume`) call,
or simply omitting `--waves`. Prefer one phase per session — the per-phase form
is what makes a lost session cost one phase.

Outputs land in `/home/user/patcher-work/runs/patch-run-subset-04/`
(`state.json`, `wave-plan.json`, `wave-run.json`, per-task records, transcripts,
`full-suite.json`, `patcher-report.json`). That directory is **outside the
repository** on purpose: per-task records pair a bug id with a file and a line,
which the publishing rule does not allow in a committed artefact.

## Preflight status as of 2026-08-10

The config validates. Everything preflight can check about the inputs, the
plan and the sandbox passes:

```
[11:01:46]   ok   bug report: 10 task(s), 5 file(s)
[11:01:46]   ok   playbook: 7 entry/entries
[11:01:46]   ok   sandbox hook: verified — denies out-of-tree access
[11:01:46]   ok   execution: waves, up to 2 chain(s) at a time
[11:01:46]   ok   post-wave gate: up to 2 unit gate(s) at a time
[11:01:46]   FAIL node_modules /home/user/patcher-work/node_modules does not exist. Install it once, outside the tree (`npm ci` against a committed lockfile), and point the config at it. The patcher may not run installs, and an unpinned tree makes every differential metric unattributable.
[11:01:46]   FAIL /home/user/Cybersecurity-Coding-Agent-Harness/target-apps/juice-shop-blind is not built: 6 file(s) the application requires at startup are missing (build/server.js, frontend/dist/frontend/index.html, frontend/dist/frontend/styles.css ...). The API suite boots the app, so every API gate would fail at load regardless of any patch. Point base_tree at a built tree, or build it.
[11:01:46] 2 problem(s). Nothing was run and nothing was spent.
```

Exit code 2. **Both failures are environmental, not configuration defects.**
This machine has no `/home/user/patcher-work/` at all and
`target-apps/juice-shop-blind` is an unbuilt checkout. Neither is something the
config can fix: the shared `node_modules` must be installed once with `npm ci`
against the committed lockfile, and the target tree must be built, before any
phase is launched. Re-run `--check` afterwards and expect a clean preflight.

## Guard rails carried in the map

- `read_denylist` — `models/challenge.ts`, `lib/antiCheat.ts`,
  `data/datacreator.ts`. A per-file plan hands an owned file's whole content to
  its agent, so one of these appearing in a chunk's `files[]` would be a
  blind-boundary breach. None does; `test_subset04_map.py` asserts it.
- `never_writable` — `test/**`, `**/*.spec.ts`. The tests are how the work is
  judged.
- `shared_extension_zone` — `views/**`, `config/**`, `swagger.yml`. Files more
  than one chunk may need to extend, outside the one-owner rule.
