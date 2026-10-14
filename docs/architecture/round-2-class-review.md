# Round 2: human class review and budgeting before the hunt

## Context

Task 2a delivered round-1 inputs (target, reports folder, exclusions, budget), the spend
ledger, the Stage 1 estimate and the reservation gate. It explicitly left out "the round-2
class review screen" (`docs/architecture/task-2a-inputs-budget-ledger.md:7`, dispatch brief
items I and J). Since then PRs 62 to 65 merged: the playbook agent now **owns the run's class
set** (coverage call, turn1 / turn2 passes / turn3 decision loop with web search, then one
web research call per new class) and writes `class-selection.json`, which puts Stage 0.5 in
"agent mode" (no floor classes, signals route only selected classes, unreached selected
classes go on every hunt lane, a lane left with no class is skipped). PR 65 froze that as the
final agent architecture.

What is missing is the human checkpoint. Today the agent's pick goes straight to lane
assignment. The only pause is the run-start confirmation (`cli/src/secscan.ts:450-518`),
whose `[e]` edits limits and re-runs Stage 1 only. Round 2 turns that pause into a second
round of user input. The user reviews the agent's classes, deletes or adds classes, sets the
budget, and starts. Every change re-plans and redraws. When the budget covers only part of
the repo, the riskiest files run first, and the existing gate ends the run early with
whatever was found.

Decisions already made (from the Q&A):

| Topic | Decision |
|---|---|
| Starting list | The agent's selection (`class-selection.json`). The agent is treated as always on. |
| Edits | **Delete** and **add** only. No "update": to change a class, delete it and add another. |
| Added class | Resolved by code first (catalog id, number, code, cached class). Otherwise a cheap model call resolves it to a built-in or defines a new class, and a new class gets a web research call for its playbook. |
| Deleted class | Removed from the final list. Its playbook is never loaded, because no lane carries it. |
| Rows on screen | Selected classes with file counts only. No per-class cost, no list of unselected classes. |
| Files left with no class | Skipped (PR 62 behaviour). The screen says how many files dropped out. |
| Research failure | Retry once automatically, then report and leave the list unchanged. |
| Scan order | Risk-first in **every product run**. Lab and benchmark runs keep inventory order. |
| Partial budget | Nothing is pre-dropped. The scan runs risk-first, and the existing spend gate stops it at the cap. The report covers what was scanned and is marked INCOMPLETE. |
| No terminal (`--yes`, CI) | `--drop-class` / `--add-class` flags. `[s]` saves the reviewed edits into `secscan.config.json`. |

## The feature at a glance

```
Round 1 inputs ─► Recon ─► Playbook agent ─► Stage 0.5 ─► Stage 1 ─► ROUND 2 SCREEN ─► Hunt (risk-first, live spend) ─► Report
 target, out,     (LLM)    decision loop +    lanes        estimate,     │      ▲
 excludes,                 research           (code)       risk order    │      │ re-plan: Stage 0.5 + Stage 1 (code, no model)
 budget                    (LLM + web)                     (code)        ▼      │
                                                                     edit applied
                                                    delete / catalog add ─► code only, $0
                                                    free-text add ─► review:resolve (LLM, no web)
                                                                     └─ new class ─► review:research (LLM + web, retry once)
```

Only the agent steps call a model. The re-plan after an edit is the existing Stage 0.5 and
Stage 1 run as child processes: no model calls, a few seconds (to be measured, not promised
as "under a second").

### Round 2 screen (illustrative numbers)

See [captured renderer and scripted-session previews](round-2-budget-previews.md)
for all budget states after the 2026-10-14 wording revision.

```
Recon and planning done · spent so far $0.06 (recon $0.01, playbook agent $0.05)
Target: ./my-app (commit a1b2c3d, 1,204 files) · Model: GPT-6 Luna (OPENAI_API_KEY found)

Vulnerability classes for this repo                       files
  1  injection                                            212
  2  access-control                                       180
  3  crypto-auth                                           96
  ...
 11  prototype-pollution          added by you (web)       74
 12  sensitive-business-flows     no matching signal      541  (all files)

Scan 541 files, skip 663 (not code 640, no selected class 23)
Total estimate: $2.12
  $0.06 spent + input $0.85 + output $1.21.
  Accuracy band: ±7% (90%).
Current budget: $1.50
Budget will not cover all 541 files.
Estimated coverage: 378 of 541 files, scanned by severity first.
Raise the budget to $2.12 to cover the full estimated scan.
The report will be INCOMPLETE if the budget stops the scan.

[Enter] start  [d] delete a class  [a] add a class  [b] budget  [e] limits  [s] save  [q] quit
```

