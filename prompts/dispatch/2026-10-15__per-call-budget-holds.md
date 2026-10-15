# Per-call budget holds for the spend gate

Standing constraint: never search for, read, or reference any answer-key or ground-truth material anywhere on this machine. Work only in the harness checkout. No paid scans and no model API calls; every test uses synthetic numbers and fake clients.

## Problem

A product run ($5 cap, gpt-6-luna, 143 files, 8-9 classes per lane, concurrency 32) spent $1.04 of $5 and finished INCOMPLETE. Stage 1 priced one fixed reservation unit U per chunk (`shared/pricing.ts` `reservationUnitUsd`, the sum of every call's worst case in a chunk, about $0.11 with a 64,000-token output cap and ~3 calls), while real cost was about $0.016 per file. The gate (`stage1-budget-governor/src/spend-gate.ts`) held `chunks × U` per file until the file finished and made every retry reserve another U or fail its file at once. With 32 files in flight about $3.5 was held, so with ~$1 spent the cap read as full: 18 files failed on retry ("one more reservation unit for a retry would exceed the budget") and 80 never started.

## Approved fix (owner-approved)

1. **Hold per call, not per file.** Before each model call, hold that call's own worst case: its actual prompt bound (message bytes plus 32 bytes framing each; a token is at least a byte) at the upper input rate, plus the output cap at the output rate, with the long-context, tier and region multipliers (`callReservationUsd` beside `reservationUnitUsd`). Release the hold the moment the call returns, in the same synchronous step that books its real cost in the ledger. A file is admitted when there is room for its first call's hold.
2. **Retries wait instead of failing.** A call (first, follow-up or retry) that cannot get its hold while other calls are in flight waits for releases, as new files already do. It is refused for `max_cost` only when nothing else is in flight and `spent + hold > cap`.
3. **Fit concurrency to the budget.** Files in flight = `min(configured, max(1, floor(0.5 × (cap − spent) / maxCallHold)))`, re-evaluated as spend grows. No user-facing warning; record the value in progress, run-status and scan-plan metadata.
4. **Invariant:** `spent + sum(holds) <= cap` at all times, so the cap is never passed even if every call costs its full worst case. Unpriced models and `cap = null` behave exactly as before. Resuming an old scan plan (only `reservation_unit_usd`) still works. Keep `reservation_unit_usd` in the plan for compatibility, but stop using it as the gate unit; add the per-call figure alongside.
5. Do not touch v1 components (`stage2-hunt-lanes`, `stage05-lane-selector`). Benchmark-profile runs without a cap must behave exactly as before.

## Implementation notes

- `shared/pricing.ts`: `callPromptBytes`, `callReservationUsd`, `planCallReservationsUsd` (first-call and largest-call bounds from the same call-i bound as U). `reservationUnitUsd` is unchanged.
- `spend-gate.ts`: holds keyed per call; a file's first-call hold is taken at admission and handed to its first call; FIFO waiters; new files wait behind queued calls; `budgetConcurrency`; `release(hold, actual, book)` books and releases atomically.
- `call-policy.ts`: every attempt acquires its own hold, waits if needed, and backs off before acquiring (never holding while asleep). A no-usage response is booked at its own hold under a cap, and at U without one (unchanged).
- `hunt-executor.ts`: admission against `first_call_reservation_usd`; concurrency fitted against the larger of that and the largest hold a call has actually asked for. The plan's `call_reservation_usd` (largest call, assuming every earlier answer used the whole output cap) is recorded and serves as the fallback. A plan without per-call figures under a cap has them sized from the prompts at hunt start; an uncapped run never re-reads prompts for them.
- `scan-plan.ts`: `call_reservation_usd`, `first_call_reservation_usd`, `concurrency.effective`; product `first_start_usd` = spent + first-call hold. The CLI confirmation screen uses the same figure, and `chunks × U` only for older plans.

## Verification

- Gate unit tests: admission, seed handover, waiting retry granted on release, refusal only with nothing held, atomic release and booking, effective concurrency shrinks and never goes below 1.
- Simulation through the real policy, gate and admission loop: $5 cap, concurrency 32, 143 files, three calls per file at about $0.005 each with ~$0.035 holds and some retries: every file completes. Adversarial (every call costs exactly its hold): `spent + holds <= cap` at every send, admission and booking; the run stops cleanly with `max_cost`.
- Run every scanner suite: shared (guard and foundation), stage1, stage2-hunt-lanes-perfile, stage05-lane-selector-perfile, stage-playbook-agent, cli, report, and the stage0 test files through `npx tsx --test`.
- Update docs that describe the reservation unit so they describe the per-call hold.
