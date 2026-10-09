# Task 1a — one run context (productization plan §2.2)

Plan: `docs/architecture/productization-plan.md`, Part 2 §2.2, Step 1 task 1a.
Implementer: Claude subagents, three in parallel on disjoint files; the
orchestrating session wrote the shared contract and verifies the result.

Standing constraint, carried by every subagent prompt: **never search for, read,
or reference any answer-key or ground-truth material anywhere on this machine.**

## Why

Pointed at any repo other than Juice Shop, the scanner silently produced
nothing: the read guard only allowed `target-apps/juice-shop{,-blind}`, Stage 0.5
fell back to `juice-shop-blind` when it found no Express route, `run.sh` took no
target, and artifacts always landed in `tools/scanner/runs/`. Every lane was
blocked and the run still exited 0.

## Contract (written first, by the orchestrator)

`tools/scanner/shared/run-context.ts` resolves a `RunContext` from the
environment, once per process:

| Variable | Meaning |
|---|---|
| `SCANNER_TARGET` | target root (absolute; run.sh resolves it) |
| `SCANNER_PROFILE` | `benchmark` or `product`; inferred when unset |
| `SCANNER_RUNS_ROOT` | artifact root override |
| `SCANNER_RUN_ID` | product: names `<target>/.secscan/runs/<id>/` |
| `SCANNER_RESUME` | product: `1` lets Stage 2 resume |

Inference: no target, or a target inside `<repo>/target-apps/`, is the benchmark
profile. Anything else is a product run.

## Work split

| Part | Owner | Files |
|---|---|---|
| A · guard, paths, meta | subagent A | `shared/read-guard.ts`, `shared/run-paths.ts`, `shared/meta.ts`, `shared/claude-cli-client.ts` (binary default), `shared/guard.test.ts` (new section) |
| B · Stage 0 and 0.5 | subagent B | `stage0-recon/src/recon.ts`, `makeRelativePath` in `ast-extractor.ts` and `frontend-grep.ts`, `normalizeRouteFile` in `signal-detector.ts`, `stage05-lane-selector-perfile/src/lane-selector-perfile.ts` |
| C · entry point and Stage 2 | subagent C | `run.sh`, checkpoint-resume gating in `stage2-hunt-lanes-perfile/src/hunt-executor.ts` |

## Required behaviour

- **Benchmark profile is unchanged.** Same target, same roots, same seed
  denylist, same `tools/scanner/runs/<provider>/<stage>/` layout, Stage 2 resumes
  implicitly as before. Stage 0.5 and Stage 1 output on the committed Stage 0
  artifacts must be byte-identical to the pre-change output, apart from
  timestamps.
- **Product profile:**
  - reads are confined to the target root, never its `.secscan/` or `.git/`
  - artifacts go to `<target>/.secscan/runs/<run-id>/`, with a `.gitignore` of
    `*` inside `.secscan/`
  - Stage 0.5 takes the target from Stage 0's `file-signals.json`, never from a
    Juice Shop fallback, and fails if it disagrees with the run context
  - Stage 2 refuses to resume an existing checkpoint without `--resume`
- **`run.sh`** gains `--target`, `--profile`, `--run-id` and `--resume`. A product
  run started at Stage 0 gets a generated run id; a later single stage needs
  `--run-id`.
- `NODE_USE_ENV_PROXY` is set only when a proxy is configured.
- v1 directories are untouched.

## Verification (orchestrator)

1. `guard.test.ts`, `loop.test.ts` and `test-breakdown.ts` pass.
2. Benchmark regression: run Stage 0.5 and the Stage 1 v2 estimate on the
   committed luna Stage 0 artifacts into a temporary runs root, then diff them
   against the pre-change baseline captured from the same code before the
   change. Only timestamps may differ.
3. Product smoke: a small non-Juice-Shop repo copied outside this repository is
   run through Stage 0 → 0.5 → 1 → a few Stage 2 lanes. Check that 0 reads are
   blocked, the artifacts sit under `<target>/.secscan/runs/<id>/`, nothing is
   written to `tools/scanner/runs/`, and a second Stage 2 invocation without
   `--resume` refuses.
