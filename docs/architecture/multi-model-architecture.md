# Multi-model architecture

How the scanner runs under any inference model, and the rules that keep those
runs from contaminating each other.

Read this before changing anything under `tools/scanner/`.

---

## 1. Two roles, don't confuse them

| Role | Who | Touches |
|---|---|---|
| **Coding agent** — edits scanner source, refactors, writes docs | Claude Code sessions, Qwen Code, humans | `tools/scanner/*/src/**`, `docs/**` |
| **Scanner inference model** — reads target code, produces findings | whichever model the run selects, called from inside the stages | nothing on disk; it's a network call |

This document is about the **second** role. No inference model "lives" in a
directory — they are runtime parameters. What gets isolated is the *evidence
each run produces*.

The two roles are independent. Which agent writes the scanner's code has nothing
to do with which model the scanner calls, and changing one does not change the
other. See `CLAUDE.md` for the coding-agent split.

---

## 2. The model registry

Models are **data, not code**. `tools/scanner/shared/models.json` is the single
source of truth; nothing under `tools/scanner/*/src/` names a model, an endpoint
or a credential.

| Provider key | Label | Model id | Endpoint | Credential |
|---|---|---|---|---|
| `luna` (default) | GPT-5.6 Luna | `gpt-5.6-luna` | `api.openai.com` | `OPENAI_API_KEY` |
| `terra` | GPT-5.6 Terra | `gpt-5.6-terra` | `api.openai.com` | `OPENAI_API_KEY` |
| `sol` | GPT-5.6 Sol | `gpt-5.6-sol` | `api.openai.com` | `OPENAI_API_KEY` |
| `luna-fixed` | GPT-5.6 Luna (post-fix arm) | `gpt-5.6-luna` | `api.openai.com` | `OPENAI_API_KEY` |
| `qwen` | Qwen 3.6 Plus | `qwen-plus` | DashScope OpenAI-compatible | `DASHSCOPE_API_KEY` |
| `qwen37` | Qwen 3.7 Plus | `qwen3.7-plus` | DashScope OpenAI-compatible | `DASHSCOPE_API_KEY` |
| `opus5` | Claude Opus 5 | `claude-opus-5` | `api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `sonnet5` | Claude Sonnet 5 | `claude-sonnet-5` | `api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `gemini-pro` | Gemini 3.1 Pro | `gemini-3.1-pro` | `generativelanguage.googleapis.com` | `GEMINI_API_KEY` |
| `gemini-cyber` | Gemini 3.5 Flash Cyber | `gemini-3.5-flash-cyber` | `generativelanguage.googleapis.com` | `GEMINI_API_KEY` |
| `kimi` | Kimi K3 | `kimi-k3` | `api.moonshot.ai` | `MOONSHOT_API_KEY` |
| `glm` | GLM-5.2 | `glm-5.2` | `api.z.ai` | `ZAI_API_KEY` |
| `deepseek` | DeepSeek V4 | `deepseek-v4` | `api.deepseek.com` | `DEEPSEEK_API_KEY` |

The last eight were added on 2026-08-01 for the twelve-model benchmark. Every
one of them reaches the same `openai` SDK through `base_url`; there is no
second client, no vendor SDK, and no code path that knows any of them exist.

**Every non-`api.openai.com` host above must be on the environment's egress
allowlist**, or the first API call fails with "Host not in allowlist" rather
than an auth error — see §8.

Aliases are accepted everywhere a key is and canonicalized before anything
touches disk: `openai` and `gpt-5.6-luna` → `luna`; `dashscope` and `qwen-plus`
→ `qwen`; `opus`, `sonnet`, `cyber`, `moonshot`, `zai` and each model id map to
their target. `run.sh openai …` and `run.sh luna …` are the same run.

Every provider executes **byte-identical scanner logic** against a
**byte-identical corpus**, with identical prompts, schemas, and token budgets.
The only permitted differences are the ones the registry declares. That is what
makes a cross-model diff meaningful — anything else and you are comparing two
codebases rather than two models.

### Adding a model

