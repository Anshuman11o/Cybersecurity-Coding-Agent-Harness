# npm packaging and hand-off plan (Task 1e)

Status: decided with the owner on 2026-10-16; implementation started the same day.
Part of `productization-plan.md` (Step 1, task 1e). Where this file and the
productization plan disagree, this file is newer; the decision log at the end of
`productization-plan.md` records the changes.

## Context

Tasks 1a to 1d are merged:
- run context
- generalized recon
- the `secscan` CLI with its prompts, budget, resume and `models`
- the report stage

The CLI still runs only inside this checkout:
- `tools/scanner/install.sh` installs about 10 private packages, each with its own `node_modules`.
- `cli/src/stages.ts` spawns `bash run.sh … <stage>` for every stage.
- `run.sh` runs `npm run`, which runs `tsx`.

None of that works on Windows, and none of it can be published.

The goal is one link the owner can hand to a developer. From it, the developer can:
- understand what the scanner does and does not do
- install and run it on their own repository with their own API key
- find every terminal command in one short guide

## Decisions

| Topic | Decision |
|---|---|
| First release | Public on npm as `0.1.0`, labelled **preview**. The README states the release-bar status (§3.1 of the productization plan) instead of the release waiting for it. |
| npm name | `@anshuman11o/secscan`. The unscoped `secscan` is taken by an unrelated 2022 package. The command stays `secscan`. |
| Platforms | macOS, Linux, Windows |
| Product repo | New public repo `github.com/anshuman11o/secscan`: product source, build and README only |
| Source of truth | This harness. Code flows one way, harness → product repo, through an allowlisted export with a leak guard. Fixes land here first. |
| Hand-off link | `github.com/anshuman11o/secscan`. The npm page renders the same README file. |
| Orientation | The product README plus a grouped `secscan --help`. The README's command guide is generated from the same definition as `--help`, and a test fails if they drift. |
| Models shipped | **One fixed model, GPT-6 Luna (`luna6`)**, owner decision 2026-10-17. `shared/models.json` `product_models` lists what ships; the build drops every other target and the custom-endpoint template. The packaged CLI then has no `models` command and no `--model`, `--base-url`, `--api-key-env`, `--price` or `--models-file` (cli/src/registry.ts `cliMode()`); the harness keeps full model choice. (Superseded: the first cut shipped 11 models minus `lab_only`.) |
| Publishing | Manual `npm publish --access public` by the owner, with 2FA |
| Release gate | Smoke tests only, run manually by the owner. The owner also does an end-to-end test and a README review before handing the link to anyone. |

## What the end user experiences

1. They open `github.com/anshuman11o/secscan` (or the npm page). The first screen shows:
   - what it finds and what it does not
   - the requirements: Node 20+ and their own API key
   - a 3-line quickstart:
     ```
     export OPENAI_API_KEY=sk-...
     cd my-repo
     npx @anshuman11o/secscan
     ```
2. The round-1 prompts confirm the target, the reports folder, exclusions and the budget before any spend.
3. `report.html` opens at the end. It and `findings.json` live under `<repo>/.secscan/`, which is kept out of git.
4. `secscan --help` and the README's command guide cover everything else.

## Technical design

These refinements came from reading the code after the plan was agreed. They
replace the "bundle with tsup" and "assets helper" ideas in the first draft.

### Package layout: transpile, don't bundle

The build transpiles each shipped `.ts` file to `.js` with esbuild (no
bundling, no code splitting) and **keeps the repository layout** under `dist/`:

```
@anshuman11o/secscan/
  package.json            bin: secscan -> dist/tools/scanner/cli/src/secscan.js
  README.md  LICENSE  THIRD-PARTY-NOTICES.md
  dist/
    build-info.json       { name, version, harness_commit, built_at }
    tools/scanner/
      shared/             *.js + models.json (lab_only removed), vuln-classes.json, signal-classes.json
      cli/src/            secscan.js (#!/usr/bin/env node) …
      report/src/
      stage0-recon/src/
      stage-playbook-agent/ src/ + guidance.md
      stage05-lane-selector-perfile/src/
      stage1-budget-governor/src/
      stage2-hunt-lanes-perfile/src/ (+ playbooks/*.ts kept as data)
```