After a delete:
```
Deleted logging-monitoring. 23 files no longer have a class and will be skipped.
Re-planning ... done (no model calls)
```

After a free-text add:
```
Add a class (name, number or code): prototype pollution
  Not in the catalog. Checking with the agent costs about $0.005.  [Enter] go  [c] cancel
  Agent: new class "prototype-pollution" (CWE-1321), routed by signals: model_write, deserialize
  Writing its playbook with web research costs about $0.02.  [Enter] go  [c] cancel
  Playbook written (4.1 KB, 3 searches, $0.018). 74 files. Re-planning ... done
```

### Budget messages (`B` is the total budget, including what is already spent)

| Condition | Message | Enter |
|---|---|---|
| `B >= total estimate` | "Budget covers the estimated cost of all M files." | starts |
| `spent + input cost <= B < total` | "Budget will not cover all M files." / "Estimated coverage: N of M files, scanned by severity first." / "Raise the budget to $X to cover the full estimated scan." / "The report will be INCOMPLETE if the budget stops the scan." | starts |
| `spent + first file's reservation <= B < spent + input cost` | "Budget will not cover even the estimated input cost for all files." / "Raise the total budget to cover at least partial scan." / "Starting now will allow only a partial scan." | starts after `Start with this low budget? [y/N]` |
| `B < spent + first file's reservation` (or `B <= spent`) | "Scan cannot start with this budget." / "Raise the total budget to at least complete partial scan." | disabled |

`Total estimate:` includes spend so far plus estimated remaining input and output.
`Current budget:` appears immediately before the coverage message so users can
compare the two amounts; an uncapped budget displays `Unlimited`. Low and blocked
messages do not recommend a monetary threshold or display reservation amounts.
The estimate and current budget remain visible in those states.

The phrase "scanned by severity first" labels the existing planning heuristic:
route handlers first, then distinct risk-signal count descending, then path. It
does not imply that finding severities have been determined before the hunt.
The wording revision changes no ordering, accounting, reservation or start rules.

- N comes from the existing cumulative walk (`lanes_within_cap`, `scan-plan.ts:282-291`), now over risk order.
- The first file's reservation is `chunks × U` for the first lane in risk order. That is the exact condition the spend gate uses to refuse a start (`spend-gate.ts:48-62`).
- A budget at or below spend so far is rejected as input, as `askNewBudget` already does.

## Inputs and outputs

**Inputs to Round 2**
- `stage-playbook-agent/class-selection.json` and `classes-overlay.json`: the agent's pick
- `stage05-lane-selector-perfile/lane-assignments.json`: file counts per class, skip counts
- `stage1-budget-governor-perfile/scan-plan.json`: estimate split, band, U, risk order
- `spend-ledger.jsonl`: spend so far
- flags and config: `--budget`, `--drop-class`, `--add-class`, `secscan.config.json`

**New and changed artifacts** (all under `runPath(provider, 'stage-playbook-agent')`, no new stage key)

| File | Written by | Meaning |
|---|---|---|
| `class-selection.agent.json` | review step, once, before the first edit | Immutable copy of the agent's own pick, so the human delta is always recoverable |
| `class-review.json` (`secscan.class-review/1`) | review step, after each edit | `agent_selection`; `edits[]` (`at`, `action: drop or add`, raw `input`, `resolved: {kind: builtin, cached, researched, rejected, failed; id}`, call labels, `cost_usd`); `final {builtin, added, classes}`; `budget_changes[]` |
| `class-selection.json` | review step (rewritten) | Same schema and contract as today, now the reviewed set. Downstream readers are unchanged. |
| `classes-overlay.json` | review step | Grows only: a researched class is appended. Deleted classes stay in the dictionary, and the selection decides routing. |
| `research-failures/<id>.json` | review step | Same record as the agent's, with `attempt: 1 or 2` |

