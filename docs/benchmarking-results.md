# Benchmarking results

**The permanent record of every model scored in the multi-model benchmark.**

This file is the shared destination for every agent running any model. It is
**append-only**. Its contents are cited in comparisons long after the run that
produced them, so a number removed here cannot be reconstructed from anywhere
else without paying for the run again.

---

## Rules for this file — read before editing

1. **Append. Never overwrite, never delete, never rewrite a recorded row.**
   A result already here is a measurement that was paid for. If it later proves
   wrong, add a correction *below* it saying what changed and why, and leave the
   original in place.
2. **Every number must come from a committed artifact**, not from a run log,
   an agent's summary, or this file's previous revision. The artifact paths are
   named in each entry. Re-derive rather than copy when in doubt.
3. **Score every model with the same scorer, the same answer key and the same
   denominator.** `tools/scan-benchmark/score_scanner.py`, rebased to the 97
   reachable entries. A row scored any other way is not comparable.
4. **Record the run parameters with the result** — concurrency, tree SHA, rate,
   loop mode, reasoning effort. A metric is only reproducible next to the
   configuration that produced it.
5. **Aggregates only.** Per `CLAUDE.md`, nothing here may pair a challenge
   identifier with a file, a line, or a found/not-found status. Per-class
   recall over ground-truth *classes* is aggregate and allowed; per-entry
   detail is not, and belongs in the answer-key repo.
6. **Only completed runs belong here.** A run that did not finish all lanes is
   not a result and must not be added.

---

## 1. Results

All figures rebased to the **97 reachable** ground-truth entries. All runs use
the v2 per-file pipeline, `HUNT_LOOP=trace`, `reasoning_effort: high`,
`max_output_tokens: 64000`.

| Metric | `luna` (GPT-5.6 Luna) | `glm52` (GLM-5.2) | `gemini36flash` (Gemini 3.6 Flash) | `sonnet5cli` (Claude Sonnet 5, CLI transport) |
|---|---|---|---|---|
| **Recall** (file + exact line + category) | **69/97 = 71.1%** | **65/97 = 67.0%** | **57/97 = 58.8%** | **64/97 = 66.0%** |
| Recall, category-blind | 77/97 = 79.4% | 77/97 = 79.4% | 67/97 = 69.1% | 77/97 = 79.4% |
| **Localization** (±15 lines) | **86/97 = 88.7%** | **83/97 = 85.6%** | **73/97 = 75.3%** | **84/97 = 86.6%** |
| Localization, category-blind | 93/97 = 95.9% | 91/97 = 93.8% | 89/97 = 91.8% | 94/97 = 96.9% |
| File-level (any line, any category) | 97/97 = 100% | 97/97 = 100% | 96/97 = 99.0% | 97/97 = 100% |
| **Precision proxy**, category-aware | **12.5%** (69/553) | **7.8%** (70/892) | **16.5%** (47/285) | **6.4%** (81/1270) |
| Precision proxy, category-blind | 22.4% (124/553) | 13.8% (123/892) | 23.5% (67/285) | 11.5% (146/1270) |
| **Total runtime** | **13m04s** at C=32 | **~18.5 min** at C=32 | **32m12s** at C=8 | **~4h wall across 4 usage windows** at C=6 |
| **Total cost (USD)** | **$4.37** | **$17.01** | **$24.85** | **$84.04** |
| **Input tokens** | **7,174,088** | **7,265,980** | **7,585,865** | **17,528,930** |
| — of which prefix-cached | 0 | 3,278,400 | 14,486 | 8,552,056 |
| **Output tokens** | **2,444,855** | **2,402,317** | **1,795,715** | **5,569,453** |
| **Total tokens** | **9,618,943** | **9,668,297** | **9,381,580** | **23,098,383** |
| **Model size** | no public record on model size | no public record on model size | no public record on model size | no public record on model size |
| Findings emitted | 553 | 892 | 285 | 1,270 |
| Hedging (classes/finding) | 1.418 | 1.459 | 1.512 | 1.536 |
| Distinct lines cited | 3,597 | 4,577 | 1,181 | 6,709 |
| Mean / max trace steps | 8.74 / 51 | 6.64 / 38 | 4.56 / 13 | 6.66 / 30 |
| Lanes | 541/541 | 541/541 | 541/541 | 541/541 |
| Calls | 1,082 | 1,082 | 1,082 | 1,093 successful (+229 refused) |
| Degraded | false | false | false | false |

---

## 2. Per-model detail

### 2.1 `luna` — GPT-5.6 Luna

| | |
|---|---|
| Model id | `gpt-5.6-luna` |
| Run | run 6, 2026-08-01 |
| Tree | `20889d4` (Stage 2) |
| Concurrency | 32 |
| Loop mode / effort | `trace` / `high` |
| Rate | $0.20 / $1.20 per MTok, `price_asof` 2026-08-01 |
| Artifacts | `tools/scanner/runs/luna/` |

