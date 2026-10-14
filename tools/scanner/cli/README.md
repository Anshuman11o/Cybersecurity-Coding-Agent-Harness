# secscan CLI

`secscan` collects a target, reports folder, exclusions and budget, then runs
recon, planning and the per-file hunt. The product default is **GPT-6 Luna**
(`luna6`), from `shared/models.json`. The lab default remains `luna`.
GPT-6 Luna is labelled unmeasured; its initial estimate calibration is borrowed
from the existing Luna calibration, not a measurement of this model.

This is a local npm package in this checkout. Install the scanner packages
first, then use its local command:

```bash
cd tools/scanner
./install.sh
cd cli
npx --no-install secscan scan /path/to/my-app
```

`npm run secscan -- scan /path/to/my-app` is equivalent. No published npm
package is required. Scans bill the account whose key you supply. `help` and
`models` make no model calls.

## Round-1 inputs

With no subcommand, `secscan` scans the current directory. Before recon it
shows the model and whether the registry's credential variable is set, then
asks these questions in order:

```text
secscan · model GPT-6 Luna · OPENAI_API_KEY found
Scan this repository?  /path/to/my-app  (git main @ a1b2c3d)
                       [Enter] yes   [c] change   [q] quit
Save reports to?       /path/to/my-app/.secscan/   (kept out of git)
                       [Enter] yes   [c] change
Exclude anything?      none  (.secscanignore not found)
                       [Enter] no    [c] add files or folders
Budget in USD?         >
```

A supplied flag decides its answer: it is displayed without asking again.
When the selected model's key is missing, an interactive run asks once with
hidden input and keeps the key only in the process environment inherited by
the stages. A non-interactive run requires the key to be set already.

| Command or flag | Meaning |
|---|---|
| `secscan` | Scan the current directory, with round-1 prompts |
| `secscan scan <dir>` | Scan the supplied target |
| `secscan models [--all]` | List registry models and credential presence; `--all` includes lab-only transports |
| `secscan report [run-id]` | Rebuild a run's `report.html` and `findings.json` from disk; default the newest run in `./.secscan` (`--out` selects another reports folder) |
| `--budget <usd>` | Total run budget, including recon and earlier passes; alias `--max-cost` |
| `--out <dir>` | Reports folder; default `<target>/.secscan/` |
| `--exclude <path-or-glob>` | Exclude files or folders, repeatable |
| `--drop-class <id>` | Remove a selected class before the hunt; repeatable |
| `--add-class <text>` | Add a class by catalog ID, number, code, alias or free text; repeatable |
| `--yes` | Skip all prompts; requires an explicit `--budget` unless resuming |
| `--resume [run-id]` | Resume that INCOMPLETE run, or the latest INCOMPLETE run in the reports folder |
| `--paths <a,b>`, `--include <glob>` | Restrict scope; repeatable |
| `--max-files`, `--max-file-size`, `--timeout` | Other run limits |
| `--concurrency <n>` | Override concurrency derived after recon |
| `--config <path>`, `--no-config` | Select or disable the target's `secscan.config.json` |
| `--no-open` | Do not open `report.html` in the browser when the run ends |

For example, from this directory:

```bash
npx --no-install secscan scan /path/to/my-app --yes --budget 5 --exclude vendor
npx --no-install secscan scan /path/to/my-app --resume --budget 10
npx --no-install secscan scan /path/to/my-app --out /path/to/reports --resume RUN_ID --yes
```

Interactive resume asks for a budget unless `--budget` supplies it. With
`--resume --yes`, omitting `--budget` keeps the previous budget. A resume keeps
the run's model, ledger and completed files. Use the same `--out` to find a run
stored outside the default reports folder. Changing `--paths` or `--exclude`
after recon requires a new scan, since the inventory and read allowlist belong
to the original scope. The saved plan also pins model, endpoint, output cap,
sampling and loop settings; changes that invalidate U require a new plan.

## Scope and reports

Recon applies explicit exclusions while selecting files, before its model
probes. It honours `.gitignore` and `.secscanignore`; selected files are saved
in a read allowlist used by later stages. A model-requested read cannot bring
an excluded file back into scope. Recon also writes a read audit containing
paths and timestamps, not source contents.

The reports folder gets a `.gitignore` containing `*`. If it is inside the
target, the entire reports folder is excluded from recon and the corpus read
guard, including previous runs and calibration data. The stages receive
`SCANNER_REPORTS_ROOT` and `SCANNER_RUNS_ROOT` from the CLI.

```text
<reports>/
  .gitignore
  calibration.json
  index.html                  every run with a report, newest first
  runs/<run-id>/
    report.html               summary and per-finding view
    findings.json             run facts, summary and every finding
    run-record.json
    secscan.log
    read-allowlist.json
    read-audit.jsonl
    <model>/
      spend-ledger.jsonl
      stage0-recon/api-profile.json
      stage1-budget-governor-perfile/scan-plan.json
      stage2-hunt-lanes-perfile/progress.json
      stage2-hunt-lanes-perfile/run-status.json
      stage2-hunt-lanes-perfile/candidate-findings.json
```

