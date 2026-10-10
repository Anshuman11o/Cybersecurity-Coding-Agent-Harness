# Productization plan: ship the scanner to end users

Status: approved by the owner on 2026-10-09. Implementation follows Part 5;
each task lands as its own PR, and the next task starts only after the previous
one is merged and evaluated against Part 3.

## Context

The scanner is a research harness today. It runs only from the owner's checkout and
only on OWASP Juice Shop. There it scores 71.1% exact-line recall and 88.7%
localization for $4.37 on GPT-5.6 Luna (`README.md`, `docs/benchmarking-results.md`).
The goal is a tool any developer can run on their own codebase, with their own API
key, and get a report they can act on.

Decisions taken with the owner (2026-10-08):

| Decision | Answer |
|---|---|
| Audience | Individual developers and OSS maintainers |
| Inference cost | Paid by the user with their own API key (BYOK); never by the owner |
| Language scope | Language-agnostic best effort; languages without measured results are labelled "unmeasured" |
| License | MIT, fully open source |
| Delivery options | Two: an npm package run in the terminal, and a GitHub Action |
| Out of scope for this plan | Patcher, verification stage (a recommendation only, §2.12), coding-agent/skill delivery, hosted service |

"secscan" below is a placeholder name.

The plan has four parts:
1. delivery
2. scanner update
3. readiness evaluation
4. report contents

---

## Part 1 · Product delivery: two options, one package

### 1.1 How the repo splits

One npm package (the **engine + CLI**) is the product. Both options use it. The
research harness stays in the repo as the internal **lab** and is never shipped.

| Today | Becomes |
|---|---|
| `tools/scanner/stage0-recon`, `stage05-lane-selector-perfile`, `stage1-budget-governor`, `stage2-hunt-lanes-perfile`, `shared/` (models.json, read guard, playbooks, class registry) | **Engine**, after Part 2 makes it target-agnostic |
| *(new)* CLI layer: flags, run-start confirmation, progress, report writer | **Option A**, the `secscan` command |
| *(new)* `action.yml`, a thin wrapper that runs the same CLI | **Option B**, the GitHub Action |
| `target-apps/`, `results/`, `runs/`, `tools/eval`, `tools/scan-benchmark`, `tools/blind-development`, ledgers, blind-dev rules, `sonnet5cli` transport, v1 pipeline, all other research tooling | **Lab**: internal only, not in the package. v1 is preserved exactly. |

### 1.2 Option A: npm package in the terminal

The user installs nothing. They run:
```bash
export OPENAI_API_KEY=sk-...        # their own key and account
npx secscan scan ./my-app
```
- The run-start confirmation (§2.7) shows directories, limits, model and estimated
  cost before any spend.
- Progress and spend are shown live.
- The report is written locally (Part 4).
- The user's code goes only to the model provider they chose; the owner runs no
  server and sees nothing.

**Publishing.**
- `npm publish` puts the package on npmjs.com, free for public packages.
- Source stays on GitHub under MIT.
- Versions are semver; users can pin, e.g. `npx secscan@1.2.0`.
- Requirement: Node 20+.

### 1.3 Option B: GitHub Action

The user adds one workflow file to their repo and stores their API key as an
encrypted **repository secret**. GitHub then runs the scanner on GitHub's machines.
The Action is a small public repo (`action.yml`) that calls
`npx secscan@<pinned version>`.

Three trigger modes, all built on scanner features from Part 2:

| Mode | Trigger | What runs |
|---|---|---|
| **Per PR** | `pull_request` | Diff mode: changed files plus the files that import them or are imported by them (§2.8). Results appear inline on the PR. |
| **Cadence** | `schedule` (cron, e.g. weekly) | Full scan within the limits in the repo's config file |
| **On command** | `workflow_dispatch` ("Run workflow" button) | Full or path-scoped scan, with inputs for paths, max cost and model |

```yaml
# .github/workflows/secscan.yml  (in the user's repo)
on:
  pull_request:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:
    inputs: { max-cost: { default: "5" }, paths: { default: "" } }
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions: { contents: read, security-events: write }
    steps:
      - uses: actions/checkout@v5
      - uses: <owner>/secscan-action@v1
        with: { api-key: "${{ secrets.OPENAI_API_KEY }}" }
```