Per-class recall (over ground-truth entries in each class):

| Class | Recall | Localized |
|---|---|---|
| crypto-auth | 23/25 = 92.0% | 23/25 |
| injection | 15/18 = 83.3% | 18/18 |
| misconfiguration | 10/17 = 58.8% | 12/17 |
| access-control | 9/16 = 56.2% | 14/16 |
| insecure-design | 7/13 = 53.8% | 10/13 |
| api-property-auth | 3/4 = 75.0% | 4/4 |
| ssrf | 3/3 = 100% | 3/3 |
| integrity-failures | 2/3 = 66.7% | 2/3 |
| resource-consumption | 1/2 = 50.0% | 2/2 |
| logging-monitoring | 1/1 = 100% | 1/1 |
| ai-llm-agency | 0/4 = 0.0% | 4/4 |

### 2.2 `glm52` — GLM-5.2

| | |
|---|---|
| Model id | `glm-5.2` |
| Run | 2026-08-02 |
| Tree | `aac8c00` |
| Concurrency | 32 |
| Loop mode / effort | `trace` / `high` |
| Rate | $1.40 / $0.26 cached / $4.40 per MTok, `price_asof` 2026-08-01 |
| Artifacts | `tools/scanner/runs/glm52/` |

Per-class recall:

| Class | Recall | Localized |
|---|---|---|
| injection | 17/18 = 94.4% | 18/18 |
| crypto-auth | 22/25 = 88.0% | 23/25 |
| api-property-auth | 3/4 = 75.0% | 4/4 |
| integrity-failures | 2/3 = 66.7% | 2/3 |
| insecure-design | 8/13 = 61.5% | 9/13 |
| resource-consumption | 1/2 = 50.0% | 2/2 |
| access-control | 7/16 = 43.8% | 15/16 |
| misconfiguration | 4/17 = 23.5% | 9/17 |
| ssrf | 3/3 = 100% | 3/3 |
| logging-monitoring | 1/1 = 100% | 1/1 |
| ai-llm-agency | 0/4 = 0.0% | 4/4 |


### 2.3 `gemini36flash` — Gemini 3.6 Flash

| | |
|---|---|
| Model id | `gemini-3.6-flash` |
| Run | 2026-08-02 |
| Tree | `2a4bf04` |
| Concurrency | **8** — a measured ceiling on this target, not a starting point |
| Loop mode / effort | `trace` / `high` (Stage 2); Stage 0 probes at default effort |
| Rate | $1.50 / $0.15 cached / $7.50 per MTok, `price_asof` 2026-08-02 |
| Artifacts | `tools/scanner/runs/gemini36flash/` |
| Archive | answer-key repo, `runs/2026-08-02T16-38Z__stage2-v2-perfile-trace-loop__gemini36flash__2a4bf04/` |

Per-class recall:

| Class | Recall | Localized |
|---|---|---|
| ssrf | 3/3 = 100% | 3/3 |
| logging-monitoring | 1/1 = 100% | 1/1 |
| injection | 15/18 = 83.3% | 18/18 |
| crypto-auth | 20/25 = 80.0% | 23/25 |
| api-property-auth | 3/4 = 75.0% | 4/4 |
| integrity-failures | 2/3 = 66.7% | 2/3 |
| resource-consumption | 1/2 = 50.0% | 2/2 |
| insecure-design | 5/12 = 41.7% | 8/12 |
| access-control | 6/16 = 37.5% | 9/16 |
| ai-llm-agency | **1/4 = 25.0%** | 3/4 |
| misconfiguration | 3/17 = 17.6% | 5/17 |

### 2.4 `sonnet5cli` — Claude Sonnet 5 (Claude Code CLI transport)

| | |
|---|---|
| Model id | `claude-sonnet-5` |
| Run | 2026-08-03 |
| Tree | `80b9f90` |
| Concurrency | 6 |
| Loop mode / effort | `trace` / `high` |
| Rate | $2.00 / $0.20 cached / $2.50 cache-write / $10.00 per MTok, `price_asof` 2026-08-02 |
| Artifacts | `tools/scanner/runs/sonnet5cli/` |

**This row is not transport-comparable with the other three and must never be
merged with a `sonnet5` row.** It was measured through the local Claude Code
binary in headless mode against a Max subscription, not over the
OpenAI-compatibility endpoint. Four deltas, all measured:

1. **Effort asymmetry, and it favours this row.** `--effort high` is genuinely
   applied here. The registry records `sonnet5`/`opus5` as *accepting*
   `reasoning_effort` over the compat layer with no reasoning tokens ever
   observed. So this arm may think more than an API run of the same model
   would, and recall is monotone in trace length (§9.1 of the run plan).
2. Structured output is a forced tool call via `--json-schema`, not
   `response_format: json_schema strict`.
