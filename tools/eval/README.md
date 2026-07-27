# Eval tooling

## Metric definitions in force

Both bars require the candidate's category to intersect the ground-truth entry's
categories.

| Metric | Definition |
|---|---|
| **Recall** | file match + **exact** ground-truth line + category match |
| **Localization** | file match + within **15 lines** + category match |
| **File-match rate** | right file, any line, any category — diagnostic only |
| **Precision proxy** | findings that localize to some ground-truth entry within 15 lines, over all findings |

Recall is deliberately the stricter bar. A scanner that names the wrong line
still hands a patcher the wrong place to edit.

"Precision proxy" is named a proxy because an unmatched finding is not
automatically wrong — it may be a real vulnerability outside the fixed benchmark
set. Those are tracked, not scored.

## Files

| File | Purpose |
|---|---|
| `generate_eval_report.py` | Renders the PDF from `results/eval-history/*.jsonl` |
| `cost-model.py` | Predicts token cost for a per-file scan, bucketed by file size |
| `usage-tracker.ts` | Emits per-lane predicted-vs-actual usage records |
| `usage-aggregator.py` | Aggregates those records after a run |

## Scoring scripts and the answer key

Scoring reads the answer key from outside this repository. The scripts are safe
to keep here — they contain no answers — but **their output is not**. Per-challenge
hit/miss detail belongs in the private run archive only.
