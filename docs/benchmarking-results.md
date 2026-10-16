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

## 4. Regression checks (appended; not new benchmark entries)

A re-run of an already-recorded model to check that a non-prompt change left
recall intact. Same scorer, same answer key, rebased to 97.

### 4.1 `luna` · 2026-10-10 · productization Task 1a (run context, PR #54)

| | |
|---|---|
| Tree | `7072dfb` (merged main) |
| Concurrency / loop / effort / cap | 32 / `trace` / `high` / 64000 |
| Stages | Stage 0 carried over from `tools/scanner/runs/luna/`; 0.5 and 1 regenerated (content-identical to the committed ones); Stage 2 ran fresh |
| Artifacts | private run store `runs/2026-10-10T22-36Z__stage2-v2-perfile__7072dfb`; not committed here so run 6's committed artifacts stay in place. Eval-history row `scanner-2026-10-10-luna-task1a` |

| Metric | This run | Run 6 |
|---|---|---|
| Recall | 69/97 = 71.1% | 69/97 = 71.1% |
| Localization (±15) | 85/97 = 87.6% | 86/97 = 88.7% |
| File-level | 97/97 = 100% | 97/97 = 100% |
| Recall / localization, category-blind | 79.4% / 97.9% | 79.4% / 95.9% |
| Precision proxy, category-aware / blind | 12.2% / 21.2% | 12.5% / 22.4% |
| Hedging | 1.386 | 1.418 |
| Findings | 533 | 553 |
| Tokens / cost | 9,385,314 / $3.68 | 9,618,943 / $4.37 |
| Wall clock | 13m25s | 13m04s |
| Lanes / retries / fatal / blocked reads | 541/541 / 0 / 0 / 0 | 541/541 / 0 / 0 / 0 |

Every delta is inside the ±7-entry nondeterminism floor. **Qualification:** not
single-variable against run 6. Besides Task 1a, the tree carries post-run-6
Stage 2 and registry commits (output cap 24000 to 64000, chunk bounds,
failed-lane reporting, checkpoint fix).

## Held-out targets

Full Stage 0–2 v2 runs on separately pinned public targets belong here. These
results have their own ground-truth denominators and are not directly comparable
to the Juice Shop table above. Class-selection-only evaluations do not qualify.
All rows: GPT-6 Luna, product profile, 2026-10-15, scored with the 95% OWASP-code floor lifted; category-aware figures are lower bounds where the playbook agent added non-OWASP classes. Full caveats are in each row of `results/eval-history/scanner.jsonl`.