Ledger labels: `review:resolve`, `review:research:<id>` (attempt 1 and 2), `source: 'playbook'`.
The run record gains `class_review` (agent pick, final set, edits, review spend), and the
confirmation summary records the class rows the user saw (Part 3 CLI row: "the confirmation
screen matches what the run then does").

## Effects on other stages

| Stage | Change |
|---|---|
| Round 1 (`cli/src/inputs.ts`, `args.ts`, `config.ts`) | New repeatable `--drop-class <id>` and `--add-class "<text>"`. Config gains `classes: {drop: [], add: []}`. Budget question unchanged. |
| Recon | None. |
| Playbook agent (`stage-playbook-agent/src/`) | New review entry point (`review.ts`, `npm run review`) that reuses the agent's research function, `playbookProblems`, meter and cache unchanged. It adds one new call type, `resolve`: strict schema `{kind: builtin, id} or {kind: new, id, framework, codes[], signals[]} or {kind: not_a_class, why}`, no web. The decision loop is not re-run. Review writes `meta.json` only on success and never marks the stage failed first, so a failed edit cannot unseat the valid previous selection (today's `main.ts:50-53` does the opposite for full runs). |
| `shared/playbook-overlay.ts` | `writeClassSelection` + `appendOverlayEntry` helpers that run the existing `validateClassSelection` / `validateOverlay`. |
| Stage 0.5 | None. It already routes whatever `class-selection.json` says. The golden no-selection test still guards benchmark output. |
| Stage 1 | **Product profile:** orders `plan.admitted` by risk and records `order_basis`. Risk = route handler first, then number of risk signals on the file, then path. Exports `input_threshold_usd` and `first_start_usd` for the budget messages. The lab profile is byte-identical. |
| Stage 2 | Iterates admitted lanes in `plan.admitted` order instead of `assignments.lanes` order (`hunt-executor.ts:2178, 2380`). Same order in the lab, because the lab plan keeps inventory order. The plan-consistency checks (`hunt-executor.ts:1882-1915`) are untouched, and that is why every edit re-runs Stage 0.5 and Stage 1. |
| Live progress (`cli/src/progress.ts`) | Shows spent, estimate and budget on the same basis. Fix the known mismatch: the progress estimate is scan-only while spent is the full ledger (`hunt-executor.ts:2454`). |
| Report (Task 1d, not built yet) | Lists the classes hunted, which were added or deleted by the user, and on INCOMPLETE which files were not reached. Located detail stays out of committed artifacts as today. |
| `--resume` | Classes are frozen once the hunt has started: a class change would invalidate U and the plan. Resume shows Round 2 with budget-only edits (the existing `askNewBudget` path). |
| Benchmark / blind boundary | Round 2 never appears in lab or benchmark runs (`run.sh`), and `guard.test.ts` asserts that a benchmark run record has `class_review.edits == []`. A human editing classes against a scored target would break blind measurement. |

## Edge cases handled

- **Delete the last class:** Enter is disabled with "no classes selected".
- **Delete a class that is a file's only class:** that file is skipped, and the screen gives the count.
- **Add a class already selected:** "already selected", $0. The match uses id, catalog number, OWASP code or alias.
- **Add a previously deleted built-in:** code-only re-add, $0. This is the undo path.
- **Free text resolves to a built-in:** treated as a catalog add, after the resolve cost (~$0.005).
- **Free text resolves to an existing cached class (same id, framework and model):** cache hit, no research.
- **Free text is not a class** ("make it fast"): `not_a_class`, message shown, resolve cost booked.
- **New class whose signals reach no file:** goes on every hunt lane (existing unrouted rule). The row shows "(all files)".
- **Research fails validation:** retried once automatically. After the second failure: "could not build a playbook for X ($0.04 spent): <check>". The class is not added and the list is unchanged.
- **Research would exceed the budget:** checked as spent plus a one-call worst-case reservation. The user is asked to raise the budget first.
- **Ctrl-C during a review call:** the attempt is booked in the ledger, the class is not added, and the screen redraws.
- **Re-plan fails:** same handling as today's `[e]` path. The log tail is shown and the run ends without hunt spend.
- **`--yes` with `--add-class` and a resolve or research failure after retry:** exits non-zero before any hunt spend. A class the user asked for is never silently missing.
- **Agent added an outside-catalog class:** shown like any other row and deletable at $0.

## Build plan (one PR, with a dispatch spec first)

1. Spec `prompts/dispatch/2026-10-1x__round-2-class-review.md` and doc
   `docs/architecture/round-2-class-review.md` (this plan, made durable). Carry the standing
   answer-key constraint.
