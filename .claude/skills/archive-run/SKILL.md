---
name: archive-run
description: Archive a completed scanner run before its outputs are overwritten. Use immediately after any Stage 0-3 run finishes, or when asked to record, archive, or log a run's results. Captures stage outputs, run logs, and eval detail into the private run store, appends the eval-history record, and regenerates the report.
---

# Archive a scanner run

The next run overwrites stage outputs in place. A run that is not archived is
unrecoverable. One run has already been lost this way (~3 million tokens of
completed work).

Run every step. Skipping a step silently loses something.

This skill covers **one step of the lifecycle**: the archive. Capturing the run's
identity before launch, and writing a score into a file after a sighted scoring
pass, are `record-run` and `docs/protocols/run-record-keeping.md`. Those are
where runs have actually been lost — including two patcher scores that were
produced and never written down.

Resolve the actual artifact root from the completed run's `meta.json`
`run_context` before copying anything. Do not infer it from a target name:

- Benchmark: `tools/scanner/runs/<provider>/<stage>/` by default.
- Product: `<reports-root>/runs/<run-id>/<provider>/<stage>/`, where
  `SCANNER_REPORTS_ROOT` may put reports outside both target and harness.
- `SCANNER_RUNS_ROOT` overrides either root; the recorded `runs_root` is authoritative.

Set `SOURCE_RUNS_ROOT` to that recorded root and `PROVIDER` to the recorded
provider. Require every consumed stage's metadata to agree on profile, target,
run id and root, or explain historical/carried-over metadata in the manifest.
Product artifacts stay outside the harness. Never copy target source or private
scoring details into the harness while archiving.

## 0. Before launching a run: clear the previous checkpoint

Stage 2 resumes from whatever is in its output directory. If the previous
run's `candidate-findings.json` is still there, the new run **skips every lane
it already has and returns the old findings**, reporting success. Nothing warns
you: the log looks normal, the output is well-formed, and the results are stale.

Archive the previous run first, confirm the archive is complete, then move the
output directory aside before launching. Do not delete it until the archived
copy has been verified — a resume that silently reuses old work and a delete
that destroys it are the same mistake in opposite directions.

This has been caught once, with 309 findings from a prior run sitting in place
at launch time.

## 1. Gather run identity

    SHA=$(git rev-parse --short HEAD)
    TS=$(date -u +%Y-%m-%dT%H-%MZ)
    RUN="${PRIVATE_RUN_STORE:?set an absolute private archive root}/${TS}__<variant>__${SHA}"

`<variant>` names the architecture that ran, e.g. `stage2-v2-perfile` or
`stage0-2-v1`. The directory name must sort chronologically, name the variant,
and pin the commit, so any number can be traced back to reproducible inputs.

## 2. Snapshot every stage output

Copy `"$SOURCE_RUNS_ROOT/$PROVIDER/"` into `$RUN/`, preserving one subdirectory
per stage and checking file counts and hashes against the source. This covers
both tracks and both profiles, including reports roots outside the repository. Keep each stage's
`meta.json` — it names the provider, model and commit the artifacts came from.
Include stages that did not run in this pass but whose outputs were consumed as
inputs — the run is not reproducible without them. Label carried-over outputs as
such in the manifest.

## 3. Copy the run logs

Runs launched through `tools/scanner/run.sh` tee their logs into
`$SOURCE_RUNS_ROOT/$PROVIDER/<stage>/logs/`; anything
launched by hand leaves logs in `/tmp`, which dies with the container. Either
way they are not durable — copy every log the run produced. If a run was restarted, copy each segment; they are the only record of
retries, rate limits and partial failures.

## 4. Copy eval detail

If the run was scored, copy the per-challenge hit/miss detail. **This file pairs
challenge identifiers with ground-truth locations and must never enter the
scanner repository.** The private store is the only correct home for it.

## 5. Write `MANIFEST.md`

Make the run self-describing without opening any JSON:

- date, harness commit, architecture variant, target name and full target commit, ground-truth set, model
- profile, reports root, runs root, run id, provider and all path overrides
- which stages actually ran, and which outputs were carried over
- headline metrics (recall, localization, precision proxy, findings, tokens,
  lanes completed, failures)
