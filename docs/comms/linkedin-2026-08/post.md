# LinkedIn post — scanner benchmark, August 2026

| File | Use |
|---|---|
| `recall-by-cost.png` | **The figure.** Recall score by total evaluation cost, four models. |
| `recall-by-cost.html` | Source, with tooltips and a table view. Re-render snippet at the bottom. |

## The table

| Model | Recall (±15 lines) | Cost | Cost per vulnerability | Total tokens |
|---|---|---|---|---|
| GPT-5.6 Luna | 88.7% (86/97) | $4.37 | **$0.045** | 9,618,943 |
| Claude Sonnet 5 | 86.6% (84/97) | $84.04 | **$0.866** | 23,098,383 |
| GLM-5.2 | 85.6% (83/97) | $7.33* | **$0.076** | 9,668,297 |
| Gemini 3.6 Flash | 75.3% (73/97) | $24.85 | **$0.256** | 9,381,580 |

\* Estimated model cost for self hosting at a large organization.

Cost per vulnerability is cost ÷ 97. Carried in the table and the figure's tooltips;
deliberately not plotted.

## What the two axes mean

**Recall score** is the *localization* row of `docs/benchmarking-results.md` — the
scanner named the vulnerability within ±15 lines of its ground-truth location, over the
97 reachable entries. It is deliberately not the stricter exact-line-plus-correct-OWASP-category
row, which reads 71.1 / 66.0 / 67.0 / 58.8 and is a harder bar than most commercial
scanners report against. Say which one you mean if anyone asks — both are in the record.

**Cost** is metered run spend for Luna and Gemini, straight from each run's usage
artifact. Two rows carry qualifications:

- **GLM-5.2's $7.33 is a self-hosting estimate, not what the run was billed.** The run was
  billed **$17.01** against Z.ai's API. GLM-5.2 ships MIT-licensed open weights (753B MoE,
  40B active, ~750GB at FP8 → an 8×H200 node), so a large organization running it on its
  own hardware pays compute rather than API margin. The $7.33 figure is supplied, not
  derived here; the figure marks it with an asterisk and names the basis. For reference,
  two other defensible numbers for the same run are **$17.01** metered and **~$14.11** at
  the cheapest published third-party rate for the same weights.

- **Claude Sonnet 5 ran over the Claude Code CLI transport, not a direct API client**,
  at concurrency 6 across four usage windows. See the open question below before citing
  its $84.04.

The cost axis is **log scale**, and the label says so. The four runs span $4.37 to $84.04;
on a linear axis the two cheapest marks overlap.

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

The figure plots $84.04, the recorded value, because that is the citable number in the
permanent record. If the CLI's own accounting is right, Sonnet 5 sits near $144 and its
cost per vulnerability is $1.49 rather than $0.866. The post's "cost 19 times more"
becomes "33 times more". Worth resolving before this goes out.

Also in the record and worth knowing: of Sonnet 5's 1,322 lane calls, **229 terminated on
`stop_sequence` rather than `tool_use`** and are recorded as refusals. A safety classifier
declining a share of a defensive security-scanning workload is a genuinely interesting
result, and it is in no headline here.

---

## The post

1,504 characters. Attach `recall-by-cost.png` after the line ending "cybersecurity scanning:".

> The cheapest and most thorough model for detecting security vulnerabilities in code is
> GPT-5.6 Luna. With a total run cost of $4.37 and recall of 88.7%, it costs 4.5 cents per
> vulnerability.
>
> I built a five stage AI agent harness that scans a codebase for OWASP-categorised
> vulnerabilities. Subagents recon the code and map where vulnerabilities likely sit, then
> each suspect file gets its own subagent to pin down the exact line and type. The output
> is a report with run cost and time taken.
>
> Why this is important: last month OpenAI reported two of its models broke out of a test
> sandbox, unprompted, and reached Hugging Face's production systems to steal benchmark
> answers. Attackers move at agent speed. Defenders still read code at human speed.
>
> I ran four models through the harness to benchmark them at cybersecurity scanning:
>
> Luna won outright. It was the cheapest and had the highest recall. Claude Sonnet 5 came
> second at 86.6% and cost 19 times more. Gemini 3.6 Flash cost $24.85 and finished last
> at 75.3%.
>
> I made multiple rounds of architecture changes to improve recall from 38% to 88% from
> first to last run. The harness was improved through continuous testing and evaluation,
> with subagents on persistent custom loops that found gaps and proposed fixes.
>
> For finding vulnerabilities in code, Luna is clearly the best value today.
>
> Source: openai.com/index/hugging-face-model-evaluation-security-incident/
>
> #AppSec #CyberSecurity #AIAgentHarness #Benchmark #Claude #ChatGPT #Gemini #GLM

House style for this post: no em dashes, no semicolons.

## Suggested first comment

The post never defines recall, which is the first thing a sceptical reader will ask about.
Post this within a minute of publishing.

> Method, for anyone who wants to poke holes in it: 97 reachable ground-truth entries (one
> sits in a denylisted file and is unreachable by construction, so it's excluded rather than
> counted as a miss). Recall here is localization, meaning the finding lands within ±15
> lines of the ground-truth location. On the stricter exact-line-plus-correct-OWASP-category
> scoring the same four runs read 71.1 / 66.0 / 67.0 / 58.8. Same scorer and denominator
> across all four. GLM-5.2's cost is a self-hosting estimate on its open weights, not the
> $17.01 the API run was billed. Sonnet 5 ran over a CLI transport rather than a direct API
> client. And the honest gap: high recall is the easy half. The best run emitted 553
> findings to land those 86, and the validation stage that would cut the noise isn't wired
> into this pipeline track yet.

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

Export is 2400 px wide (2× device scale), 1.51:1, which LinkedIn renders without cropping.
