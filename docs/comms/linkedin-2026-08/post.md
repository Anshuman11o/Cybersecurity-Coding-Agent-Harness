# LinkedIn post — blind scanner benchmark, August 2026

Assets in this directory:

| File | Use |
|---|---|
| `fig1.png` | **Lead image.** Recall by cost. This is the post's one insight. |
| `fig2.png` | Recall by vulnerability class — the "every model fails the same way" slide. |
| `fig3.png` | Findings emitted vs. matched — the honest limitation. |
| `figures.html` | Source for all three, with tooltips and table views. Re-render with the snippet at the bottom. |

Every number traces to `docs/benchmarking-results.md`. Nothing here pairs a challenge
identifier with a file, a line, or a found/not-found status — aggregates and per-class
recall only, per `CLAUDE.md`.

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
> same scorer, same 97-entry denominator. Three results I did not expect:
>
> **1 — Cost and accuracy were inversely correlated.** The cheapest run ($4.37) had the highest
> recall at 71.1%. The most expensive ($24.85) had the lowest at 58.8%. All three burned
> 9.4–9.7M tokens, so the 5.7× price spread is pricing, not effort. The expensive model wasn't
> thinking harder. It was just expensive.
>
> **2 — The failure profile barely moves between models.** Crypto and injection are near-solved
> across the board (80–94%). Misconfiguration, broken access control, and anything that needs
> the agent to read intent across several files sit at 18–59% — for every model. Swapping models
> buys a few points. It does not change the shape of the failure. That reframes the remaining
> gap as an architecture problem rather than a model-selection problem, which is a much more
> useful thing to know.
>
> **3 — Recall turned out to be the easy half.** Every run reaches the correct file for
> essentially every ground-truth entry (100%, 100%, 99%). But the best run emitted 553 findings
> to land 69 of them. Getting an agent to find the bug is close to solved. Getting it to stop
> crying wolf is the actual product, and mine isn't there yet.
>
> The lesson I'd hand to anyone building agentic evals: the measurement infrastructure *is* the
> project. The scanner took days. A number I'd be willing to defend took weeks.
>
> Happy to talk about any of it — agentic evals, security tooling, or how to design a benchmark
> your own system can't quietly read.
>
> #AppSec #AIEngineering #LLM #SecurityEngineering #Benchmarking

**Attach:** `fig1.png`, `fig2.png`, `fig3.png`, in that order.

---

## Short variant

If you want a version that fits above LinkedIn's "…see more" fold with room to spare:

> The cheapest model in my security-scanner benchmark was also the most accurate. $4.37 and
> 71.1% recall, against $24.85 and 58.8% for the priciest — on the same pipeline, the same
> codebase, and 9.4–9.7M tokens either way. The price spread was pricing, not effort.
>
> I built the scanner against OWASP Juice Shop with every answer mechanically stripped into a
> separate private repository, so neither the scanner nor the coding agent writing it could read
> the ground truth. Scoring happens once, afterwards, by a script.
>
> Two things fell out of it that I didn't expect:
>
> Every model fails on the same classes. Crypto and injection are near-solved at 80–94%.
> Misconfiguration and access control sit at 18–59% for all three. Changing models moves the
> numbers a few points and never changes the shape — so the remaining gap is architecture, not
> model choice.
>
> And recall is the easy half. The best run reached the right file for essentially every
> ground-truth entry, then emitted 553 findings to land 69. Finding the bug is close to solved.
> Not crying wolf is the product.
>
> #AppSec #AIEngineering #LLM #Benchmarking

---

## Suggested first comment

Posting the method detail as the first comment keeps the post itself readable and gives the
algorithm a second surface:

> Method, for anyone who wants to poke holes in it: 97 reachable ground-truth entries (one sits
> in a denylisted file and is unreachable by construction, so it's excluded rather than counted
> as a miss). An entry only counts as found if the scanner names the correct file, the exact
> line, and the correct OWASP category — file-level-only recall would have read 100%, 100% and
> 99% and told you nothing. Same scorer and denominator for all three runs. Wall-clock isn't
> comparable across the three: one model was rate-limited to concurrency 8 against 32 for the
> others, so I've reported cost rather than time.

---

## Re-rendering the figures

```bash
node - <<'EOF'
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const OUT = 'docs/comms/linkedin-2026-08';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1320, height: 1200 }, deviceScaleFactor: 2,
  colorScheme: 'light' });
await p.goto('file://' + process.cwd() + '/' + OUT + '/figures.html', { waitUntil: 'networkidle' });
await p.evaluate(() => document.querySelector('.viz-root').classList.add('capture'));
for (const id of ['fig1', 'fig2', 'fig3'])
  await (await p.$('#' + id)).screenshot({ path: `${OUT}/${id}.png` });
await b.close();
EOF
```

Exports are 2400 px wide (2× device scale), ~1.2:1, which LinkedIn renders without cropping.
