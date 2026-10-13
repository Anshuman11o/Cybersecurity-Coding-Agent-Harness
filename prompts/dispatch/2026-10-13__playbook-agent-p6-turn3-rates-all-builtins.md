# Dispatch — Playbook agent precision P6: turn3 rates every built-in; "low" needs a source check

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

Branch: `claude-anshuman/playbook-agent-precision` (builds on b7d0e6c, P5).

## Why

With source evidence (P4/P5), turn3's removals are mostly right, but turn3 only
re-rates classes already selected: a built-in the earlier calls left out is
never judged against the code. And "low" currently means "recon shows only that
the feature exists", a weak bar for removing a class. P6 makes turn3 a full
re-selection over every built-in from the code, and requires a source check
before rating low.

## Change 1 — turn3 text

Replace `tasks.turn3` with exactly:

    Re-think the class selection using turn2_review (turn2's reasoning and the recon evidence it named for each class it added), the current class list, recon's data and the source code in source_excerpts. Return every built-in class, whether selected or not, and every currently selected additional class, each with a likelihood: how likely it is that this target contains an exploitable vulnerability of that class, judged from that evidence. Use high when the source or recon shows a concrete sink, risky pattern, unsafe configuration or missing control that the class hunts for; medium when they show the surface and a plausible attacker-reachable path to such a weakness; low only when you have checked the relevant source and it shows no such sink or path, or shows every one properly controlled. The final selection is every class rated high or medium; classes rated low are removed. Include an additional class not selected only when the source or recon shows such evidence, and list it in changes with the evidence and why. Return the final decision in the same schema.

No other task string, the `about` string or `guidance.md` changes.

## Change 2 — merge: an unselected built-in rated high/medium is included

In `rethinkDecision` (agent.ts), one rule changes:

- A **built-in** id not selected before turn3 and returned with `high` or
  `medium` is **included** (taking turn3's entry, as for any inclusion), with
  or without a `changes` entry: the rating is its explanation, as it already is
  for a low-rated removal. It is listed in the turn's `added`.
- Everything else is unchanged: a new **additional** class still needs an
  explained `changes` entry and a high/medium rating; a selected id rated low is
  removed; a selected id omitted is removed only if explained, else
  `unexplained` and kept; a new id rated low is not included and not listed as
  unexplained; empty-result rejection; `ratings` records every returned id.

## README

turn3 row and merge paragraph: turn3 rates every built-in; an unselected
built-in rated high/medium is included; low requires a source check.

## Tests (mocked; no network)

- turn3's task equals the new text.
- An unselected built-in returned medium with no `changes` entry is included
  and listed in `added`; one returned low is not included and not unexplained.
- A new additional class rated high without a `changes` entry is still not
  included (listed in `unexplained`).
- Existing turn3 behaviours hold; all existing tests pass, including the Stage
  0.5 golden and guard.test.ts.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, judgement calls, and each
command's pass/fail counts verbatim.
