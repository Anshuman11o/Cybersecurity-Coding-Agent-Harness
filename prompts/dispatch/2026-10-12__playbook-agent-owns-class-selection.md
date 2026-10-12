# Dispatch — The playbook agent owns class selection

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

## Why

Today Stage 0.5 (`stage05-lane-selector-perfile`) decides which built-in classes a
run hunts: every hunt lane gets the three floor classes plus every built-in class
its file's signals map to in `shared/signal-classes.json`. The playbook agent
(`stage-playbook-agent`) can only *add* classes on top. On a typical target this
already puts ~12 of the 14 built-ins on some hunt lane before the agent runs, so
the agent's judgement about which classes apply is never exercised or measurable.

From now on, **when the playbook agent has run, it decides the complete class set**
— built-in and new alike — and Stage 0.5 only routes that set onto files. When the
agent has not run, everything behaves exactly as today (the Juice Shop benchmark
depends on that).

## Changes

### 1. `tools/scanner/stage-playbook-agent/src/agent.ts`

- Coverage decision schema (`decisionSchema`): add a required property
  `builtin_classes`, between `reason` and `classes`:
  array of strict objects `{ id: string (enum = the built-in class ids, i.e. the
  keys of o.builtins), reason: string }`. Keep `classes` (additional classes)
  exactly as it is. Strict mode: every property required, `additionalProperties:
  false`, as the existing `object()` helper already does.
- Validate after the coverage call, before any search or cache write: every
  `builtin_classes[].id` is a built-in id, no duplicates, non-empty `reason`.
  An empty `builtin_classes` array is valid. An additional class id equal to a
  built-in id is still rejected (as `validateOverlay` does today).
- Replace the coverage call's `task` string with exactly:
  `Select the built-in classes that apply to this target and decide coverage against the built-ins. Return every applicable built-in class in builtin_classes and every additional class needed for this run in classes, including applicable cached classes; no web search on this call. Reuse cached identifiers.`
- `PlaybookPlan` gains `builtin_classes: { id: string; reason: string }[]` and
  `selected_classes: string[]` — the sorted, de-duplicated union of the selected
  built-in ids and the additional class ids. `selected_classes` is the run's
  complete class set.
- `runPlaybookAgent` returns, in addition to `plan` and `overlay`, a
  `selection` object (see §3 for its shape).

No other prompt text, request parameter or validation in this file changes.
The research call is untouched.

### 2. `tools/scanner/stage-playbook-agent/guidance.md`

Only the `## Coverage decision` section changes, and only as follows.

Insert this as the section's **first** paragraph, verbatim:

    Class selection is your job. No class is applied to this run by default:
    not the built-ins and not the former floor classes. Return in
    builtin_classes every built-in class that applies to this target, judged
    from recon's evidence and the built-in guidance, and in classes every
    additional class. Their union is the complete set of classes this run will
    hunt; a class you do not return is not hunted.

In the third paragraph, replace the sentence
`Map every proposed class to one or more EXISTING signal names. Do not invent signals or change the three floor classes.`
with
`Map every additional class to one or more EXISTING signal names. Do not invent signals.`

Nothing else in `guidance.md` changes.

### 3. `tools/scanner/shared/playbook-overlay.ts`

- Export `CLASS_SELECTION_FILE = 'class-selection.json'` and
  `interface ClassSelection { schema: 'secscan.class-selection/1'; created_at: string; model: string; builtin: string[]; added: string[]; classes: string[] }`
  (`classes` = sorted union of `builtin` and `added`).
- Export `validateClassSelection(sel, builtins, overlay)`: schema string right;
  every `builtin` id is a built-in; every `added` id is a key of the overlay and
  not a built-in; no duplicates; `classes` equals the sorted union.
- Export `readClassSelection(provider): ClassSelection | null` modelled on
  `readClassesOverlay`: `null` when the file does not exist; otherwise
  `assertUpstream(provider, PLAYBOOK_STAGE)`, parse, validate against the shipped
  `vuln-classes.json` and the overlay, return.

### 4. `tools/scanner/stage-playbook-agent/src/main.ts`

Write `class-selection.json` with the other artifacts (same atomic `writeJson`),
before the success `writeMeta`. Order: plan, overlay, selection, meta.
Log line: `Playbook agent: N class(es) selected (B built-in, A additional); searched=…`.

### 5. `tools/scanner/stage05-lane-selector-perfile/src/lane-selector-perfile.ts`

When `readClassSelection(PROVIDER)` returns a selection ("agent mode"):

- No floor: the effective floor is `[]`.
- The effective signal→class map keeps, for each signal, only classes in
  `selection.classes` (built-ins from the shipped map, additional classes from
  the overlay merge that already happens).
- Per hunt-eligible file: routed classes = selected classes reached by its signals.
- `unrouted` = selected classes reached by no hunt-eligible file's signals. Add
  every unrouted class to every hunt-eligible lane, with
  `class_basis['selection-unrouted']` listing them.
- A hunt-eligible lane that still has zero classes becomes a skip lane with
  `skip_reason: 'No selected class applies to this file'`, `classes: []`.
  (This matters: Stage 2 falls back to category-derived classes when a hunt
  lane's `classes` is empty, which would reintroduce defaults.)
- Assert before writing: when at least one hunt lane exists, the union of
  `classes` over hunt lanes equals `selection.classes` exactly. Throw otherwise.
  The coverage ledger invariant (hunt + skip == inventory) still holds.
- Output: `floor_classes: []`, plus a top-level
  `class_selection: { source: 'playbook-agent', classes: [...], unrouted: [...] }`.

When `readClassSelection` returns `null`, the output must be **byte-identical** to
today's: no `class_selection` field, same floor, same everything.

### 6. Tests (`tools/scanner/stage-playbook-agent/src/*.test.ts`)

Update the existing mocked decisions to the new schema and add:

- the coverage request's schema has `builtin_classes` with the built-in enum;
- an unknown or duplicate built-in id is rejected before any search;
- `selected_classes` / `class-selection.json` hold the union;
- Stage 0.5 in agent mode (one-file and multi-file synthetic targets): hunt-lane
  union equals the selection; no floor class appears unless selected; an
  unrouted selected class lands on every hunt lane; a file reached by no
  selected class becomes a skip lane; a built-in that its signals would reach
  but that was not selected is absent;
- Stage 0.5 without a selection still produces exactly
  `fixtures/lane-assignments-no-overlay.json` (existing test — keep it passing);
- `readClassSelection` refuses a selection whose stage `meta.json` records a failure.

All model and web responses stay mocked. **Make no network call and run no stage
against a real model.**

### 7. `tools/scanner/stage-playbook-agent/README.md`

Under "Decision and cache", add one short paragraph describing builtin selection,
`class-selection.json`, and Stage 0.5's agent mode (no floor, routing, unrouted
classes on every hunt lane, empty lanes skipped). Under "Artifacts and hooks",
list `class-selection.json`.

## Do not touch

- `tools/scanner/stage0-recon/` (any file), `tools/scanner/stage2-hunt-lanes*/`
  (including every playbook and `hunt-executor.ts`), `tools/scanner/stage05-lane-selector/`
  (v1), `tools/scanner/stage1-budget-governor/`, `tools/scanner/cli/`.
- `shared/vuln-classes.json`, `shared/signal-classes.json`, `shared/models.json`.
- `tools/scanner/run.sh` — the playbook agent stays opt-in.
- Any prompt text other than the two edits in §1 and §2.

## Done means

From the repo root:

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report the list of files changed and each command's
pass/fail counts.
