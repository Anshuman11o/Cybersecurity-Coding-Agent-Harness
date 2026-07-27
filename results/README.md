# Results

## `eval-history/` — the source of truth

Append-only JSONL, one line per evaluated run. Everything else in this directory
is derived from it.

- `scanner.jsonl` — runs of this harness's own scanner
- `external-baseline.jsonl` — the third-party tool comparison (frozen)

Never rewrite a historical record. If a run is later found invalid, annotate it
in its `notes` field. A rewritten history cannot be trusted to show a regression.

## `reports/`

Generated artifacts. Regenerate with:

    python3 tools/eval/generate_eval_report.py

Never hand-edit; the next regeneration overwrites it.

## `archive/`

Superseded results, kept for provenance rather than active use. Each archived
set carries its own README explaining what it was and what replaced it.

## What is NOT here

Raw scanner outputs from real runs. Those are gitignored in the stage
directories and archived to `/home/user/harness-private/runs/`, outside this
repository, because per-challenge results pair challenge identifiers with
ground-truth locations. See `docs/protocols/blind-development.md`.
