# secscan CLI

The command a user runs: model selection, run limits, the run-start
confirmation and live progress (productization plan
`docs/architecture/productization-plan.md` §2.5–§2.7, Task 1c). The report it
hands off to is Task 1d; packaging as an npm `bin` is Task 1e. Until then it
runs from this directory:

```bash
cd tools/scanner && ./install.sh          # once
cd cli
export OPENAI_API_KEY=sk-...              # your key; the scan bills your account
npm run secscan -- scan ../../../my-app   # or: npx tsx src/secscan.ts scan <dir>
```

## Commands

```
secscan models [--all]       registry: price, measured or unmeasured, whether the key is set
secscan scan [dir] [flags]   recon -> plan -> confirm -> hunt with live progress
secscan help
```

`secscan help` lists every flag. The ones that matter most:

| Flag | Meaning |
|---|---|
| `--model <key>` | a model from `secscan models`; default is the registry default (`luna`) |
| `--base-url <url> --model <id> [--api-key-env VAR] [--price in/out]` | any OpenAI-compatible endpoint: OpenRouter, another vendor, a local Ollama or LM Studio |
| `--models-file <path>` | your own `models.json` overlay |
| `--max-cost <usd>` | hard stop: no new file starts once projected spend would pass it |
| `--max-files`, `--max-file-size`, `--timeout`, `--concurrency` | the other limits |
| `--paths a,b`, `--include <glob>`, `--exclude <glob>` | scope (repeatable) |
| `--yes` | skip the confirmation (scripts, CI) |
| `--resume <run-id>` | continue a stopped run |
| `--out <dir>` | keep results in this run store instead of `<dir>/.secscan` (must be outside the repository) |

## Models (§2.5)

`secscan models` reads `shared/models.json`. A model is **measured** when the
lab has scored it: its entry carries a `benchmark` block copied from
`docs/benchmarking-results.md`, and `shared/guard.test.ts` fails if the two
disagree. Measured is per language too: the benchmark is Juice Shop, so only
TypeScript is measured, and the confirmation screen marks every other language
unmeasured. Lab-only transports (`claude-cli`) are hidden unless `--all`, and a
scan refuses them.

Two ways to bring your own model, both always unmeasured:

- **Overlay** (`--models-file`, or `SCANNER_MODELS_FILE`): a JSON file with
  `targets` (and optionally `aliases`) in exactly the shipped format. It can add
  keys, never redefine a shipped one, never claim a `benchmark`, and supports
  the `openai` transport only.
- **Generic endpoint** (`--base-url`): the CLI fills in the
  `generic_openai_compatible` template in `models.json`. The key is read from
  `SCANNER_CUSTOM_API_KEY` unless `--api-key-env` names another variable: it
  deliberately never defaults to a vendor's variable, which would send that
  vendor's key to whatever host `--base-url` names. Without `--price` the model
  is unpriced and `--max-cost` refuses to run.

No model id, endpoint or credential variable appears in the CLI's code; the
guard test checks.

## Limits (§2.6)

Stage 1 applies the scope limits and prices every remaining file, lane by
lane, into `scan-plan.json`. Stage 2 asks a spend gate
(`stage1-budget-governor/src/spend-gate.ts`) before it **starts** each file:

- `--max-cost`: a file starts only if spend so far, plus the projections of
  files in flight, plus its own projection fits under the cap. Projections are
  scaled up once measured spend shows them running low. A file in flight is
  never cut off (its calls are already billed), so the overshoot is bounded by
  the files in flight.
- `--timeout`: no file starts after it; the window restarts on each resume.
- `--max-files`: files past the count are not scanned.
- `--paths`, `--include`, `--exclude`, `--max-file-size`: scope. Files they
  leave out are listed as excluded, not as missing.

Hitting a limit, Ctrl-C or SIGTERM ends the run cleanly: no new file starts,
the ones in flight finish, and the run is recorded **INCOMPLETE** with every
file that was not scanned and why. A second Ctrl-C abandons the files in
flight (their projected cost is still booked as spend). `--resume <run-id>`
continues the run without rescanning finished files. Raise `--max-cost` or
`--max-files` on the resume if a limit stopped it.

Exit codes: `0` complete (or not started at the prompt), `3` incomplete,
`130` interrupted, `2` usage error, `1` a stage failed.

## Confirmation and progress (§2.7)

```
Target: ./my-app (commit a1b2c3d, 1,204 files)
Languages: TypeScript 61%, Python 30%, Go 9% (Python, Go: unmeasured)
Scan 412 files in: src/ api/ workers/   Skip 792: node_modules/ dist/ assets/  (780 not code, 12 too-large)
Model: gpt-5.6-luna (OPENAI_API_KEY found), measured   Extra guidance: none (built-in playbooks only)
Estimate: ~$1.90, ~6 min    Cap: $5.00
Limits: concurrency 8 (default 8)
[Enter] start   [e] edit dirs/limits   [s] save as secscan.config.json   [q] quit
```