3. ~170 tokens per call of irreducible CLI framing survive `--system-prompt ''`.
4. The trace loop's second turn is a `--resume`, served partly from prompt
   cache — 8,552,056 of 17,528,930 input tokens were cache reads. Input bills
   cheaper here than an uncached compat-layer run would.

**Cost is taken from `stage2-hunt-lanes-perfile/cli-usage.jsonl`, the per-call
ledger, not from `usage-v2.json`.** The latter reports $52.60 over 397 lanes
and is wrong: a checkpoint defect destroyed 144 lanes' per-lane token records
mid-run (fixed in `80b9f90`). The findings artifact is complete and unaffected;
only the per-lane v2 detail for those 144 lanes is missing. Cited cost is
$84.04. The CLI's own `costUSD` field is also not used — it prices this model
at the post-2026-08-31 rate.

Execution: 541/541 lanes, `degraded: false`, 0 blocked reads, 0 retries, 0
fatals in the final pass. 1,093 successful calls of which exactly 541 were
resumes — 541 turn-1 + 541 turn-2 + 11 re-runs — so every lane completed both
turns. A further 229 calls were session-limit refusals costing ~37 output
tokens each; the run spanned four subscription usage windows. One 5-hour window
absorbed ~313 lanes / ~12.3M tokens.

Per-class recall:

| Class | Recall | Localized |
|---|---|---|
| api-property-auth | 4/4 = 100% | 4/4 |
| ssrf | 3/3 = 100% | 3/3 |
| injection | 16/18 = 88.9% | 18/18 |
| crypto-auth | 22/25 = 88.0% | 23/25 |
| insecure-design | 9/13 = 69.2% | 11/13 |
| integrity-failures | 2/3 = 66.7% | 2/3 |
| resource-consumption | 1/2 = 50.0% | 2/2 |
| access-control | 7/16 = 43.8% | 12/16 |
| misconfiguration | 4/17 = 23.5% | 9/17 |
| ai-llm-agency | 0/4 = 0.0% | 4/4 |
| logging-monitoring | 0/1 = 0.0% | 1/1 |

**Read the recall next to the line budget.** This run cited **6,709 distinct
lines across 1,270 findings**, against luna's 3,597 across 553 and glm52's
4,577 across 892 — roughly twice luna's line budget and nearly three times its
finding count. Recall came out at 66.0% against luna's 71.1%. Per §9.1 the
confound *flatters* this row rather than penalising it: it had far more shots on
goal and did not convert them. Its 6.4% category-aware precision proxy is the
lowest of the four for the same reason. This is the opposite of the
`gemini36flash` situation, where a low score had to be checked against a short
trace before it could be read as capability.

---

## 3. Method — how a row here is produced

Reproduce exactly, or the row is not comparable:

```bash
# 1. Score against ground truth (98-entry denominator)
python3 tools/scan-benchmark/score_scanner.py \
  --findings tools/scanner/runs/<provider>/stage2-hunt-lanes-perfile/candidate-findings.json \
  --answer-key <answer-key path — never commit this path> \
  --label <provider>-<date>

# 2. Rebase to the 97 reachable entries: hits unchanged, denominator 98 -> 97.
#    One entry is on SEED_DENYLIST and unreachable by construction.
#    Precision proxy and hedging are per-finding and are NOT rebased.

# 3. Cost and tokens — from the artifact, never from a log
cat tools/scanner/runs/<provider>/stage1-budget-governor-perfile/usage-v2.json

# 4. Line budget
node -e "const f=require('./tools/scanner/runs/<provider>/stage2-hunt-lanes-perfile/candidate-findings.json');
const a=Array.isArray(f)?f:(f.findings||Object.values(f).find(Array.isArray));
const l=a.map(x=>(x.trace||[]).length);const d=new Set();
a.forEach(x=>(x.trace||[]).forEach(s=>d.add(s.file+':'+s.line)));
console.log(a.length+' findings, mean trace '+(l.reduce((p,c)=>p+c,0)/l.length).toFixed(2)+
            ', max '+Math.max(...l)+', '+d.size+' distinct lines');"
```

Also record, from `usage-v2.json` and the stage `meta.json` files: `lane_count`,
`calls`, `lanes_missing_measurement`, `degraded`, `git_sha`, `loop_mode`,
`reasoning_effort`, and the concurrency used.

**Every metric in §1 must be filled.** A metric that could not be obtained is
recorded as the reason it could not be — as `model size` is recorded as
"no public record on model size" — never left blank and never estimated.

---

## 4. Pending

| Model | Registry key | State |
|---|---|---|
| Qwen 3.7 Plus | `qwen37` | on hold |
| Claude Sonnet 5 | `sonnet5` | on hold — API transport still unmeasured; `sonnet5cli` is NOT a substitute (§2.4) |
| Claude Opus 5 | `opus5` | on hold |
| Gemini 3.1 Pro | `gemini31pro` | on hold |

See `protocols/benchmark-run-plan.md` for preconditions and the mandatory
per-model checks (§3a) that must be cleared before a run is launched.
