# Dispatch: Task 1e, npm packaging (runtime, package, hand-off)

Plan: `docs/architecture/npm-packaging-plan.md` (read it first; it is the design).
Productization plan: `docs/architecture/productization-plan.md` §1.2, §2.11, Part 5 task 1e.
Branch: `claude-anshuman/intelligent-hamilton-b0zkw0`. Do not commit; the orchestrator
verifies and commits.

**Standing constraint: never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** That includes every directory
whose name contains `answer-key`, `/home/user/harness-private/`, and any file
named or containing `benchmark_ground_truth`. Nothing in this task needs them.

Baseline before any change (2026-10-16, main `52faa21`), all green:
cli 54, report 47, shared 17, stage-playbook-agent 81, stage05-lane-selector-perfile 11,
stage1-budget-governor 30, stage2-hunt-lanes-perfile 39, stage0-recon 35
(`npx tsx --test src/*.test.ts`). A part is done only when its suites are still green
and its new tests pass.

Rules that bind every part:
- `run.sh`, `install.sh`, v1 stages (`stage05-lane-selector`, `stage2-hunt-lanes`) are
  not edited.
- The `benchmark` profile's behaviour is unchanged. `guard.test.ts` pins stay.
- No model id, endpoint or credential env var in code; the registry only.
- Edit only the files your part owns (below). Parts run at the same time in one tree.
- Match the surrounding code's comment density and idiom.

---

## Part A: runtime (1e-1)

Owns: `tools/scanner/cli/src/stages.ts`, the `cliVersion()` function and the bottom
entry guard of `tools/scanner/cli/src/secscan.ts` (nothing else in that file), new
`tools/scanner/shared/entry.ts`, `tools/scanner/shared/meta.ts` (`gitSha` only), the
entry guards in `stage2-hunt-lanes-perfile/src/hunt-executor.ts`,
`stage1-budget-governor/src/budget-governor.ts`, `stage-playbook-agent/src/main.ts`,
`stage-playbook-agent/src/review.ts`, path-portability fixes anywhere under
`stage0-recon/src`, `shared/read-guard.ts`, `stage05-lane-selector-perfile/src`,
`stage2-hunt-lanes-perfile/src`, `report/src` (only where a Windows path bug is real),
and new tests `cli/src/stages.test.ts`, `shared/entry.test.ts` (wire into
`shared/package.json` test script).

