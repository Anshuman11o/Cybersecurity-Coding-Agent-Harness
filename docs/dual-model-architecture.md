# Dual-model architecture

How the scanner runs under more than one LLM provider, and the rules that keep
those runs from contaminating each other.

Read this before changing anything under `tools/scanner/`.

---

## 1. Two roles, don't confuse them

| Role | Who | Touches |
|---|---|---|
| **Coding agent** — edits scanner source, refactors, writes docs | Claude Code sessions, humans | `tools/scanner/*/src/**`, `docs/**` |
| **Scanner inference model** — reads target code, produces findings | `qwen-plus` or `gpt-5.6-luna`, called from inside the stages | nothing on disk; it's a network call |

This document is about the **second** role. Neither inference model "lives" in a
directory — they are runtime parameters. What gets isolated is the *evidence
each run produces*.

---

## 2. Providers

| Provider key | Model id | Endpoint | Credential |
|---|---|---|---|
| `qwen` (default) | `qwen-plus` | DashScope OpenAI-compatible | `DASHSCOPE_API_KEY` |
| `openai` | `gpt-5.6-luna` | `api.openai.com` | `OPENAI_API_KEY` |

Override the model within a provider via `QWEN_MODEL` / `OPENAI_MODEL`.

Both providers execute **byte-identical scanner logic** against a
**byte-identical corpus**, with identical prompts, schemas, and token budgets.
The only permitted differences are the model id and the credential. That is what
makes a cross-provider diff meaningful — anything else and you are comparing two
codebases rather than two models.

### Selecting a provider

Resolution order (first match wins), in `shared/provider.ts`:

1. `SCANNER_PROVIDER_<STAGE>` — per-stage override (`SCANNER_PROVIDER_STAGE3=openai`)
2. `SCANNER_PROVIDER` — global
3. `qwen` — default, preserves pre-existing behaviour

### Provider-specific API differences

Handled centrally; do not special-case at call sites.

| Concern | qwen | openai | Helper |
|---|---|---|---|
| Output token cap | `max_tokens` | `max_completion_tokens` | `tokenLimitParam()` |
| Sampling | `temperature: 0.1` | omitted | `samplingParams()` |
| Base URL | DashScope | default | `createClient()` |

GPT-5.x reasoning models **reject** `max_tokens` with a 400, and are
inconsistent about accepting non-default sampling values. That is why both are
routed through helpers rather than written inline.

---

## 3. Directory layout

```
tools/scanner/
├── shared/                    zero-dependency helpers, imported by every stage
│   ├── run-paths.ts             runPath(provider, stage) — the only path source
│   ├── provider.ts              provider/model/param resolution
│   ├── read-guard.ts            corpus allowlist for model-supplied paths
│   ├── meta.ts                  meta.json write + provenance assertions
│   └── guard.test.ts            smoke tests (npx tsx ../shared/guard.test.ts)
│
├── stage0-recon/src/          shared code — NEVER forked per provider
├── stage05-lane-selector/src/
├── stage1-budget-governor/src/
├── stage2-hunt-lanes/src/
├── stage3-validate/src/
│
├── runs/                      ALL run artifacts, provider-scoped
│   ├── qwen/<stage>/            *.json + meta.json + logs/ (gitignored)
│   └── openai/<stage>/
│
├── run.sh                     the entry point — always use this
├── diff.sh                    cross-provider comparison
└── .run.lock/                 mutex (gitignored)
```

The old per-stage `output/` directories are gone. Their contents were
`git mv`'d into `runs/qwen/<stage>/` — that is the historical baseline.

---

## 4. Access rules

