# The task loop, in full

Companion to `README.md`. That file says what the architecture is and why.
This one is the specification the code implements: every phase, every gate,
every transition, every recorded fact. If the code and this document disagree,
the code is wrong.

Blind-safe. No challenge identifier, file, line, reference fix or oracle title
appears here.

---

## 1. Vocabulary

| Term | Means |
|---|---|
| **task** | one bug from the bug report. 97 bugs ⇒ 97 tasks. Never more, never fewer. |
| **phase** | one agent invocation inside a task. Fresh context, always. |
| **round** | one pass of `FIX → VERIFY`. Round 0 is the first fix; rounds 1..N are reconciles. |
| **gate** | a machine-checked condition the orchestrator evaluates itself. |
| **axis A** | the vulnerability is closed. Measured in-sandbox by the agent's own probe. |
| **axis B** | the application still works. Measured by the agent's own workflow test, plus existing tests. |
| **carry** | the bounded structured object handed from one phase to the next. |
| **work tree** | the single cumulative copy of the target app the run patches. |
| **scratch** | `<tree>/.patcher-scratch/<task_id>/` — agent-authored artefacts. Excluded from every diff, harvested and removed at end of run. |

---

## 2. Task state machine

```
                        ┌──────────┐
                        │ PENDING  │
                        └────┬─────┘
                             │  snapshot(tree)
                             v
                   ┌───────────────────┐
      ┌───────────►│  CHARACTERISING   │  phase ①  (source read-only, enforced)
      │            └────────┬──────────┘
      │  workflow red       │  workflow green
      │  & rounds left      v
      └────────────┬───────────────────┐
                   │      FIXING       │  phase ②
                   └────────┬──────────┘
                            │
                            v
                   ┌───────────────────┐
        ┌─────────►│    VERIFYING      │  phase ③  — runner executes, agent absent
        │          └────────┬──────────┘
        │                   │
        │      ┌────────────┴─────────────┐
        │      │                          │
        │  gates fail                gates pass
        │  & rounds left                  │
        │      v                          v
        │  ┌───────────────┐      ┌────────────────┐
        └──┤ RECONCILING   │      │   ATTESTING    │  phase ⑤
           └───────┬───────┘      └───────┬────────┘
                   │ rounds exhausted     │
                   v                      v
           ┌───────────────┐      ┌────────────────┐
           │ EXHAUSTED     │      │   RESOLVED     │
           │ apply         │      │ disposition:   │
           │ policy.       │      │ fixed          │
           │ on_exhausted  │      └────────────────┘
           └───────────────┘
```

Terminal dispositions, and nothing else is permitted:

| Disposition | Meaning | Tree state at exit |
|---|---|---|
| `fixed` | every gate passed | patched |
| `fixed_workflow_only` | axis B green, probe never reached `PROVEN` so axis A is unverified in-sandbox | patched |
| `already_remediated` | probe could not be proven **and** an earlier task edited the same location — the fix landed upstream in this run | unchanged by this task |
| `abandoned` | reconcile budget exhausted, both axes unsatisfiable | reverted (default policy) |
| `partial` | budget exhausted, best round retained | patched, flagged |
| `agent_failed` | the runtime failed (timeout, unparseable output, rate limit past max wait) | reverted |
| `blocked` | a gate could not be evaluated at all (typecheck harness broken, tree unbuildable) | reverted |

`fixed` and `fixed_workflow_only` are reported separately and never summed into
one "fixed" count. Folding them would be exactly the "false confidence" failure
`docs/patcher/EVAL-METRICS.md` exists to catch.

---

## 3. Phase contracts

Each phase is one `claude -p` invocation with `cwd` = work tree. Its *only*
durable output is the file named in its contract. Everything else — reasoning,
tool calls, transcript — is logged and then dropped.

### ① CHARACTERISE

**Given:** the bug entry, the playbook section for its class, the scratch path.
**Source tree is read-only for this phase.** The orchestrator hashes every
source file before and after; any modification is reverted and recorded as
`violations.source_edited_in_characterise`.