| Target | Target commit | Harness commit / run id | Ground truth | Recall | Localization | File-level | Precision proxy (category-aware) | Hedging | Notes |
|---|---|---|---|---|---|---|---|---|---|
| aigoat-clean-LLM (secscan, playbook agent) | `9c62129` | `d299ee2` / heldout-aigoat-2026-10-15-luna6-secscan | aigoat-clean v1.0.1 export (23 entries) | 12/23 (52.2%); blind 18 | 15; blind 22 | 23/23 | 23.4% (blind 40.6%) | 1.172 | complete $0.21 |
| aigoat-clean-LLM (fixed classes) | `9c62129` | `d299ee2` / heldout-aigoat-2026-10-15-luna6-fixed-classes | aigoat-clean v1.0.1 export (23 entries) | 15/23 (65.2%); blind 19 | 16; blind 22 | 23/23 | 28.6% (blind 35.1%) | 1.299 | complete $0.2 |
| androgoat-clean-mobile (secscan, playbook agent) | `8abc7a6` | `d299ee2` / heldout-androgoat-2026-10-15-luna6-secscan | androgoat-clean v1.1.1 export (29 entries) | 18/29 (62.1%); blind 21 | 20; blind 22 | 26/29 | 55.6% (blind 75.0%) | 1.417 | complete $0.27 |
| androgoat-clean-mobile (fixed classes) | `8abc7a6` | `d299ee2` / heldout-androgoat-2026-10-15-luna6-fixed-classes | androgoat-clean v1.1.1 export (29 entries) | 25/29 (86.2%); blind 25 | 27; blind 27 | 27/29 | 69.0% (blind 73.8%) | 1.524 | complete $0.11 |
| smartbugs-clean-solidity (secscan, playbook agent) | `6d09946` | `d299ee2` / heldout-smartbugs-2026-10-15-luna6-secscan | smartbugs-clean export (207 entries) | 9/207 (4.3%); blind 44 | 20; blind 59 | 62/207 | 20.4% (blind 74.2%) | 1.677 | INCOMPLETE: $5 cap hit by Stage 2 reservations, not spend ($1.04 spent); 18 lanes failed on reservation and 80 never started (63/143 hunted). Budgeting defect, not a reasoning result. $1.04 |
| smartbugs-clean-solidity (fixed classes) | `6d09946` | `d299ee2` / heldout-smartbugs-2026-10-15-luna6-fixed-classes | smartbugs-clean export (207 entries) | 103/207 (49.8%); blind 145 | 134; blind 189 | 198/207 | 56.7% (blind 77.1%) | 1.551 | complete $0.7 |
| castle-clean-c (secscan, playbook agent) | `4278a49` | `d299ee2` / heldout-castle-2026-10-15-luna6-secscan | castle-clean v1.2.0 per-record export (150 vulnerable records; 100 clean programs held separately) | 21/150 (14.0%); blind 78 | 21; blind 82 | 83/150 | 15.0% (blind 61.4%) | 1.026 | Playbook agent selected 8 classes without the floor; 85/250 programs had no selected class and were skipped. Clean-program false-positive rate 33.0% (33/100 clean programs flagged, 46 findings). $0.63 |
| castle-clean-c (fixed classes) | `4278a49` | `d299ee2` / heldout-castle-2026-10-15-luna6-fixed-classes | castle-clean v1.2.0 per-record export (150 vulnerable records; 100 clean programs held separately) | 30/150 (20.0%); blind 55 | 31; blind 62 | 66/150 | 24.7% (blind 56.8%) | 1.048 | complete $0.5 |
| smartbugs-clean-solidity (secscan post-fix, second sample) | `6d09946` | `c50ff09` / heldout-smartbugs-2026-10-15-luna6-secscan-rerun | smartbugs-clean export (207 entries) | 37/207 (17.9%); blind 137 | 52; blind 172 | 193/207 | 20.6% (blind 82.5%) | 1.478 | Intended as a budget-fix-only check, but the routing change landed in the same worktree before Stage 0.5 ran, so it used both fixes; treat as a second sample of the final configuration. $1.18 |
| smartbugs-clean-solidity (secscan post-fix) | `6d09946` | `c50ff09` / heldout-smartbugs-2026-10-15-luna6-secscan-postfix | smartbugs-clean export (207 entries) | 31/207 (15.0%); blind 141 | 45; blind 182 | 192/207 | 18.3% (blind 79.5%) | 1.621 | complete $1.11 |
| castle-clean-c (secscan post-fix) | `4278a49` | `c50ff09` / heldout-castle-2026-10-15-luna6-secscan-postfix | castle-clean v1.2.0 per-record export (150 vulnerable records; 100 clean programs held separately) | 24/150 (16.0%); blind 100 | 25; blind 108 | 111/150 | 11.6% (blind 60.2%) | 1.216 | Clean-program false-positive rate 48.0% (48/100 flagged, 78 findings). $0.9 |
| aigoat-clean-LLM (secscan, run-scoped cache) | `9c62129` | `c414875` / heldout-aigoat-2026-10-16-luna6-secscan-runcache | aigoat-clean v1.0.1 export (23 entries) | 12/23 (52.2%); blind 19 | 15; blind 23 | 23/23 | 25.0% (blind 43.3%) | 1.1 | Run-scoped playbook cache: the agent added no classes this run and nothing was inherited. Class-name type matching. Complete, 90/90 lanes. $0.21 |
| androgoat-clean-mobile (secscan, run-scoped cache) | `8abc7a6` | `c414875` / heldout-androgoat-2026-10-16-luna6-secscan-runcache | androgoat-clean v1.1.1 export (29 entries) | 20/29 (69.0%); blind 24 | 20; blind 25 | 26/29 | 58.8% (blind 79.4%) | 1.676 | Run-scoped playbook cache: every agent class researched in this run, none inherited (6 agent classes); cache removed at run end. Class-name type matching; 20 class labels on findings use agent names that cannot match the answer key, so category-aware figures understate detection. Complete, 34/34 lanes. $0.39 |
| smartbugs-clean-solidity (secscan, run-scoped cache) | `6d09946` | `c414875` / heldout-smartbugs-2026-10-16-luna6-secscan-runcache | smartbugs-clean export (207 entries) | 45/207 (21.7%); blind 145 | 74; blind 185 | 195/207 | 25.0% (blind 83.5%) | 1.508 | Run-scoped playbook cache: every agent class researched in this run, none inherited (4 agent classes); cache removed at run end. Class-name type matching; 201 class labels on findings use agent names that cannot match the answer key, so category-aware figures understate detection. Complete, 143/143 lanes. $1.20 |

2026-10-16 rows: scored with class-name type matching (`score_scanner.py` default since `c3ccb8c`), no floor wrapper. CASTLE is dropped from held-out testing for now: 108 of its 150 entries carry no class name in the answer key, so its class-matched figures cannot be measured; its 2026-10-15 rows above stand as recorded.

### Historical playbook-agent comparability

Playbook-agent results recorded on **2026-10-13** for the **AI Goat** and
**AndroGoat** targets were measured before the Terraform/Kotlin signal changes.
They are not comparable with runs after those changes. Preserve those historical
results and their original qualifications; later runs need a separate baseline.