1. **Launcher.** Rewrite `launchStage` so the CLI no longer runs `bash run.sh`.
   - Stage table, keyed by the stage names the CLI already uses:
     `stage0-recon → stage0-recon/src/recon`,
     `stage-playbook-agent → stage-playbook-agent/src/main`,
     `stage05-lane-selector-perfile → stage05-lane-selector-perfile/src/lane-selector-perfile`,
     `stage1-budget-governor-perfile → stage1-budget-governor/src/budget-governor --v2 --mode estimate`,
     `stage2-hunt-lanes-perfile → stage2-hunt-lanes-perfile/src/hunt-executor`,
     `reconcile-v2 → stage1-budget-governor/src/budget-governor --v2 --mode reconcile`.
     Unknown stage → throw.
   - Scanner root = `join(dirname(fileURLToPath(import.meta.url)), '../..')`.
     If this module is `.ts` (running from source), spawn
     `process.execPath [<tsx cli>, <entry>.ts, ...args]`, with `<tsx cli>` from
     `createRequire(import.meta.url).resolve('tsx/cli')`. If it is `.js` (built
     package), spawn `process.execPath [<entry>.js, ...args]`. Pass the realpath of
     the entry file.
   - cwd: the stage's package directory (`<root>/<dir>`), as `npm run` gave it.
   - Env: the caller's `l.env`, plus `SCANNER_PROVIDER=<provider>`,
     `SCANNER_PROFILE=product`, `SCANNER_TARGET=<realpath of target>`,
     `SCANNER_RUN_ID=<runId>`, `SCANNER_RESUME=1` only when `resume` (else delete it),
     and `NODE_USE_ENV_PROXY=1` only when any of `HTTPS_PROXY https_proxy HTTP_PROXY
     http_proxy` is non-empty (else leave it unset). Keep `SCANNER_REPORTS_ROOT` and
     `SCANNER_RUNS_ROOT` from `l.env`.
   - Logs: stdout and stderr go to `l.logPath` (append, as today) and also to
     `<SCANNER_RUNS_ROOT>/<provider>/<logdir>/logs/<stage>.stdout.log` /
     `.stderr.log`, where `<logdir>` is the stage name except `reconcile-v2 →
     stage1-budget-governor-perfile` (run.sh's `stage_logdir`). Write a
     `=== [<provider>] <stage> ===` header and `=== [<provider>] <stage> exited <code> ===`
     footer line into `l.logPath`, as run.sh did.
   - Keep the `StageLaunch` / `RunningStage` / `StageResult` shapes, so
     `secscan.ts` and `orchestration.test.ts` need no change beyond `RUN_SH` if any test
     imports it (check; if a test imports `RUN_SH`, replace that use and say so).
   - Drop the cross-provider lock for CLI launches (product runs have their own run
     directory); explain this in the module comment.
2. **Signals.** POSIX: unchanged (`detached: true`, group signals via `-pid`).
   Windows (`process.platform === 'win32'`): spawn with `detached: true,
   windowsHide: true` so the console's Ctrl-C reaches only the CLI; `signalStage`
   uses `child.kill(sig)` for anything but SIGKILL, and for SIGKILL runs
   `taskkill /pid <pid> /T /F` (best effort, ignore errors). Make the platform an
   injectable parameter so a test can cover the win32 branch on Linux.
3. **Entry guards.** New `shared/entry.ts` exporting
   `isEntryPoint(metaUrl: string, argv1 = process.argv[1], platform = process.platform): boolean`:
   compare `realpathSync` of both (fall back to `resolve` on error), lower-cased
   on win32. Replace `process.argv[1] === fileURLToPath(import.meta.url)` in
   hunt-executor, budget-governor, playbook-agent main and review, and the CLI's
   `import.meta.url === pathToFileURL(resolve(process.argv[1])).href`. Behaviour
   under `tsx` must be unchanged.
4. **Build info.** The package build writes `<REPO_ROOT>/build-info.json`
   (`REPO_ROOT` from `shared/run-context.ts`; in the package that is `dist/`), shape
   `{ name, version, harness_commit, built_at }`. Absent in the harness.
   - `cliVersion()`: if build-info exists, return `"<version> (harness <harness_commit>)"`;
     else the current behaviour (read `../package.json` via `fileURLToPath`, not
     `.pathname`, which breaks on Windows).
   - `meta.ts gitSha()`: if build-info exists, return its `harness_commit`; else the
     current `git rev-parse`.
5. **Path portability audit** (Windows). Look for: string `'/'` joins and splits of
   OS paths, `startsWith(root + '/')`, `relative()` results used as POSIX keys without
   `split(path.sep).join('/')`, `.gitignore`/`ignore` matching fed native paths, and
   `new URL(...).pathname` used as a file path. Fix real bugs minimally; list each fix.
   If something cannot be fixed without risk, list it as a known Windows gap instead.

Tests: `cli/src/stages.test.ts` covering the table, dev vs dist argv, env rules
(resume, proxy), log file placement and the win32 signal branch (with a fake child).
`shared/entry.test.ts` covering symlink and case rules. Run all suites listed in the
baseline.

## Part B: package, registry and export (1e-2, 1e-3)

Owns: new `tools/scanner/package/` (except `README.md`), `tools/scanner/shared/models.json`
(add `"lab_only": true` to `sonnet5cli` and `luna-fixed` only), `shared/models.ts` (only if
needed to expose `lab_only`), `cli/src/registry.ts` (add `labOnly` to `ModelInfo`),
`cli/src/display.ts` (hide `labOnly` unless `--all`; the footer points to the README instead
of `docs/benchmarking-results.md`), new `tools/release/`.

1. **`tools/scanner/package/package.json`**: name `@anshuman11o/secscan`, version `0.1.0`,
   description, `license: MIT`, `type: module`, `engines.node >=20`,
   `bin: { "secscan": "dist/tools/scanner/cli/src/secscan.js" }`,
   `files: ["dist", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"]`,
   `repository` → `github.com/anshuman11o/secscan`, keywords, `dependencies` =
   the union of the shipped stages' runtime dependencies at the versions their
   package.json files declare (openai, ts-morph, web-tree-sitter, tree-sitter-wasms,
   ignore, js-yaml, https-proxy-agent; check each shipped package), `devDependencies`:
   esbuild (exact version), `scripts`: `build`, `smoke`, `prepack` (build).
   Commit a `package-lock.json` for the package.
2. **`build.mjs`**: source root = `../` (tools/scanner) when run in the harness; in the
   product repo the export keeps the same `tools/scanner/…` layout, so resolve the
   source root as `<package dir>/..` if `<package dir>/../shared/models.json` exists,
   else `<package dir>/tools/scanner` (the product repo puts the package files at its
   root). Then:
   - wipe `dist/`;
   - transpile (esbuild, `bundle: false`, `format: esm`, `platform: node`,
     `target: node20`) every `.ts` under `shared/`, `cli/src/`, `report/src/`,
     `stage0-recon/src/`, `stage-playbook-agent/src/`,
     `stage05-lane-selector-perfile/src/`, `stage1-budget-governor/src/`,
     `stage2-hunt-lanes-perfile/src/`, excluding `*.test.ts`, `fixtures/`,
     `test-harness.ts`, `test-breakdown.ts`, `preflight.ts`, `node_modules/`, to
     `dist/tools/scanner/<same relative path>.js`;
   - copy assets: `shared/vuln-classes.json`, `shared/signal-classes.json`,
     `stage-playbook-agent/guidance.md`, `stage2-hunt-lanes-perfile/src/playbooks/*.ts`
     (verbatim, as data: the budget governor and report read their text), and any other
     non-TS file a shipped module reads at runtime (grep `readFileSync`, `new URL(`,
     `join(__dirname` in shipped sources; list what you found);
   - write `dist/tools/scanner/shared/models.json` = the registry minus every
     `lab_only` target, and minus aliases pointing at them; fail if the product
     default is missing or any shipped target's transport is not the HTTP/OpenAI one;
   - rewrite the first line of `dist/tools/scanner/cli/src/secscan.js` to
     `#!/usr/bin/env node` and chmod 755;
   - write `dist/build-info.json` `{ name, version, harness_commit, built_at }`
     (`harness_commit` from `git rev-parse --short HEAD` of the source root, or from an
     `EXPORTED_FROM` file at the package root when present, else `"unknown"`);
   - copy `../../../LICENSE` and `../../../THIRD-PARTY-NOTICES.md` into the package dir
     when building in the harness (they are gitignored there; committed in the product repo).
   - Check transpiled `.js` imports resolve: every relative import in `dist` points at
     an existing file (fail with the list otherwise).
3. **`smoke.mjs`**: `npm pack` into a temp dir, install the tarball into a temp prefix
   (`npm install --prefix <tmp> <tgz>`), then run the installed `secscan`
   (`<tmp>/node_modules/.bin/secscan`, `.cmd` on win32) with `--version`, `--help`,
   `models`, and `scan <tmp fixture dir> --yes --budget 0.01` with the selected
   model's key unset (expect exit 2 or 1 with a readable message and no stack trace).
   Print PASS/FAIL per step; exit non-zero on any FAIL. Never needs an API key.
4. **Registry**: `lab_only` in models.json (two entries); `ModelInfo.labOnly`;
   `renderModels` hides `labOnly` or non-openai unless `all`. Add a test in
   `cli/src/` for the filter.
5. **`tools/release/leak-guard.mjs`**: export `scanTree(dir)` and `scanTarball(tgz)`
   returning violations; CLI `node leak-guard.mjs <dir|tgz>` exits 1 on any.
   Path rules: refuse any path segment `target-apps`, `results`, `runs`, `prompts`,
   `docs`, `eval`, `scan-benchmark`, `blind-development`, `patcher`, `fixtures`,
   `node_modules` (tarball only: dependencies are not packed anyway), files
   `*.test.ts`, `*.test.js`, `.env*`, `stage05-lane-selector/`, `stage2-hunt-lanes/` (v1).
   Content rules: `benchmark_ground_truth`, `harness-private`, `answer-key` (as a
   repository/directory name, e.g. `-answer-key` or `answer-key/`; decide the exact
   regex by running it over the shipped tree and reporting every hit and how you
   classified it; do not weaken a rule to pass, change what ships), any models.json
   target with `lab_only`, private-key blocks with a base64 body, and key-shaped
   literals (`sk-[A-Za-z0-9_-]{20,}`, `AKIA[0-9A-Z]{16}`, `ghp_[A-Za-z0-9]{36}`,
   `xox[baprs]-`). Tests in `tools/release/leak-guard.test.mjs` (node:test) incl. planted
   violations.
6. **`tools/release/export-product.mjs <dest>`**: refuse if `<dest>` is inside this repo
   or not empty except for `.git`; copy the allowlist (the source dirs and assets the
   build uses, each stage's `tsconfig.json`, plus `tools/scanner/package/*` minus
   `node_modules`/`dist`/`*.tgz`) into `<dest>` so that `<dest>/package.json`,
   `<dest>/build.mjs`, `<dest>/README.md` sit at the root and sources sit at
   `<dest>/tools/scanner/…`; copy root `LICENSE` and `THIRD-PARTY-NOTICES.md`; write
   `<dest>/EXPORTED_FROM` (`harness_commit`, date); write a product `.gitignore`
   (`node_modules/`, `dist/`, `*.tgz`, `.secscan/`); run the leak guard on `<dest>` and
   fail on violations. Test: export to a temp dir, then `npm ci && npm run build` there
   succeeds (skip `npm ci` if offline; say so).

Verify: `cd tools/scanner/package && npm install && npm run build && npm run smoke`.
`--version`, `--help` and `models` must work from the installed tarball. Report the packed file
count and size.

## Part C: help and docs (1e-2, 1e-3)

Owns: `tools/scanner/cli/src/args.ts`, new `tools/scanner/cli/src/help-doc.ts`, new
`tools/scanner/cli/src/help.test.ts`, `tools/scanner/package/README.md` (new),
`tools/scanner/cli/README.md`, root `README.md` (a pointer box only), and an appended
decision log in `docs/architecture/productization-plan.md`. Do not edit `secscan.ts`; the
orchestrator wires `help <topic>` into it.

1. **One command definition** in `args.ts`: commands (`scan`, `models`, `report`,
   `help`, `version`) and option groups (Scope, Budget & limits, Model, Classes, Run
   control, Output) with name, value placeholder, description, and default where one exists.
   `parseArgs` behaviour must not change (existing tests stay green), except that `help`
   now accepts an optional topic (`secscan help scan`, `secscan scan --help`,
   `secscan models --help`) returning `{ command: 'help', topic?: string }`; an unknown
   topic is a `UsageError`.
2. **`usage(customKeyDefault, topic?)`** renders grouped help from the definition:
   - a 2-line description
   - the quickstart (`secscan` in a repo, or `npx @anshuman11o/secscan`)
   - commands
   - option groups
   - 3 to 5 examples
   - exit codes
   - a footer with `https://github.com/anshuman11o/secscan`

   With a topic, show only that command and its options. Keep the existing facts:
   reports location, Ctrl-C semantics, `--yes` requiring `--budget`.
3. **`help-doc.ts`**: `renderCommandGuide(customKeyDefault)` returns Markdown for the
   README (a table per group). `help.test.ts` asserts the text between
   `<!-- commands:start -->` and `<!-- commands:end -->` in
   `tools/scanner/package/README.md` equals `renderCommandGuide(<the registry's custom
   key default>)`, and covers `help <topic>` parsing. Add a tiny script
   (`cli/src/help-doc.ts` runnable with `--write`) that rewrites the README block.
4. **Product README** (`tools/scanner/package/README.md`). This is the hand-off page.
   It renders on GitHub and npm; keep it skimmable, with no em dashes. Sections:
   1. title, one-paragraph what-it-is, and a "preview" notice
   2. what it finds: the classes from `shared/vuln-classes.json` as names with OWASP
      codes, plus recon-guided extra classes. What it does not do: no patching, no
      execution, findings are candidates, false positives expected.
   3. quickstart: requirements (Node 20+, a model API key); 3 commands; what happens
      (prompts, the budget question, the report opening)
   4. cost and models: BYOK; `secscan models`; measured vs unmeasured; the default model;
      the custom OpenAI-compatible endpoint; benchmark figures quoted as reference.
      Aggregates only, taken from the root `README.md`. Never a file, line or
      challenge name.
   5. command guide (generated block)
   6. reading the report (`report.html`, `findings.json`, `index.html`, run record,
      INCOMPLETE and `--resume`)
   7. configuration: `secscan.config.json`, `.secscanignore`, `--models-file`
   8. privacy and safety: code goes only to the provider you choose; no telemetry; no
      server; `.secscan/` is git-ignored; the read guard keeps reads inside the target
   9. limitations and status: preview, unmeasured languages, static reasoning only,
      precision proxy, re-runs differ, Windows best effort until smoke-tested
   10. troubleshooting: missing key, proxy, Node version, a stopped run
   11. a link to the research harness and the license

   Facts must come from the code and the root README. Check each flag against `args.ts`.
5. **Root `README.md`**: a short box right under the title: "Use the scanner on your
   own repo: github.com/anshuman11o/secscan (npm `@anshuman11o/secscan`)." Nothing
   else changes.
6. **`productization-plan.md`**: append a "Decision log" section with a 2026-10-16
   entry listing the changes from `npm-packaging-plan.md`:
   - the name
   - the separate product repo
   - transpile-not-bundle
   - the CLI launcher without bash
   - manual publish
   - the smoke-only gate

   Do not rewrite earlier text.
7. **`cli/README.md`**: the "local npm package" section mentions the packaged install
   and that the CLI no longer goes through `run.sh`.