- **No interactive prompt in CI.** A committed `secscan.config.json` (directories,
  limits, model) replaces the run-start confirmation. Locally, the confirmation can
  write that file.
- **Key safety.** GitHub withholds secrets from fork PRs, so scans of outside
  contributions run after maintainer approval or after merge. The workflow never
  uses `pull_request_target`.
- **Where results appear:** Part 4.4.

### 1.4 Build order

Option A comes first: Option B is Option A running inside GitHub. Option B ships
after the diff mode (§2.8) and SARIF output (§4.4) exist.

---

## Part 2 · Scanner update: from Juice-Shop harness to product

### 2.1 Current state (verified in source)

**Blocks running on any other repo:**
- **The read guard is locked to Juice Shop.** `shared/read-guard.ts:25` allows only
  `target-apps/juice-shop{,-blind}`. On another repo every lane is blocked, and the
  run still exits 0 looking clean.
- **The target dir is guessed from the first Express route.**
  `stage05-lane-selector-perfile/src/lane-selector-perfile.ts:424` falls back to
  `juice-shop-blind` when there is none. Stage 0 already writes the right
  `target_dir`, but 0.5 ignores it.
- **`run.sh` takes no target.** Only Stage 0 reads `SCANNER_TARGET`.
- **Run artifacts land inside the tool repo.** `shared/run-paths.ts` writes them
  there, and Stage 2 silently resumes from stale output.

**JS/Juice-Shop-specific:**
- **Recon is Express + Angular in Juice Shop's layout.** It hardcodes `server.ts`,
  `routes/chat.ts` and `frontend/src/app`, and only reads routes on a variable named
  `app`.
- **Auth detection uses Juice Shop's own function names**
  (`stage0-recon/src/ast-extractor.ts:384`).
- **Signal patterns are JS-flavoured.**
- **Route context only parses JS/TS `export`.**
- **File selection ignores `.gitignore`.** It skips no vendor, venv or minified
  files and has no byte cap.

**Missing for users:**
- no report beyond `candidate-findings.json`
- no spend cap (the governor only projects)
- no run-start confirmation or progress display
- no packaging (seven private packages run via `tsx`)

**Reusable as-is:**
- the model registry (`shared/models.json`, `models.ts`, `provider.ts`)
- the v2 per-file pipeline with its generic playbooks and trace loop
- checkpointing, retry and concurrency derivation
- the coverage ledger (hunt + skip = inventory, `blocked_reads`)
- the 14-class registry mapped to OWASP codes

### 2.2 Generalize hardcoded directories: one run context

Introduce a **run context** (target root, output dir, profile, limits) created once
and passed to every stage:

- `read-guard.ts` takes its allowed root from the context: the user's target root
  only. It stays fail-closed and still blocks symlink and `..` escapes.
- `run-paths.ts` takes the output dir from the context. The default is
  `<target>/.secscan/runs/<timestamp>/`; the tool adds it to `.gitignore`.
- **No implicit resume.** `--resume <run>` is explicit.
- Stage 0.5 reads `target_dir` from Stage 0's `file-signals.json`. The Juice Shop
  fallback is removed.
- The `/opt/claude-code/bin/claude` path and the `NODE_USE_ENV_PROXY` assumption
  leave the product path.
- **A `benchmark` profile keeps every lab guarantee unchanged:**
  - Juice Shop roots
  - `SEED_DENYLIST`
  - the `runs/<provider>/` layout
  - `guard.test.ts` pins
  - the archive skills

### 2.3 Generalize JS-specific prompts, code and stages

- **Recon v3, language-agnostic.**
  - `web-tree-sitter` (WASM, no native build) extracts symbols and imports across
    about 10 languages.
  - One LLM call produces an **architecture summary** from a repo map (manifests,
    README, entry points, directory tree): frameworks, entry points, **auth
    mechanisms by their real names** (replacing the hardcoded list), data stores and
    trust boundaries.
  - The existing Express AST extractor becomes one optional framework enricher.
    Others follow: FastAPI/Flask/Django, Spring, Rails, Go `net/http`, Next.js.