Append one entry to `models.json`. No code changes anywhere:

```jsonc
"terra": {
  "label": "GPT-5.6 Terra",
  "model": "gpt-5.6-terra",
  "model_env": "TERRA_MODEL",          // env var pinning a snapshot
  "api_key_env": "OPENAI_API_KEY",
  "base_url": null,                     // null = SDK default
  "base_url_env": "OPENAI_BASE_URL",
  "token_limit_param": "max_completion_tokens",
  "sampling": {}
}
```

A provider key is also its run-artifact namespace (`runs/<key>/<stage>/`), so
key on the **model**, not the vendor: `api.openai.com` serves more than one
model, and each needs its own isolated tree to be comparable. That is why the
key is `luna` rather than `openai`.

After adding one, run `npx tsx ../shared/guard.test.ts` — its registry-contract
block iterates every configured model and will exercise the new entry.

### Selecting a provider

Resolution order (first match wins), in `shared/provider.ts`:

1. `SCANNER_PROVIDER_<STAGE>` — per-stage override (`SCANNER_PROVIDER_STAGE3=luna`)
2. `SCANNER_PROVIDER` — global
3. `models.json` `default_provider` — currently `luna`

`SCANNER_MODEL` pins a model id across whichever target is selected; a target's
own `model_env` (e.g. `OPENAI_MODEL`) beats it.

### Provider-specific API differences

Declared per target in the registry, resolved through helpers. **Never
special-case a model at a call site** — there is no `if (provider === …)`
anywhere outside `shared/`, and adding one breaks the "add a model = one JSON
entry" property.

| Concern | Registry field | Helper |
|---|---|---|
| Output token cap | `token_limit_param` | `tokenLimitParam()` |
| Sampling | `sampling` | `samplingParams()` |
| Endpoint + credential | `base_url`, `api_key_env` | `clientConfigFor()` |
| Model id | `model`, `model_env` | `modelFor()` |

Concretely: GPT-5.x reasoning models **reject** `max_tokens` with a 400 and are
inconsistent about accepting non-default sampling values, so `luna` declares
`max_completion_tokens` and an empty `sampling`. DashScope accepts only
`max_tokens`, so `qwen` declares that and `temperature: 0.1`.

### Operational profile per model

The registry declares what the API *accepts*. It deliberately does not declare
rate limits or price — those are account properties, not model properties, and
hardcoding them would rot. Measured values, for planning a run:

| | `luna` / `gpt-5.6-luna` | `qwen` / `qwen-plus` |
|---|---|---|
| Tokens-per-minute ceiling | **200,000** (observed in 429 bodies) | not measured |
| Safe `HUNT_CONCURRENCY` for 541 lanes | **4** — 8 lost 52 lanes to TPM | 8 used historically |
| Price basis used for reported cost | $1.00/M in, $6.00/M output | — |
| Full v2 Stage 2 run | ~20 min, ~4.0M tokens, ~$5.82 | — |

Discover a new model's ceiling the same way: the 429 body states it verbatim
(`Limit N, Used N, Requested N. Please try again in Xs`). Read it from the run
log rather than guessing — the wait it asks for is usually 1–4s, which tells you
whether a failure was a short spike or sustained saturation. See
`../protocols/running-a-scan.md` §5.

### Bringing a new model to a comparable run

1. Add the registry entry; run `npx tsx ../shared/guard.test.ts`.
2. `SCANNER_PROVIDER=<key> npx tsx ../shared/preflight.ts` — confirms the
   credential, the model id, and that `json_schema` responses round-trip. A model
   that cannot do structured output cannot run Stage 2.
3. Seed or re-run upstream stages **into that provider's own tree**. Artifacts
   are provider-isolated, so a new key starts with an empty `runs/<key>/`.
   Comparing a new model against an existing baseline requires the same Stage 0.5
   manifest, so either seed it or confirm the regenerated one matches.
4. Run Stage 2 at a conservative concurrency until the TPM ceiling is known.
5. Score with the same scorer, validated against the previous run's published
   numbers first (`../protocols/eval-howto.md`).

