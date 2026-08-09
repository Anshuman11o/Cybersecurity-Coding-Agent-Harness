# `tools/patcher/` — the remediation agent architecture

A task-wise agent loop that fixes every vulnerability in a bug report without
destroying the application, enforced by a real `while` loop in the orchestrator
rather than by asking a model to be disciplined.

**This directory is blind-safe.** Nothing here — code, prompt, schema or fixture
— contains a challenge identifier, a reference fix, an oracle test title, or any
pairing of a vulnerability with its known-correct remediation. That is the whole
point: the agent has to earn the fix.

> New architecture, built from scratch. It does not read, import, or extend the
> earlier bake-off arm runner. Nothing under `patcher-ground-truth/harness/` in
> the answer-key repo is a dependency of this code.

---

## 1. The shape of it in one picture

```
INPUTS (all three are blind-safe, validated before dispatch)
  ├── bug report ........ exact file + line + OWASP class, 100% precise, no false positives
  ├── target tree ....... the app, and nothing else on the machine is reachable
  └── playbook .......... OWASP remediation guidance, per vulnerability class
                                     │
                                     v
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  OUTER LOOP   run_patcher.py                                             │
  │  while pending_tasks:  (one task per bug; 97 bugs == 97 tasks)           │
  │                                                                          │
  │    snapshot tree ──────────────────────────────► revert point            │
  │                                                                          │
  │    ┌────────────────────────────────────────────────────────────────┐    │
  │    │  INNER LOOP   task_loop.py     ── fresh agent context per phase │    │
  │    │                                                                 │    │
  │    │  ①  CHARACTERISE  (source is read-only, enforced)               │    │
  │    │        author a workflow test for this exact code path          │    │
  │    │        author an exploit probe for this exact defect            │    │
  │    │        runner executes both on the UNTOUCHED tree and records:  │    │
  │    │            workflow  must be GREEN   ← this is the "ground      │    │
  │    │            probe     must be PROVEN     truth of the workflow"  │    │
  │    │        ↺ retry until the workflow test is green                 │    │
  │    │                                                                 │    │
  │    │  ②  FIX                                                         │    │
  │    │        patch source per bug report + playbook                   │    │
  │    │                                                                 │    │
  │    │  ③  VERIFY  (the RUNNER executes; the agent is never believed)  │    │
  │    │        typecheck ∧ workflow GREEN ∧ probe NOT_PROVEN            │    │
  │    │                  ∧ no regression in related existing tests      │    │
  │    │                                                                 │    │
  │    │  ④  RECONCILE                                                   │    │
  │    │        while not (both axes hold) and rounds left:              │    │
  │    │            hand back the exact structured failure ──► ③         │    │
  │    │                                                                 │    │
  │    │  ⑤  ATTEST + close out                                          │    │
  │    │        agent states confidence and residual risk                │    │
  │    └────────────────────────────────────────────────────────────────┘    │
  │                                                                          │
  │    exhausted without both axes ──► revert to snapshot, record honestly    │
  │    write task record, flush state  ← crash here costs one task, not a run │
  │    context is discarded; next task starts clean                          │
  └──────────────────────────────────────────────────────────────────────────┘
                                     │
                                     v
OUTPUTS (exactly two, as specified)
  ├── patcher-report.json  ....... aggregation of all task records
  └── the patched tree ........... one codebase, all tasks applied
                                     │
                                     v
                         scored later, on the sighted side,
                         against oracles this code never sees
```

---

## 2. Why the loop is built this way

### 2.1 The orchestrator owns the loop, not the prompt

A prompt that says *"iterate until the tests pass"* produces an agent that
decides for itself when it has iterated enough. Every gate here is a Python
`while` with a machine-checked exit condition:

| Gate | Checked by | Not checked by |
|---|---|---|
| workflow test is green before the fix | `verify.py` running the test | the agent saying it ran it |
| source untouched during characterisation | tree hash diff, auto-reverted | trust |
| vulnerability closed | probe exit string flips `PROVEN` → `NOT_PROVEN` | the agent's confidence |
| no collateral damage | per-test transition vs a task-start baseline | the agent's summary |
| the task is done | all four of the above, conjoined | `"status": "fixed"` in a report |

