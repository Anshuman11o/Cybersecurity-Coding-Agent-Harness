# LinkedIn post — blind scanner benchmark, August 2026

| File | Use |
|---|---|
| `recall-by-cost.png` | **The figure.** Recall score by total evaluation cost, four models. |
| `recall-by-cost.html` | Source, with tooltips and a table view. Re-render snippet at the bottom. |

## The table

| Model | Recall (±15 lines) | Cost | Cost per vulnerability | Total tokens |
|---|---|---|---|---|
| GPT-5.6 Luna | 88.7% (86/97) | $4.37 | **$0.045** | 9,618,943 |
| Claude Sonnet 5 | 86.6% (84/97) | $84.04 | **$0.866** | 23,098,383 |
| GLM-5.2 | 85.6% (83/97) | $6.22 | **$0.064** | 9,668,297 |
| Gemini 3.6 Flash | 75.3% (73/97) | $24.85 | **$0.256** | 9,381,580 |

Cost per vulnerability is cost ÷ 97. Computed for the table; deliberately not plotted.

## What the two axes mean

**Recall score** is the *localization* row of `docs/benchmarking-results.md` — the
scanner named the vulnerability within ±15 lines of its ground-truth location, over the
97 reachable entries. It is deliberately not the stricter exact-line-plus-correct-OWASP-category
row, which reads 71.1 / 66.0 / 67.0 / 58.8 and is a harder bar than most commercial
scanners report against. Say which one you mean if anyone asks — both are in the record.

**Cost** is metered run spend for Luna and Gemini, straight from each run's usage
artifact. Two rows carry qualifications:

- **GLM-5.2's $6.22 is a self-hosted equivalent, not what the run was billed.** The run
  was billed $17.01 against Z.ai's API. GLM-5.2 ships MIT-licensed open weights (753B
  MoE, 40B active, ~750GB at FP8 → an 8×H200 node), so $6.22 = the run's 9,668,297
  tokens × $0.643/MTok, an 8×H200 vLLM FP8 figure at 73% utilization. That rate is
  transferred from a 70B dense model and assumes a utilization this run never sustained.
  It estimates what self-hosting *would* cost. Alternatives if challenged: $17.01 metered,
  or ~$14.11 at the cheapest published third-party rate for the same weights.

- **Claude Sonnet 5 ran over the Claude Code CLI transport, not a direct API client**,
  at concurrency 6 across four usage windows. See the open question below before citing
  its $84.04.

The x axis is **log scale**, and the label says so. The four runs span $4.37 to $84.04;
on a linear axis Luna and GLM-5.2 land 19px apart and their marks overlap.

## Open question on the Sonnet 5 cost — read before posting

The token counts in the record reconcile exactly against the run's own
`cli-usage.jsonl`: 17,528,930 input (8,552,056 cache-read, 8,974,346 cache-write,
2,528 uncached) and 5,569,453 output, 23,098,383 total. Those are solid.

**The $84.04 does not reconcile.** Three different figures are derivable from the same
artifact:

| Basis | Figure |
|---|---|
| Recorded in `benchmarking-results.md` | **$84.04** |
| Registry rates ($2 / $0.20 cached / $2.50 cache-write / $10 out) applied to the artifact's token split | $79.85 |
| The CLI's own per-call `costUSD` fields, summed, Sonnet 5 component only | $139.96 |

Separately, the recorded row counts **only the Sonnet 5 component**. The CLI transport
also spent 4,143,486 input and 9,435 output tokens on `claude-haiku-4-5` — $4.19 by the
CLI's own accounting — which is real spend on this run and is not in the row. Including
it, the CLI's total for the run is $144.15.

The figure currently plots $84.04, the recorded value, because that is the citable
number in the permanent record. If the CLI's own accounting is right, Sonnet 5's true
position is roughly $144 and its cost per vulnerability is $1.49 rather than $0.866 —
which strengthens rather than weakens the post's argument, but changes the number.
Worth resolving before this goes out.

Also in the record and worth knowing: of Sonnet 5's 1,322 lane calls, **229 terminated on
`stop_sequence` rather than `tool_use`** and are recorded as refusals. A safety classifier
declining a share of a defensive security-scanning workload is a genuinely interesting
result, and it is not in any headline here.

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
> Then I ran four models through it. Same pipeline, same 541 lanes, same scorer, same 97-entry
> denominator, all four on high reasoning effort.
>
> **The result I did not expect: paying more bought less.** GPT-5.6 Luna found the most —
> 88.7% — for $4.37. Claude Sonnet 5 came second at 86.6%, and cost $84.04 to get there.
> Nineteen times the money for two points less. Self-hosted GLM-5.2 landed third at 85.6% for
> an estimated $6.22. Gemini 3.6 Flash cost $24.85 and finished last at 75.3%.
>
> Per vulnerability found, that is **4.5 cents against 86.6 cents** for the same job on the
> same code.
>
> Three of the four did genuinely identical work — 9.4 to 9.7M tokens each — so between them
> the entire price spread is pricing, not effort. Sonnet was the exception: it spent 23M tokens
> and emitted 1,270 findings against Luna's 553, and still didn't out-find it. More looking is
> not more finding.
>
> **What it cost me to learn that:** about $130 in inference, and several weeks building the
> measurement rather than the thing being measured. That was the real lesson. The scanner took
> days. A number I'd be willing to defend took weeks — the blind split, the scoring harness,
> the denominator argument, and three separate incidents where the answer key leaked into
> somewhere the agent could see it.
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
> $4.37 and 88.7% recall. The runner-up scored 86.6% and cost $84.04 — nineteen times the
> money for two points less. Per vulnerability found: 4.5 cents against 86.6 cents.
>
> I built the scanner against OWASP Juice Shop with every answer mechanically stripped into a
> separate private repository, so neither the scanner nor the coding agent writing it could read
> the ground truth. Scoring happens once, afterwards, by a script.
>
> Three of the four models consumed near-identical tokens, so between them the price spread is
> pricing, not effort. The expensive one spent 23M tokens and emitted more than twice as many
> findings as the winner — and still found less. More looking is not more finding.
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
> same four runs read 71.1 / 66.0 / 67.0 / 58.8. Same scorer and denominator across all four.
> GLM-5.2's cost is a self-hosted estimate on its open weights, not the $17.01 the API run was
> billed. Sonnet 5 ran over a CLI transport rather than a direct API client. And the honest
> gap: high recall is the easy half — the best run emitted 553 findings to land those 86, and
> the validation stage that would cut the noise isn't wired into this pipeline track yet.

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
