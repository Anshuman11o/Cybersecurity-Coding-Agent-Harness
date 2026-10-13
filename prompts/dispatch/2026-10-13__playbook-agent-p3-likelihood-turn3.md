# Dispatch — Playbook agent precision P3: turn3 rates likelihood; code drops "low"

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

Branch: `claude-anshuman/playbook-agent-precision` (builds on 8f07d9e).

## Why

Every decision call asks whether a class *applies*, meaning whether its surface exists.
Recon is summary-level and almost every surface exists in a real application,
so the agent's reasons are "the feature is present; exposure is unknown" and nearly every
built-in is selected. The question is changed for the final turn only: how
likely is it that this target *contains* an exploitable weakness of the class,
judged from recon's evidence. Classes rated low are dropped by code.

## Change — `tools/scanner/stage-playbook-agent/src/agent.ts` (+ README, tests)

1. Replace `tasks.turn3` with exactly:

       Re-think the class selection using turn2_review (turn2's reasoning and the recon evidence it named for each class it added), the current class list and recon's data. For every class you return, set likelihood: how likely it is that this target contains an exploitable vulnerability of that class, judged only from recon's evidence. Use high when recon shows a concrete sink, risky pattern, unsafe configuration or missing control that the class hunts for; medium when recon shows the surface and a plausible attacker-reachable path to such a weakness; low when recon shows only that the feature, technology or dependency exists. Return every currently selected class with its likelihood; classes rated low are removed. Include a class not selected only when recon shows such evidence, and list it in changes with the evidence and why. Return the final decision in the same schema.

   No other task string and no `guidance.md` change.

2. Schema: turn3 alone uses a decision schema whose `builtin_classes` and
   `classes` items also require `likelihood: { type: 'string', enum: ['high', 'medium', 'low'] }`.
   Every other call's schema is unchanged. (Add a third schema next to
   `coverage` / `turn`; `decisionSchema` takes the extra option.) Validation:
   on turn3 every returned entry must carry one of the three values.

3. Merge (`rethinkDecision`), changes only:
   - An id selected before turn3 and returned with `likelihood: 'low'` is
     **removed** (the rating is its explanation; no `changes` entry needed).
   - An id selected before turn3 and returned with high/medium is kept, with its
     earlier definition and reason, as today.
   - An id selected before turn3 that turn3 omits: as today (removed only if
     explained in `changes`, otherwise `unexplained` and kept).
   - A new id is included only if explained in `changes` (as today) **and**
     rated high or medium; a new id rated low is not included and not listed
     as unexplained.
   - Empty-result rejection as today.
   - The turn3 record gains `ratings: Record<string, 'high' | 'medium' | 'low'>`
     (every id turn3 returned → its rating).
   - Progress line unchanged in shape: `added=<ids|-> removed=<ids|->`.

4. README: turn3 row and the merge paragraph describe the likelihood rating,
   the low-rated removal, and the `ratings` turn field.

## Not in scope

No change to coverage/turn1/turn2/research/revision texts, guidance.md,
Stage 0.5/1/2, `shared/`, `run.sh`, `tools/eval/`.

## Tests (mocked; no network)

- turn3's request task equals the new text; turn3's request schema requires
  `likelihood` on both item kinds with the three-value enum; coverage/turn1/turn2
  schemas do not have it.
- A built-in and an additional class returned low are removed everywhere
  (decision, selection, plan, overlay, class-decision); the additional class is
  not researched; `ratings` recorded.
- High/medium keep; a new id with an explained change and medium is included;
  a new explained id rated low is not included.
- Existing turn3 behaviours (unexplained omission kept, empty rejection, kept
  definition wins, blank kept reason allowed) still hold.
- All existing tests pass, including the Stage 0.5 golden.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, judgement calls, and each
command's pass/fail counts verbatim.