- **defects in force during the run** — a number without its caveats will be
  re-read later as a clean measurement
- provenance notes: restarts, what was lost, what was resumed

## 6. Score the run

    python3 tools/scan-benchmark/score_scanner.py \
        --findings <stage output>/candidate-findings.json \
        --answer-key <path> \
        --label "<run label>" \
        --json-out <scratch>/metrics.json

The answer-key path is a required argument and must never be written into this
repository — not in a script default, a Makefile, a doc, or a committed command
line. Pass it at the prompt.

If the scorer refuses to run because too few findings yield an OWASP code, that
is a schema fault, not a bad scan: `categories` has stopped holding code strings.
Fix that before recording anything — a run scored through that fault reports a
collapse that reads like a reasoning regression.

## 7. Append to eval history

Add one line to `results/eval-history/scanner.jsonl` with the universal fields
from `docs/protocols/eval-framework.md`: run_id, timestamp, component, version,
ground_truth_set, models_used, tokens, wall_clock_time, metrics, notes.
For held-out product runs also include `target_name` and `target_commit`. Use the
actual ground-truth denominator; never assume the reference benchmark's size.
Publish these rows only in the separate Held-out targets table in
`docs/benchmarking-results.md`, never its Juice Shop comparison table.

The metrics block must carry the class-model fields alongside the headline
numbers, or the headline numbers cannot be read:

- `hedging_mean_classes_per_finding` and `hedging_class_count_distribution` —
  recall rises when findings carry more labels, so a recall delta without this
  beside it overstates the result
- `recall_category_blind_pct` / `localization_category_blind_pct` — the ceiling
  the run would reach if category never mismatched, which separates a detection
  gap from a labelling gap
- `precision_proxy_category_aware_pct` as well as the category-blind figure

**Comparisons spanning the vulnerability-class model** (anything before
`2026-07-27` versus anything after) must re-score the older run with
`--alias-expand` and cite that line as the baseline. Otherwise the newer run
wins partly by labelling consistently and the two effects cannot be separated.
See `docs/architecture/vulnerability-class-model.md`.

Never rewrite a historical record. If a run is later found invalid, annotate it
in `notes` — do not edit or delete it. A re-score is a new line marked as a
re-score, not an edit to the original.

**If the score arrives after this line has been written**, the row cannot be
edited. Append a re-score row, in the same session the number appears:

    python3 tools/eval/run_records.py record-score \
        --history results/eval-history/scanner.jsonl --run <run_id> \
        --score <score_scanner.py --json-out file> --aggregate-key . \
        --ground-truth-set "97 reachable entries, <date>" --defects "…" --notes "…"

`--aggregate-key .` because that file is a flat metrics document with no
`aggregate` wrapper; naming the block is where you decide it carries nothing
located. The new row keeps the `metrics` shape the scanner history uses, so
`generate_eval_report.py` still reads it.

A score reported to a human and not written to a file does not exist.

## 7. Regenerate the report

    python3 tools/eval/generate_eval_report.py

The PDF is generated from the history files, never hand-edited.

## 8. Save the dispatch prompt

After checking that it contains no private key paths, ground-truth content or
located evaluation details, copy the prompt that drove the run into `prompts/dispatch/` as
`<YYYY-MM-DD>__<short-description>.md`. These prompts are the architecture of
the LLM stages; losing them loses reproducibility.

## 9. Commit both repositories

Commit the private store (run archive) and the scanner repository (eval history,
report, prompt) separately. They have different audiences and different
disclosure rules.

## Verify before reporting done

- the archive contains every stage output, every log, and the manifest
- `results/eval-history/scanner.jsonl` has exactly one new line
- the run's record is complete, and no run on disk lacks a row:

      python3 tools/eval/run_records.py check --run <run_id>   # exit 0, no `unscored`
      python3 tools/eval/run_records.py check                  # no ERROR

- no challenge identifier or ground-truth location entered the scanner repo:

      grep -rE "\b[a-zA-Z]+Challenge\b" results/ docs/ prompts/

Then finish the lifecycle: `record-run`.
