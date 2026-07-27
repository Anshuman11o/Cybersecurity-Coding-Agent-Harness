# Cybersecurity Models — Pricing & Benchmark Research

Research notes compiled 2026-07-27. Collects the token-accounting measurements taken
against this repo's scanner, plus external pricing and cybersecurity-evaluation data for
the candidate models under consideration.

**Scope note:** the scanner measurements (Tables 1–2) are derived from files in this
repository and are reproducible. The pricing and benchmark data (Tables 3–4) come from
external sources as of the date above and will drift — re-verify before making a
model decision on them.

---

## Table 1 — Scanner token consumption (measured)

Total tokens recorded by the scanner's budget-consumption artifacts for the last
checkpointed pipeline run (commit `9d5d631`).

**Important limitation:** the harness records only `usage.total_tokens`. There is no
input/output split anywhere on disk, and no per-run history — each execution overwrites
`output/`, so only the latest run's numbers survive.

| File | Entries | Total tokens |
|---|---|---|
| `tools/scanner/stage2-hunt-lanes/output/budget-consumption.json` | 16 lanes | 243,809 |
| `tools/scanner/stage3-validate/output/budget-consumption.json` | 39 candidates | 171,493 |
| **Combined** | | **415,302** |

Relevant source locations:

- `tools/scanner/stage2-hunt-lanes/src/hunt-executor.ts:261` — `tokensUsed: response.usage?.total_tokens ?? 0`
- `tools/scanner/stage3-validate/src/validator-orchestrator.ts:262` — same
- `tools/scanner/stage2-hunt-lanes/src/types.ts:54` — `BudgetConsumption` carries a single `tokens_used` field

Stage 3 records two candidates with `was_retry: true` (CONS-0008 at 3,549 tokens;
CONS-0035 at 8,367). Those figures are attempt 1 + attempt 2 summed by the budget
tracker, so the retry-only cost is not separable.

---

## Table 2 — Output-token ceiling from the scanner's response templates

Every LLM call in the pipeline is capped by a `max_tokens` argument. Multiplying each
cap by the call count from the last run gives the hard maximum the templates permit.

| Stage | Call site | Cap | Calls | Max output |
|---|---|---:|---:|---:|
| 0 Recon | `llm-probe.ts:64` tool-calling probe | 500 | 1 | 500 |
| 0 Recon | `llm-probe.ts:216` category applicability | 5,000 | 1 | 5,000 |
| 0.5 Lane selector | `lane-selector.ts:751` | 3,000 | 1 | 3,000 |
| 1 Budget governor | deterministic, no LLM | — | 0 | 0 |
| 2 Hunt lanes | `hunt-executor.ts:317` `HUNT_RESPONSE_SCHEMA` | 8,000 | 16 | 128,000 |
| 2 Hunt lanes | `hunt-executor.ts:536` `ORCHESTRATOR_SCHEMA` | 4,000 | 1 | 4,000 |
| 3 Validate | `validator-orchestrator.ts:355` `VALIDATOR_SCHEMA` | 4,000 | 39 | 156,000 |
| 3 Validate | `validator-orchestrator.ts:413` `FORCE_SCHEMA` retry | 4,000 | 2 | 8,000 |
| **Total ceiling** | | | **61 calls** | **~304,500** |

**Actual emitted output ≈ 68K tokens** (~22% of ceiling), estimated from the
model-authored text in the artifacts at ~3.5 chars/token:

- `candidate-findings.json` — 73,714 chars, 41 findings, essentially all generated → ~21K
- `validated-findings.json` — 188,801 chars total, but the model-authored portion is
  `validator_evidence` at 139,561 chars → ~40K (the rest is `trace`/`title` copied
  forward from Stage 2)
- `category-applicability.json` — 17,123 chars → ~5K
- `lane-manifest.json` + tool-calling probe — mostly deterministic → ~2K

Consistency check: 415,302 recorded total minus ~61K output attributable to Stages 2–3
leaves ~354K input, which matches 16 lanes × ~14K plus 41 validator calls × ~3.5K.

---

## Table 3 — Estimated cost at 6,000,000 input + 25,000 output tokens