Every figure comes from the run's own artifacts: languages from Stage 0's file
inventory (Task 1b will widen it), the file split from Stage 0.5 and the scan
plan, the estimate and the cap from the scan plan. `[e]` edits scope and limits
and re-plans; `[s]` writes `secscan.config.json`. The time estimate is
calibrated on luna run 6 and labelled approximate.

**Known gap:** Stage 0 makes up to two small recon model calls *before* the
screen, because the screen needs its output. Everything else waits for the
confirmation. Moving the probes after it belongs with recon v3 (Task 1b).

During the hunt one line shows files done/total and failed, spend against the
estimate and the cap, elapsed time and ETA, and findings by severity. All of it
is Stage 2's own `progress.json`, so the spend shown is the spend the gate is
enforcing.

## secscan.config.json

```json
{
  "model": "luna",
  "paths": ["src", "api"],
  "exclude": ["**/*.test.ts", "vendor"],
  "limits": { "max_cost": 5, "max_files": 500, "max_file_size": "200k", "timeout": "30m" }
}
```

Read from the target root (or `--config`); flags override it. It may **not**
name an endpoint, a credential variable or an overlay: the file is repository
content, so a pull request could otherwise point the scan, and the key, at its
own host. In CI, pass `--max-cost` on the command line as well, so a pull
request cannot raise the cap by editing the file.

## What a run leaves behind

Results go to a run store, `<target>/.secscan/` (or `--out <dir>`, which must
lie outside the repository). The store carries a `.gitignore` of `*`, so git
never sees it. The first run asks before creating it (`--yes` is the answer in
scripts and CI); answering no writes nothing. Layout, and the `runs` command
that lists and prunes runs: `tools/scanner/report/README.md`.

```
.secscan/
├── index.json  latest -> runs/<newest>
└── runs/<run-id>/
    ├── report.html  report.md  findings.json  findings.sarif   the report (Task 1d)
    ├── run-record.json                                         the run's manifest (below)
    └── work/                                                   internals
```

| File | Written by | Contents |
|---|---|---|
| `run-record.json` | CLI, at every end | the run's manifest and the hand-off to the report (below) |
| `report.html`, `report.md`, `findings.json`, `findings.sarif` | report stage, after the hunt | the report, including on a stopped run (marked INCOMPLETE) |
| `work/secscan.log` | CLI | every stage's full output |
| `work/<model>/stage1-budget-governor-perfile/scan-plan.json` | Stage 1 | admitted and excluded files, each priced; limits; concurrency |
| `work/<model>/stage2-hunt-lanes-perfile/progress.json` | Stage 2, live | the progress line's source |
| `work/<model>/stage2-hunt-lanes-perfile/run-status.json` | Stage 2, at its end | COMPLETE/INCOMPLETE, reasons, unscanned files, spend |
| `work/<model>/stage2-hunt-lanes-perfile/candidate-findings.json` | Stage 2 | the findings |

### run-record.json (`secscan.run-record/1`)

| Field | Meaning |
|---|---|
| `status` | `COMPLETE` only when every admitted file was scanned and every stage exited 0 |
| `incomplete_reasons[]` | `max_cost`, `timeout`, `interrupted`, `over-max-files`, `failed_lanes`, `blocked_reads`, `chunk_bound`, `stage_failed`, `cancelled`, each with a detail |
| `unscanned[]` | `{lane_id, target_file, reason, detail}` for every file in scope that was not scanned |
| `scope_excluded[]` | files the scope left out (`user-excluded`, `too-large`); not incompleteness |
| `confirmation` | who confirmed (`prompt` or `--yes`), when, and the full summary shown |
| `limits`, `model`, `config_file` | what the run ran under (the config file by path and sha256) |
| `coverage` | inventory, hunt, admitted, completed, failed, not started |
| `spend` | estimate, the gate's measured spend, the reconciled `usage-v2.json` cost, tokens, calls |
| `stages[]` | every stage invocation across all passes, with exit code and log |
| `resume_command` | the command that continues the run, or null |

## Lab use

`run.sh` takes the same limits as flags (`--max-cost`, `--max-files`,
`--max-file-size`, `--timeout`, `--concurrency`, `--paths`, `--include`,
`--exclude`, `--models-file`). With none set, the benchmark profile behaves as
before: Stage 1's `budget-plan-v2.json` and Stage 2's findings and consumption
are unchanged on the committed luna lanes.
