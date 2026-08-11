---
name: archive-patch-run
description: Archive a completed patcher run before its outputs are lost. Use immediately after any patcher run finishes (v1 task loop, v2 waves, or v3 chunks), or when asked to record, archive, or log a patch run's results. Splits the run into an aggregate row in the repository and located detail in the private store, and refuses to publish anything that pairs a bug id with a file or a line.
---

# Archive a patcher run

The counterpart to `archive-run`, which does this for the scanner. Do not use
that one for a patcher run: its steps are about stage outputs and
`scanner.jsonl`, and following it will put a patcher run in the wrong file with
the wrong fields.

**A patcher run is gone the moment its container is.** `outputs.run_dir` in every
shipped config points *outside* the repository — deliberately, because a per-task
record pairs a bug id with a file and a line, and the publishing rule does not
allow that in a committed artefact. The consequence is that the run store sits on
ephemeral disk with nothing durable pointing at it. Subset 2's run was scored,
and then its entire run store — records, transcripts, cost, the disposition
histogram — was lost exactly this way. Only the sighted per-case table survived,
in the answer-key repo. That is why `patcher.jsonl`'s one row has nulls in it.

Run every step.

## The split, which is the whole point

```
aggregate  ->  results/eval-history/patcher.jsonl   committed, publishable
located    ->  <private store>/<stamp>/             outside the repository
```

`patcher-report.json` contains both halves. `totals` is aggregate; `tasks[]` is
located and may not be published in any form — not filtered, not summarised, not
"just the counts per file". The archiver never reads it.

## 1. Archive, in one command

```bash
python3 tools/patcher/src/archive_run.py \
    --run-dir        /home/user/patcher-work/runs/<run_id> \
    --label          subset-02-v3 \
    --private-store  /home/user/harness-private/patcher-runs \
    --score          <path to the sighted eval-result.json, if scored> \
    --located-detail-at "answer-key repo, branch <b>, commit <sha>" \
    --defects        "<what was known-broken during the run>" \
    --provenance     "<restarts, what was lost, what was resumed>" \
    --notes          "<what happened, including cost and failure>"
```

Add `--dry-run` first. It builds the row, runs the publishability guard and
prints what it would do, without copying or appending. It costs nothing and it
is the step that catches a leak *before* it is committed.

The tool copies the run store verbatim, writes `MANIFEST.md` beside it, and
appends exactly one line to `results/eval-history/patcher.jsonl`.

## 2. What the guard refuses, and why you must not work around it

`assert_publishable()` rejects a row containing a bug id, a challenge key, a
`file:line` reference, a source path, or a key named `tasks`, `file`, `line`,
`bug_id`, `per_case` and friends. If it fires:

**Rephrase the row. Never loosen the guard.** The right home for "which bug, in
which file, at which line" is the answer-key repo. Four blind-boundary breaches
are recorded in the root `CLAUDE.md`, and two of them came from eval write-up
rather than from code, because the useful conclusion is naturally phrased in
terms of locations. That is precisely the sentence you will be tempted to put in
`notes`.

## 3. Score it, sighted, and carry only the aggregate

Scoring happens in the answer-key repo, after the run has completed
independently. `eval-result.schema.json` there encodes the rule structurally:
`aggregate` is publishable, `per_case[]` is not. `--score` reads the `aggregate`
block and nothing else.

Two things the row must state next to any number, because both are open:

- **no committed lockfile** for the target tree (`.npmrc` sets
  `package-lock=false`), so the dependency set is whatever resolved that day and
  cross-run comparison is uncontrolled;
- **no frozen pre-patch baseline** — the suite has never been run green on the
  unpatched tree, so axis B is differenced against an unmeasured starting point.

## 4. Never fold two oracle sets into one trend

If the ground truth grew between two scorings, the later number is not progress.
Subset 2 went from 2/10 to 10/23 effective fixes **without a single patch
changing** — 13 new driver-backed oracles made previously unscoreable cases
scoreable. A ground-truth change invalidates comparison across it. Say so in
`notes`, in the row, not in a footnote somewhere else.

Also state which denominator a rate uses. Effective fixes over *scoreable* cases
and over *all* bugs are different metrics and differ by several points.

## 5. Append-only

`patcher.jsonl` is append-only for the same reason `docs/benchmarking-results.md`
is: each row cost a real run and cannot be reconstructed. The tool refuses a
duplicate `run_id`. A correction is a **new row** carrying `--rescore-of`, never
an edit — a rewritten history cannot be trusted to show a regression.

## 6. Commit the two repositories separately

They have different audiences and different disclosure rules. The private store
holds the located half; this repository holds one line of aggregate.

## Verify before reporting done

- the archive directory exists and its file count matches what the tool printed
- `MANIFEST.md` names the defects in force — a number without its caveats gets
  re-read later as a clean measurement
- `results/eval-history/patcher.jsonl` gained **exactly one** line
- the guard passes against what is actually on disk:

      python3 -m pytest tools/patcher/tests/test_archive_run.py -q

- and nothing located reached the repository:

      grep -rE "\bBUG-[0-9]+\b|[a-z][A-Za-z0-9]*Challenge\b" results/ docs/ prompts/