**Must produce**, in `<scratch>/`:

| File | Contract |
|---|---|
| `workflow.test.ts` | a `node:test` file exercising the *legitimate* behaviour of the cited code path. Must pass on the untouched tree. This is the recorded ground truth of correct behaviour. |
| `exploit.probe.ts` | a standalone script that exercises the vulnerable path and prints exactly `PROVEN` or `NOT_PROVEN` as its last line. Must print `PROVEN` on the untouched tree. |
| `characterisation.json` | prose: what correct behaviour is, what the defect is, which existing test files cover this path, what the agent expects to change. |

**Runner-executed gate** (the agent's claims about these runs are ignored):

```
G1  workflow.test.ts exits 0 on the untouched tree          REQUIRED
G2  exploit.probe.ts last line == "PROVEN"                  DESIRED
G3  characterisation.json parses and matches its shape      REQUIRED
```

`G1` or `G3` failing ⇒ re-run phase ① with the failure text, up to
`loop.characterise_rounds` (default 2). Still failing ⇒ `blocked`.

`G2` failing after the budget ⇒ continue, `probe_unproven = true`. If a prior
task in this run edited the same `file:line`, disposition becomes
`already_remediated` and the task closes here without a fix phase.

Rationale for `G1` being required and `G2` merely desired: a workflow test that
does not pass before the change cannot detect damage after it, so it is
worthless — that gate has to hold. A probe that will not fire is a gap in the
agent's understanding, which is worth measuring but is not grounds to skip a bug
that the report stipulates is real.

### ② FIX

**Given:** the bug entry, the playbook section, the characterisation *summary*
(not the phase-① transcript), the two artefact paths, the list of existing test
files the characterisation named.

**May write:** application source inside the tree.
**May not write:** anything under `test/`, `cypress/`, `frontend/src/**/*.spec.ts`,
or the scratch directory's `workflow.test.ts` / `exploit.probe.ts` — the gates are
frozen once phase ① signs them off. The hook denies all of these.

**Must produce:** `<scratch>/attestation.json` (see §5).

### ③ VERIFY — no agent runs

The orchestrator executes, in this order, stopping at the first hard failure:

| # | Gate | Command | Fails ⇒ |
|---|---|---|---|
| V1 | typecheck | `commands.typecheck` | reconcile: `typecheck` |
| V2 | workflow ground truth holds | run `workflow.test.ts` | reconcile: `workflow_broken` |
| V3 | vulnerability closed | run `exploit.probe.ts`, expect `NOT_PROVEN` | reconcile: `still_exploitable` |
| V4 | no collateral damage | related existing tests vs task-start baseline | reconcile: `regression` |
| V5 | blast radius | files touched outside the bug's file, lines changed | advisory, recorded, never blocks |

V3 is skipped when `probe_unproven`. V4's baseline is captured at *task start*,
not run start, so a test already red because of task 12 is not charged to task
40. The transition is what counts, exactly as the sighted scorer computes it.

The result object is structured, not prose:

```jsonc
{
  "green": false,
  "failures": [
    {"gate": "V4", "kind": "regression",
     "test_file": "test/api/<x>.test.ts",
     "test_title": "<it() title>",
     "was": "pass", "now": "fail",
     "output_tail": "…160 lines of the actual failure…"}
  ]
}
```

### ④ RECONCILE

Runs only when V1–V4 produced failures and rounds remain.

**Given:** the carry — bug entry, playbook section, characterisation summary,
the *current unified diff for this task only*, and the structured failure list
above with real output. Not the previous round's reasoning.

The instruction is specifically the one your architecture calls for: *the
workflow test in ① is the record of what correct behaviour looks like; use it to
find a change that satisfies both axes.* Explicitly forbidden, and hook-enforced
where possible: editing the test to match the code, weakening the probe,
deleting the feature, or reverting the security fix to make the workflow pass.

Then back to ③. Loop while `not green and round < loop.reconcile_rounds`.

### ⑤ ATTEST

The final `attestation.json` from the last fix/reconcile round is read, not
re-requested — no extra invocation. It carries the agent's own view:

```jsonc
{
  "bug_id": "BUG-0xx",
  "status": "fixed" | "not_fixed",
  "confidence": 0.0,
  "what_changed": "one sentence",
  "why_it_closes_the_path": "one or two sentences",
  "why_the_workflow_still_works": "one or two sentences",
  "residual_risk": "what could not be closed, or null",
  "rounds_used": 0
}
```

The task record pairs this with the measured facts. Where they disagree, the
measurement wins in the record and the disagreement is itself recorded — that
delta is the input to the verifier-calibration metric on the sighted side.

---

## 4. Between tasks

```python
record = task_loop.run(task, ...)
if record.disposition in REVERT_DISPOSITIONS:
    workspace.restore(tree, snapshot)      # tree is exactly as task N-1 left it
workspace.harvest_scratch(tree, task_id, run_dir)   # copy out, then delete
state.append(record)
state.flush()                              # fsync; crash costs this task only
# no context to compact: the next phase is a new process
```

Scratch is harvested and removed, not left in the tree, so the submitted diff
never contains agent-authored test files. `workspace.tree_diff()` also excludes
the scratch path unconditionally, so even a harvest failure cannot leak it into
the deliverable.

---

## 5. Outputs

Exactly two, per the specification.

### 5.1 `patcher-report.json`

Validates against `contracts/patcher-report.schema.json`. Contains:

- `run` — run id, target sha, config digest, start/end, **measured** cost and
  token usage per model (captured from the CLI's JSON output; never estimated)
- `blind_audit` — the audit verdict. `contaminated: true` puts a warning at the
  top of every rendering and disqualifies the run's numbers
- `totals` — dispositions counted, per-axis in-sandbox pass rates, rounds-to-green
  distribution, probe-coverage rate, blast radius, tasks reverted
- `tasks[]` — one record per bug: disposition, measured gate results per round,
  the agent's attestation, diff stats, cost, wall time, violations

The report describes what the *patcher* did. It contains no oracle result and no
score — scoring happens later, sighted, from the tree.

### 5.2 The patched tree

One directory. All retained tasks applied. No scratch. No test edits.

---

## 6. Resume semantics

`state.json` is flushed after every task. `--resume <run_id>`:

1. reloads the task records already written,
2. leaves the work tree exactly as it was found — it is not rebuilt, because
   rebuilding would discard the fixes already paid for,
3. re-verifies that the tree's digest matches the digest recorded after the last
   completed task, and **refuses to continue** if it does not,
4. starts the outer loop at the first task with no record.

Point 3 is the one with teeth. A resumed run against a tree that drifted would
attribute someone else's edits to the patcher, and the divergence would be
invisible in the final report.

---

## 7. Failure handling

| Failure | Handling |
|---|---|
| rate limit (HTTP 429) | block and re-probe on an interval up to `agent.rate_limit_max_wait_s`. A 429 is "not yet", not "could not" — recording it as a 1-turn $0 failure would misreport an infrastructure event as a reasoning result |
| phase timeout | that phase's invocation fails; the round counts; the task continues if rounds remain |
| unparseable CLI output | same as timeout, with the raw stdout preserved in the log |
| orchestrator crash | last flushed state resumes; at most one task's work is lost |
| tree unbuildable at task start | `blocked` for that task, tree reverted, run continues — one poisoned task must not end the run |

Every one of these appears in the report by name. An infrastructure failure that
gets read later as a reasoning result is the specific outcome the repository's
reporting rule forbids.

---

## 8. Cost shape

Per task, at the default budget: 1 characterise (+ up to 1 retry) + 1 fix + up
to 4 reconciles = **2 to 7 agent invocations**, plus runner-executed test
commands which cost nothing. Verification is free; only reasoning is paid for.

Reconciles dominate. `rounds_to_green` in the report is therefore both a quality
signal and the main cost lever, which is why it is recorded per task rather than
averaged.