Cross-model comparisons are only meaningful when the *manifest* is identical, not
merely the code — lane assignment depends on Stage 0's output, and Stage 0 is
itself an LLM call.

### Bash reads the same registry

`run.sh`, `diff.sh` and `seed-upstream.sh` get the provider list and alias
resolution from `shared/registry-cli.mjs`, which reads the same `models.json`.
A hardcoded bash list would drift the first time a model was added, and the
failure is silent: run.sh tees logs into `runs/openai/` while the stage writes
`runs/luna/`.

---

## 3. Directory layout

```
tools/scanner/
├── shared/                    zero-dependency helpers, imported by every stage
│   ├── models.json              THE model registry — data, not code
│   ├── models.ts                registry loader + validation
│   ├── registry-cli.mjs         the same registry, for bash
│   ├── run-paths.ts             runPath(provider, stage) — the only path source
│   ├── provider.ts              provider/model/param resolution
│   ├── read-guard.ts            corpus allowlist for model-supplied paths
│   ├── meta.ts                  meta.json write + provenance assertions
│   └── guard.test.ts            smoke tests (npx tsx ../shared/guard.test.ts)
│
├── stage0-recon/src/          v1 — shared code, NEVER forked per provider
├── stage05-lane-selector/src/
├── stage1-budget-governor/src/  (also hosts v2's governor, behind --v2)
├── stage2-hunt-lanes/src/
├── stage3-validate/src/
│
├── stage05-lane-selector-perfile/src/   v2 — one lane per file
├── stage2-hunt-lanes-perfile/src/
│
├── runs/                      ALL run artifacts, provider-scoped
│   ├── luna/<stage>/            *.json + meta.json + logs/ (gitignored)
│   └── qwen/<stage>/
│
├── run.sh                     the entry point — always use this
├── diff.sh                    cross-model comparison
└── .run.lock/                 mutex (gitignored)
```

The old per-stage `output/` directories are gone — for **both** tracks. v1's
contents were `git mv`'d into `runs/qwen/<stage>/`; v2's surviving
`lane-assignments.json` into `runs/qwen/stage05-lane-selector-perfile/`. Those
are the historical baseline.

`runs/openai/` was renamed to `runs/luna/` when provider keys became
model-scoped. The artifacts are unchanged and their `meta.json` carries
`provider_key_renamed_from: "openai"`; the `model` field always said
`gpt-5.6-luna`.

---

## 4. Access rules

Stated per-provider, but the rule is general: a run may write only its own tree.

| Path | own-provider run | other-provider run | Why |
|---|:---:|:---:|---|
| `target-apps/**` | R | R | the corpus — controlled variable |
| `tools/scanner/*/src/**`, `shared/**` | R | R | identical code |
| `tools/scanner/runs/<own>/**` | RW | — | provider-owned |
| `tools/scanner/runs/<other>/**` | — | RW | provider-owned |
| `tools/scanner/.run.lock/` | RW | RW | the mutex |
| `results/**`, `docs/**`, `.git/**` | — | — | human-curated; contains scored outcomes |

### The read guard

Three call sites read a path a **model** produced:

| Site | Path source |
|---|---|
| `hunt-executor.ts` `readSeedFiles()` | lane manifest `seed_files` |
| `hunt-executor.ts` scope expansion | LLM `scope_requests`, orchestrator-approved |
| `validator-orchestrator.ts` `readCitedFiles()` | trace steps from the stage-2 model |

All three go through `readCorpusFile()` in `shared/read-guard.ts`. It is an
**allowlist** confined to `target-apps/juice-shop` and
`target-apps/juice-shop-blind`, so it fails **closed** — anything not explicitly
permitted is denied without needing a new denylist entry.

This is what keeps prior-run findings, scored benchmark results, and the
scanner's own source out of model context. Before the guard existed, a hunting
lane could request `results/scan-benchmark-summary.md` (which contains scored
outcomes) or a previous run's `validated-findings.json`, and it would be read
and pasted into the prompt.