| Path | qwen run | openai run | Why |
|---|:---:|:---:|---|
| `target-apps/**` | R | R | the corpus — controlled variable |
| `tools/scanner/*/src/**`, `shared/**` | R | R | identical code |
| `tools/scanner/runs/qwen/**` | RW | — | provider-owned |
| `tools/scanner/runs/openai/**` | — | RW | provider-owned |
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
./tools/scanner/run.sh <qwen|openai> <stage|all>
```

```bash
./tools/scanner/run.sh qwen   stage3-validate     # baseline
./tools/scanner/run.sh openai stage3-validate     # challenger
./tools/scanner/run.sh openai all                 # full pipeline
./tools/scanner/diff.sh stage3-validate           # compare
```

`run.sh` acquires the lock, exports `SCANNER_PROVIDER`, tees stdout/stderr into
`runs/<provider>/<stage>/logs/`, and releases the lock on exit.

**Always use `run.sh`.** Calling `npm run run` inside a stage directly bypasses
the lock and the log capture. It will still work and still write to the right
provider directory (the path helper does not depend on the runner), but two
providers could then run concurrently.

### Preflight

Before spending money on a stage run, verify credentials, model access, and
parameter shape:

```bash
cd tools/scanner/stage3-validate
SCANNER_PROVIDER=openai npx tsx ../shared/preflight.ts
```

Checks the key is present, makes one tiny completion call, and probes
`json_schema` strict mode. Exits non-zero on failure.

### Seeding upstream artifacts

`assertUpstream()` refuses to run a stage whose upstream artifacts belong to a
different provider. For a **validator-only** comparison (same candidates,
different judge), copy the upstream across:

```bash
./tools/scanner/seed-upstream.sh qwen openai stage1-budget-governor stage2-hunt-lanes
./tools/scanner/run.sh openai stage3-validate
```

The rewritten `meta.json` carries `seeded_from`, so the artifacts stay honestly
labelled. **Results from a seeded run are not an end-to-end comparison** — say
so when reporting them.

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
{ "provider": "openai", "model": "gpt-5.6-luna", "stage": "stage2-hunt-lanes",
  "git_sha": "8a3b95a", "started": "...", "ended": "...",
  "exit_code": 0, "blocked_reads": 0 }
```

Every downstream stage calls `assertUpstream(provider, stage)` before reading,
which throws if the upstream artifacts were produced by a different provider or
by a failed run.

**Why the assertion and not just the paths:** path centralisation prevents a
provider mix-up; it does not *detect* one. If someone hardcodes
`runPath('qwen', ...)` instead of `runPath(provider, ...)`, you get an
"openai" run that silently consumed qwen's candidates and looks completely
normal in the output. The assertion turns that into a startup crash naming both
providers. A corrupted comparison is the exact failure mode this whole structure
exists to prevent.

Missing `meta.json` warns but does not block — the pre-existing `runs/qwen/`
baseline predates the mechanism.

---

## 7. Rules for future changes

1. **Never fork a stage per provider.** If you find yourself writing
   `if (provider === 'openai')` outside `shared/`, stop — it belongs in a helper.
2. **Never add a path literal.** All artifact paths come from `runPath()`.
3. **Never pass a model-supplied path to anything but `readCorpusFile()`.**
4. **Never widen `CORPUS_ROOTS`** without thinking about what a model could then
   read. Adding `tools/` or `results/` would defeat the guard entirely.
5. **Run `npx tsx ../shared/guard.test.ts` after touching `shared/`.**
6. **Keep both providers on the same SDK version.** A version skew is an
   uncontrolled variable in the comparison.

---

## 8. Known issues

- **The committed `runs/qwen/` baseline is stale.** Stage 0/1 artifacts were
  produced on 2026-07-24 (`9d5d631`); commit `9a98041` on 2026-07-25 stripped
  content from `target-apps/juice-shop-blind`, so re-running Stage 1 today
  produces smaller seed-byte totals. The baseline is internally coherent
  (Stage 2/3 were produced against the Stage 1 plan that is committed), so it
  has been left as-is. Regenerate the whole pipeline under `qwen` before using
  it as a comparison point.
- **`api.openai.com` is not in the Claude Code web environment's egress
  allowlist.** The OpenAI path cannot be exercised from a web session until the
  host is added to the environment's network settings
  (https://code.claude.com/docs/en/claude-code-on-the-web), or the run is done
  on a local machine. The qwen path works from either.
- **`tsc` on `stage0-recon` reports 15 pre-existing errors** in
  `ast-extractor.ts` (ts-morph typing) and `recon.ts` (strict-null). These were
  previously masked because `tsc` aborted on a config error. The other four
  stages type-check clean. Nothing builds via `tsc` — stages run through `tsx`.