`run-record.json` records status, incomplete reasons, unscanned files, scope
exclusions, limits, confirmation, coverage, ledger spend, stage invocations
and a resume command.

## Report

When a run ends, the CLI writes the report next to the run record, prints
both paths and opens `report.html` in the default browser (only when attached
to a terminal; `--no-open` turns it off). The report makes no model calls and
reads only what the run already wrote; the code is in `tools/scanner/report/`.

- `findings.json` (`secscan.findings/1`): run facts, scan gaps, summary counts,
  every file not scanned with its reason, the resume command, then every
  Stage 2 finding exactly as written plus one field, `location`, copied from
  the trace's last step. Findings are in report order: severity, then
  confidence, then file and line.
- `report.html`: one self-contained page rendered from that same data, with no
  network requests. The summary shows status, scan gaps, the severity range
  (High, Medium, Low), a table of the ten most severe findings to review first
  (severity, vulnerability, file, line, confidence, confidence band), counts by
  vulnerability type with their OWASP codes, the top files, coverage, spend
  against budget and token usage. The findings view
  filters and sorts every finding, groups findings that share a line, shows
  each trace and copies a finding's JSON.
- `<reports>/index.html`: rebuilt from every run's `findings.json`.

Stage 2 may rate a finding critical. Only a run that has a critical finding
carries a `critical` count in `findings.json` and a Critical band in the page;
every other run shows High, Medium and Low alone.

A stopped run gets a partial report covering exactly the files that finished,
marked INCOMPLETE with the reasons and the resume command. A run that scanned
no files gets a report only when it failed (a stage crash or a provider
refusal); quitting at confirmation, a Ctrl-C before any file finished, or a
budget too small for the first file writes none. A resume replaces the run's
report with one covering every pass; a resume cancelled at confirmation leaves
it as it was. A report that cannot be written never changes the exit code;
`secscan report <run-id>` rebuilds it, including after the CLI was killed.

## Estimate, ledger and budget

Recon makes **up to five model calls**, and they count against the budget.
The plan confirmation follows recon. It shows scope, model, estimated input
and output cost, spend so far, total estimate, accuracy band, tier and
concurrency. The existing confirmation supports starting, editing limits,
saving config, or quitting.

Stage 1 builds the hunt's exact first-call prompt for every admitted chunk.
It estimates tokens using this run's recon measurements, earlier calibration
in the reports folder, or registry defaults. Output estimates use earlier
calibration for the same model and reasoning effort. The displayed 90% bands
are ±7% for at least 300 files, ±15% for 100–299, ±27% for 40–99 and ±78% for
10–39. Under 10 files the estimate says it can vary widely. These bands and
the registry's initial ratios come from earlier Luna calibration; they are
not new GPT-6 Luna measurements.

Every recon and hunt attempt appends to `<model>/spend-ledger.jsonl`. Usage
prices include cache reads, cache writes, completion/reasoning tokens, served
tier, long-context rates and regional uplift where configured. Missing usage
is charged at a conservative reservation and labelled accordingly. Progress,
budget checks and the final run record use the ledger total. Resumes append
to the same ledger.

The budget gate uses one fixed worst-case reservation **U** per chunk,
computed at planning. A file with `c` chunks can start only when:

```text
ledger spend + reservations in flight + c × U <= budget
```

If the next file does not fit, the scheduler waits for files in flight to
finish. If none are in flight, it stops INCOMPLETE with `max_cost`. A retry
must reserve another U; refusal also stops the run with `max_cost`. Actual
call costs enter the ledger as responses arrive, and finishing a file
releases its reservations. The estimate and U have different purposes: a
file may need more budget to start than its estimated cost.

When an interactive hunt reaches the budget, the CLI shows total spend,
files completed and remaining, and an approximate additional cost. Its
average is hunt ledger spend divided by completed files; before any file
finishes it uses the plan's estimate per file. A new total budget greater
than spend so far continues the same run. Enter stops INCOMPLETE. `--yes`
and non-terminal runs do not show this prompt.

## Tier, concurrency and failures

For models declaring service tiers, recon's first call sends no
`service_tier`, allowing the account setting to decide. Recon records the
served tier and rate-limit headers in `api-profile.json`, pins that tier on
later calls, and passes it to the hunt. An unknown tier stops the run
INCOMPLETE with `unpriced_service_tier`.

Concurrency is derived from the observed token/request limits, estimated
tokens per call and registry timing, using 70% of the reported limits and a
ceiling of 32, the vendor ceiling and admitted lane count. Without headers,
the starting default is 8, subject to those ceilings. `--concurrency` wins.
Rate-limit responses can reduce concurrency; it never climbs back during
the run.

