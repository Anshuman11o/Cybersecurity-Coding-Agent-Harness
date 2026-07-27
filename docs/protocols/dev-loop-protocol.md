# Dev↔Eval Iteration Loop Protocol

*Reusable across every component of the harness — scanner first, then patcher/fixer, verifier, and
end-to-end integration. Defines how much data a dev-time eval runs against, the two distinct kinds
of "limit" in this system, and the concrete build→eval→iterate-or-stop loop every component's
development follows. Paired with `docs/protocols/eval-framework.md`, which defines what gets measured; this
document defines how much data it's measured against and when to stop iterating.*

## Why this exists

Measuring a component (per `docs/protocols/eval-framework.md`) costs real tokens and wall-clock time. If
every single dev iteration re-runs a full eval against the whole available dataset, iteration
itself becomes the bottleneck — the same failure mode this project's own five-tool benchmark saw at
the tool level (VVAH's exhaustive pipeline, VulnHunter's spend cap, both documented in
`results/archive/2026-07-five-tool-benchmark/summary.md`). This protocol sizes a dataset subset cheap enough to run
after every meaningful change, reserving the full set for milestone confidence checks, and defines
the loop itself: a fixed contract (target metric + iteration cap, set before work starts) so a
dev-loop session knows exactly when it may declare success and when it must stop and hand control
back — rather than quitting too early or burning budget indefinitely chasing a number.

## The dataset universe

`target-apps/juice-shop/data/static/challenges.yml` has **113 total challenges across 16 native
categories** (Sensitive Data Exposure 16, Injection 14, Improper Input Validation 12, Broken Access
Control 12, XSS 9, Broken Authentication 9, Vulnerable Components 8, Miscellaneous 6, Cryptographic
Issues 5, Security Misconfiguration 4, Observability Failures 4, Broken Anti Automation 4, Security
through Obscurity 3, Insecure Deserialization 3, XXE 2, Unvalidated Redirects 2).

Only 10 of these 113 are elevated to the rich `benchmark_ground_truth` schema (file/line, solve
condition, reference fix, exploit test) that scoring needs, deliberately chosen to hit **10
distinct categories, one instance each**. That's already a minimal spanning set for category
breadth. What it structurally can't do is measure class **coverage** (did a fix address every
instance of a pattern, not just the one flagged?) — that needs at least two instances of the same
category, and the current 10 has exactly one accidental pair: two entries that share the SQL Injection class (identifiers and locations withheld — see the private eval archive). Keep this
pair together in any subset rather than splitting them across tiers.

**Category labels were a leak, now fixed, independent of dataset sizing.**
`challenges.yml`'s `category` field (e.g. `category: XSS`) was a direct in-code giveaway — used
only by the frontend scoreboard's cosmetic filter, but readable by any scanner as a shortcut.
`target-apps/juice-shop-blind/` exists for exactly this reason: a full, file-for-file copy of the
working copy with that field neutralized (`Unspecified`) across all 113 entries — same app, same
complexity, no shrinking, just no label to read off. A matching `ground-truth-subset.json` (the
same 10 entries, no `category` field) lives in the private answer-key repo. **Every tier below
targets `juice-shop-blind/`, not the original `juice-shop/`.**

## Why shrinking the app itself is the wrong lever

Scanning a smaller hand-picked slice of the app instead of the whole working copy is rejected.
Recon's entire job is mapping a full, unfamiliar attack surface; a pre-picked slice doesn't make
that faster in a meaningful way, it makes it untested. The scanner's own cost design (deterministic
AST-first recon, narrowly-seeded hunting lanes, budgeted per-lane not per-repo) already keeps a
full-app scan cheap — the dominant cost driver is **lane count** (roughly one per present category,
~9 for this app), not raw file count. Shrinking the app wouldn't meaningfully cut cost and would
break what's actually being validated. The real levers are dataset *list* size (for components
whose cost scales per ground-truth item) and caching (below).

## Dataset tiers

