# Results

## `eval-history/` — the source of truth

Append-only JSONL, one line per evaluated run. Everything else in this directory
is derived from it.

- `scanner.jsonl` — runs of this harness's own scanner
- `patcher.jsonl` — runs of the patcher (v1 task loop, v2 waves, v3 chunks)
- `external-baseline.jsonl` — the third-party tool comparison (frozen)

Rows are **aggregate only**. A patcher row in particular is written by
`tools/patcher/src/archive_run.py`, which builds it from an allowlist of fields
and then re-checks the finished row for bug ids, challenge keys, `file:line`
references and source paths before writing. Do not hand-write a row; a hand-added
row is how the last blind-boundary breach got in, and
`tools/patcher/tests/test_archive_run.py` re-runs the guard over everything
committed here.

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