The hunt has one retry layer: SDK retries are disabled, each call gets at
most three attempts, and each attempt enters the ledger. Empty or truncated
answers fail and retry; exhausted attempts mark the file failed. Rate limits
step concurrency down to `max(1, floor(current × 0.75))`, at most once per
60 seconds, and use Retry-After/reset headers capped at 60 seconds. Transient
network and server errors back off and retry. Quota or provider spend limits
stop immediately with `provider_quota`. Three failed files in a row, in
completion order, stop with `provider_failing`.

A limit or first Ctrl-C/SIGTERM stops new files and lets files in flight
finish. A second Ctrl-C abandons those files. The run records every admitted
file left unscanned and its reason. `--timeout` starts a new window on each
resume; `--max-files` can be raised to admit more files.

Exit codes: `0` complete or cancelled at a prompt, `3` incomplete,
`130` interrupted, `2` usage error, `1` stage failure.

## Round 2: review classes and budget

After recon, the playbook agent selects classes and researches any new guidance.
Product runs always run that agent. Before the hunt, Round 2 shows the selected
classes and their file counts, skipped files, total spend so far, and the remaining
input/output estimate. It offers start, delete, add, budget, limits, save and quit.

Deleting a class or adding a catalog class costs nothing. A free-text addition
first makes a metered resolution call; a new class then needs web research. The
screen asks before those calls and checks their reservations against the total
budget. Research retries once automatically. A failed edit keeps the previous
selection and records any money already spent. Files left without a class become
skips. Every successful class change reruns lane selection and planning without
model calls.

Product hunts start route handlers first, then files with more risk signals,
breaking ties by path. A partial budget keeps every admitted file in the plan;
the spend gate stops work at the cap and records the unscanned files as INCOMPLETE.
The screen blocks a start when the first file's reservation cannot fit, and asks
for confirmation when the budget fits that reservation but is below the input
estimate. Once the hunt starts, resume freezes classes and allows budget edits.

The screen labels the full-run cost `Total estimate:` and shows `Current budget:`
immediately before the coverage message. Partial coverage says "Budget will not
cover all M files" and "Estimated coverage: N of M files, scanned by severity
first." This label refers to the route-handler/signal-count ordering above;
finding severity is not known before scanning.

Below the estimated input-cost threshold, the warning says:

```text
Budget will not cover even the estimated input cost for all files.
Raise the total budget to cover at least partial scan.
Starting now will allow only a partial scan.
```

If the budget cannot start the scan, the message says:

```text
Scan cannot start with this budget.
Raise the total budget to at least complete partial scan.
```

These warnings omit minimum-dollar recommendations and reservation breakdowns;
the total estimate and current budget still appear above them. See the
[budget-state table](../../../docs/architecture/round-2-class-review.md#budget-messages-b-is-the-total-budget-including-what-is-already-spent)
for the exact conditions and Enter behavior.

For CI, use `--yes --budget <usd>` with repeatable `--drop-class` and
`--add-class` flags. Failure to add a requested class exits before the hunt.
The save action writes the reviewed class edits into the config:

```json
{
  "classes": { "drop": ["logging-monitoring"], "add": ["injection"] },
  "limits": { "max_cost": 5 }
}
```

The run preserves the agent's original selection, the human edit audit and the
final selection under `stage-playbook-agent/`. The run record also keeps the
review and the exact class rows confirmed. Lab and benchmark `run.sh` workflows
retain their existing class selection and inventory order.

## Configuration and lab options

`secscan.config.json` is read from the target root, or from `--config`.
Command-line flags override it:

```json
{
  "paths": ["src", "api"],
  "exclude": ["**/*.test.ts", "vendor"],
  "limits": { "max_cost": 5, "max_files": 500, "max_file_size": "200k", "timeout": "30m" }
}
```

The config may select a model but cannot name an endpoint, credential
variable or overlay. Automated fresh runs must supply the budget flag even
if the config includes a cap.

Help groups `--model`, `--models-file`, `--base-url`, `--api-key-env` and
`--price` under **Lab options**. Overlays add OpenAI-compatible targets
without replacing shipped entries. A custom endpoint uses the registry's
generic credential variable unless `--api-key-env` overrides it, and needs
`--price` for budgeted runs. Models, endpoints, credential variable names,
prices and tier rules remain registry data.

The lab's `default_provider` stays `luna`; `product_default_provider` selects
`luna6` for this CLI. Targets without the new pricing/tier fields retain their
existing multipliers and send no service tier. Lab recon starts a fresh
ledger; product runs each have their own folder and never truncate it.
The legacy `budget-plan-v2.json` calculation remains separate from the new
`scan-plan.json` estimate and gate.

See [Task 2a architecture](../../../docs/architecture/task-2a-inputs-budget-ledger.md)
for the formulas and stage interfaces.