The guard also blocks `..` traversal (via `resolve()`) and symlinks pointing
outside the corpus (via `realpathSync()` re-check). It **logs and returns null**
rather than throwing — a blocked read degrades a run instead of crashing it, and
the `[GUARD] BLOCKED` line plus `meta.json`'s `blocked_reads` count give you a
detectable signal that a model tried.

`SEED_DENYLIST` (the three Juice Shop bookkeeping files that reference challenge
names) also lives in `read-guard.ts` now, so it covers all three read paths
rather than only the manifest write in stage 0.5.

> **Pipeline-internal reads do not use the guard.** Cross-stage artifact reads
> use `readUpstreamArtifact()` in `meta.ts`, which is only ever called with
> hardcoded filenames. Two APIs, two privilege levels. Never pass a
> model-supplied path to `readUpstreamArtifact()`.

---

## 5. Running

```bash
./tools/scanner/run.sh <provider> <stage|all|all-v2>
```

```bash
./tools/scanner/run.sh luna all-v2                # v2 pipeline, per-file lanes
./tools/scanner/run.sh qwen stage3-validate       # v1 baseline
./tools/scanner/run.sh luna stage3-validate       # v1 challenger
./tools/scanner/diff.sh stage3-validate qwen luna # compare
```

Two pipelines, selected by target:

| Target | Stages, in order |
|---|---|
| `all` (v1) | `stage0-recon` → `stage05-lane-selector` → `stage1-budget-governor` → `stage2-hunt-lanes` → `stage3-validate` |
| `all-v2` | `stage0-recon` → `stage05-lane-selector-perfile` → `stage1-budget-governor-perfile` → `stage2-hunt-lanes-perfile` → `reconcile-v2` |

Both tracks share Stage 0. `stage1-budget-governor-perfile` and `reconcile-v2`
are the same source directory (`stage1-budget-governor`, behind `--v2`) writing
to their own stage key — a stage key is an artifact namespace, not necessarily a
source directory.

`run.sh` canonicalizes the provider alias, acquires the lock, exports
`SCANNER_PROVIDER`, tees stdout/stderr into
`runs/<provider>/<stage>/logs/<stage>.std{out,err}.log`, and releases the lock
on exit.

**Always use `run.sh`.** Calling `npm run run` inside a stage directly bypasses
the lock and the log capture. It will still work and still write to the right
provider directory (the path helper does not depend on the runner), but two
providers could then run concurrently.

### Preflight

Before spending money on a stage run, verify credentials, model access, and
parameter shape:

```bash
cd tools/scanner/stage3-validate
SCANNER_PROVIDER=luna npx tsx ../shared/preflight.ts
```

Checks the key is present, makes one tiny completion call, and probes
`json_schema` strict mode. Exits non-zero on failure.

### Seeding upstream artifacts

`assertUpstream()` refuses to run a stage whose upstream artifacts belong to a
different provider. For a **validator-only** comparison (same candidates,
different judge), copy the upstream across:

```bash
./tools/scanner/seed-upstream.sh qwen luna stage1-budget-governor stage2-hunt-lanes
./tools/scanner/run.sh luna stage3-validate
```

The rewritten `meta.json` carries `seeded_from`, so the artifacts stay honestly
labelled. **Results from a seeded run are not an end-to-end comparison** — say
so when reporting them.

### Degraded runs

Stage 0 and Stage 0.5 catch LLM failures and fall back to deterministic
analysis. That is a safety net, but it means a stage can exit 0 with
normal-looking artifacts while the model never ran.

Every fallback path now calls `markDegraded()` (`shared/degraded.ts`). The
result lands in `meta.json`:

```json
{ "degraded": true,
  "degraded_reasons": ["category probe: no API key for provider — used deterministic analysis"] }
```

`failIfDegraded()` then decides the exit code:

| Provider chosen | Degraded | Exit |
|---|---|---|
| defaulted (no env var) | yes | **0** — fallback is the intended safety net |
| explicit (`SCANNER_PROVIDER…`) | yes | **1** — the model being evaluated never ran |
| either | no | 0 |

