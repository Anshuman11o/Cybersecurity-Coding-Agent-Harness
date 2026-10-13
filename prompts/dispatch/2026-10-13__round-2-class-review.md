# Round 2 class review implementation

Standing constraint: never search for, read, or reference any answer-key or ground-truth material anywhere on this machine. Work only in the harness checkout. No paid model calls; all model/web tests use mocks. Do not edit benchmark history or frozen playbook architecture.

Implement docs/architecture/round-2-class-review.md in one PR, following its decisions and defaults. The agent remains always on for product runs; lab and benchmark behavior stays unchanged. Failure recovery from an initial agent stage failure is deferred as specified.

## Work ownership

- Review engine: stage-playbook-agent/src/review.ts and tests, package review entry point, shared/playbook-overlay.ts write helpers and tests. Reuse current research, cache, meter and validation. Preserve valid selection/meta on failed edits. Resolve and research calls are budget reserved and booked exactly once, including failure/cancellation. Save immutable agent selection and review audit.
- Planning and execution: stage1-budget-governor risk order and budget thresholds, stage2-hunt-lanes-perfile plan order and full-ledger estimate basis, focused tests. Product only risk order; lab artifacts must remain byte-identical.
- CLI: injectable round2.ts, flags/config, confirmation summary, secscan integration, run record, progress rendering and tests. All class edits re-run Stage 0.5 and Stage 1 without model calls. Resume freezes classes after hunt starts. Noninteractive requested-add failures stop before hunt.
- Integration: independently inspect the final diff; run required suites and deterministic baseline comparisons. Guard benchmark records against review edits. Document measured re-plan timing, limitations, test evidence and exact final interface.

## Shared contracts

Coordinate exported APIs directly before integrating. Artifacts stay under runPath(provider, 'stage-playbook-agent'). Class selection preserves existing schema. New scan-plan fields are product-only: order_basis, input_threshold_usd and first_start_usd. The confirmation budget uses total ledger spend plus remaining scan cost; start threshold is spent plus first remaining lane chunks times U. No classes selected disables start.

## Verification

Run stage-playbook-agent, stage0-recon, Stage 0.5 golden fixture, stage1-budget-governor, stage2 affected tests, cli, shared guard and foundation. Test every budget boundary and ledger failure path, scripted edits and resume behavior. Compare lab lane output and scan plan admitted order with baseline main. Verify git merge-base HEAD origin/main and actual source before creating the PR. Do not claim live inference or accuracy validation.