Pricing as of 2026-07-27. "GPT-5.6" and "Qwen 3.6" are model *families*, not single
models, so each tier is listed separately.

| Model | Input $/MTok | Output $/MTok | Input cost | Output cost | **Total** |
|---|---:|---:|---:|---:|---:|
| Qwen 3.6 Flash | $0.1875 | $1.125 | $1.13 | $0.03 | **$1.15** |
| Qwen 3.6 Plus | $0.325 | $1.95 | $1.95 | $0.05 | **$2.00** |
| GPT-5.6 Luna | $1.00 | $6.00 | $6.00 | $0.15 | **$6.15** |
| Gemini 3.5 Flash | $1.50 | $9.00 | $9.00 | $0.23 | **$9.23** |
| GPT-5.6 Terra | $2.50 | $15.00 | $15.00 | $0.38 | **$15.38** |
| Kimi K3 | $3.00 | $15.00 | $18.00 | $0.38 | **$18.38** |
| Claude Opus 5 | $5.00 | $25.00 | $30.00 | $0.63 | **$30.63** |
| GPT-5.6 Sol | $5.00 | $30.00 | $30.00 | $0.75 | **$30.75** |

**Output is a rounding error at this workload shape.** At a 240:1 input:output ratio,
output tokens are 1–3% of every bill. Input price is essentially the whole cost.

**Caching dominates model choice.** Kimi K3 publishes a 90% cache-hit discount
($0.30/MTok cached) — a well-cached run lands at ~$2.18, competitive with the Qwen tier.
Claude cache reads are ~0.1× input, trending a well-cached Opus 5 run toward ~$3–6
rather than $30. A cheap model with cold caches can cost more than an expensive model
with warm ones.

**Sizing note:** the measured 415K tokens for Stages 2–3 is ~14× below the 6M figure
above. If 6M is a projection for a full-repo multi-stage scan rather than a measurement,
the table scales linearly.

### Supporting estimate — tokens per line of code

Measured against `target-apps/juice-shop` (excluding `node_modules` and `dist`):
59,405 lines / 2,217,933 chars = **37.3 chars per line**. At ~3.3–3.7 chars/token for
TS/JS, that is **~10.7 tokens per line**, or ~634K tokens for the whole app.

So 50,000 lines ≈ **535K tokens** to read every line exactly once. Reaching 6M implies
~120 tokens/line, which is not a tokenization rate but a re-read rate — driven by
multi-stage pipelines re-sending overlapping files, conversation accumulation (every
tool result stays in context and is re-billed on each subsequent turn), and per-call
prompt overhead.

---

## Table 4 — Cost against published cybersecurity evaluations

**There is no single cyber benchmark covering all these models.** The score column is
not apples-to-apples; each vendor reports against a different eval.

| Model | Total (6M in / 25K out) | Cyber benchmark result | Source / benchmark |
|---|---:|---|---|
| Qwen 3.6 Flash | $1.15 | No published cyber eval | — |
| Qwen 3.6 Plus | $2.00 | Absent from CyberBench top-20; "failed dramatically" on threat-hunting evals. Sibling Qwen 3.7 Plus: **37.50%** (rank 19) | CyberBench; Simbian AI report |
| GPT-5.6 Luna | $6.15 | Rated **High capability** (cyber) under OpenAI Preparedness Framework; no per-tier CTF number published | OpenAI GPT-5.6 system card |
| Gemini 3.5 Flash | $9.23 | No score for base model. Separate **Gemini 3.5 Flash Cyber** variant is "competitive with frontier-scale models" on **CyberGym** | DeepMind model card / blog |
| GPT-5.6 Terra | $15.38 | **High capability** (cyber); found vulns and partial exploits, no autonomous end-to-end attack on hardened targets | OpenAI system card |
| Kimi K3 | $18.38 | **79.03%** on CyberBench (rank 5). UK AISI/CAISI: "significantly below the most recent frontier cyber-capable models" | CyberBench; UK AISI/CAISI joint assessment |
| Claude Opus 5 | $30.63 | Compromised enterprise networks in **8 of 10** UK AISI cyber-range tests. Strong on vuln *identification*, notably weaker on *exploitation* | Anthropic Opus 5 system card |
| GPT-5.6 Sol | $30.75 | **96.7%** on OpenAI's internal CTF suite (saturated); **High capability** | OpenAI system card |