Check before trusting any result: `jq '.degraded' runs/<provider>/<stage>/meta.json`

> `run.sh` always exports `SCANNER_PROVIDER`, so every run launched through it
> is "explicit" and a degraded stage fails the pipeline. The lenient row only
> applies to invoking a stage by hand with no env var set — which is also the
> only way to exercise the deterministic path without spending money.

> `shared/degraded.ts` keeps its state on `globalThis`, not in a module-level
> variable. tsx can load one file into both the CJS and ESM graphs of a single
> process, giving two module instances with separate state — which silently
> broke the first implementation. `shared/package.json` (`"type": "module"`)
> also forces consistent ESM resolution.

### Lock semantics

The lock is a **directory** (`mkdir` is atomic on POSIX), so no `flock` is
needed — macOS does not ship it.

| Situation | Result |
|---|---|
| No run in progress | acquired |
| Same provider already running | **joined** — re-entrant, allows parallel sub-work |
| Different provider running | **blocked**, names the holder and PIDs |
| Previous run crashed | **auto-cleared** via `kill -0` liveness check |

One provider at a time; unlimited parallelism within a provider.

---

## 6. Provenance

Every stage writes `meta.json` next to its artifacts:

```json
{ "provider": "luna", "model": "gpt-5.6-luna", "stage": "stage2-hunt-lanes-perfile",
  "git_sha": "8a3b95a", "started": "...", "ended": "...",
  "exit_code": 0, "blocked_reads": 0, "degraded": false }
```

