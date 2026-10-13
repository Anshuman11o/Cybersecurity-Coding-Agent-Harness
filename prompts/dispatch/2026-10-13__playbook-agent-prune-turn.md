# Dispatch — Playbook agent: turn3 becomes a pruning turn; turn2 defaults to one pass

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

## Why

Every decision call can only add classes, so whatever the first call
over-includes stays in the final set. In the two latest evaluation runs both
final sets held every built-in class, and turn3 and the second turn2 pass added
nothing in either run. The project owner approved: (B) turn3 becomes a review
turn that may remove classes, and (C) turn2 runs one pass by default.

## Change B — turn3 prunes

`tools/scanner/stage-playbook-agent/src/agent.ts`

1. Replace `tasks.turn3` with exactly this text (approved by the project owner,
   byte for byte):

       Review every selected class against recon's data. For each, name the recon evidence (signal, dependency, framework, category verdict or architecture element) that shows the target has a surface it applies to. Remove a class when you can name no such evidence. Return the final decision in the same schema, listing each removed class and why.

   No other task string and no `guidance.md` text changes.

2. turn3 keeps today's request shape (same input, schema with `changes`, web
   search available, `tool_choice: 'auto'`, validated with `validateDecision`).
   Only its merge differs. turn1 and every turn2 pass keep the no-drop union
   exactly as today.

3. turn3 merge is an **intersection**, enforced in code (a new function next to
   `unionDecision`, e.g. `pruneDecision(before, turn)`):
   - The result keeps, from `before`, every built-in and every additional class
     whose id is in turn3's returned ids. A kept entry keeps its `before`
     definition and reason (turn3 cannot redefine a class).
   - `removed` = ids in `before` that turn3 did not return.
   - An id turn3 returns that was not in `before` is **not added**; list it in
     the turn record as `ignored`.
   - The decision's `reason` becomes turn3's.
   - If the intersection would be empty, keep `before` unchanged, set
     `removed: []`, and record `prune_rejected: 'empty'` on the turn.
4. `DecisionTurn` gains `removed: string[]` (always present; `[]` for turn1 and
   turn2) and optional `ignored?: string[]`, `prune_rejected?: 'empty'`. turn3's
   `restored` is `[]` and `added` is `[]`.
5. Everything after the loop (`class-decision.json`, research, overlay, plan,
   class selection) uses the pruned decision. A pruned additional class is not
   researched and does not appear in the overlay.
6. Progress line for turn3: `added=-` becomes `removed=<ids or ->`.

## Change C — turn2 runs one pass by default

- `main.ts`: `SCANNER_PLAYBOOK_LOOP_PASSES` default `3` → `1`. The env var still
  overrides with any positive integer; validation unchanged.
- `agent.ts`: the `o.loop` fallback default `maxPasses: 3` → `1`.
- The early stop on a pass that adds nothing is unchanged.

## Docs

`tools/scanner/stage-playbook-agent/README.md`: update the loop table (turn2
default 1; turn3 reviews every selected class and may remove ones it can name no
recon evidence for), and the "Turns can only add classes" paragraph: turn1 and
turn2 only add; turn3 only removes (intersection, keeps the first definition,
ignores new ids, an empty result is rejected and the set kept). Mention the
`removed`, `ignored` and `prune_rejected` turn fields where turn records are
described.

## Not in scope

No change to `guidance.md`, the coverage/turn1/turn2/research/revision task
strings, Stage 0.5, 1, 2, `shared/`, `run.sh`, or `tools/eval/`.

## Tests (mocked; no network, no real model)

- turn3's request task equals the new text exactly.
- turn3 omitting a built-in and an additional class removes both: they are absent
  from `class-decision.json`, `class-selection.json`, the plan and the overlay;
  the removed additional class gets no research call; the turn records
  `removed` with both ids.
- turn3 returning a new id does not add it; it is listed in `ignored`.
- turn3 returning a kept class with a different definition/reason keeps the
  earlier one.
- turn3 returning nothing (empty builtin_classes and classes) keeps the pre-turn3
  set and records `prune_rejected: 'empty'`.
- turn1 and turn2 still restore omitted classes (existing tests).
- With no env var, `loopOptions({})` gives `{ enabled: true, maxPasses: 1 }` and
  exactly one turn2 pass runs; `SCANNER_PLAYBOOK_LOOP_PASSES=3` still allows
  three. Update existing tests that assumed default 3.
- All existing tests pass, including the Stage 0.5 golden.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, judgement calls, and each
command's pass/fail counts verbatim.
