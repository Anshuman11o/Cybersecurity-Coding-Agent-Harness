# Task 1c: models, limits, run-start confirmation, progress (productization plan §2.5, §2.6, §2.7)

Plan: `docs/architecture/productization-plan.md`, Part 2 §2.5–§2.7, Step 1 task 1c.
Implementer: one Claude session, on the files below only; Task 1b (recon,
signals, file selection) runs in parallel on disjoint files.

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.**

## Files owned

`shared/models.ts`, `shared/models.json` (format only), `shared/provider.ts`,
`stage1-budget-governor/**`, `run.sh`, new `tools/scanner/cli/`, and in Stage 2
`hunt-executor.ts` only the lane scheduling, spend gate and progress code
(never the prompt or schema functions). Append-only in `shared/guard.test.ts`.

## Contract

| Piece | Where | Decides |
|---|---|---|
| Limits resolver | `stage1-budget-governor/src/limits.ts` | `SCANNER_MAX_COST`, `SCANNER_MAX_FILES`, `SCANNER_MAX_FILE_SIZE`, `SCANNER_TIMEOUT`, `HUNT_CONCURRENCY`, `SCANNER_PATHS/INCLUDE/EXCLUDE`; admission; concurrency derivation. One resolver for Stage 1, Stage 2 and the CLI. |
| Scan plan | `stage1-budget-governor/src/scan-plan.ts` → `scan-plan.json` | admitted lanes (priced) and excluded lanes (with reason). `budget-plan-v2.json` is unchanged. |
| Spend gate | `stage1-budget-governor/src/spend-gate.ts` | whether Stage 2 may start the next lane: cap, deadline, calibration. |
| Status files | `stage1-budget-governor/src/run-status.ts` | `progress.json` (live) and `run-status.json` (end), written by Stage 2. |
| Run record | `cli/src/run-record.ts` → `<run>/run-record.json` | the Task 1d hand-off: COMPLETE/INCOMPLETE, reasons, unscanned list, spend. |

## Required behaviour

- `secscan models` lists every registry entry with price and measured/unmeasured.
  Measured comes from a `benchmark` block in `models.json`, pinned to
  `docs/benchmarking-results.md` by the guard test.
- `--model <key>`; a user overlay (`--models-file`); a generic OpenAI-compatible
  entry (`--base-url --model --api-key-env --price`). Overlays and the generic
  entry are always unmeasured, never replace a shipped key, and the generic
  entry never defaults to a vendor's credential variable.
- No model id, endpoint or credential variable in code.
- `--max-cost` is a hard stop at lane boundaries; `--max-files`,
  `--max-file-size`, `--timeout`, `--concurrency` (derived by default),
  include/exclude globs and `--paths`.
- A limit or Ctrl-C ends cleanly, records INCOMPLETE plus the unscanned list,
  and is resumable with `--resume`.
- The confirmation screen from §2.7 with `[e]`, `[s]`, `[q]`; `--yes`;
  `secscan.config.json`, which may not name an endpoint, credential variable or
  overlay. Live progress and spend.
- Benchmark profile unchanged when no limit is set.

## Verification (orchestrator)

1. `guard.test.ts`, the Stage 1 tests (`test-harness.ts`, `limits.test.ts`),
   `cli.test.ts`, `loop.test.ts`, `test-breakdown.ts`; `tsc --noEmit` for Stage 1,
   Stage 2 and the CLI.
2. Benchmark regression: Stage 1 on the committed luna Stage 0/0.5 artifacts →
   `budget-plan-v2.json` identical apart from `generated_at`. Stage 2 old tree vs
   new tree on the same lanes against a local fake endpoint at concurrency 1 →
   `candidate-findings.json` identical, `budget-consumption.json` identical
   apart from timing.
3. Product end to end against a fake endpoint on a small repo outside this
   repository: cap hit then resume, Ctrl-C once (clean stop) and twice (abort),
   `--timeout`, a failing lane retried on resume, `--max-files` raised on resume,
   the interactive `[s]`/`[e]`/`[q]` flow in a pseudo-terminal, and Ctrl-C through
   `run.sh`'s process group.
4. One small real run with the default model and a cap, to compare estimate and
   spend.
