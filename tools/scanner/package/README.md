# secscan

**An AI agent that scans your codebase for security vulnerabilities and reports them.**

secscan runs from your terminal as an npm package. Point it at a repository, set a budget, and it returns every vulnerability it finds with the file, the line and the OWASP class, in a JSON bug report and an HTML summary.

> **Preview (0.1.0).** Treat findings as leads for a human to check, not as a verdict.

## Benchmark

Latest runs of secscan on its default model, **GPT-6 Luna**, against held-out repositories with known vulnerabilities (2026-10-16):

| Target | Known vulnerabilities | Recall | Total run cost |
|---|---|---|---|
| Deliberately vulnerable AI web app (Python, React, Terraform) | 23 | **91.3%** | **$0.20** |
| Deliberately vulnerable Android app (Kotlin) | 29 | **86.2%** | **$0.35** |
| Smart contracts with known bugs (Solidity) | 207 | **92.3%** | **$0.85** |

Recall counts a known vulnerability as found when a finding points at the right file within 15 lines of it.

**Why GPT-6 Luna is the default:** it finds close to 9 in 10 known vulnerabilities while a full scan costs under a dollar, at $0.10 / $0.50 per million input / output tokens. You can switch models with `--model`; see [Models and cost](USAGE.md#models-and-cost).

## What it finds

- **Where:** the exact file and line of each vulnerability.
- **What:** its class (for example `injection`, `access-control`, `crypto-auth`) and OWASP codes from the Top 10, API Security Top 10 and LLM Top 10. [All classes](USAGE.md#vulnerability-classes).
- **A detailed JSON bug report** (`findings.json`) with severity, confidence and a trace from entry point to sink for every finding.
- **An HTML summary report** (`report.html`). [See a sample](https://raw.githack.com/anshuman11o/secscan/main/sample-report.html).

## Quickstart

**1. Requirements.** [Node.js 20+](https://nodejs.org) and an [OpenAI API key](https://platform.openai.com/api-keys). You pay the provider directly; secscan has no account or server.

**2. Set your key.**

```sh
export OPENAI_API_KEY=sk-...           # Windows PowerShell: $env:OPENAI_API_KEY = "sk-..."
```

**3. Run it in the repository you want to scan.**

```sh
cd my-repo
npx @anshuman11o/secscan
```

Or install once with `npm install -g @anshuman11o/secscan` and run `secscan` anywhere.

**4. Answer the start-up prompts.** Nothing is spent until you confirm.

| Prompt | What to do |
|---|---|
| Scan this repository? | `Enter` to accept the current folder, `c` to change it |
| Save reports to? | `Enter` for `.secscan/` (kept out of git) |
| Exclude anything? | `Enter` for none, or `c` to add files or folders |
| Budget in USD? | Type a cap, for example `5`. The scan stops there. |

secscan then reads the repository, picks the vulnerability classes that fit it, and shows a **plan screen** with the cost estimate. Press start, and the report opens in your browser when the scan finishes.

**For CI**, skip the prompts: `secscan scan . --yes --budget 5`

## Scope

- **Languages measured:** TypeScript, Python, Terraform, Kotlin (Android), Solidity, C (C is the weakest today).
- **Also recognized, unmeasured:** JavaScript, Java, Go, Ruby, PHP, C#, Rust, C++, Swift, Dart.
- **Static analysis only:** it reads source code; it does not run your app, try exploits or fix code.

## Learn more

- [Usage guide](USAGE.md): a scan step by step, [commands and options](USAGE.md#commands-and-options), [configuration](USAGE.md#configuration)
- [Reports](USAGE.md#reports): what is in `report.html` and `findings.json`, resuming stopped runs
- [Models and cost](USAGE.md#models-and-cost): other models, your own endpoint
- [Privacy and safety](USAGE.md#privacy-and-safety): what leaves your machine
- [Limitations](USAGE.md#limitations) and [troubleshooting](USAGE.md#troubleshooting)
- [Sample report](https://raw.githack.com/anshuman11o/secscan/main/sample-report.html) ([source](sample-report.html))

## About

secscan is built, tested and measured in the [Cybersecurity Coding Agent Harness](https://github.com/Anshuman11o/Cybersecurity-Coding-Agent-Harness), which holds the scanner architecture, every test run, the evals and the per-model benchmark results. Fixes land there first and are exported here.

Released under the [MIT License](LICENSE). Third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