Why this layout:
- The code already resolves files three ways: `import.meta.url`, `REPO_ROOT = <shared>/../../..` and joins like `join(REPO_ROOT, 'tools/scanner/shared/vuln-classes.json')` (budget governor). Keeping `tools/scanner/` under `dist/` makes `dist/` the `REPO_ROOT`, and every one of those paths resolves unchanged.
- Each module keeps its own `import.meta.url`, so the per-stage entry guards keep their meaning. With a bundle they would be wrong: a guard inside a module bundled into the CLI would fire in the CLI process.
- The budget governor and the report read the built-in playbooks' **`.ts` text** for size estimates and scope. Those files ship as data next to their `.js`.
- Runtime dependencies resolve from the package root `node_modules`, including the tree-sitter WASM grammars.

Excluded from the package: tests, fixtures, the v1 stages, `run.sh` and `install.sh`, every lab directory, and `node_modules`.

### Stage launcher with no bash

`cli/src/stages.ts` stops spawning `bash run.sh`. It owns the v2 stage table and spawns:
- **from source** (lab and dev): `node <tsx cli> <stage>/src/<entry>.ts [args]`
- **from `dist/`** (package): `node <stage>/src/<entry>.js [args]`

From `run.sh` it keeps, for the product profile:
- the stage → entry/args mapping (`stage1-budget-governor-perfile` → `budget-governor --v2 --mode estimate`, `reconcile-v2` → `--mode reconcile`)
- `SCANNER_PROVIDER`, `SCANNER_RESUME` only when resuming, and the realpath'd `SCANNER_TARGET`
- `NODE_USE_ENV_PROXY=1` only when a proxy variable is set
- cwd = the stage's package directory
- per-stage `logs/<stage>.std{out,err}.log` next to the stage artifacts, plus the CLI's `secscan.log`

What it drops:
- **The cross-provider lock.** It protects the lab's shared `runs/<provider>/` tree, and every product run has its own directory.
- **`run.sh` itself, for CLI launches only.** `run.sh` is unchanged and remains the lab entry point.

Signals:
- **POSIX:** unchanged. The stage gets its own process group; the first Ctrl-C on the hunt is a stop file, and a forced stop signals the group.
- **Windows:** `detached` + `windowsHide`, so the user's console Ctrl-C reaches only the CLI. The stop file works the same. A forced stop uses `taskkill /T /F`.

### Entry-point guards

`process.argv[1] === fileURLToPath(import.meta.url)` fails in two cases:
- under npm's bin symlink: argv is the symlink, the URL is the real file
- on Windows, where paths can differ in case

A new `shared/entry.ts` provides `isEntryPoint(import.meta.url)`, which compares realpaths (case-insensitively on Windows). It replaces the exact-equality guards in the v2 stages and the CLI.

### Version and provenance

The build writes `dist/build-info.json`. Two readers use it:
- `secscan --version` prints `0.1.0 (harness <sha>)`.
- `meta.json`'s `git_sha` uses `harness_commit`. Without it, `git rev-parse` would run outside a repo, or inside the user's repo when installed locally, and report the wrong commit.

### Product registry

- `shared/models.json` gains `"lab_only": true` on `sonnet5cli` and `luna-fixed`. The registry stays the single source of truth, so adding a model is still one entry.
- `secscan models` hides `lab_only` entries unless `--all`.
- The build writes `dist/…/shared/models.json` without them. It fails if any shipped entry uses a transport other than OpenAI-compatible HTTP, or if the product default is missing.

### Help and README

