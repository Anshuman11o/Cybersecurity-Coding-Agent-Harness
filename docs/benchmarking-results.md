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
   original in place. `run-history.md`'s pricing correction is the pattern:
   the wrong figures stayed, and the corrected ones were added beside them.
2. **Every number must come from a committed artifact**, not from a run log,
   an agent's summary, or this file's previous revision. The artifact paths are
   named in each entry. Re-derive rather than copy when in doubt.
3. **Score every model with the same scorer, the same answer key and the same
   denominator.** `tools/scan-benchmark/score_scanner.py`, rebased to the 97
   reachable entries. A row scored any other way is not comparable and must say
   so in its own caveats.
4. **A qualified number travels with its qualification.** If a metric is
   compromised — wrong concurrency, a degraded stage, a partial run — the
   caveat goes in the row, not in a footnote someone will drop when they copy
   the table.
5. **Aggregates only.** Per `CLAUDE.md`, nothing here may pair a challenge
   identifier with a file, a line, or a found/not-found status. Per-class
   recall over ground-truth *classes* is aggregate and allowed; per-entry
   detail is not, and belongs in the answer-key repo.
6. **A run that did not complete is not a result.** Record it in §4 as a failed
   attempt so the cost and cause are on record, but never in the results table.

---

## 1. Results

All figures rebased to the **97 reachable** ground-truth entries. All runs use
the v2 per-file pipeline, `HUNT_LOOP=trace`, `reasoning_effort: high`,
`max_output_tokens: 64000`.

| Metric | `luna` (GPT-5.6 Luna) | `glm52` (GLM-5.2) |
|---|---|---|
| **Recall** (file + exact line + category) | **69/97 = 71.1%** | **65/97 = 67.0%** |
| Recall, category-blind | 77/97 = 79.4% | 77/97 = 79.4% |
| **Localization** (±15 lines) | **86/97 = 88.7%** | **83/97 = 85.6%** |
| Localization, category-blind | 93/97 = 95.9% | 91/97 = 93.8% |
| File-level (any line, any category) | 97/97 = 100% | 97/97 = 100% |
| **Precision proxy**, category-aware | **12.5%** (69/553) | **7.8%** (70/892) |
| Precision proxy, category-blind | 22.4% (124/553) | 13.8% (123/892) |
| **Total runtime** | **13m04s** @ C=32 | **~18.5 min** @ C=32 ⚠ |
| **Total cost (USD)** | **$4.37** | **$17.01** |
| **Input tokens** | **7,174,088** | **7,265,980** |
| — of which prefix-cached | 0 | 3,278,400 |
| **Output tokens** | **2,444,855** | **2,402,317** |
| **Total tokens** | **9,618,943** | **9,668,297** |
| **Model size** | no public record on model size | no public record on model size |
| Findings emitted | 553 | 892 |
| Hedging (classes/finding) | 1.418 | 1.459 |
| Distinct lines cited | 3,597 | 4,577 |
| Mean / max trace steps | 8.74 / 51 | 6.64 / 38 |
| Lanes | 541/541 | 541/541 |
| Calls | 1,082 | 1,082 |
| Degraded | false | false |

### How to read this table

**The recall difference between these two models is not a result.** 69 vs 65 is
4 entries, against a **±7-entry nondeterminism floor** on byte-identical
prompts. One run each cannot separate them. Do not publish a ranking from this
table; publish that they are indistinguishable on recall and separated on cost.

**Cost is the real separation.** $17.01 against $4.37 — 3.9x — for
statistically equivalent recall. That gap is far outside any noise floor.

**Precision genuinely differs.** `glm52` emitted 61% more findings (892 vs 553)
for the same number of hits, so its precision proxy is materially lower.

**The trace-length confound favours `glm52` in this comparison.** Recall is
monotone in trace length — the scorer matches a finding when *any* step of its
trace lands on a ground-truth line (`eval-howto.md` §3). `glm52` cited **more**
distinct lines (4,577 vs 3,597) across more findings, so it had more shots on
goal and still did not score higher. Its number is flattered by the confound,
not penalised by it.

---

## 2. Per-model detail

### 2.1 `luna` — GPT-5.6 Luna