Deterministic stages (Stage 1, and v2's Stage 0.5) write `"model":
"deterministic"` — they still carry the provider, because their *input* did, but
they will not name a model that never ran.

Every downstream stage calls `assertUpstream(provider, stage)` before reading,
which throws if the upstream artifacts were produced by a different provider or
by a failed run.

**Why the assertion and not just the paths:** path centralisation prevents a
provider mix-up; it does not *detect* one. If someone hardcodes
`runPath('qwen', ...)` instead of `runPath(provider, ...)`, you get a "luna" run
that silently consumed qwen's candidates and looks completely normal in the
output. The assertion turns that into a startup crash naming both providers. A
corrupted comparison is the exact failure mode this whole structure exists to
prevent.

Missing `meta.json` warns but does not block — the pre-existing `runs/qwen/`
baseline predates the mechanism.

---

## 7. Rules for future changes

1. **Never name a model in code.** No model id, endpoint or credential env var
   belongs anywhere but `models.json`. If you find yourself writing
   `if (provider === '…')` outside `shared/`, stop — it belongs in a registry
   field. The property being protected is that adding a model is one JSON entry.
2. **Never add a path literal.** All artifact paths come from `runPath()`.
3. **Never pass a model-supplied path to anything but `readCorpusFile()`.**
4. **Never widen `CORPUS_ROOTS`** without thinking about what a model could then
   read. Adding `tools/` or `results/` would defeat the guard entirely.
5. **Run `npx tsx ../shared/guard.test.ts` after touching `shared/`.**
6. **Keep every stage on the same SDK version.** A version skew is an
   uncontrolled variable in the comparison — it was one until
   `stage2-hunt-lanes-perfile` was moved from `openai@4` to `openai@6` with the
   rest.
7. **Preserve v1 exactly when changing v2, and vice versa.** Both tracks are
   load-bearing and both are now provider-isolated; they share only Stage 0 and
   `shared/`.

---

## 8. Known issues

- **The two 2026-07-27 v2 runs are not blind.** Their lane manifests assigned
  `models/challenge.ts`, `lib/antiCheat.ts` and `data/datacreator.ts` to hunt
  lanes, so the challenge-key list reached the model mid-scan. Do not cite
  `scanner-2026-07-27-a` or `-b` as a blind baseline. The manifest that produced
  them has been removed from the repo rather than left where it could be re-run;
  the runs themselves are in the private archive. See `CLAUDE.md`'s
  blind-development section for the fix and the lesson.

- **No v2 run under `luna` has been scored yet.** The v2 track is wired and its
  deterministic stages (0, 0.5, 1) have been run end to end under `luna`, but
  Stage 2 — the only v2 stage that calls a model — has not been run for real.
  Its startup path was verified as far as the first API call and no further. So
  there is no v2 luna result to compare against anything, and
  `runs/luna/stage2-hunt-lanes-perfile/` does not exist.

  The v1 `runs/luna/` artifacts are inherited from the pre-rename `runs/openai/`
  tree: stage 3 is a real run, stages 1 and 2 are `seeded_from: qwen`.

- **The committed `runs/qwen/` baseline is partially refreshed and still not
  self-consistent.** Stage 0, 0.5, 1 and 2 artifacts were regenerated on
  2026-07-27 (PR #9). Stage 3 was **not** — `validated-findings.json` still
  derives from an older `candidate-findings.json` than the one now committed
  beside it. The mismatch below therefore still stands.

  Stage 1 is inconsistent with Stage 0.5 too, and that one is cheap to see:
  Stage 1 is fully deterministic (no LLM call), so re-running it on the
  committed `lane-manifest.json` must reproduce the committed
  `budget-plan.json` byte for byte. It does not — 19 of its lines change, and
  lane `unclassified-code-2` drops from 1 seed file / 853,037 bytes to 0.
  The seed files are re-read from disk at plan time, so the target app has
  moved under the committed plan.

  **How it drifted, found 2026-07-28:** `budget-governor.ts` ran `main()` at
  module scope, with no entry-point guard. `test-harness.ts` imports
  `BudgetTracker` from it, so `npm test` in that stage silently executed a full
  Stage 1 run and rewrote the committed `budget-plan.json` as a side effect —
  no log line, no diff anyone was looking at. The 19-line drift above is that
  rewrite. The guard is now in place (`process.argv[1] === fileURLToPath(...)`,
  matching the hunt executors) and `npm test` leaves the baseline byte-identical,
  but the committed file has already absorbed at least one such rewrite.

  ```bash
  cd tools/scanner/stage1-budget-governor && npx tsx src/budget-governor.ts
  git diff --stat tools/scanner/runs/qwen/stage1-budget-governor/budget-plan.json
  # expected: no diff. Any diff means the baseline is stale.
  ```

  Consolidation is deterministic (union-find, no model call), so identical
  stage-2 input must yield identical `CONS-xxxx` ids. When it was last measured
  — against the pre-refresh stage-2 output — the committed stage-3 file
  disagreed on both the candidate count and the identity of most shared ids,
  proving the two files came from different runs. The stage-2 refresh has only
  widened that gap; the exact numbers above have not been re-measured since.

  Consequence: **do not compare anything against the committed qwen stage-3
  baseline.** `diff.sh` detects this and aborts. Regenerate the whole
  pipeline under `qwen` before using it as a comparison point.
- **`api.openai.com` must be on the environment's egress allowlist.** It has
  been added for this project; a fresh environment needs it added again under
  network settings (https://code.claude.com/docs/en/claude-code-on-the-web) or
  the run must happen on a local machine. `run.sh` also exports
  `NODE_USE_ENV_PROXY=1`, without which the openai SDK bypasses the proxy and
  every request fails with "Host not in allowlist". The qwen path is unaffected.
  This applies to the default provider now, so a fresh environment fails on the
  very first stage rather than only when someone opts into a second model.
- **`tsc` on `stage0-recon` reports 15 pre-existing errors** in
  `ast-extractor.ts` (ts-morph typing) and `recon.ts` (strict-null). These were
  previously masked because `tsc` aborted on a config error. The other six
  stages type-check clean. Nothing builds via `tsc` — stages run through `tsx`.
- **The Stage 0 → Stage 0.5 v2 handoff needs `file-signals.json`**, which the
  committed `runs/qwen/stage0-recon/` baseline does not contain. v2 therefore
  cannot start from the committed baseline; `stage0-recon` has to run first.
  `run.sh <provider> all-v2` does that automatically.
