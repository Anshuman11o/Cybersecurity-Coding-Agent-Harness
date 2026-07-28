# Scoring a run

`eval-framework.md` defines *what* is measured and why. This is *how* — where the
answer key is, exactly how each number is computed, and the three ways the
numbers mislead if read plainly.

## Where the answer key is, and why the eval script is not here

The answer key is **not in this repository and must never be**. It lives in a
separate private repo, attached to a session on demand:

    <answer-key-repo>/answer-key.json  →  .benchmark_ground_truth   (98 entries)

Entry shape: `challengeKey`, `category`, `file`, `line`, `owasp_codes`,
`solveCondition`, `referenceCorrectFix`, `exploitTest`, `confidence`.

**The scoring script also lives outside this repo**, alongside the answer key. It
reads ground truth, so keeping it here would put a ground-truth reader in the
tree the coding agent works in. Archived runs, their eval JSON, and any located
analysis go to the answer-key repo under `runs/` and `analysis/`.

What may live here: aggregate metrics with no location attached. What may not:
any pairing of a benchmark entry with a file and line, any per-entry hit/miss
table, any verbatim ground-truth source line. See `blind-development.md`.

## The metrics, precisely

`LINE_SLACK = 15`, defined in `tools/scan-benchmark/score.py:28` and mirrored at
`validator-orchestrator.ts:36`.

A finding matches a ground-truth entry when some step of its `trace` is in the
entry's file. Three tightening position tolerances, each a strict subset of the
one above:

| Metric | Position test | Denominator |
|---|---|---|
| **File-level** | same file | 98 entries |
| **Localization** | same file, within ±15 lines | 98 entries |
| **Recall** | same file, **exact line** | 98 entries |

Each has a **category-aware** and a **category-blind** form. Category-aware also
requires the finding's `categories[]` (OWASP code strings) to intersect the
entry's `owasp_codes`. Unqualified "recall" and "localization" mean the
category-aware form.

**Precision proxy** is per finding, not per entry:

- *category-blind* = findings within ±15 lines of any entry / all findings
- *category-aware* = same, plus a code intersection / all findings

It is a proxy because a finding outside the 98 may still be a real defect; the
benchmark cannot tell.

**Hedging rate** = mean vulnerability classes per finding. Mandatory alongside
recall: matching is by set intersection, so a finding naming more classes carries
more codes and matches more entries without finding anything new. Before the
class model this was exactly 1.000.

**Per-class recall** groups entries by class via `shared/vuln-classes.json`
(code → class). An entry spanning two classes counts toward both, so the per-class
totals sum to more than 98.

### A discrepancy to be aware of

`eval-framework.md:57` defines localization as *"matched findings within
line-slack / **file-matched findings**"*. What is implemented, and what every run
so far reports, is **per ground-truth entry over all 98**. The implemented form is
the more useful one and all runs are mutually comparable, but the doc and the
practice disagree. Treat the implementation as authoritative until the doc is
reconciled.

## Validate the scorer before trusting a new number

Any reimplementation of the scoring logic must first **reproduce the previous
run's published numbers exactly** before being run against a new one. Point it at
the archived `candidate-findings.json` and the registry as it stood for that run
(`git show <sha>:tools/scanner/shared/vuln-classes.json` — the registry changes,
and per-class grouping depends on it).

If the replay does not match to the unit, the scorer is wrong, not the run.

## Three ways these numbers mislead

**1. Recall is location-weighted, not challenge-weighted.** The 98 entries occupy
only **67 distinct (file, line) locations**. The three most crowded carry 11, 8
and 5 — 24 entries at 3 lines. One line landing or slipping moves the headline by
up to 11 points, with no change in what the scanner actually detected.

This is not hypothetical. Between the two runs of 2026-07-28, scored recall fell
5 points; excluding the single 11-entry location it **rose** 5. The sign of the
result flipped on one line. Always report the distinct-location count alongside
recall, and treat small deltas as noise unless a diagnostic independent of
labelling moved too.

**2. Category-aware metrics move with labelling, not detection.** If scored
recall rises while category-blind recall is flat, the change improved labelling
and found nothing new. That is a legitimate result but must be reported as such.
Read category-blind recall, category-blind localization and file-level together —
all three are independent of the label.

**3. Precision has nothing downstream to recover it in v2.** Stage 3 reads the v1
output. Any change that raises emission lowers precision with no validator to
claw it back.

## Reporting

The comparison table every run report carries:

| Metric | This run | Baseline | Target |
|---|---|---|---|
| Recall (file + exact line + category) | | | ≥90% |
| Localization (±15 lines) | | | ≥90% |
| File-level (any line) | | | — |
| Precision proxy (category-aware) | | | ≥95% |
| Hedging | | | baseline 1.000 |

Plus, because the table above is three-quarters category-aware: category-blind
recall, category-blind localization, lanes emitting ≥1 finding, confidence
distribution, per-class recall, tokens in/out, and cost.

Targets come from `eval-framework.md`'s five-tool reference benchmark. No run has
met any of them yet.
