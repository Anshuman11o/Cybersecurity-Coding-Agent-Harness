# Run brief: four held-out targets, GPT-6 Luna, 2026-10-15

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Scoring is a separate step run
by the orchestrator after the scans.

Owner request: full scanner runs on the four held-out targets in parallel, on
the latest product flow (playbook agent, round-two class review, Task 1d
report, budgeting), with round-two inputs left unchanged; the orchestrator only
launches, waits and scores.

## Inputs (same for every target)

| Prompt | Answer |
|---|---|
| Model | `luna6` (GPT-6 Luna) |
| Save reports to? | scanner default, `<target>/.secscan` |
| Exclude anything? | nothing |
| Budget in USD? | 5 |
| Playbook web search | unrestricted (product default) |
| Round two | agent's classes unchanged (`--yes`, no class edits) |

Targets (public, pinned): aigoat-clean-LLM `9c62129`, androgoat-clean-mobile
`8abc7a6`, smartbugs-clean-solidity `6d09946`, castle-clean-c `4278a49`.
Harness: main `d299ee2`.

## Procedure

1. Clean harness worktree at main; merge-base and grep checks for terraform,
   key-material, kotlin, solidity and c support.
2. Per target, detached: `secscan scan <target> --model luna6 --budget 5 --yes --no-open`.
3. Wait for all four to exit; no intervention.
4. Score with `tools/scan-benchmark/score_scanner.py` against each target's
   private export; archive in each private answer-key repo; aggregate rows only
   here.

A fixed-class comparison (`run.sh ... all-v2`, `SCANNER_PLAYBOOK_AGENT` unset,
`--max-cost 10`) was launched first by mistake and completed; it is recorded as
a separate arm.

Results: `heldout-<target>-2026-10-15-luna6-{secscan,fixed-classes}` in the eval
history and the Held-out targets table.