- The CLI's flags and commands move to one typed definition in `cli/src/args.ts`. `usage()` renders it as grouped help with examples, and `secscan help <command>` shows one command.
- `cli/src/help-doc.ts` renders the same definition as Markdown.
- The package README carries it between `<!-- commands:start -->` and `<!-- commands:end -->` markers, and a test fails if the two differ.

### Export and leak guard

`tools/release/export-product.mjs <product-repo-dir>`:
- copies an **allowlist**: the v2 stage sources, `shared/`, `cli/`, `report/`, and `tools/scanner/package/*`
- lays it out as the product repo (`tools/scanner/…` stays as is, so the same `build.mjs` works in both repos)
- records the source harness commit in `EXPORTED_FROM`

The leak guard (`tools/release/leak-guard.mjs`) runs on:
- the exported tree
- the packed tarball's file list
- the tarball's contents

It refuses:
- answer-key and private-store markers (`benchmark_ground_truth`, `harness-private`, `-answer-key`)
- lab paths (`target-apps/`, `results/`, `runs/`, `prompts/`, `docs/`, `tools/eval`, `tools/scan-benchmark`, `tools/blind-development`, `tools/patcher`)
- test files and fixtures
- `lab_only` models
- `.env` files and key-shaped strings

If it fires, change what is shipped; never loosen the guard. (Same rule as `tools/patcher/src/archive_run.py`.)

The benchmark-profile branch of `shared/run-context.ts` ships but cannot be reached: the CLI always sets `SCANNER_PROFILE=product`.

## Work breakdown

The session is bound to one branch, so this lands as one PR with three commits:

| Part | Scope |
|---|---|
| 1e-1 runtime | `cli/src/stages.ts` launcher; `shared/entry.ts` + guards; Windows signals; `build-info` readers; path-portability audit of recon file selection, the read guard and the lane selector |
| 1e-2 package | `tools/scanner/package/` (package.json, `build.mjs`, smoke script); `lab_only` + `models` filter; grouped `--help`, `help <command>`, generated README command guide |
| 1e-3 hand-off | `tools/release/export-product.mjs` + leak guard + tests; product README; harness README pointer; decision log in `productization-plan.md` |

## Owner steps (manual)

1. Create `github.com/anshuman11o/secscan` (public).
2. Create the npm account `anshuman11o` and enable 2FA.
3. `node tools/release/export-product.mjs ../secscan`, then commit in the product repo.
4. In the product repo: `npm ci && npm run build && npm run smoke && npm pack`.
5. Pre-publish smoke, on each OS available:
   - install the `.tgz` into a temp prefix
   - `secscan --version`, `secscan --help`
   - `secscan models`: shows only shipped models, `luna6` is the default
   - `secscan scan <tiny dir> --yes --budget 0.01` with no key: a clean "key not set" exit
   - interactive start, then `q`
   - Ctrl-C at a prompt

   If Windows cannot be tested, the README says Windows is best effort.
6. The owner's end-to-end paid run and README review.
7. `npm publish --access public`, tag `v0.1.0`, and create a GitHub Release.
8. Share `github.com/anshuman11o/secscan`.

## Verification (harness side, before the PR is marked ready)

- `npm test` in `cli/`, `shared/`, `report/`, `stage1-budget-governor/`, `stage05-lane-selector-perfile/`, `stage2-hunt-lanes-perfile/` and `stage-playbook-agent/`: no new failures against the pre-change baseline.
- `run.sh` is unchanged (`git diff --stat` shows no edit).
- `tools/scanner/package`: `npm run build`, then `npm pack`. Install the tarball into a temp prefix outside the repo, then run `secscan --version`, `--help`, `models` and a no-key scan, which must exit cleanly.
- From the installed tarball, a product run through recon → lane selection → plan on a small fixture with a fake endpoint, to prove the launcher and the asset paths.
- The leak guard passes on the export and the tarball, and fails on a planted answer-key file and a planted `lab_only` model.