| Tier | Contents | Used by | When |
|---|---|---|---|
| **Fast** | 5 items (exact set to be finalized when patcher/verifier development starts — parked for now, see Resolved Decisions): the SQLi class-coverage pair, one semantic/IDOR item with no pattern to match, one LLM-specific remediation item, and one frontend fix-path item (identifiers withheld — see the private eval archive) | Patcher, Verifier | Every dev iteration |
| **Standard** | All 10 `benchmark_ground_truth` items, full `juice-shop-blind` app | Scanner | Every dev iteration (see caching note — this doesn't mean every *stage* re-runs) |
| **Milestone** | Same 10 items, full app, all components run together | All components; end-to-end | Before declaring any single component "done"; always, for end-to-end integration runs |

**Why the scanner has no Fast tier:** its cost is dominated by lane count and recon, not by how many
ground-truth items it's scored against afterward (scoring itself is free, non-LLM Python over
`score.py`). Running against 5 items instead of 10 wouldn't make a scanner run cheaper, only less
informative. **Why the patcher/verifier get one:** their cost genuinely scales per item — each
ground-truth entry needs its own fix-write, test-write/run, and verify cycle — so 5 items instead of
10 is a real ~2x cost/time cut per iteration, and the chosen five exercise every architecturally
distinct fix path (pure pattern-based backend fix, semantic-reasoning-only fix, LLM-specific fix,
frontend/Angular fix) plus the one real class-coverage pair available without inventing new ground
truth.

**Caching, so "every iteration" isn't a full re-run every time:** recon and lane-selection output
(the route table, category-applicability table, lane manifest) doesn't change unless the target app
itself changes — cache it after the first run in a dev cycle and reuse it across iterations. If an
iteration only modifies one lane's playbook, only that lane plus validation/output need to re-run —
not the other ~8 lanes or recon. The full multi-lane pipeline only runs end-to-end for the Milestone
confirmatory pass.

**Future expansion (not needed now):** the other 103 native challenges already carry a category tag
even in the stripped working copy and could seed a larger tier later, specifically picking multiple
instances within Injection (14 available), Broken Access Control (12), or XSS (9) for real
statistical signal on class-coverage beyond the one SQLi pair. Not required to start.

## Expected usage per tier (planning estimate — no instrumented baseline exists yet; replace with
real telemetry from each component's first real run)

| Run | Rough tokens | Rough wall-clock | Rough cost |
|---|---|---|---|
| Scanner, Standard tier, full multi-lane run (recon + ~9 lanes + validation) | ~180k–250k | 5–15 min (lanes parallel) | low single-digit $ |
| Scanner, single-lane re-run (cached recon) | ~10k–25k | 1–3 min | well under $1 |
| Patcher or Verifier, Fast tier (5 items, sequential — each needs the app running) | ~80k–160k | 10–20 min | ~$1 |
| Patcher or Verifier, Milestone tier (10 items) | ~160k–320k | 20–40 min | ~$2 |
| End-to-end, Milestone tier, full pipeline | sum of the above | up to ~1 hr | a few $ |

## Two distinct control layers — do not conflate these

| | **Layer 1 — Dev-Improvement Loop** | **Layer 2 — Per-Job Runtime Governor** |
|---|---|---|
| Question it answers | "Is this component's architecture good enough yet?" | "Is this one run, right now, staying within a sane budget?" |
| Governs | Iterating on the component's *design* (prompts, playbooks, lane structure) | Executing the component's *already-frozen* design, once, for a real job |
| Lives in | This document's Directive block (max iterations, target metrics, early-stop/regression rules) | Inside the component itself (for the scanner: its Budget Governor stage, plus lane-selection/hunting runtime checks) |
| Lifespan | Temporary — active only while a component is being actively tuned | Permanent — runs on every invocation, forever, dev or production |
| Ends when | The human reviews the metrics and says "this architecture is good enough" | Never — it's not a phase, it's a standing part of the architecture |
| At its limit | Stop iterating, report progress + trace, ask the human what to do next | Stop the *current job* cleanly, alert, report what was completed vs. cut short — the architecture itself doesn't change |

