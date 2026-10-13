# Dispatch — Playbook agent: turn2 requires evidence; turn3 re-thinks the selection from turn2's evidence

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

Builds on `2026-10-13__playbook-agent-prune-turn.md` (commit c61dbe2).

## Why

turn2 adds a class when recon "does not rule it out"; across the evaluation runs
its additions were almost never right. turn3 as a pure prune kept nearly
everything. The project owner's decision: turn2 must name recon evidence for each
addition (still add-only); turn3 re-thinks the whole selection from turn2's
reasoning and evidence, the current class list and recon, and may keep (no
explanation), include or remove (each with evidence).

## Change 1 — turn2 text

In `tools/scanner/stage-playbook-agent/src/agent.ts`, replace `tasks.turn2` with
exactly:

    Reconsider every class you did not select: each excluded built-in, and any vulnerability family relevant to this platform that is not yet covered that you can use web tooling to search for. For each one, check recon's data again (platform, languages, frameworks, dependencies, file signals, category verdicts and architecture) and decide whether the target has a surface it applies to. Add it only if recon shows the target has that surface, and name the recon evidence in changes. Do not add a class only because recon does not rule it out. Do not drop any class already selected. Return the full updated decision in the same schema. If nothing is added, return the decision unchanged.

turn2's merge is unchanged (no-drop union). Pass default stays 1.

## Change 2 — turn3 re-thinks the selection

### Text

Replace `tasks.turn3` with exactly:

    Re-think the class selection using turn2_review (turn2's reasoning and the recon evidence it named for each class it added), the current class list and recon's data. For each selected class decide whether to keep or remove it, and for each class not selected decide whether to include it; web search is available if needed. Keep a class without explanation. Remove a class only when you can name no recon evidence of a surface it applies to, and include a class only when recon shows such a surface. List every class you remove or include in changes, with the recon evidence and why. Return the final decision in the same schema.

No other task string and no `guidance.md` text changes.

### Input

turn3's input is today's turn input (`{ ...base, task, current_decision, searches_so_far }`,
same order so the shared prefix is unchanged) plus, appended last,
`turn2_review`: one entry per turn2 pass run, in order,
`{ purpose, reason, changes }` taken verbatim from that pass's model output
(`reason` and `changes` as the model returned them, before the union). Only
turn3 receives `turn2_review`. If the loop ran no turn2 pass, it is `[]`.

### Validation

turn3's output is validated like any turn, with one relaxation: a built-in or
additional class whose id was selected before turn3 may have a blank `reason`
(it keeps its earlier reason). A class turn3 newly includes must pass the full
check, non-blank reason included. Every other call's validation is unchanged.

### Merge (code-enforced, replaces `pruneDecision`)

Let `before` be the decision entering turn3, `own` the ids turn3 returns, and
`explained` the ids that have a `changes` entry with a non-blank `why`.

- **Kept** = ids in both `before` and `own`: kept with their `before`
  definition and reason.
- **Removed** = ids in `before` not in `own` **and** in `explained`.
- **Included** = ids in `own` not in `before` **and** in `explained`: built-ins
  take turn3's entry; an additional class takes turn3's definition (codes,
  signals, framework, reason) and is researched like any other uncached class.
- **Unexplained** = ids turn3 removed or included without an explained `changes`
  entry. The change is not applied (an unexplained removal stays selected; an
  unexplained inclusion is not added). Record them.
- The decision's `reason` becomes turn3's (keep `before.reason` if turn3's is blank).
- If the result would be empty, keep `before` unchanged and record
  `prune_rejected: 'empty'` (as today).

Turn record for turn3: `added` = included ids, `removed`, `restored: []`,
`unexplained: string[]` (always present on turn3), and `prune_rejected` when
rejected. Drop the `ignored` field (turn3 no longer ignores new ids) from the
type, code, tests and README.

Progress line for turn3: `added=<ids or -> removed=<ids or ->` (incomplete
response: `added=- removed=-`).

Everything after the loop (`class-decision.json`, research, overlay, plan,
class selection) uses the turn3 result.

## Docs

`tools/scanner/stage-playbook-agent/README.md`: loop table rows for turn2
(add only with named recon evidence) and turn3 (re-thinks from turn2_review,
current classes and recon; keep, include or remove); the merge paragraph (turn1
and turn2 only add; turn3 keeps, includes or removes, and code applies an
inclusion or removal only with an explained `changes` entry); the turn-record
fields (`unexplained`, `prune_rejected`; no `ignored`); turn3's extra
`turn2_review` input.

## Not in scope

No change to `guidance.md`, the coverage/turn1/research/revision task strings,
Stage 0.5, 1, 2, `shared/`, `run.sh`, or `tools/eval/`.

## Tests (mocked; no network, no real model)

- turn2's and turn3's request tasks equal the new texts exactly.
- turn3's request input contains `turn2_review` with each pass's verbatim
  `reason` and `changes`, appended after `searches_so_far`; turn1 and turn2
  inputs have no `turn2_review`; with `SCANNER_PLAYBOOK_LOOP_PASSES=2` it has two
  entries in order.
- turn3 removes an explained built-in and an explained additional class: both
  gone everywhere (decision, selection, plan, overlay, class-decision); the
  removed additional class gets no research call.
- turn3 includes an explained new built-in and an explained new additional
  class: both present; the new additional class is researched; record `added`.
- An unexplained removal stays selected; an unexplained inclusion is not added;
  both in `unexplained`.
- A kept class returned with a blank reason passes validation and keeps its
  earlier reason; a newly included class with a blank reason fails validation.
- A kept class returned with a different definition keeps the earlier one.
- Empty result: earlier set kept, `prune_rejected: 'empty'`.
- turn1 and turn2 still restore omitted classes.
- All existing tests pass, including the Stage 0.5 golden.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, judgement calls, and each
command's pass/fail counts verbatim.
