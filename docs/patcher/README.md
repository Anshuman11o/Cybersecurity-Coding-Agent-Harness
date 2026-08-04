# Patcher / Verifier — harness-side documentation

Everything here is **answer-key free** and readable by any harness session,
including agents that build or run the patcher.

| Document | What it covers |
|---|---|
| `EVAL-METRICS.md` | **What the patcher is judged on**, in aggregate: the two axes, the verdict buckets, and which architectural lever each number moves |
| `DATASET-READINESS-AND-HANDOFF.md` | Whether the target app can be patched today (it cannot — three blockers), and the scanner→patcher data structure |
| `VERIFICATION-TECHNIQUES.md` | Candidate in-sandbox self-checks, both axes. **Unvalidated** — the adopted set must be chosen empirically |
| `contracts/` | Mirrored JSON Schemas for what the patcher and verifier emit |

## The agent itself

The remediation agent architecture — the task-wise loop, its prompts, its
gates, and the sandbox that enforces the blind boundary — lives in code at
**[`tools/patcher/`](../../tools/patcher/)**. Start with its `README.md` for the
shape and `ARCHITECTURE.md` for the loop specification.

It reads a bug report and a remediation playbook, and emits two things: an
aggregated report and one patched codebase. The numbers it produces are
in-sandbox self-measurements and are not eval results; scoring happens
afterwards, sighted, against the tree.

## What is NOT here, deliberately

Ground truth, scoring, and metric definitions live in the private answer-key
repo, because they pair challenge identifiers with files and lines:

- `patcher-ground-truth/README.md` — protocol and eval map
- `patcher-ground-truth/METRICS.md` — full metric catalogue and derivation
- `patcher-ground-truth/METRICS-V1.md` — the subset to build first
- `patcher-ground-truth/ORACLE-INVENTORY.md` — measured oracle coverage
- `patcher-ground-truth/TEST-COVERAGE-PLAN.md` — workflow-oracle gaps
- `docs/CONTAMINATION-CLEANUP.md` — deferred split-leak work order

No agent building or running the harness should open that repo. See the
blind-development boundary in the root `CLAUDE.md`.

## Contracts are mirrors

`contracts/*.schema.json` are copies. The authoritative versions live with the
scorer in the answer-key repo. They contain no challenge, file, or line
reference, which is why they are safe to mirror — if the two ever diverge, the
scorer's copy wins.