| | |
|---|---|
| Model id | `gpt-5.6-luna` |
| Run | run 6, 2026-08-01 |
| Tree | `20889d4` (Stage 2) |
| Concurrency | 32 |
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

**Caveats.**
- Cost was originally *published* as $21.84 at a rate that was 5x wrong. $4.37
  is correct and is what the artifact records. Never cite $21.84.
- Recall is monotone in trace length and this run cites 3.6x the lines run 5
  did; a budget-matched null accounts for +16.5 of its +27.8 points over run 5.
  Comparisons against pre-run-6 rows need that null.
- Stage 0 ran at the old hardcoded 5,000-token probe cap. It completed
  un-degraded, so the cap was never binding and the result is unaffected — but
  it is a different Stage 0 configuration from every run after 2026-08-02.

### 2.2 `glm52` — GLM-5.2

| | |
|---|---|
| Model id | `glm-5.2` |
| Run | 2026-08-02 |
| Tree | `aac8c00` |
| Concurrency | 32 — **above the vendor limit, see caveats** |
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

**⚠ Runtime caveat — the one compromised metric.** This run used
`HUNT_CONCURRENCY=32` against GLM-5.2's documented in-flight limit of **10**
(3.2x over; the limit is a per-model cap, separate from RPM/TPM, and appears in
no response header). 108 of 1,082 calls (10%) were throttled with 429s, costing
321s of cumulative backoff. **~18.5 min is not a runtime this model can deliver
within its limits** — at a compliant C=10 the same work projects to roughly
**50 minutes**, from the observed ~58s mean lane. Cite it as "~18.5 min at C=32,
above the vendor limit", or re-measure at C=10.

**Every other metric is unaffected.** A 429 is rejected before generation, so no
throttled call was billed and no lane went unmeasured — 1,082 calls landed,
exactly 2 per lane, 0 lanes missing measurement.

**Other notes.**
- 45% of input was served from Z.ai's prefix cache, worth $3.73 against an
  uncached $20.74. Cost came in 12% under the $19.32 projection because of it.
- `reasoning_effort: high` is set and the endpoint honours the parameter
  (`minimal` drives reasoning tokens to 0), but high is **not** measurably above
  that endpoint's default — baseline 935/924/652 vs high 1042/540/586, fully
  overlapping. Set for consistency across targets, not as a measured uplift.
- The strength profile is lopsided: strong on injection and crypto-auth, weak on
  misconfiguration (23.5%) and access-control (43.8%). That is a playbook-shaped
  gap, not a uniform capability gap.

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

# 4. Line budget, for the trace-length confound (§1)
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

## 4. Failed attempts

Recorded so the cost and cause are on record. **These are not results and must
never be scored, cited or promoted into §1.**

| Date | Model | Reached | Cause | Cost |
|---|---|---|---|---|
| 2026-08-02 | `glm52` | Stage 0 | Stage 0 hardcoded a 5,000-token probe cap; GLM-5.2 needs ~14,100 for the category probe, so the body truncated, JSON parse failed, and the stage refused to continue rather than substitute deterministic analysis. Fixed in `aac8c00`. | a few cents |
| 2026-08-02 | `glm52` | 92/541 lanes (17%) | Container reclaimed mid-run while the session was idle. `setsid nohup` survives session end, not container teardown. Token accounting never flushed, so the exact spend is unrecoverable; ~1M tokens by log estimate. | ~$2–4, unmeasurable |

Both failures shared a shape worth remembering: **each surfaced as "the model
found nothing" rather than as an error.** That is the failure mode this whole
benchmark is most vulnerable to misreading as a capability result.

---

## 5. Pending

| Model | Registry key | State |
|---|---|---|
| Gemini 3.6 Flash | `gemini36flash` | active, not yet run |
| Qwen 3.7 Plus | `qwen37` | on hold — unresolved ~300s non-streaming timeout |
| Claude Sonnet 5 | `sonnet5` | on hold |
| Claude Opus 5 | `opus5` | on hold |
| Gemini 3.1 Pro | `gemini31pro` | on hold |

See `protocols/benchmark-run-plan.md` for preconditions, the mandatory per-model
checks (§3a) and the open issues that qualify any result added here.
