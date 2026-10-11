# Report stage

Productization plan §2.9 and Part 4. Deterministic: no model call, no network.
It turns a finished (or stopped) v2 run into the Option A outputs.

    ./tools/scanner/run.sh <provider> report                                  # benchmark
    ./tools/scanner/run.sh --target DIR [--out DIR] --run-id ID <provider> report   # product

`all-v2` runs it last, after `reconcile-v2`.

## Inputs

All under `<runs root>/<provider>/` (in a product run,
`<store>/runs/<run-id>/work/<provider>/`), read by fixed name:

| File | Used for | If missing |
|---|---|---|
| `stage2-hunt-lanes-perfile/candidate-findings.json` | findings | stage fails |
| `stage05-lane-selector-perfile/lane-assignments.json` | lane → file, coverage ledger, skip reasons | stage fails |
| `stage2-hunt-lanes-perfile/budget-consumption.json` | which lanes ran, failed or were blocked; tokens | status INCOMPLETE |
| `stage2-hunt-lanes-perfile/meta.json` | model, loop arm, effort, Stage 2 wall clock | status INCOMPLETE |
| `stage1-budget-governor-perfile/usage-v2.json` | reconciled cost | cost computed from Stage 2 tokens at the registry price |
| `stage1-budget-governor-perfile/budget-plan-v2.json` | the estimate | "not available" |
| `stage0-recon/architecture-summary.json`, `file-signals.json` | the recon-based confidence signals | those signals read n/a |
| `stage2-hunt-lanes-perfile/logs/stage2-hunt-lanes-perfile.stdout.log` | retry count (last pass) | "not recorded" |

`usage-v2.json` is used only when it postdates the consumption record it should
describe; a stale one is ignored and the report says so.

The scanned repository is read only through the read guard
(`shared/read-guard.ts`), with the same path form Stage 2 uses, so the product
profile never excerpts `.secscan/` or `.git/` and the benchmark never excerpts a
denylisted file.

## Outputs

| File | What |
|---|---|
| `report.html` | one self-contained page, no script, light and dark |
| `report.md` | same sections; the GitHub job summary in Option B |
| `findings.json` | the report model; every other output is rendered from it |
| `findings.sarif` | SARIF 2.1.0, validated against the OASIS schema |
| `meta.json` | provenance, as every stage writes; always in `<runs root>/<provider>/report/` |

plus a summary on stdout. `SOURCE_DATE_EPOCH` pins the timestamps; with it, two
runs over the same artifacts and working copy write byte-identical files.

**Benchmark profile:** everything goes to `<runs root>/<provider>/report/`,
beside the stages, which carries a `.gitignore` of `*`: the report is derived
from committed artifacts and runs to tens of megabytes on a full run.
`archive-run` copies it with the rest of `runs/<provider>/`.

**Product profile:** the run store.

## The run store (product)

```
<repo>/
└── .secscan/                  the run store; git-ignored by its own .gitignore of *
    ├── .gitignore             "*", written by run.sh after consent
    ├── index.json             one row per run, rebuilt from disk by every report
    ├── latest                 symlink to the newest reported run (latest.txt where symlinks fail)
    └── runs/<run-id>/         <run-id> is a UTC timestamp, YYYYMMDD-HHMMSS
        ├── report.html  report.md  findings.json  findings.sarif    what the user opens
        ├── run-record.json    the run's manifest, written by the secscan CLI (cli/README.md)
        └── work/<provider>/<stage>/   stage internals, checkpoints, logs
```

- **Consent.** The secscan CLI and `run.sh` create the store only after asking
  once on a terminal ("Create it? [Y/n]"), or with `--yes` in scripts and CI.
  With neither, nothing is written. The repository's own `.gitignore` is never touched; the
  store ignores itself, as pytest's `.pytest_cache` does.
- **`--out DIR`** moves the whole store, for example outside the repository.
  It must lie outside the target (a store inside it would be inventoried and
  scanned as source) and must be new, empty, or already a store: `run.sh` never
  writes a `.gitignore` of `*` into a directory holding someone's files. A later
  stage of the same run needs the same `--out`.
- **Index and latest.** Rebuilt from the run directories each time, so a run
  that died before its report shows as `no report` instead of going missing.
