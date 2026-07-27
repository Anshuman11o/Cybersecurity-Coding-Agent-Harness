# Stage 3 — Validate

`tools/scanner/stage3-validate/src/validator-orchestrator.ts`

Independent adversarial re-check of each candidate finding.

## Input
One consolidated finding's claim — trace and impact only. The hunting lane's
reasoning transcript and lane identity are deliberately withheld so the check is
blind. Reads Stage 2 v1's `candidate-findings.json`.

Overlapping candidates are consolidated first, using the same 15-line slack the
scorer uses so consolidation and scoring agree on what counts as one finding.

## Output
`output/validated-findings.json`: `consolidated_id`, `original_finding_ids[]`,
`original_lane_ids[]`, `verdict`, `validator_evidence`, plus carried-through
title, trace and severity.

## Status
Built but **not current**. The committed output predates the target-app cleanup
and the v2 architecture, and it consumes v1's Stage 2 output rather than v2's.
Treat any numbers from it as stale.

An agreed redesign is pending: move from CONFIRMED/REJECTED verdicts to an
annotator model that reports confidence and concerns without the power to
reject. Rationale — a validator that can silently kill a true finding is a
recall risk that is hard to detect after the fact.

## Why the stage exists
The benchmarked tool that scored highest paired parallel hunting with a separate
blind validator. The party that produces a finding should not be the party that
confirms it.