### Why this column should not be used as a ranking

- **Different benchmarks measure different things.** GPT-5.6 Sol's 96.7% is on OpenAI's
  own CTF set, which they describe as *saturated* — the benchmark stopped
  discriminating, which is not the same as the model being 96.7% of the way to perfect
  capability. Kimi's 79.03% is third-party CyberBench. Opus 5's 8/10 is a cyber-range
  pass rate. These cannot be placed on one axis.
- **CTF is not this project's task.** Every benchmark here measures *offensive*
  capability — find and exploit a vulnerability, capture a flag. This scanner does
  *defensive static analysis*: read a codebase, identify candidate vulns, validate them,
  suppress false positives. Vuln-identification ability transfers; exploitation ability
  largely does not. That split specifically favors Opus 5, which the system card
  describes as strong at identification and weak at exploitation.
- **Three cells are genuinely empty**, not omitted for brevity: Qwen 3.6 Flash and base
  Gemini 3.5 Flash have no published cyber eval; GPT-5.6 Luna has a category rating but
  no number.

### Relevance to this harness

The scanner currently runs `qwen-plus` (`hunt-executor.ts:317`,
`validator-orchestrator.ts:355`) — the one model family on this list with a *negative*
published cyber result. If Stage 3 is producing false positives or shallow findings,
model capability is a plausible cause worth isolating before tuning prompts.

Suggested cheap experiment: re-run Stage 3 validation only (41 calls, ~170K tokens)
against a stronger model and diff the CONFIRMED/REJECTED verdicts against the answer
key. At Stage 3's volume that is roughly $0.90 on Opus 5 versus ~$0.06 on qwen-plus.
Stage 2 hunting is where the bulk of input tokens land, so validate the hypothesis on
Stage 3 first.

---

## Sourcing caveat

Several primary sources returned HTTP 403 to the fetch tool used during this research
(Anthropic's Opus 5 system card PDF, the UK AISI Kimi K3 page, DeepMind's Gemini Cyber
blog, and two leaderboards). Those rows in Table 4 derive from search-result summaries
rather than direct reading of the documents. Before making a model decision on these
numbers, open the system cards directly — particularly the Anthropic and OpenAI ones,
which are load-bearing for the two most expensive rows.

Claude Opus 5 pricing is taken from the Anthropic model catalog bundled in the
development environment rather than from a web source.

### References

- OpenAI GPT-5.6 deployment safety hub — https://deploymentsafety.openai.com/gpt-5-6-preview/cyber-capability-evaluations-informational
- CSA research note, GPT-5.6 dual-use cybersecurity — https://labs.cloudsecurityalliance.org/research/csa-research-note-frontier-ai-dual-use-cybersecurity-gpt56-2/
- Claude Opus 5 system card — https://www-cdn.anthropic.com/c5fbac3f0b1280a933ebd26d3cb8bb9f5bdeaf48/Claude%20Opus%205%20System%20Card.pdf
- UK AISI / CAISI preliminary assessment of Kimi K3 — https://www.aisi.gov.uk/blog/preliminary-assessment-of-kimi-k3s-cyber-capabilities
- CyberBench leaderboard — https://benchlm.ai/benchmarks/cyber
- Gemini 3.5 Flash Cyber — https://deepmind.google/blog/introducing-gemini-3-5-flash-cyber/
- Cybench — https://cybench.github.io/
- Simbian AI technical report — https://arxiv.org/pdf/2604.19533
- Gemini 3.5 Flash pricing — https://www.aipricing.guru/models/gemini-3-5-flash/
- OpenAI API pricing (July 2026) — https://www.tldl.io/resources/openai-api-pricing
- Kimi K3 pricing — https://kie.ai/blog/kimi-k3-pricing
- Qwen 3.6 Plus / Flash pricing — https://openrouter.ai/qwen/qwen3.6-plus, https://openrouter.ai/qwen/qwen3.6-flash