2. `shared/playbook-overlay.ts`: selection and overlay write helpers and tests.
3. `stage-playbook-agent/src/review.ts` + `resolve` schema and prompt, research retry once, `class-review.json`, ledger labels. All tests mocked.
4. Stage 1: risk order (product profile only), threshold fields in `scan-plan.json`. Stage 2: iterate `plan.admitted`.
5. CLI: `cli/src/round2.ts` (render + key handling on the injectable `InputIO`), extend `ConfirmationSummary` with `classes[]` and `budget_message`, wire into the `secscan.ts` confirmation loop, flags, config, run record.
6. Progress spend basis fix.

Reuse: `buildSummary`/`renderSummary` (`cli/src/confirm.ts`), `editLimits` and the re-plan
block (`secscan.ts:485-507`), `askNewBudget` (`inputs.ts:249-273`), research + `playbookProblems`
+ `PlaybookMeter` (`stage-playbook-agent/src`), `readCachedPlaybook`/`writeCachedPlaybook`
(`shared/playbook-cache.ts`), `validateClassSelection` (`shared/playbook-overlay.ts:77-87`),
`lanes_within_cap` walk (`stage1-budget-governor/src/scan-plan.ts:282-291`).

## Verification

- Suites: `stage-playbook-agent`, `stage0-recon`, `stage1-budget-governor`, `cli`, `shared/guard.test.ts`, `shared/foundation.test.ts`. All model and web calls mocked; no paid call.
- Deterministic before/after: the lab Juice Shop lane plan and `scan-plan.json` admitted order are byte-identical to `main`. The Stage 0.5 golden fixture still passes.
- Scripted CLI sessions through a fake `InputIO` and fake model client: delete → re-plan → counts change; catalog add at $0; free-text add → resolve → research → row appears; research fails twice → list unchanged, spend booked; all four budget messages at boundary values; delete-all disables Enter; `--yes --add-class` failure exits before hunt spend; resume allows budget edits only.
- Ledger check: every review call has exactly one ledger line per attempt, and the screen's "spent so far" equals the ledger total.
- Risk order: a fixture with mixed signals runs route handlers first under the product profile, inventory order under lab.
- Before merge: `git merge-base HEAD origin/main`, and grep that each change is present in the tree (CLAUDE.md "verify the tree").

## Still open (small, can default)

1. At add time, offer "every file" instead of the agent's signals? Default: no, since there is no update, and delete + add covers it.
2. If the agent stage itself fails on research (it exits 1 today), should Round 2 open on `class-decision.json` and let the user delete the failed class instead of failing the scan? Default: yes, as a follow-up task.
3. Risk ranking weights beyond "route handler first, then signal count": default to exactly that, with ties broken by path.
## Implementation notes and validation

The product CLI always includes the playbook agent and opens Round 2 after
successful planning. Direct lab/benchmark pipelines keep their existing opt-in
agent behavior. Failure recovery from the initial playbook agent's research remains
the separate follow-up described above.

The strict Responses API resolver schema wraps the discriminated result in a
`resolution` object, because the API requires an object root. Resolve calls omit
web tools. Research has at most three web-tool calls per attempt, and retries once
without a second confirmation; each attempt is reserved and booked separately.
The audit retains raw input, per-edit spend and aggregate review spend. Cancellation
and validation failures preserve the previous selection and successful metadata.

Product planning loads guidance only for classes carried by hunt lanes. A deleted
class remains in the append-only overlay but its cached text is not read, so a
missing deleted-class cache cannot prevent replanning. Resume after hunting retains
class assignments, reservation U and ordering. Rejected edits or quitting a resume
preserve the previous hunt's coverage and findings while recording updated review
state and spend.

Validation uses mocked model/web clients only. The suites cover the review engine,
Stage 0 recon, the Stage 0.5 golden fixture, Stage 1, Stage 2, CLI orchestration,
and shared guard/foundation checks. No paid inference or benchmark accuracy claim
is part of this change.

A deterministic comparison against baseline `9787ea2d7b5d7169d9bcc28652a814e9e466beea`
used the current 884-file Juice Shop inventory and existing recon signals. The lab
lane assignments and complete `scan-plan.json` were byte-identical after normalizing
only temporary checkout/artifact roots and freezing the clock; 301 lanes were
admitted in both. The current selector and planner took 0.585 and 0.869 seconds
respectively in the final comparison (1.454 seconds together). This is a measured
example, not a latency guarantee.