- **Committed vs ignored.** Run output contains the repository's vulnerabilities
  and code excerpts, so it stays in the ignored store. Team decisions (scan
  config, ignore lists, and later dismissed findings) belong in committed files
  at the repository root.

List and prune runs (prune is a dry run without `--yes`; the newest run is never
touched):

    npm --prefix tools/scanner/report run runs -- --target . list
    npm --prefix tools/scanner/report run runs -- --target . prune --keep 10
    npm --prefix tools/scanner/report run runs -- --target . prune --work --yes   # drop internals, keep reports

`--work` makes those runs impossible to resume or re-report.

## Rules the report keeps

- **Locations come from the lane, not the model.** A finding's file is its
  lane's `target_file`. A trace step whose own `file` disagrees is still placed
  in the lane's file, and the model's spelling is kept as `model_cited_file`.
- **The primary location is the first `sink` step.** Stage 2 guarantees the
  last step is a sink, but a trace may name several (the dangerous call, then
  what its result reaches), and the first is the line to change.
- **Excerpts are read from disk at report time**, cited line ±2, after the same
  line-preserving PEM redaction Stage 2 applies. A line that does not exist in
  the file is reported as unresolved with no excerpt, never silently clamped.
- **Permalinks are commit-pinned and only where they are true.** One is emitted
  when the repository is on GitHub (origin remote, or `GITHUB_REPOSITORY` /
  `GITHUB_SERVER_URL` in Actions), HEAD is known, and the file is unchanged from
  HEAD in the working copy. Otherwise the finding carries `path:line` alone.
- **Stable fingerprints** (§2.8): sha256 of path, the sink line's text
  (whitespace-collapsed) and the finding's primary class. An edit above a
  finding moves its line and keeps its id. Two distinct findings that still
  collide keep separate ids, suffixed in title order.
- **Confidence is explained in two halves** (§4.3): four scanner signals the
  report computes itself (trace complete; entry point exposed per recon; a
  dangerous-API signal tied to the class; which playbooks reached the file), and
  the model's own `confidence_reason`.
- **Older findings still report.** Every field added in §2.9 (`cwe`,
  `severity_reason`, `confidence_reason`, `attack_scenario`, `remediation`) is
  optional; a finding without them says "not recorded" and lists them under
  `fields_missing`, and the report counts such findings as a limitation.

## Task 1c's hand-off

When the secscan CLI ran the scan, the report reads what it and the stages
recorded, most authoritative first, and does not re-derive it:

| File | Gives the report |
|---|---|
| `<run dir>/run-record.json` (CLI) | the verdict (COMPLETE/INCOMPLETE) and its reasons, unscanned files with reasons, scope exclusions, the directories the user confirmed, limits, the config file's hash, estimate and cap |
| `work/<model>/stage2-hunt-lanes-perfile/run-status.json` | the same verdict and lists from Stage 2, for runs driven by `run.sh` |
| `work/<model>/stage1-budget-governor-perfile/scan-plan.json` | scope exclusions, the confirmed scope's estimate, the cap |

Each is used only when it describes the current Stage 2 pass. Files the scope
left out (`--paths`, `--include`/`--exclude`, `--max-file-size`) count as
skipped, not missing. The pipeline's verdict wins and its wording is used as is;
the report's own derivation from the lane manifest and consumption record is a
second opinion that can only turn a COMPLETE into an INCOMPLETE, never the
reverse. A run made before task 1c has none of these files and is reported from
the derivation alone.

Not yet produced anywhere, and shown as such: diff scope (always `full`) and
recon-guided playbooks and their sources (always none).

## SARIF alignment (deferred)

Bringing `findings.sarif` closer to industry conventions (rule metadata,
taxonomies, invocations, baseline state, suppressions) is analysed but not
decided: `docs/architecture/report-sarif-alignment.md`.

## Benchmark reference

Measured status, measured languages, recall and localization come from the
registry's `benchmark` block (`shared/models.json`), the same source the CLI's
`secscan models` and confirmation screen use, so the report cannot disagree with
them. `benchmark-reference.json` adds only the precision proxy, which the
registry does not carry; `guard.test.ts` pins each figure to
`docs/benchmarking-results.md`.

## Tests

    npx tsx src/report.test.ts          # this package
    npx tsx ../shared/guard.test.ts     # guarded reads, isolated output
