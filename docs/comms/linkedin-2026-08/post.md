# LinkedIn post — blind scanner benchmark, August 2026

| File | Use |
|---|---|
| `recall-by-cost.png` | **The figure.** Recall score by total evaluation cost. |
| `recall-by-cost.html` | Source, with tooltips and a table view. Re-render snippet at the bottom. |

## What the two axes mean

**Recall score** is the *localization* row of `docs/benchmarking-results.md` — the
scanner named the vulnerability within ±15 lines of its ground-truth location, over the
97 reachable entries. It is deliberately not the stricter exact-line-plus-correct-OWASP-category
row, which reads 71.1 / 67.0 / 58.8 and is a harder bar than most commercial scanners
report against. Say which one you mean if anyone asks — both are in the record.

| Model | Recall (±15 lines) | Cost | Cost per vulnerability |
|---|---|---|---|
| GPT-5.6 Luna | 88.7% (86/97) | $4.37 | $0.045 |
| GLM-5.2 | 85.6% (83/97) | $6.22 | $0.064 |
| Gemini 3.6 Flash | 75.3% (73/97) | $24.85 | $0.256 |

**Cost** is metered run spend for Luna and Gemini, straight from each run's usage
artifact. **GLM-5.2 is the self-hosted equivalent, not what the run was billed.** The
run was billed $17.01 against Z.ai's API. GLM-5.2 ships MIT-licensed open weights (753B
MoE, 40B active, ~750GB at FP8 → an 8×H200 node), so $6.22 = the run's 9,668,297 tokens
× $0.643/MTok, an 8×H200 vLLM FP8 figure at 73% utilization.

**That $0.643 is a transferred number.** It is measured on a 70B dense model, not a
753B MoE, and it assumes a utilization level this run never actually sustained. It is an
estimate of what self-hosting *would* cost, not a measurement of what anything did cost.
If someone in the comments pushes on it, that is the honest answer — and the two
alternatives are the $17.01 metered figure or ~$14.11 at the cheapest published
third-party rate for the same weights.

Cost per vulnerability is cost ÷ 97. Computed for reference; deliberately not plotted.

---

## Main post

> I built an AI security scanner. Then I spent most of the project making sure it couldn't cheat.
>
> **The problem.** LLMs are genuinely good at finding vulnerabilities in code. They are also
> very good at recognising a benchmark they've already seen. OWASP Juice Shop — the standard
> target for this work — ships its own answer key inside the repository: challenge definitions,
> solution write-ups, test fixtures. Point an agent at it and you cannot tell reasoning from
> recall.
>
> **So I split it.** A script mechanically strips every answer out of the checkout — challenge
> definitions, solutions, fixtures, hint files — into a separate private repository. The scanner
> runs against the stripped copy. The answer key is opened exactly once, by a scoring script,
> after the pipeline has already finished. Neither the scanner nor the coding agent that writes
> the scanner can read it.
>
> That boundary has been breached three times during this project. Each breach invalidated a
> run. Which is exactly why it's the interesting part.
>
> **What's on the other side of it:** a five-stage pipeline — recon, deterministic lane
> selection, budget projection, 541 parallel per-file hunt lanes with a two-turn trace loop,
> validation. The inference model sits behind a registry, so swapping it is one JSON entry.
>
> Then I ran three models through it. Same pipeline, same 541 lanes, same 1,082 model calls,
> same scorer, same 97-entry denominator, all three on high reasoning effort.
>
> **The result I did not expect: cost and accuracy ran in opposite directions.** The cheapest
> configuration found the most. GPT-5.6 Luna reached 88.7% recall for $4.37. Self-hosted
> GLM-5.2 reached 85.6% for an estimated $6.22. Gemini 3.6 Flash, at $24.85 — four to five
> times the price of either — found the least, at 75.3%.
>
> All three consumed 9.4–9.7M tokens doing it. The workload was identical. The price gap is
> pricing, not effort.
>
> Per vulnerability, that is 4.5 cents against 25.6 cents — a 5.7× spread on the bill for a
> 13-point deficit in what you get back.
>
> **What it cost me to learn that:** roughly $36 in inference and several weeks of building
> the measurement rather than the thing being measured. Which turned out to be the real
> lesson. The scanner took days. A number I'd be willing to defend took weeks — the blind
> split, the scoring harness, the denominator argument, and three separate incidents where
> the answer key leaked into somewhere the agent could see it.
>
> If you are building agentic evals: the measurement infrastructure *is* the project.
>
> Happy to talk about any of it — agentic evals, security tooling, or how to design a
> benchmark your own system can't quietly read.
>
> #AppSec #AIEngineering #LLM #SecurityEngineering #Benchmarking

---

## Short variant

> The cheapest model in my security-scanner benchmark was also the most accurate.
>
> $4.37 and 88.7% recall, against $24.85 and 75.3% for the priciest — same pipeline, same
> codebase, 9.4–9.7M tokens either way. The price spread was pricing, not effort. Per
> vulnerability found: 4.5 cents against 25.6.
>
> I built the scanner against OWASP Juice Shop with every answer mechanically stripped into a
> separate private repository, so neither the scanner nor the coding agent writing it could read
> the ground truth. Scoring happens once, afterwards, by a script.
>
> Getting that measurement honest took longer than building the thing being measured. The
> answer key leaked into agent-readable space three separate times before the boundary held.
> If you are building agentic evals, that is the actual project.
>
> #AppSec #AIEngineering #LLM #Benchmarking

---

## Suggested first comment

> Method, for anyone who wants to poke holes in it: 97 reachable ground-truth entries (one
> sits in a denylisted file and is unreachable by construction, so it's excluded rather than
> counted as a miss). Recall here is localization — the finding lands within ±15 lines of the
> ground-truth location. On the stricter exact-line-plus-correct-OWASP-category scoring the
> same runs read 71.1 / 67.0 / 58.8. Same scorer and denominator across all three. GLM-5.2's
> cost is a self-hosted estimate on its open weights, not the $17.01 the API run was actually
> billed. And the honest gap: high recall is the easy half — the best run emitted 553 findings
> to land those 86, and the validation stage that would cut the noise isn't wired into this
> pipeline track yet.

---

## Re-rendering the figure

```bash
node - <<'EOF'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const OUT = 'docs/comms/linkedin-2026-08';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1320, height: 1000 }, deviceScaleFactor: 2,
  colorScheme: 'light' });
await p.goto('file://' + process.cwd() + '/' + OUT + '/recall-by-cost.html', { waitUntil: 'networkidle' });
await p.evaluate(() => document.querySelector('.viz-root').classList.add('capture'));
await (await p.$('#fig')).screenshot({ path: `${OUT}/recall-by-cost.png` });
await b.close();
EOF
```

Export is 2400 px wide (2× device scale), 1.56:1, which LinkedIn renders without cropping.
