# Recon-kept built-ins, product-mode floor, broader access-control playbook

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only in the harness
checkout. No paid scans and no model API calls; every test uses synthetic
fixtures.

**Scope as implemented (owner decisions after this spec was written):** change 1
is implemented, plus one addition below; change 2 (product-mode floor) was
dropped by the owner, who wants no fixed classes added to every scan; change 3
was narrowed to four gap-driven edits (scope line, pattern 3 extended, patterns
4-6 added), and the final text is the draft file named there.

**Addition to change 1, found in review.** Recon signals also fire on files
Stage 0.5 skips (dependency manifests, declarative config). A class kept only by
such a signal would reach no hunt lane and be spread to every lane by the
unrouted rule. So `class-selection.json` carries `recon_kept`, and Stage 0.5
routes those classes by signal only: unreached ones are logged and not hunted,
and the strict union check exempts exactly them.

Three changes were originally proposed. All three apply to product (playbook-agent) runs.
Benchmark runs without a class selection must stay byte-identical.

## 1. Recon-kept built-in classes (stage-playbook-agent)

**Problem.** In product runs the playbook agent alone decides which of the 14
built-in classes a target gets. Recon's deterministic signals (Stage 0
`file-signals.json`, mapped to classes by `shared/signal-classes.json`) are only
shown to it as input. A built-in can be dropped even when its signals fired on
the target's files, and the decision schema records a reason only for classes
kept, so a dropped class leaves no trace.

**Change.**
- Add `excluded_builtins: [{ id, reason }]` to the decision schema (coverage and
  turn calls). `id` uses the built-in enum, as `builtin_classes` does. The
  coverage and turn1 task text asks the agent to list every built-in class it does
  not select, with the recon evidence that shows its surface is absent. Keep the
  wording change to that one requirement.
- `validateDecision`: each `excluded_builtins` entry is a known built-in, not also
  in `builtin_classes`, not duplicated, and has a non-empty reason. A missing or
  incomplete list is not an error (the rule below covers it).
- Across turns, keep the latest reason given for each excluded id (the
  `unionDecision` no-drop rule for selected classes is unchanged).
- After the final turn and before `recordDecision`, apply one deterministic rule to
  every built-in the agent did not select:
  - **Signals fired** (some file in `recon.file_signals.files` has a signal whose
    `signal-classes.json` entry lists this class): the class is kept. Add it to
    `builtin_classes` with a code-written reason naming the signals and file count,
    e.g. `Kept by recon: signals route_handler, model_write fired on 12 files.`
  - **No signal fired, agent gave a reason:** excluded; record the agent's reason.
  - **No signal fired, no reason:** excluded; record
    `No recon signal routes this class; the agent gave no reason.`
  Classes no signal maps to (for example `insecure-design`) can only be kept by the
  agent, as now. Never force-keep a class without a firing signal: Stage 0.5 would
  treat it as unrouted and put it on every lane.
- Record the outcome in `class-decision.json` and `playbook-plan.json`:
  `recon_kept: [{ id, signals: string[], files: number }]` and
  `excluded_builtins: [{ id, reason, source: 'agent' | 'no-signal' }]`, and
  one log line: `[playbook-agent] recon kept N built-in(s): ...; excluded M: ...`.
- Round-two review (`review.ts`) is unchanged: a class the user removes in round
  two stays removed. The rule applies only to the agent's own decision.

## 2. Product-mode floor (stage05-lane-selector-perfile)

**Problem.** `signal-classes.json` defines `floor: [insecure-design,
logging-monitoring, misconfiguration]`, applied to every lane in benchmark mode.
Agent mode sets the floor to `[]` (`lane-selector-perfile.ts:472`), so
`misconfiguration` reaches a file only through the `config_file` signal (file names
like `.env`, `.ini`, `config.*`), missing application entry files,
infrastructure-as-code and platform-settings code.

**Change.** In agent mode the floor is `signalClassMap.floor` filtered to the
selected classes (instead of `[]`), applied exactly as benchmark mode applies it
(`class_basis['floor']`). Consequences to preserve and test:
- A floor class reached through the floor is not "unrouted".
- A hunt-eligible lane whose only classes are floor classes hunts instead of being
  skipped with the no-selected-class reason.
- Lanes skipped for other reasons (tests, dependency manifests, XML outside
  manifests, etc.) stay skipped.
- Update the agent-mode log line ("no floor") to name the floor in force.
- Without a selection the manifest is byte-identical (existing goldens).

## 3. Broader access-control playbook (stage2-hunt-lanes-perfile)

Replace the text of `tools/scanner/stage2-hunt-lanes-perfile/src/playbooks/access-control.ts`
with the owner-reviewed draft at the path the orchestrator gives you, byte for byte.
Do not reword it. Update any test fixture, golden, size or token expectation that
depends on this playbook's text, and say which.

## Verification

- Playbook agent (synthetic recon, scripted model responses):
  - a built-in whose signal fired but which the agent did not select is kept,
    with the code-written reason and a `recon_kept` entry
  - an unselected built-in with no firing signal and an agent reason is excluded
    with `source: 'agent'`
  - one with neither is excluded with `source: 'no-signal'`
  - a class no signal maps to is never force-kept
  - invalid `excluded_builtins` entries fail validation
  - round-two removal of a recon-kept class stays removed
- Stage 0.5:
  - agent mode with a selection containing floor classes puts them on every hunt
    lane with `class_basis.floor`
  - a lane that would have been skipped for no selected class now hunts with them
  - an unselected floor class is not added
  - no-selection goldens are byte-identical
- Every scanner suite passes (shared incl. guard, stage0, stage-playbook-agent,
  stage05 perfile, stage1, stage2-perfile, cli, report). `tsc --noEmit` adds no
  errors in any package you touch (the cli's 9 pre-existing errors may remain).