The agent's own report is still collected — as an **attestation**, scored
separately as calibration (see `docs/patcher/EVAL-METRICS.md`). It is evidence
about the agent, never evidence about the patch.

### 2.2 Characterisation comes first, and it produces two artefacts

Your step ① asks the agent to establish what a correct workflow looks like
*before* it changes anything. The implementation does that, and adds the mirror
image, because the exit condition you specified — *workflow fixed **AND** agent
is confident the vulnerability remains fixed* — needs both halves to be
checkable:

| Artefact | Written in ① | Asserted before the fix | Asserted after the fix |
|---|---|---|---|
| `workflow.test.ts` | yes | **PASS** — this is the recorded ground truth of correct behaviour | **PASS** — unchanged |
| `exploit.probe.ts` | yes | prints **PROVEN** | prints **NOT_PROVEN** |

Without the probe, "confident the vulnerability is fixed" degrades to a vibe.
With it, the sandbox reproduces the exact two-axis conjunction the sighted
scorer applies — using tests the agent wrote itself, from the bug report and the
source, with no oracle access.

A probe that never reaches `PROVEN` does **not** abandon the task. The bug
report is stipulated 100% accurate, so an unprovable probe is a limit of the
agent, not evidence of a non-bug. The task continues gated on the workflow axis
alone and is recorded as `probe_unproven` — which aggregates into a
self-verification-coverage diagnostic, one of the more informative numbers this
architecture produces.

### 2.3 Context is refreshed by process boundary, not by asking

Every phase is a **separate `claude -p` invocation**. There is no accumulated
transcript to compact, because there is no shared transcript at all. What
crosses a phase boundary is a small structured object the orchestrator builds:

```
carry = {
  bug entry (verbatim, from the report)
  playbook section for this class
  characterisation summary   (prose + the two artefact paths + observed results)
  current diff for this task (unified, truncated)
  the last structured verification failure
  round number and rounds remaining
}
```

Bounded by construction. Task 97's fix phase gets a prompt the same size as task
1's. Nothing from tasks 1–96 leaks in except their effect on the source tree,
which is exactly what should carry.

### 2.4 One tree, applied cumulatively

Two outputs were specified: one aggregated report and one fixed codebase. That
forces a single cumulative tree — task N works on the tree task N−1 left behind.
It is also the more honest arrangement: when task 12 breaks something task 40
depends on, task 40's regression net finds it, and the run has a real chance to
notice. Isolated per-task trees merged at the end hide exactly that class of
damage until it is too late to attribute.

The cost is wall-clock: tasks run serially. That is bought back with
checkpoint/resume (`--resume <run_id>`), so an interruption costs one task
rather than the run. Set `loop.task_concurrency > 1` to trade the guarantee for
speed; the default is `1` and the guarantee.

### 2.5 The give-up policy is "revert and say so"

When a task exhausts its reconcile budget with both axes unsatisfiable, the
default `policy.on_exhausted = "revert"` rolls the tree back to that task's
snapshot and records `disposition: abandoned` with the failing assertion
verbatim.

This trades a possible remediation credit for a guaranteed non-regression, and
it keeps the damage out of the 96 tasks that follow. Two alternatives are
implemented and switchable — `keep_best` (bank the attempt, flag it) and
`keep_if_workflow_intact` (asymmetric: never ship known damage, still bank
uncertain fixes) — because which one is right is an empirical question about
how the scorer's `DESTRUCTIVE_FIX` and `NO_FIX` buckets actually populate, and
that has not been measured yet.

---

## 3. The blind boundary is enforced, not requested

Prompt text saying *"do not look for the answers"* is a request. Requests get
ignored under pressure, and a single leak invalidates every number the run
produces. Three independent mechanisms, none of which depend on the agent
cooperating:

| Layer | Mechanism | Blocks |
|---|---|---|
| **Before dispatch** | `blind_guard.py` validates and scrubs both inputs | a bug report or playbook carrying `challenge_key`, a reference fix, an oracle test title, or a solve condition — fails the run loudly rather than dispatching a contaminated prompt |
| **During the run** | `hooks/sandbox_guard.py`, a `PreToolUse` hook, `deny` decision | any read/write/glob/grep resolving outside the work tree; any write under `test/`, `cypress/`, or a frontend spec; any network egress (`curl`, `wget`, `git clone`, `npm install`) — upstream Juice Shop *is* the answer key; any path or argument matching the answer-key pattern set |
| **After the run** | `blind_guard.audit_run()` | replays every guard decision and every tool call in the transcripts; emits `blind-audit.json`. A single denial for an answer-key path marks the run `contaminated: true` and the report says so at the top |

