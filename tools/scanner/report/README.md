# Report stage

Productization plan §2.9 and Part 4. Deterministic: no model call, no network.
It turns a finished (or stopped) v2 run into the Option A outputs.

    ./tools/scanner/run.sh <provider> report                      # benchmark
    ./tools/scanner/run.sh --target DIR --run-id ID <provider> report   # product

`all-v2` runs it last, after `reconcile-v2`.

## Inputs

All under `<runs root>/<provider>/`, read by fixed name:

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

In `<runs root>/<provider>/report/` (in a product run,
`<target>/.secscan/runs/<run-id>/<provider>/report/`):

| File | What |
|---|---|
| `report.html` | one self-contained page, no script, light and dark |
| `report.md` | same sections; the GitHub job summary in Option B |
| `findings.json` | the report model; every other output is rendered from it |
| `findings.sarif` | SARIF 2.1.0, validated against the OASIS schema |
| `meta.json` | provenance, as every stage writes |

plus a summary on stdout. `SOURCE_DATE_EPOCH` pins `generated_at`; with it, two
runs over the same artifacts and working copy write byte-identical files.

In the benchmark profile the directory carries a `.gitignore` of `*`: the
report is derived from committed artifacts and runs to tens of megabytes on a
full run. `archive-run` copies it with the rest of `runs/<provider>/`.

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

## Forward-compatible hooks

Read if present, so later tasks need not change this stage:

- `budget-consumption.json` or Stage 2 `meta.json` → `stop_reason`: the run
  stopped early (a spend cap, Ctrl-C). Marks the run INCOMPLETE with the reason.
- a lane's `skip_category`: a machine-readable skip bucket (`user-excluded`,
  `ignored`, `non-code`, `too large`, `over budget`). Without it, the free-text
  `skip_reason` is bucketed by wording.

Not yet produced anywhere, and shown as such: diff/paths scope (always `full`),
recon-guided playbooks and their sources (always none), a user config file in
the config hash.

## Benchmark reference

`benchmark-reference.json` quotes the lab's aggregate figures per model from
`docs/benchmarking-results.md` §1, and the languages measured on each (plan
§3.4). Update it when a row is appended there. `guard.test.ts` asserts it stays
aggregate.

## Tests

    npx tsx src/report.test.ts          # this package
    npx tsx ../shared/guard.test.ts     # guarded reads, isolated output
