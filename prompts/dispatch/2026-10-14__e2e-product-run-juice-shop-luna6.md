# Run brief: end-to-end product run on Juice Shop, GPT-6 Luna

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Scoring is a separate step run
by the orchestrator after the scan.

Owner request, 2026-10-14: one full end-to-end run of the `secscan` CLI on the
blind Juice Shop copy with the Task 1d report (PR #67), the scanner's own inputs
answered by the owner, eval scores reported separately, and the run's
`findings.json` and `report.html` delivered.

## Inputs (owner's answers to the scanner's prompts)

| Prompt | Answer |
|---|---|
| Scan this repository? | `target-apps/juice-shop-blind` |
| Save reports to? | scanner default, `<target>/.secscan` |
| Exclude anything? | `models/challenge.ts`, `lib/antiCheat.ts`, `data/datacreator.ts` (required: the product profile has no seed denylist) |
| Budget in USD? | 5 |
| Playbook web search | unrestricted (product default) |
| Round two | start with the agent's 20 classes unchanged |

## Procedure

1. Verify the tree: merge-base with main, scanner diff against main limited to the
   report module and CLI hook.
2. Phase 1: run the CLI in a pseudo-terminal through recon, the playbook agent and
   planning; answer only the reports prompt (Enter) and round two (`q`).
3. Gate before any hunt spend: the three excluded files absent from the read
   allowlist, read audit, lane plan, scan plan and file signals.
4. Phase 2: `secscan scan <target> --resume <run-id> --yes`, detached.
5. Verify the report against Stage 2's output (every finding, location equals the
   trace's last step).
6. Score with `tools/scan-benchmark/score_scanner.py`, re-base to 97 with the
   answer-key repo's `analysis/rebase-97.py`; aggregates only in this repository.
7. Archive the run in the answer-key repo (`runs/`), append one row to
   `results/eval-history/scanner.jsonl`.

Result: `scanner-2026-10-14-luna6-e2e-product` in the eval history.
