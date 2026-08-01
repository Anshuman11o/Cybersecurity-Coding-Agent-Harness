# Dispatch — run 6: Stage 2 per-lane trace loop at high reasoning effort

Executed 2026-08-01 against `20889d4`. Recorded here because a dispatch prompt is
the architecture of an LLM stage, and losing it loses reproducibility. It is
never read at runtime.

## What was asked for

Run the full 541-lane v2 pipeline on `luna` with Stage 2's newly shipped arm, to
find out whether the 67.0% the 40-lane platform measured holds on the whole
corpus.

## The plan, as specified

- **Provider** `luna` / `gpt-5.6-luna`.
- **Stage 0 and Stage 0.5: reuse, do not re-run.** Run 3's artifacts, which are
  the ones run 5 used. This is what makes the comparison single-variable: the
  lane manifest, the dispositions and the per-lane class assignments are
  byte-identical, so the only thing that moves is Stage 2's arm.
- **Stage 1: must account for usage.** It projected one call per chunk and input
  tokens only, both of which are wrong under a loop and at a high reasoning
  effort. Fix before launching.
- **Stage 2: the variable under test.** `HUNT_LOOP=trace`, one follow-up turn,
  `reasoning_effort: high`, `max_output_tokens: 24000` — all defaults, so no env
  var is needed.
- **After the run:** report actual input, output and cost. No projection-versus-
  actual comparison; the number wanted afterwards is what it spent.
- Score and report recall, localization and the full run metric set.

## What was done before launching

Per `protocols/running-a-scan.md`, in order:

1. Branch restarted from the merged `main` so the tree that ran is the tree that
   was reviewed. Arm confirmed **by grepping the source**, not the commit log:
   `DEFAULT_LOOP_MODE = 'trace'`, registry `reasoning_effort: high` and
   `max_output_tokens: 24000`, merge fixes present, strict wording off.
2. `preflight` **PASS** — credits live, and the effort parameter confirmed going
   over the wire.
3. Stage 1 rewritten to project turns, output tokens and cost, and to report
   actual usage afterwards. Verified against run 5's manifest at 1,082 calls and
   $23.11, within 3% of an independent arm-scaled estimate.
4. Run 5's Stage 2 checkpoint moved aside **after** verifying it md5-identical to
   its archived copy — Stage 2 resumes from its output directory and would
   otherwise have skipped all 541 lanes and reported success.
5. Scorer validated by replaying run 5 and reproducing its published headline
   figures exactly, before being pointed at anything new.

## Concurrency

`HUNT_CONCURRENCY=32`, derived from this arm's own measured throughput —
~16,000 TPM per unit of concurrency at `reasoning_effort: high`, against the
~51,700 the runbook's default-effort calibration gives. 32 sits at ~26% of the
2M TPM ceiling. Deliberately under the runbook's 40–50% target: on a $20+ run,
time is the cheaper thing to spend. Result: 0 retries, 0 fatal.

## Result

Recall 69/97 = 71.1%, localization 86/97 = 88.7%, 553 findings, 9,618,943
tokens, $21.84, 13m04s, 541/541 lanes clean. Full entry in
`docs/run-history.md`; the line-budget caveat there is not optional reading.
