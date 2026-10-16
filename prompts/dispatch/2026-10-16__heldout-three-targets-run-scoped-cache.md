# Run brief: three held-out targets after the run-scoped playbook cache, 2026-10-16

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Scoring is a separate step run
by the orchestrator after the scans.

Owner request: after the playbook cache became run-scoped
(`2026-10-16__run-scoped-playbook-cache.md`), re-run AI Goat, AndroGoat and
SmartBugs on the product flow and report eval scores. CASTLE is dropped from
testing for now: 108 of its 150 ground-truth entries carry no class name, so a
class-matched score cannot be measured on it until the eval compares at a level
both sides label.

## Inputs (same for every target, same as the 2026-10-15 runs)

| Prompt | Answer |
|---|---|
| Model | `luna6` (GPT-6 Luna) |
| Save reports to? | scanner default, `<target>/.secscan` |
| Exclude anything? | nothing |
| Budget in USD? | 5 |
| Playbook web search | unrestricted (product default) |
| Round two | agent's classes unchanged (`--yes`, no class edits) |

Targets (public, pinned, fresh clones with no `.secscan`): aigoat-clean-LLM
`9c62129`, androgoat-clean-mobile `8abc7a6`, smartbugs-clean-solidity `6d09946`.
Harness: `claude/playbook-cache-per-run` at `c414875`, merge-base with main
`d299ee2`. In force, confirmed by grep: per-call budget holds (`91eb174`),
language-wide agent classes (`c50ff09`), class-name scoring default (`c3ccb8c`),
run-scoped playbook cache (`c414875`).

## Procedure

1. Per target, detached (`setsid nohup`):
   `secscan scan <target> --model luna6 --budget 5 --yes --no-open`.
2. Wait for all three to exit; no intervention.
3. Confirm each run's playbook plan shows every agent-added class as researched
   in this run (no cache hits from another run).
4. Score with `tools/scan-benchmark/score_scanner.py` (class-name matching)
   against each target's private export; archive in each private answer-key
   repo; aggregate rows only here.