Once a human signs off that a component's architecture is good enough, **Layer 1 stops being
invoked for that component entirely** — no more proactive self-improvement attempts. From that point
the component simply runs, unchanged, against whatever job it's given. But every one of those runs
still needs its own budget discipline — a real job against an unknown-size codebase could be much
bigger than the Juice Shop benchmark — which is Layer 2's job, permanently, not something that winds
down once development ends. **Layer 2 must alert and stop a run cleanly whenever it hits its
turn/token/time ceiling, regardless of dataset size** — a 10-item benchmark and a real production
codebase get the same discipline.

## The Directive: how a dev-loop round is framed

Every component-build session opens with a fixed directive instead of an open-ended "make it
better" instruction:

```
DEV-EVAL LOOP DIRECTIVE — <component>, <what's being changed this round>
Dataset tier: <Fast | Standard | Milestone>
Target (must ALL hold to succeed): <gating metrics + thresholds, from eval-framework.md>
Monitor only (report, don't gate on): <secondary metrics>
Max iterations: 3
Per-iteration runtime ceiling: inherited from the component's own Layer 2 governor —
  this directive does not set a separate number
Early-stop rule: if an iteration's gain on the primary gating metric vs. the previous
  iteration is <3 points AND it's still below target, stop early
Regression rule: if any iteration scores WORSE than the pre-loop baseline on a gating
  metric, stop immediately regardless of iterations remaining, flag it
On success: run one confirmatory Milestone-tier pass; if it holds, report full
  metrics + iteration history and stop
On exhaustion (cap hit, early-stop triggered, or a Layer 2 ceiling hit without
  reaching target): stop, report the best iteration's metrics and full trace, ask
  the human how to proceed — never continue past either cap, never report success
  that wasn't reached
```

**Worked example — scanner's first build:**

```
DEV-EVAL LOOP DIRECTIVE — Scanner, initial v1 build
Dataset tier: Standard (10-item benchmark_ground_truth, full juice-shop-blind app)
Target (must both hold): precision >= 95%, recall >= 90%
Monitor only: localization >= 90%, F1, cost, wall-clock time
Max iterations: 3
Early-stop rule: <3-point gain on recall between iterations while still below target -> stop early
Regression rule: any iteration below the first baseline run on precision or recall -> stop
On success: run Milestone pass (same 10 items) -> report -> stop
On exhaustion: report best iteration, full trace, ask human whether to keep iterating,
  accept current state, or revisit the architecture
```

**What "one iteration" means:** one coherent, plausibly metric-moving architecture or prompt change
(e.g. "rewrite the Access-Control lane's playbook") — not a re-run after every line edit. Eval runs
cost real money; batch a change into something worth spending one on before triggering the loop
again.

## Resolved decisions

- **`max_iterations = 3`, set directly.** Enough attempts to fix an obvious prompt/scoping bug or
  tune a playbook; a component stuck after 3 focused tries is very likely an architectural problem
  needing human judgment, not something a 4th attempt fixes.
- **Early-stop threshold (`<3-point gain`) confirmed as-is.** The point is specifically to stop the
  loop from burning iterations chasing marginal, noisy improvements.
- **The Fast tier's exact 5-item selection is parked, not decided now.** This tier belongs to the
  patcher/verifier; current focus is scanner-only. Revisit when patcher/verifier development
  actually starts.
- **What a failed Milestone-tier confirmation means for an already-approved component:** an
  already-approved, already-finalized component is **presumed correct** when a later full-pipeline
  run turns up a problem — the default assumption is that the issue lives in a newer or
  not-yet-approved part of the pipeline. Re-opening an approved component's architecture requires a
  genuinely large, clearly-implicating issue, not just "the full run had problems" — otherwise every
  full-pipeline hiccup would put every finished component back in question, defeating the point of
  approving one in the first place.

## How this integrates with each component's build plan

Each component's stage-by-stage build plan gets an explicit Layer 1 Directive wrapped around each
major milestone (e.g. "hunt lanes: build all lanes → Directive: Standard tier, target from
`eval-framework.md`'s scanner row, max 3 iterations → report"). The component's own Budget-Governor
stage is Layer 2 — the part of the architecture that enforces alerting/stoppage on every real run,
independent of the dev-loop entirely. The same Directive template, with its dataset tier and target
metrics swapped for the relevant component's row, is the standard opening move for the
patcher/verifier builds when their turn comes.
