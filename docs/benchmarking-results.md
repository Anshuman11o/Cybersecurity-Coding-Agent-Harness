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

| Metric | `luna` (GPT-5.6 Luna) | `glm52` (GLM-5.2) | `gemini36flash` (Gemini 3.6 Flash) |
|---|---|---|---|
| **Recall** (file + exact line + category) | **69/97 = 71.1%** | **65/97 = 67.0%** | **57/97 = 58.8%** |
| Recall, category-blind | 77/97 = 79.4% | 77/97 = 79.4% | 67/97 = 69.1% |
| **Localization** (±15 lines) | **86/97 = 88.7%** | **83/97 = 85.6%** | **73/97 = 75.3%** |
| Localization, category-blind | 93/97 = 95.9% | 91/97 = 93.8% | 89/97 = 91.8% |
| File-level (any line, any category) | 97/97 = 100% | 97/97 = 100% | 96/97 = 99.0% |
| **Precision proxy**, category-aware | **12.5%** (69/553) | **7.8%** (70/892) | **16.5%** (47/285) |
| Precision proxy, category-blind | 22.4% (124/553) | 13.8% (123/892) | 23.5% (67/285) |
| **Total runtime** | **13m04s** at C=32 | **~18.5 min** at C=32 | **32m12s** at C=8 |
| **Total cost (USD)** | **$4.37** | **$17.01** | **$24.85** |
| **Input tokens** | **7,174,088** | **7,265,980** | **7,585,865** |
| — of which prefix-cached | 0 | 3,278,400 | 14,486 |
| **Output tokens** | **2,444,855** | **2,402,317** | **1,795,715** |
| **Total tokens** | **9,618,943** | **9,668,297** | **9,381,580** |
| **Model size** | no public record on model size | no public record on model size | no public record on model size |
| Findings emitted | 553 | 892 | 285 |
| Hedging (classes/finding) | 1.418 | 1.459 | 1.512 |
| Distinct lines cited | 3,597 | 4,577 | 1,181 |
| Mean / max trace steps | 8.74 / 51 | 6.64 / 38 | 4.56 / 13 |
| Lanes | 541/541 | 541/541 | 541/541 |
| Calls | 1,082 | 1,082 | 1,082 |
| Degraded | false | false | false |

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
| Claude Sonnet 5 | `sonnet5` | on hold |
| Claude Opus 5 | `opus5` | on hold |
| Gemini 3.1 Pro | `gemini31pro` | on hold |

See `protocols/benchmark-run-plan.md` for preconditions and the mandatory
per-model checks (§3a) that must be cleared before a run is launched.
