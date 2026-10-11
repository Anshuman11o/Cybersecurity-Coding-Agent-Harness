# Task 1d — report stage and Stage 2 schema additions (productization plan §2.9, Part 4)

Plan: `docs/architecture/productization-plan.md`, §2.9 and Part 4, Step 1 task 1d.
Implementer: one Claude session, on files disjoint from tasks 1b and 1c.

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.**

## Why

The scanner's only output today is `candidate-findings.json`. A user needs a
report they can act on: what was found, how sure the scanner is and why, where
exactly, and what the scan did not cover.

## Files owned

| Part | Files |
|---|---|
| Report stage | new `tools/scanner/report/` (not named `stage3-*`) |
| Stage 2 schema | `buildHuntSchema` and the output-field text of `buildHuntPrompt` in `stage2-hunt-lanes-perfile/src/hunt-executor.ts`; `src/types.ts`. Also, because the fields would otherwise be dropped: the pass-through in `normalizeTurnFindings`, and the merge rule in `mergeFindings` (union `cwe`, never remove a field). New test `src/fields.test.ts`. |
| Entry point | one added `report` stage in `run.sh` (`STAGES_V2`, after `reconcile-v2`) |
| Guard | append-only section in `shared/guard.test.ts` |

`shared/run-paths.ts` is not owned, so `report` is not added to `STAGES`; the
report directory is `join(RUNS_ROOT, provider, 'report')`, inside the same
provider-isolated tree.

## Required behaviour

**Stage 2 additions**, all required by the strict schema, all optional in the
type: `cwe[]` (normalized `CWE-<n>`), `severity_reason`, `confidence_reason`
`{ validation, assumptions[], summary }`, `attack_scenario`, `remediation`.
The six original output-field lines stay byte-identical and first; the new
lines are appended after them, with an explicit statement that the fields do
not gate reporting (a 0.2 finding still gets them). A malformed field is
dropped, never the finding.

**Report stage**, deterministic, no model call:

- reads Stage 2 findings, the Stage 0.5 coverage ledger and the usage record
  (`usage-v2.json` when fresh, else derived from `budget-consumption.json`)
- writes `report.html` (self-contained), `report.md`, `findings.json`,
  `findings.sarif` (SARIF 2.1.0, stable fingerprints) and a terminal summary
- sections and fields exactly as Parts 4.1 to 4.3
- locations from the lane; excerpts read from disk through the read guard
- local `path:line`; commit-pinned permalink when the GitHub repo and SHA are
  known and the file matches HEAD
- works on findings written before the new fields existed

## Verification (orchestrator)

1. `report/src/report.test.ts`, `stage2…/src/fields.test.ts`, `loop.test.ts`,
   `test-breakdown.ts` and `shared/guard.test.ts` pass; `tsc --noEmit` clean in
   `report/` and Stage 2.
2. Report row (§3.2), deterministic, on the committed luna run 6 artifacts
   (old findings, no new fields) with `SCANNER_RUNS_ROOT` pointed at a copy:
   - 100% of cited `file:line` locations resolve to the cited line
   - every finding has all §4.2 fields (absent explanation fields reported as such)
   - SARIF validates against the OASIS 2.1.0 schema (draft-04, formats enforced)
   - permalinks are commit-pinned and resolve
3. HTML checked in a browser at desktop and 390px widths, light and dark.

## After merge

Juice Shop Hunt-row regression (§3.2), because the Stage 2 prompt changed:
full `all-v2` luna run on the benchmark, scored blind by the scorer in a
separate step, compared with run 6 (recall 69/97, localization 86/97). Expect
higher output tokens: each finding now carries five more fields, re-emitted by
the trace loop's second turn; Stage 1's projection basis does not model that.

## Amendment 2026-10-11 — product run store (owner-approved), SARIF deferred

Added to this task at the owner's request, after review of the first version.

**Run store.** A product run's results move from
`<target>/.secscan/runs/<id>/<provider>/report/` to a designed layout:

```
<store>/                        <target>/.secscan, or --out DIR outside the target
├── .gitignore                  "*"
├── index.json                  one row per run, rebuilt from disk by the report stage
├── latest                      symlink to the newest reported run (latest.txt fallback)
└── runs/<run-id>/
    ├── report.html report.md findings.json findings.sarif run-record.json
    └── work/<provider>/<stage>/   stage internals (was: runs/<run-id>/<provider>/<stage>/)
```

- `run.sh` gains `--out DIR` and `--yes`. The store is created only after
  consent: a prompt on a terminal, `--yes` elsewhere, otherwise nothing is
  written. `--out` must lie outside the target and must be new, empty or already
  a store. A later stage of a run that does not exist is refused.
- `shared/run-context.ts` gains `outRoot`, `runDir` and `SCANNER_OUT`; product
  `runsRoot` becomes `<runDir>/work`. Benchmark unchanged, including the keys of
  `run_context` in its meta.json.
- One existing `guard.test.ts` assertion changes (product runsRoot path), plus
  appended checks.
- `report/src/runs-store.ts` and `report/src/runs.ts`: index, latest, list and
  prune (dry run without `--yes`; the newest run is never touched).
- `--out` inside the target was ruled out rather than supported, so Stage 0 and
  Stage 0.5 (task 1b's files) need no exclusion change.

**Integration with tasks 1b and 1c**, which merged to main while this task was
open (merged in, conflicts kept both sides):

- 1c's `run-record.json` is the run's manifest, at the top of the run directory;
  the report's own `run.json` from the first draft of this amendment was dropped
  rather than kept as a second manifest.
- The report reads 1c's hand-off (run record, Stage 2 `run-status.json`, Stage 1
  `scan-plan.json`): the pipeline's verdict and wording win; scope exclusions are
  skipped files, not missing ones; the confirmed directories, limits and cap are
  shown. The report's own derivation can only add an INCOMPLETE.
- The secscan CLI runs the report stage after the hunt (also on a stopped run),
  writes the run record to the run directory, gains `--out`, asks before
  creating the store, and shows where results go on the confirmation screen.
- Measured status, recall and localization come from the registry's `benchmark`
  block; `benchmark-reference.json` keeps only the precision proxy, pinned to the
  ledger by `guard.test.ts`.
- Fixed in passing: `main`'s `guard.test.ts` did not parse after the 1b/1c merge
  (an unclosed block), so no guard check ran there.

**SARIF field alignment: deferred** until the architecture is complete and the
eval runs are done, because some fields may be model-emitted. The analysis is in
`docs/architecture/report-sarif-alignment.md`; nothing in it is implemented.
