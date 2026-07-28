# Tools

## `scanner/` — the pipeline

| Directory | Stage | Notes |
|---|---|---|
| `stage0-recon/` | 0 | Recon |
| `stage05-lane-selector/` | 0.5 | **v1** — category-themed lanes, many files each |
| `stage05-lane-selector-perfile/` | 0.5 | **v2** — one lane per file |
| `stage1-budget-governor/` | 1 | Budget planning (v1 path) |
| `stage2-hunt-lanes/` | 2 | **v1** — one lane per category theme |
| `stage2-hunt-lanes-perfile/` | 2 | **v2** — one lane per file |
| `stage3-validate/` | 3 | Blind adversarial validation (consumes v1 output) |

v1 and v2 are both live. v2 is an alternative approach under evaluation, not a
replacement — v1 is preserved so the two can be compared. Do not delete or
modify v1 when working on v2.

Run through `scanner/run.sh <provider> <stage|all|all-v2>`. Every stage writes to
`scanner/runs/<provider>/<stage>/`, so a run under one model can never overwrite
another's evidence. Those artifacts are committed; only `logs/` is gitignored.
Archive outputs after a run (`archive-run` skill).

Which model a run uses is chosen at runtime from `scanner/shared/models.json`
(default `luna` / `gpt-5.6-luna`); no model id appears in the stage sources. See
`docs/architecture/multi-model-architecture.md`.

**Inter-stage paths resolve through `runPath(provider, stage)`** in
`scanner/shared/run-paths.ts`, never a literal. Moving or renaming anything
under `scanner/` still breaks the pipeline unless every reference is updated.

## `eval/` — measurement

Scoring, cost modelling, usage tracking and report generation.
See `eval/README.md`.

## `scan-benchmark/` — scoring engine

`score.py` holds the file/line matching logic (`file_match`, `LINE_SLACK`) that
the eval scripts import. Kept at this path because several scripts and docs
reference it directly.

## `blind-development/`

`split_answer_key.py` — separates the answer key from the target app so the
scanner can be developed against a copy that does not contain its own answers.
