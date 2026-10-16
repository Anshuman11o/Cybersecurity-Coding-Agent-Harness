# secscan

secscan is a command-line security scanner that uses an AI model to find vulnerabilities in your source code. It reads your repository, picks the OWASP vulnerability classes that fit it, has the model trace each file for exploitable flaws, and writes an HTML report plus a JSON file of findings. It runs on your machine with your own model API key: you pay your model provider directly, and the scan stops at the budget you set.

> **Preview (0.1.0).** This is an early release. The bar for a full release is localization of 85% or more on every private test repository, on the default model, and it has not been met yet. The default model is unmeasured. Treat findings as leads for a human to check, not as a verdict.

## What it finds

secscan hunts the classes below. A class selection step decides from recon's view of your repository which of them apply, and you review the list before the hunt spends anything.

| Class | What it covers | OWASP codes |
|---|---|---|
| `access-control` | Broken access control: missing ownership, role or function-level checks, path traversal | A01, API1, API5 |
| `crypto-auth` | Cryptographic failures and broken authentication or session handling | A02, A07, API2 |
| `injection` | SQL, NoSQL, OS command, template and code injection, and cross-site scripting | A03 |
| `insecure-design` | Business logic that works as written and still permits abuse | A04 |
| `misconfiguration` | Dangerous defaults, exposed internals, missing security controls | A05, API8, API9 |
| `vulnerable-components` | Dependencies with known vulnerabilities, read from manifests and lockfiles | A06 |
| `integrity-failures` | Unsafe deserialization, file handling and supply-chain integrity gaps | A08 |
| `logging-monitoring` | Missing security logging, and sensitive data written to logs | A09 |
| `ssrf` | Server-side request forgery and open redirects | A10, API7 |
| `api-property-auth` | Mass assignment and object property level authorization | API3 |
| `resource-consumption` | Unrestricted resource consumption (denial of service) | API4 |
| `sensitive-business-flows` | Business flows with no anti-automation safeguards | API6 |
| `ai-llm-agency` | Prompt injection, sensitive disclosure and excessive agency in LLM features | LLM01, LLM02, LLM03, LLM06, LLM10 |
| `client-side` | Client-side cross-site scripting from unsanitized output | LLM05 |

`A` codes are the OWASP Top 10, `API` codes the OWASP API Security Top 10, and `LLM` codes the OWASP Top 10 for LLM Applications.

**Recon-guided classes.** When recon finds a platform or framework these classes do not cover, the class selection step can add a class for it. It researches the class with the model provider's web search tool and writes hunting guidance for this run. Added classes appear on the plan screen with the built-in ones, and you can drop any of them.

**What it does not do:**

- It does not fix code or open pull requests.
- It does not run your code, call a running app or try exploits. It reasons over source text only.
- Its findings are candidates. Expect false positives: in the research benchmark, about 1 in 8 findings matched a known vulnerability (a floor, since real bugs outside the answer key count as misses).
- It is not a dependency database or a rule engine. Dependency findings come from the model reading your manifests and lockfiles.
- It skips tests, vendored dependencies, build output, generated and minified files, and files over 1,000,000 bytes.

## Quickstart

You need **Node.js 20 or later** and an **API key** for the model you use. The default model, GPT-6 Luna, reads `OPENAI_API_KEY`.

```sh
export OPENAI_API_KEY=sk-...
cd my-repo
npx @anshuman11o/secscan
```

On Windows PowerShell, set the key with `$env:OPENAI_API_KEY = "sk-..."`. To keep the command around, install it once with `npm install -g @anshuman11o/secscan` and run `secscan` in any repository.

What happens next:

1. **Four questions, before anything is spent.** secscan shows the model and whether its key is set, then asks you to confirm the folder to scan, where to save reports, what to exclude, and a total budget in USD.

   ```text
   secscan · model GPT-6 Luna · OPENAI_API_KEY found
   Scan this repository?  /path/to/my-repo  (git main @ a1b2c3d)
                          [Enter] yes   [c] change   [q] quit
   Save reports to?       /path/to/my-repo/.secscan/   (kept out of git)
                          [Enter] yes   [c] change
   Exclude anything?      none  (.secscanignore not found)
                          [Enter] no    [c] add files or folders
   Budget in USD?         >
   ```

   If the key is not set, secscan asks for it once with hidden input and keeps it in memory for this run only.
