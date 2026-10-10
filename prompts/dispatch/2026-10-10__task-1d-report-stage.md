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