- **Prompts.**
  - The tool-calling probe drops its "TypeScript file" wording and its fixed
    `routes/chat.ts` path.
  - Route context uses the tree-sitter symbol table instead of JS `export` parsing.
  - The 14 v2 playbooks are already framework-neutral and stay.
- **Signals.** `shared/signal-classes.json` gets language-scoped sink patterns
  (Python, Java, Go, Ruby, PHP, C#).
- **File selection.**
  - respect `.gitignore` and a `.secscanignore`
  - skip vendor, venv, build output, minified and generated files, and lockfiles
  - add a per-file byte cap
  - extend extensions (c/cpp/h, swift, dart, mjs/cjs, …)
  - test dirs are skipped by default and shown at confirmation

### 2.4 Beyond OWASP: recon-guided guidance

The 14 built-in playbooks cover OWASP Top 10, API Top 10 and part of the LLM Top 10.
To avoid finding only OWASP-type issues, add a **guidance step** after recon:

1. **Recon emits a stack profile.** It lists languages, frameworks, key libraries
   from the manifests, and component types (web API, CLI, smart contract, IaC,
   LLM agent, …).
2. **Sources are fetched for parts no built-in playbook covers.** Guidance comes
   from an **allowlisted set of sources**:
   - CWE entries
   - OWASP Cheat Sheets
   - official framework security docs
   - GitHub Security Advisories for the declared dependencies

   Allowlisting keeps the step reproducible and limits prompt injection from web
   content.
3. **A model call distills them into dynamic playbooks.** They use the same format
   as the built-in ones (what the bug looks like, what to trace, how to tell a false
   positive) and are tagged with CWE ids.
4. **Lanes get them like built-in classes.** The lane selector assigns them by
   signals. Findings may carry a CWE outside the 14 classes and are grouped as
   "other (recon-guided)".
5. **They are saved and listed.** Dynamic playbooks go into the run dir with their
   sources and a hash in `meta.json`, are cached by stack fingerprint, and the report
   lists them.
6. **Opt-out.** `--no-web` uses built-in playbooks only.

### 2.5 Model selection

- `secscan models` lists the registry entries with price and **measured / unmeasured**
  status (from the lab's benchmarks).
- `--model <key>` selects a model. The default is `luna`, the measured best value.
  The key is read from the env var the entry names.
- **Custom models.** A user `models.json` overlay or a generic OpenAI-compatible
  entry (`--base-url --model --api-key-env`) covers OpenRouter, other providers and
  local Ollama/LM Studio. All are labelled unmeasured.
- **The rule stays.** No model id, endpoint or credential appears in code; the
  registry only.

### 2.6 Budget and hard limits

- **The budget governor becomes enforcing.** The estimate is shown before the run.
  `--max-cost` is a hard stop: no new lane starts once projected spend would exceed
  it.
- **Other limits:** `--max-files`, `--max-file-size`, `--timeout`, `--concurrency`
  (auto-derived by default), include/exclude globs, `--paths`.
- **Hitting a limit ends cleanly.** The run stops gracefully and writes a partial
  report marked **INCOMPLETE**, listing what was not scanned. Ctrl-C behaves the
  same, and the run is resumable with `--resume`.

### 2.7 Run-start confirmation, progress and spend

Before any spend, the CLI asks the user to confirm:
```
Target: ./my-app (commit a1b2c3d, 1,204 files)
Languages: TypeScript 61%, Python 30%, Go 9% (Go: unmeasured)
Scan 412 files in: src/ api/ workers/   Skip 792: node_modules/ dist/ test/ assets
Model: gpt-5.6-luna (OPENAI_API_KEY found)   Extra guidance: Django, Celery (web)
Estimate: ~$1.90, ~6 min    Cap: $5.00
[Enter] start   [e] edit dirs/limits   [s] save as secscan.config.json   [q] quit
```

During the run it shows:
- lanes done/total and failed
- spend so far against the estimate and the cap
- elapsed time and ETA
- findings so far by severity

`--yes` skips the prompt for scripts and CI.

### 2.8 Trigger support for the GitHub Action

- **`--diff <base>`** scans changed files plus their one-hop import neighbours, using
  the tree-sitter graph. This is per-PR mode.
- **Full mode** is used for the schedule and on-command triggers.
- **Action inputs** map one-to-one to CLI flags (paths, max cost, model).
- **Stable finding fingerprints** (hash of path, sink snippet and class) are emitted
  so GitHub tracks the same alert across runs instead of duplicating it.

### 2.9 Report and artifact generation

- **New stage: Report.** It is deterministic, with no model call. It reads Stage 2's
  findings plus the coverage ledger and the usage record, and writes the outputs in
  Part 4.
- **Stage 2 output schema additions:** `cwe[]`, `severity_reason`,
  `confidence_reason` (structured factors, §4.3), `attack_scenario` and
  `remediation` (high-level).
- **Locations come from the lane, not the model.** The primary location comes from
  the lane's target file. Code excerpts are read from disk at report time, never
  quoted by the model. This is the line-fidelity lesson from the PEM desync.

### 2.10 Juice Shop evaluation stays internal

- **Users have no ground truth**, so the product never computes recall on their repo.
  The report instead shows coverage, confidence and limitations, and quotes the lab's
  benchmark numbers for the chosen model as reference.
- **The lab stays as it is.** Scoring, ledgers and blind rules run only under the
  `benchmark` profile, for internal development (Part 3).

### 2.11 Packaging and cleanup

- **One npm package with a `bin`.** TS is compiled with tsup/esbuild. Stage dirs stay
  as source modules behind an in-process orchestrator, and `run.sh` keeps working for
  the lab.
- **Excluded from the package:** everything listed as "Lab" in §1.1.
- **Docs.** Add a product README/quickstart separate from the research docs. Existing
  research docs are left as they are.

### 2.12 Note on precision (for readers and reviewers; not implemented in this plan)

**Where it stands:**
- The best run's precision proxy is **12.5%**: 69 of 553 findings matched a known
  bug. Across models it ranges from 6.4% (Sonnet 5, 1,270 findings) to 16.5% (Gemini
  3.6 Flash, 285 findings).
- It is a **floor**: real bugs outside the 97 known ones count as misses.
- More findings buy recall and cost precision on every model measured.
- No stage filters false positives today. The designed Stage 3 validator was removed
  (`d4f4288`).
- For users, this means a noisy report. In this plan, severity × confidence ordering
  and confidence explanations (Part 4) are the only mitigation.

**What would raise it**, all later work:

1. **An independent verification stage** re-checks each finding adversarially. It
   is the biggest lever and a substantial architecture change, so it is a
   **recommendation only** here.
2. **User-supplied context / an editable threat model** (e.g. "auth is enforced at
   the gateway").
3. **CWE-specific checklists** the model answers before reporting.
4. **Voting** (2-of-3) when deciding whether a finding is real.
5. **Cross-referencing static-analysis hits.**

**Evidence.** Many figures are from abstracts or vendor posts, not full-paper reads.

| Lever | Source | Method tested to cut false positives | Reported effect |
|---|---|---|---|
| 1 | RepoAudit, ICML 2025, https://arxiv.org/html/2501.18160v3 | An LLM agent explores the repo on demand. A separate **validator** re-checks every claimed bug's data-flow facts and whether the path conditions can actually all be true, and discards those that fail. | 78.43% precision, 40 true bugs across 15 projects, $2.54 per project |
| 1 | LLMSAN, EMNLP Findings 2024, https://github.com/chengpeng-wang/LLMSAN | The LLM must output its data-flow path as evidence. Each step is then **checked separately**: syntactic facts by a parser, semantic facts by an LLM on a small snippet. A finding is dropped if any step fails. | About 91% precision, a large gain over unchecked output |
| 1 | "Sifting the Noise", 2026, https://arxiv.org/abs/2601.22952 | Coding-agent frameworks (Aider, OpenHands, SWE-agent) are used as **false-positive filters**: the agent investigates each static-analysis alert in the repo and labels it real or false. | OWASP Benchmark false-positive rate from over 92% to 6.3%. Over-aggressive filtering also removed real bugs. |
| 2 | ZeroPath (vendor-reported) | Users add a few **plain-language repository facts** (deployment, trust boundaries, how auth works), which the triage model reads. | 2,216 findings reduced to 530 |
| 2 | CORRECT, 2025, https://arxiv.org/abs/2504.13474 | Studies why LLM triage gives false positives, then supplies the **missing code context** (surrounding and cross-function code) before the verdict. | Most false positives traced to missing context. With context, about 0.8 precision on key CWEs. |
| 3 | ZeroFalse, 2025, https://arxiv.org/abs/2510.02534 | CodeQL alerts are enriched with the **flow trace plus CWE-specific guidance** before an LLM judges each one. | F1 0.955 on real-world OpenVuln, 0.912 on OWASP Benchmark |
| 3 | Vulnhalla, CyberArk (vendor) | **Guided questioning**: a per-rule checklist the LLM must answer before its verdict on each CodeQL alert. | Up to 96% fewer false positives (vendor-reported) |
| 4 | LLM vulnerability benchmarking, https://arxiv.org/pdf/2405.15614 | **Self-consistency**: classify each case 3 times and keep it only on a 2-of-3 majority. | Noticeably fewer false positives. A model that repeats the same mistake defeats it (EMNLP 2025). |
| 5 | IRIS, ICLR 2025, https://arxiv.org/abs/2405.17238 | **Neuro-symbolic**: the LLM writes CWE-specific taint specs (sources and sinks) for CodeQL, CodeQL finds candidate paths, then a second LLM pass judges each path with its context. | 55 of 120 real Java CVEs found vs CodeQL's 27, with about 5 points better false discovery rate |

---

## Part 3 · Implementation evaluations: when is it a ready product?

### 3.1 The release bar: 85% to 100% recall on the test repos

The updated scanner must score **recall between 85% and 100% on every test repo**.
This means the full pipeline, on the default model, with all Part 2 changes in the
tree.

- **Recall definition.** A known vulnerability counts as found when a finding names
  the right file, within ±15 lines, with the right vulnerability class. The README
  calls this metric localization; it is 88.7% on Juice Shop today. Exact-line recall
  (71.1% today) and file-level recall are reported alongside.
- **Test repos.** Repositories with known vulnerabilities whose ground truth is held
  privately. Juice Shop is one of them and doubles as the regression check against
  run 6.
- **Measured on every run, never a threshold:** cost, tokens, wall clock and the
  precision proxy.

### 3.2 Stage-wise evaluations

Each updated stage is tested on its own before the full-pipeline recall run. A
recall miss can then be traced to the stage that caused it.

| Stage | What is measured | Pass condition |
|---|---|---|
| **Stage 0 · Recon v3** (§2.3) | Recon output for each test repo against a hand-written recon key: languages, frameworks, entry points, auth mechanisms, data stores. `tools/scan-benchmark/score_stage0.py` already scores recon on Juice Shop and is extended to the other test repos. | All languages and frameworks detected. ≥ 90% of entry points found. ≥ 90% of auth mechanisms named and mapped to the right routes. Juice Shop recon coverage no lower than today. 0 reads outside the target root. |
| **Guidance step** (§2.4) | The dynamic playbooks produced for each test repo, and their effect on recall | A playbook exists for every detected stack element no built-in playbook covers. 100% of sources are on the allowlist. Recall on known vulnerabilities outside the 14 built-in classes is higher with guidance than without (same lanes), with no drop on in-class ones. |
| **Stage 0.5 · Lane selector** (§2.2, §2.3) | The lane plan | hunt + skip = inventory on every run. 100% of files holding a known vulnerability are `hunt` with the right class or playbook (`tools/scan-benchmark/preflight_class_coverage.py`). Every skip has a recorded reason. Identical input gives an identical plan. |
| **Stage 1 · Budget governor** (§2.6) | Estimate and cap | Estimate within ±25% of actual spend (run 6 was 5.5% over). Spend never exceeds `--max-cost` by more than one in-flight lane. Hitting the cap writes an INCOMPLETE report listing unscanned files. |
| **Stage 2 · Hunt** | Recall per test repo, plus exact-line and file-level; lane health | Release bar met. 0 failed or silently blocked lanes. Prompt line numbers match the file on disk for 100% of lanes (the existing fidelity assertion in `guard.test.ts`). |
| **Report stage** (§2.9, Part 4) | Output correctness | 100% of `file:line` locations resolve to the cited line. Every finding has all §4.2 fields. SARIF validates against 2.1.0. GitHub annotations land on the right lines. Permalinks resolve. |
| **CLI** (§2.5 to §2.7) | Behaviour | The confirmation screen matches what the run then does (dirs, model, limits). Progress and spend figures match the usage record. `--resume` continues without re-scanning finished lanes. |
| **GitHub Action** (§2.8) | Runs on a public test repo | PR, schedule and manual triggers all run. PR mode scans only the diff set. Fork PRs receive no secrets. |
| **End to end** | ≥ 5 real OSS repos without ground truth, across ≥ 3 languages, one with > 5k files | Every run completes with 0 crashes and a correct coverage receipt |

### 3.3 How an evaluation round runs

This is the loop the project has used since its first build
(`docs/protocols/dev-loop-protocol.md`). Claude, the default agent, implements every
change.

1. **Fix the targets before running.** The round's directive names:
   - the stage that changed
   - the §3.2 rows and test repos that apply, with their pass conditions
   - the stop rules: at most 3 iterations; stop early if an iteration gains under 3
     points while still below target; stop at once on any regression
2. **Verify the tree.** Record the git SHA, run `git merge-base HEAD origin/main`, and
   grep each intended change in the source (`CLAUDE.md`, "Verify the tree before a
   run").
3. **Run the stage evals first.** The deterministic stages (0.5, 1, report) make no
   model calls and cost nothing; recon and guidance are cheap.
4. **Iterate on a narrow slice.** Run Stage 2 only on the lanes that hold known
   vulnerabilities. This is the 40-lane platform used for Juice Shop, built the same
   way for each test repo, and it keeps each iteration to minutes.
5. **Confirm on everything.** Do one full run across all test repos and check the
   release bar.
6. **Score blind and record.**
   - `tools/scan-benchmark/score_scanner.py` scores in a separate step.
   - Ground truth lives only in the private answer-key repo, and the implementing
     session never opens it.
   - Numbers are taken from the scorer and test output, never from the implementing
     session's own account.
   - Archive with `archive-run`, then append aggregates to `results/eval-history/` and
     `docs/benchmarking-results.md`.
7. **Ship, or record as falsified.** A change that misses its target is written up as
   falsified and does not ship.

### 3.4 Ready product

- The release bar (§3.1) is met on every test repo.
- Every §3.2 row passes. The GitHub Action row gates only Option B.
- Recon-guided guidance (§2.4) stays opt-in until its row passes.
- A language is labelled **measured** in reports once a test repo in that language
  meets the release bar. All others stay unmeasured.

---

## Part 4 · What the report shows

### 4.1 Report sections

1. **Header.**
   - repo, branch, commit SHA, date
   - secscan version, model, scope (full, diff vs base, paths), config hash
2. **Summary at a glance.**
   - Potential vulnerabilities: total, by severity (Critical/High/Medium/Low), by
     confidence band (High ≥ 0.8, Medium 0.5 to 0.8, Low < 0.5).
   - By category: OWASP code and CWE, plus "other (recon-guided)".
   - **Review first:** the top 5 by severity × confidence.
   - Hotspot files: the most findings.
3. **Coverage.**
   - Files: total, scanned, skipped (by reason: user-excluded, ignored, non-code,
     too large, over budget), failed.
   - Code lines scanned against total (%).
   - Languages, each marked measured or unmeasured.
   - Directories included and excluded, as confirmed.
   - Vulnerability classes hunted, built-in and recon-guided, with sources.
   - Status: **COMPLETE** or **INCOMPLETE** (with the reason).
4. **Limitations,** generated from the run itself:
   - unmeasured languages
   - skipped or failed files
   - cap reached
   - static reasoning only: findings are not executed or verified
   - expected false positives, citing the benchmark precision proxy as a floor
   - re-runs can differ
   - cross-file flows are limited to recon context
   - no recall figure exists for this repo (benchmark figures given for reference)
5. **Run stats.** Tokens in/out, cost (actual vs estimate), wall clock, model,
   retries.
6. **Findings,** sorted by severity × confidence (§4.2).
7. **Appendix.** Skipped-file list, failed lanes, guidance sources, full config.

### 4.2 Each finding

| Field | Content |
|---|---|
| ID | Stable fingerprint (same issue keeps its ID across runs) |
| Title, category | Plain title; OWASP code + CWE |
| Severity | Level + one-line reason (impact × how reachable) |
| Confidence | 0 to 1 + band + explanation (§4.3) |
| Location | `path:line` (local) or permalink (GitHub) |
| What's wrong | Plain-language description |
| Evidence | Trace, entry point → propagation → sink. Each step has a location and a 3 to 5 line excerpt read from disk. |
| Attack scenario | How an attacker reaches it, and the preconditions |
| Remediation | High-level fix approach (no code patch) |

### 4.3 Confidence explanation

Confidence is shown as two parts, so a user can see why to trust or doubt a finding:

**Scanner signals** (deterministic, computed from the run):
- trace complete from entry point to sink
- entry point exposed per recon (public route, no auth found)
- sink in a known dangerous API
- file reached by the dynamic playbooks or the built-in ones

**Model reasoning** (`confidence_reason`):
- was input validation or sanitising looked for, and found absent?
- what assumptions does it rest on (config, deployment)?

Example: *"0.82 High: public route, no auth middleware found; traced unparameterized
to SQL sink; no sanitizer on path; assumes no upstream WAF."*

### 4.4 Where the report appears

**Option A (local):**
- A terminal summary.
- In `.secscan/runs/<timestamp>/`:
  - `report.html` (single self-contained file)
  - `report.md`
  - `findings.json`
  - `findings.sarif` (opens in VS Code's SARIF viewer)
  - optional `report.pdf`
- Locations print as `relative/path.ts:42`, which is clickable in VS Code and most
  terminals.

**Option B (GitHub):**
- **SARIF upload** puts the findings in the repo's **Security → Code scanning** tab.
  They are tracked as open, fixed or dismissed across runs, and show as **inline
  annotations on the exact PR lines**. This is free for public repos.
- **Job summary** (Markdown on the Actions run page): summary, coverage and a
  findings table. Every location is a **commit-pinned permalink**
  (`https://github.com/<owner>/<repo>/blob/<sha>/<path>#L42`), so links never drift.
- **PR summary comment** (optional): counts by severity plus "review first" links.
- **The HTML/PDF report** is uploaded as a workflow artifact, with the same
  permalinks.

---

## Part 5 · Build order

| Step | Scope | Must pass (Part 3) |
|---|---|---|
| 1 | §2.2 run context + §2.3 generalization + §2.5 models + §2.6 limits + §2.7 confirmation/progress + §2.9 report + §2.11 packaging → **Option A** release candidate | Release bar; Recon, Lane selector, Budget, Hunt, Report, CLI and End-to-end rows |
| 2 | §2.4 recon-guided guidance, opt-in until its row passes | Guidance row; release bar re-checked |
| 3 | §2.8 diff mode + `action.yml` → **Option B** | GitHub Action row; Report row re-run on GitHub |

### Step 1 task breakdown

Step 1 is delivered as five PRs, in this order. Each PR description carries a
visual summary (what changed, which plan section, which files, expected input
and output changes), and the Part 3 rows listed here are run after it merges.

| Task | Plan section | Part 3 rows run after merge |
|---|---|---|
| 1a · Run context | §2.2 | Lane selector (benchmark lane plan identical to before), Hunt (0 blocked lanes on a non-Juice-Shop repo, line fidelity), Juice Shop regression |
| 1b · Generalize recon, signals, file selection | §2.3 | Recon, Lane selector, Hunt / release bar on Juice Shop |
| 1c · Models, limits, run-start confirmation, progress | §2.5, §2.6, §2.7 | Budget, CLI |
| 1d · Report stage and schema additions | §2.9, Part 4 | Report |
| 1e · Packaging | §2.11 | End to end, release bar |

The work spec for each task is saved in `prompts/dispatch/` before it is built.
