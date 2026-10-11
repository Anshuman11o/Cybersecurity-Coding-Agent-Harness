# Task 1b evaluation run (plan Part 3 rows for 1b)

Directive from the owner after PR #57 merged: run task 1b's Part 3 rows on
Juice Shop with luna. Free stage evals first; the paid benchmark run launched
with `setsid nohup`; scored blind with `tools/scan-benchmark/score_scanner.py`
in a separate step; archived with `archive-run`; aggregates only in this repo.

## Rows and pass conditions (plan §3.2, Part 5 task table)

| Row | Checks change | Pass condition |
|---|---|---|
| Recon | recon v3: architecture call, auth by real names, Express as enricher, tool-calling probe | all languages and frameworks detected; ≥ 90% of entry points; ≥ 90% of auth mechanisms named and mapped to the right routes; coverage no lower than today (`score_stage0.py`); 0 reads outside the root |
| Lane selector | file selection, test skip, skip reasons, inventory-driven selector | hunt + skip = inventory; every skip has a reason; identical input → identical plan; `preflight_class_coverage.py` 100% of reachable entries hunt with the right class |
| Hunt / release bar | everything above, end to end | 0 failed or blocked lanes; line fidelity; recall and localization against run 6 and the 1a run; release bar 85% localization |

## How it ran

- Tree `d776714`, merge-base = HEAD; each 1b change grepped in source.
- `SCANNER_RUNS_ROOT` redirected to a scratch dir; committed `tools/scanner/runs/` untouched.
- Stage 0 fresh with luna (scratch `--import` usage hook for its token count),
  then 0.5 and 1 (free), a second 0.5 on a copy of Stage 0 for determinism,
  then `HUNT_CONCURRENCY=32 setsid nohup run.sh luna stage2-hunt-lanes-perfile && run.sh luna reconcile-v2`
  with the default arm (`trace`, effort `high`, cap 64000).
- Scorers run with output to the private store; only aggregates read back.

Results: `docs/benchmarking-results.md` §4.2 and eval-history row
`scanner-2026-10-11-luna-task1b`.