The standing constraint from the root `CLAUDE.md` is also carried verbatim in
every dispatched prompt. That is the fourth layer, and the weakest one, which is
why it is not the only one.

**What the agent can reach:** the work tree, and nothing else. `cwd` is the
tree, `--add-dir` names only the tree, `WebFetch` and `WebSearch` are denied
outright, and the hook re-checks every path after resolution, so `../` and
symlinks do not help.

---

## 4. Layout

```
tools/patcher/
├── README.md                     this file — the architecture
├── ARCHITECTURE.md               the loop, state machine and gates in full detail
│
├── contracts/                    JSON Schemas. Blind-safe by construction.
│   ├── bug-report.schema.json        INPUT  — what the agent is told
│   ├── playbook.schema.json          INPUT  — OWASP guidance per class
│   ├── task-record.schema.json       OUTPUT — one per task, measured facts + attestation
│   └── patcher-report.schema.json    OUTPUT — the aggregation
│
├── config/
│   └── run-config.example.json   every knob, with the default and why
│
├── src/
│   ├── run_patcher.py            ENTRYPOINT. Outer while loop, checkpoint/resume.
│   ├── task_loop.py              Inner while loop. The five phases, the gates.
│   ├── agent.py                  AgentRunner interface + Claude CLI adapter.
│   ├── prompts.py                Every prompt, one file, blind-safe.
│   ├── workspace.py              Tree prep, per-task snapshot/revert, diff capture.
│   ├── verify.py                 Runner-executed gates. Typecheck, workflow, probe.
│   ├── testmap.py                Changed file -> existing test files that exercise it.
│   ├── blind_guard.py            Input scrub + post-run transcript audit.
│   ├── state.py                  Run state, incremental flush, resume.
│   └── report.py                 Task records -> patcher-report.json.
│
├── hooks/
│   └── sandbox_guard.py          PreToolUse hard denial. Invoked by the CLI.
│
└── tests/                        Self-tests. Run with a fake agent, no model, no cost.
    ├── test_blind_guard.py
    ├── test_sandbox_guard.py
    ├── test_task_loop.py
    └── test_report.py
```

## 5. Running it

```bash
# self-test, no model, no cost, ~2s
python3 -m pytest tools/patcher/tests -q

# dry run: fake agent, real loop, real gates, proves the state machine
python3 tools/patcher/src/run_patcher.py --config <cfg> --agent fake

# real run, detached, checkpointed (scans and patch runs outlive a session)
setsid nohup python3 tools/patcher/src/run_patcher.py \
    --config tools/patcher/config/run-config.example.json \
    > run.log 2>&1 &

# resume after an interruption; finished tasks are not re-paid for
python3 tools/patcher/src/run_patcher.py --config <cfg> --resume <run_id>
```

`run_patcher.py --check` validates inputs, the tree, the toolchain and the
sandbox hook, then exits without spending a token. Run it first, every time.

---

## 6. What is deliberately not decided here

- **Which model.** `agent.model` in the run config. The `AgentRunner` interface
  exists so a second runtime can be added without touching the loop.
- **The reconcile budget.** `loop.reconcile_rounds` defaults to 4. The right
  number is whatever the rounds-to-green distribution turns out to be, and that
  needs a run.
- **The regression net.** `policy.regression_net` defaults to `related` (the
  agent's own test plus existing tests touching the changed files, then one full
  suite gate at the end). `own_only` and `full_suite_per_task` are implemented.
- **Whether the probe should be mandatory.** `policy.require_probe` defaults to
  `false`, per §2.2. Flip it once the `probe_unproven` rate is known.

Each of these is a measurement, not an opinion, and none of them can be
measured before the inputs land and a baseline exists (see
`docs/patcher/DATASET-READINESS-AND-HANDOFF.md`).
