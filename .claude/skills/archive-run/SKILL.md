---
name: archive-run
description: Archive a completed scanner run before its outputs are overwritten. Use immediately after any Stage 0-3 run finishes, or when asked to record, archive, or log a run's results. Captures stage outputs, run logs, and eval detail into the private run store, appends the eval-history record, and regenerates the report.
---

# Archive a scanner run

Stage outputs are gitignored and the next run overwrites them in place. A run
that is not archived is unrecoverable. One run has already been lost this way
(~3 million tokens of completed work).

Run every step. Skipping a step silently loses something.

## 1. Gather run identity

    SHA=$(git rev-parse --short HEAD)
    TS=$(date -u +%Y-%m-%dT%H-%MZ)
    RUN="/home/user/harness-private/runs/${TS}__<variant>__${SHA}"

`<variant>` names the architecture that ran, e.g. `stage2-v2-perfile` or
`stage0-2-v1`. The directory name must sort chronologically, name the variant,
and pin the commit, so any number can be traced back to reproducible inputs.

## 2. Snapshot every stage output

Copy `tools/scanner/*/output/` into `$RUN/<stage>/`, one subdirectory per stage.
Include stages that did not run in this pass but whose outputs were consumed as
inputs — the run is not reproducible without them. Label carried-over outputs as
such in the manifest.

## 3. Copy the run logs

Scan logs live in `/tmp` and die with the container. Copy every log the run
produced. If a run was restarted, copy each segment; they are the only record of
retries, rate limits and partial failures.

## 4. Copy eval detail

If the run was scored, copy the per-challenge hit/miss detail. **This file pairs
challenge identifiers with ground-truth locations and must never enter the
scanner repository.** The private store is the only correct home for it.

## 5. Write `MANIFEST.md`

Make the run self-describing without opening any JSON:

- date, harness commit, architecture variant, target, ground-truth set, model
- which stages actually ran, and which outputs were carried over
- headline metrics (recall, localization, precision proxy, findings, tokens,
  lanes completed, failures)
- **defects in force during the run** — a number without its caveats will be
  re-read later as a clean measurement
- provenance notes: restarts, what was lost, what was resumed

## 6. Append to eval history

Add one line to `results/eval-history/scanner.jsonl` with the universal fields
from `docs/protocols/eval-framework.md`: run_id, timestamp, component, version,
ground_truth_set, models_used, tokens, wall_clock_time, metrics, notes.

Never rewrite a historical record. If a run is later found invalid, annotate it
in `notes` — do not edit or delete it.

## 7. Regenerate the report

    python3 tools/eval/generate_eval_report.py

The PDF is generated from the history files, never hand-edited.

## 8. Save the dispatch prompt

Copy the prompt that drove the run into `prompts/dispatch/` as
`<YYYY-MM-DD>__<short-description>.md`. These prompts are the architecture of
the LLM stages; losing them loses reproducibility.

## 9. Commit both repositories

Commit the private store (run archive) and the scanner repository (eval history,
report, prompt) separately. They have different audiences and different
disclosure rules.

## Verify before reporting done

- the archive contains every stage output, every log, and the manifest
- `results/eval-history/scanner.jsonl` has exactly one new line
- no challenge identifier or ground-truth location entered the scanner repo:

      grep -rE "\b[a-zA-Z]+Challenge\b" results/ docs/ prompts/