2. **Recon and class selection.** Recon reads the repository and makes up to five model calls. Class selection then picks the classes and may research new ones on the web. Both count against your budget.
3. **The plan screen.** It lists the selected classes with their file counts, the files skipped, the spend so far and the estimate for the rest. You can start, drop or add classes, change the budget or limits, save these settings, or quit. Nothing is spent on the hunt until you start it.
4. **The hunt.** Progress and spend are shown live. Ctrl-C stops it cleanly (see [Reading the report](#reading-the-report)).
5. **The report.** `report.html` opens in your browser, with `findings.json` beside it.

For CI or scripts, skip the prompts with `--yes`, which requires an explicit budget: `secscan scan . --yes --budget 5`.

## Cost and models

secscan is bring-your-own-key. It has no account and no server, and the model provider bills the key you supply. `secscan help` and `secscan models` make no model calls.

`secscan models` lists the models this release ships: the key you pass to `--model`, the provider's model id, the price per million input and output tokens with the date it was checked, whether the model is measured, and whether its API key variable is set. The default is marked `*`.

- **Measured** means the research harness scored that model on its benchmark: OWASP Juice Shop, a TypeScript application, against 97 known vulnerabilities held in a private answer key.
- **Unmeasured** means everything else: the default model, GPT-6 Luna, every model you add with `--models-file`, and every `--base-url` endpoint.

For reference, the measured results on Juice Shop. Recall counts a known vulnerability as found when a finding names the right file, the exact line and the right class; localization allows 15 lines either side.

| Model (`--model`) | Recall | Localization | Cost | Wall clock |
|---|---|---|---|---|
| `luna` (GPT-5.6 Luna) | 71.1% | 88.7% | $4.37 | 13m04s |
| `glm52` (GLM-5.2) | 67.0% | 85.6% | $17.01 | about 18.5 min |
| `gemini36flash` (Gemini 3.6 Flash) | 58.8% | 75.3% | $24.85 | 32m12s |

These numbers come from the research pipeline in August 2026, before this CLI and its class selection step existed, on 541 hunted files out of 865. They describe the approach and those models, not this release, and not your code. Early runs of the default model through secscan on other public test repositories are recorded in the research harness and are below the release bar.

The plan screen shows the cost estimate for your repository, with an accuracy band, before the hunt starts. Recon and class selection have already spent a little by then, and that spend is included in the total.

**Your own endpoint.** Any OpenAI-compatible endpoint can stand in for a shipped model:

```sh
export SCANNER_CUSTOM_API_KEY=...
secscan scan . --base-url https://llm.example.com/v1 --model <model-id> --price 0.5/1.5
```

`--price` is USD per million input/output tokens, and a budget needs it. `--api-key-env` names a different variable for the key. Class selection calls the OpenAI Responses API with its web search tool, so the endpoint must offer both; without them, a scan stops at that step after recon has spent its share.

## Command guide

<!-- commands:start -->

### Commands

| Command | What it does |
|---|---|
| `secscan scan [dir]` | Scan the repository in `dir`, or the current directory. The default command. |
| `secscan models [--all]` | List the models with price, measured or unmeasured, and whether the API key is set. |
| `secscan report [run-id]` | Rebuild a run's `report.html` and `findings.json` from what the run wrote. Default: the newest run. |
| `secscan help [command]` | Show help for every command, or for one. |
| `secscan version` | Print the version. |

| Option | What it does | Command |
|---|---|---|
| `--all` | Also list lab-only models, hidden by default. | `secscan models` |

### Scope

| Option | What it does | Default |
|---|---|---|
| `--paths <p,...>` | Scan only these files or folders, relative to the target. Comma-separated. Repeatable. | the whole repository |
| `--include <glob>` | Scan only files matching this glob. Repeatable. |  |
| `--exclude <glob>` | Skip files or folders matching this path or glob, on top of `.gitignore` and `.secscanignore`. Repeatable. |  |
| `--max-file-size <size>` | Skip files larger than this: bytes, or `200k`, `1m`. Recon always skips files over 1,000,000 bytes. |  |

### Budget & limits

| Option | What it does | Default |
|---|---|---|
| `--budget <usd>` | Total spend cap in USD, including recon and class selection. Also `--max-cost`. | asked before the scan |
| `--max-files <n>` | Scan at most n files; the rest are recorded as not scanned. |  |
| `--timeout <time>` | Start no new file after this long: seconds, or `90s`, `30m`, `1h`. Each resume starts a new window. |  |
| `--concurrency <n>` | Files scanned at once. | derived from the model's rate limits |

### Model

Also works with `secscan models`.

| Option | What it does | Default |
|---|---|---|
| `--model <key>` | A model key or alias from `secscan models`. With `--base-url`, the endpoint's own model id. | the model marked `*` in `secscan models` |
| `--base-url <url>` | Use an OpenAI-compatible endpoint instead, with `--model`. A scan needs its Responses API with web search. |  |
| `--api-key-env <VAR>` | The variable holding that endpoint's API key. | `SCANNER_CUSTOM_API_KEY` |
| `--price <in/out>` | That endpoint's price in USD per million input/output tokens, e.g. `0.5/1.5`. Needed for a budget. |  |
| `--models-file <path>` | Your own `models.json` overlay. Adds models; never replaces shipped ones. |  |

### Classes

| Option | What it does | Default |
|---|---|---|
| `--drop-class <id>` | Remove a selected vulnerability class before the hunt. Repeatable. |  |
| `--add-class <text>` | Add a class by id, number, OWASP code or name. Free text costs a model call to resolve. Repeatable. |  |

### Run control

| Option | What it does | Default |
|---|---|---|
| `-y`, `--yes` | Skip every prompt. Needs `--budget`, except with `--resume`. |  |
| `--resume [run-id]` | Continue a stopped run with its model, spend and finished files. | the latest INCOMPLETE run |
| `--config <path>` | Read settings from this file. | `<dir>/secscan.config.json` |
| `--no-config` | Ignore `secscan.config.json`. |  |

### Output

Also works with `secscan report`.

| Option | What it does | Default |
|---|---|---|
| `--out <dir>` | Reports folder. | `<dir>/.secscan`, or `./.secscan` for `report` |
| `--no-open` | Do not open `report.html` in the browser at the end. |  |

### Examples

```sh
# Scan the current directory; prompts confirm each choice.
secscan

# Cap total spend at $5 and skip the vendor folder.
secscan scan ./my-app --budget 5 --exclude vendor

# No prompts, for CI: --yes needs --budget.
secscan scan . --yes --budget 10

# Continue the latest INCOMPLETE run.
secscan scan --resume

# Show the models and which API keys are set.
secscan models
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | complete, or cancelled at a prompt |
| `1` | failure |
| `2` | usage error |
| `3` | incomplete: a limit or a stop; `--resume` continues it |
| `130` | interrupted |

<!-- commands:end -->

`secscan help <command>` (or `secscan <command> --help`) shows one command and the options it takes.

## Reading the report

Every run gets its own folder inside the reports folder, `.secscan/` in the scanned repository unless you pass `--out`:

```text
.secscan/
  .gitignore           contains *, so nothing here is committed
  index.html           every run with a report, newest first
  calibration.json     what earlier runs taught the cost estimate
  runs/<run-id>/
    report.html        the report page
    findings.json      the same data, in full
    run-record.json    status, limits, spend, files not scanned, resume command
    secscan.log        the full output of every stage
```

- **`report.html`** is one self-contained page with no network requests: scan results, a severity chart, findings by vulnerability type, the ten files with the most findings, an impact table ranked by severity, and run details. Its links open `findings.json` in VS Code at a finding.
- **`findings.json`** (schema `secscan.findings/1`) holds the run facts, any scan gaps, summary counts, every file not scanned with its reason, the resume command, and every finding. A finding has a title, a description, a severity estimate, a confidence from 0 to 1, its classes and OWASP codes, and a trace of steps from entry point to sink, each with a file and line. Findings are sorted by severity, then confidence, then file and line.
- **`index.html`** lists every run in the folder that has a report.

Confidence is shown as High (0.8 and above), Medium (0.5 and above) or Low. A Critical band appears only when a run has a critical finding.

**INCOMPLETE runs.** A budget or time limit, a provider quota, or Ctrl-C ends a run cleanly: files already in flight finish, and the run is recorded INCOMPLETE with the reasons and every file not scanned. Press Ctrl-C twice to abandon the files in flight. The partial report covers exactly the files that finished and shows the command to continue:

```sh
secscan scan --resume            # the latest INCOMPLETE run
secscan scan --resume <run-id> --budget 10
```

A resumed run keeps its model, spend and finished files, and its report then covers every pass. Pass the same `--out` if the run was saved elsewhere. If a report is missing, for example because the CLI was killed, `secscan report <run-id>` rebuilds it from what the run wrote, with no model calls.

## Configuration

**`secscan.config.json`** in the repository root (or the file named by `--config`) sets defaults for a scan. Every field is optional, and command-line flags override it. The plan screen's save option writes it for you.

```json
{
  "model": "luna6",
  "paths": ["src", "api"],
  "include": ["**/*.ts"],
  "exclude": ["**/*.test.ts", "vendor"],
  "classes": { "drop": ["logging-monitoring"], "add": ["ssrf"] },
  "limits": { "max_cost": 5, "max_files": 500, "max_file_size": "200k", "timeout": "30m", "concurrency": 8 }
}
```

The file cannot name an endpoint, a credential variable or a models overlay. It is repository content, so anyone who can change it in a pull request could otherwise send your code and your key elsewhere. A fresh `--yes` run still needs `--budget` on the command line, even when the file sets `max_cost`.

**`.secscanignore`** in the repository root uses `.gitignore` syntax and is applied after your `.gitignore` files. Put anything there you never want scanned or sent to the provider.

**`--models-file <path>`** adds models from your own JSON file, in the same format as the shipped [`models.json`](tools/scanner/shared/models.json): a `targets` object and optional `aliases`. An overlay can add models but never redefine a shipped one or claim a benchmark result.

## Privacy and safety

- **Your code goes only to the model provider you choose.** Recon sends a map of the repository and parts of some files, and the hunt sends each scanned file, all to the selected model's endpoint. Class selection uses that provider's web search tool, and the provider runs those searches.
- **No telemetry and no server.** secscan has no backend and sends nothing anywhere else.
- **Keys stay in your environment.** secscan reads the key from the variable the model names. If it asks for one, it keeps it in memory for that run and does not write it to disk.
- **Reports stay local.** `.secscan/` carries its own `.gitignore` (`*`), so runs are never committed by accident.
- **The model cannot widen its own reach.** When the model asks for another file, a read guard allows only files recon selected inside the target. `.git/`, the reports folder and anything you excluded stay out.
- **Secrets in the tree are withheld.** Key and certificate files (`.pem`, `.key`, `.crt`) are sent as a line count only, and private-key blocks inside other files are redacted.

## Limitations and status

- **Preview.** The release bar is not met, and the default model is unmeasured.
- **Languages.** Only TypeScript has been measured. Recon recognizes many more, including JavaScript, Python, Go, Java, Kotlin, Ruby, PHP, C#, Rust, C, C++, Swift, Dart and Solidity, but results on them are unmeasured.
- **Static reasoning only.** The model reads one file at a time, with recon's map of the repository and any extra files it asks for. A flaw that spans many files can be missed.
- **Precision.** The best measured run had a precision proxy of 12.5%. Expect to triage false positives.
- **Re-runs differ.** Model output is not deterministic, so two scans of the same code can report different findings.
- **Model endpoints.** Class selection needs the OpenAI Responses API with web search, so a model whose endpoint lacks either cannot complete a scan.
- **Windows** is supported on a best-effort basis until it has been smoke-tested. macOS and Linux are the primary platforms.

## Troubleshooting

**"OPENAI_API_KEY is not set."** A run with `--yes`, or one not attached to a terminal, needs the key in the environment before it starts. Export it, or run interactively to be asked once. `secscan models` shows which variable each model reads and whether it is set.

**Behind a proxy.** Set `HTTPS_PROXY` (or `HTTP_PROXY`) and also `NODE_USE_ENV_PROXY=1`, which makes Node route the model calls through it. Node's built-in proxy support needs a recent Node 22 or 24 release; Node 20 does not have it.

**"no terminal to confirm on."** secscan was started without a terminal, for example in CI. Pass `--yes` with `--budget`.

**Node version.** secscan needs Node 20 or later. Check with `node --version`.

**A stopped or failed run.** Run `secscan scan --resume` to continue the latest INCOMPLETE run, with `--budget` to raise the cap. Changing `--paths` or `--exclude` after recon needs a new scan. When a stage fails, secscan prints the end of its log; the full output is in `.secscan/runs/<run-id>/secscan.log`.

**A provider quota or spending limit.** The run stops INCOMPLETE with `provider_quota`. Raise the limit with your provider, then resume.

**No report.** `secscan report` rebuilds the newest run's report; `secscan report <run-id>` rebuilds a specific one.

## About and license

secscan is developed and measured in the [Cybersecurity Coding Agent Harness](https://github.com/Anshuman11o/Cybersecurity-Coding-Agent-Harness), where the benchmark method, per-model results and design records live. Fixes land there first and are exported here.

Released under the [MIT License](LICENSE). Third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
