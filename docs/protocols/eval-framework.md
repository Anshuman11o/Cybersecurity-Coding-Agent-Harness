# Evaluation Framework

*Reusable across every component of the harness — scanner first, then patcher/fixer, verifier, and
end-to-end integration. Defines what gets measured every time a component is built or changed, so
"did this actually improve things" has a concrete, repeatable answer instead of a vibe. Referenced
from the scanner implementation plan; written generically so it applies unchanged when later
components are built. Paired with `docs/protocols/dev-loop-protocol.md`, which defines how much data an eval
runs against and the build→eval→iterate loop that uses these metrics.*

## Why this exists

The harness is being built iteratively: scanner first, then patcher/fixer, then verifier, each
layered on the last. Building this way without a measurement discipline risks a component looking
more sophisticated (more stages, fancier prompting, a bigger model) while quietly regressing on the
thing that matters (fewer real vulnerabilities found, more false positives, slower, more
expensive). Every time a component is built or changed, it gets scored against two references — the
ground truth (is it right?) and the previous best-known run of that same component (is it an
improvement or a regression?) — before a decision is made to keep chasing an architecture change or
call it good enough.

This reuses infrastructure already in this repo: `tools/scan-benchmark/score.py` already implements
ground-truth matching (`file_match`, `LINE_SLACK`-based localization) and a markdown report
renderer for the scanner; that engine is the right foundation to generalize rather than rebuild for
the patcher/verifier/end-to-end stages.

## Design principle: a small, fixed core + a few stage-specific additions

Every eval report, regardless of which component ran, reports the same core columns (identity,
cost, time, pass/fail against target, delta vs. baseline) plus 3–5 columns specific to what that
component is actually supposed to get right. Not every metric belongs at every stage — e.g.
"localization accuracy" is meaningless for a patcher (there's no "line" to localize, there's a
diff), and "false-confidence rate" is meaningless for a scanner (that's a verifier-specific failure
mode). Resist adding a metric unless it would change a real decision.

## Universal core columns (every eval report, every component)

| Column | What it captures | Why it's mandatory |
|---|---|---|
| `run_id` / timestamp | Unique identifier for this eval run | Needed to log history and diff against later |
| `component` + `version` | e.g. `scanner@a1b2c3d` (git SHA) or a semantic tag | Ties a score to an exact, reproducible artifact |
| `ground_truth_set` | Name + version of the target/answer set used (e.g. `juice-shop-benchmark-v1, 10 challenges`) | Scores are meaningless without knowing what they were measured against |
| `model(s)_used` | Model tier per sub-stage/lane if more than one | Cost and quality both hinge on this |
| `tokens` (input/output/cached) | Raw usage, broken down by lane/model if applicable | The primitive "usage" measure; survives model price changes |
| `est_cost_usd` | Tokens × current pricing | Derived, not primitive, since pricing changes over time |
| `wall_clock_time` | Total run time; also report parallel-lane time vs. total compute-time if lanes ran concurrently | Latency and total cost diverge under parallelism — both matter, for different reasons |
| primary correctness metric(s) | Defined per component below | The actual "is it right" signal |
| `delta_vs_baseline` | Per-metric change vs. the last recorded run (or best-known run) of the same component | The "did it improve" signal |
| `pass/fail vs. target` | Explicit gate against the pre-agreed target range (below) | Turns numbers into a decision, not just data |

## Scanner metrics

| Metric | Definition | Applies to |
|---|---|---|
| Precision | in-scope true findings / in-scope findings reported | Overall + per-lane |
| Recall | ground-truth items found / total ground-truth items | Overall + per-lane |
| F1 | harmonic mean of precision/recall | Overall — single scalar for fast comparison across runs |
| Localization accuracy | matched findings within line-slack / file-matched findings | Overall + per-lane |
| False positives (in-scope) | in-scope findings that are wrong | Overall — precision's raw numerator gap |
| Out-of-scope findings (informational) | real findings outside the fixed ground-truth set | Tracked, not scored — signals whether the scanner finds real bugs beyond the fixed benchmark |

### Class-model metrics (mandatory for the scanner from 2026-07-27)

Findings name a *vulnerability class* and carry that class's OWASP alias codes, and may name up to
two classes (`docs/architecture/vulnerability-class-model.md`). Three metrics exist because that
change makes a bare recall number uninterpretable on its own.

| Metric | Definition | Why it is mandatory, not diagnostic |
|---|---|---|
| **Hedging rate** | mean vulnerability classes emitted per finding | Emitting more labels matches more ground truth partly by widening the net. Before the class model this was exactly `1.000`. A recall gain with a flat hedging rate is detection; a recall gain that tracks it is a wider net. Reporting recall without it overstates the result. |
| **Per-class recall** | recall broken down by vulnerability class | A single scanner-wide number says something regressed; this says *which playbook*. An entry spanning two classes counts toward both — either playbook finding it is that playbook's success. |
| **Precision proxy, category-aware** | findings landing within line-slack of a ground-truth entry **and** agreeing on category / all findings | The category-blind proxy cannot see hedging at all. Reported alongside it, not instead of it. |

**Comparability across the class-model boundary.** A run predating the class model emitted one code
per finding and cannot be compared directly against one that postdates it — the newer run wins
partly by labelling consistently rather than by finding more. `score_scanner.py --alias-expand`
re-scores both sides under the same alias semantics, which splits the delta into *found more* vs.
*labelled better*. Any comparison spanning that boundary reports both numbers or it is not a
comparison.

**Guard.** `categories` holds OWASP code strings, never class ids. If that ever inverts, every
intersection empties and the run reports a collapse indistinguishable from a reasoning regression.
The scorer refuses to run when fewer than 95% of findings yield a code, rather than reporting a
plausible-looking zero.

Two **optional, diagnostic-only** sub-metrics, useful while developing recon/lane-selection/
validation specifically but not part of the mandatory top-line report:
- **Category-applicability accuracy** — did recon's present/absent/uncertain call match the
  categories actually exercised in the ground truth? Isolates whether lane selection or hunting is
  the source of a recall miss.
- **Validator precision/recall** — of the hunting lanes' raw candidates, how many did validation
  correctly keep vs. correctly kill? Isolates whether a false positive/negative originated in the
  hunter or the validator.

**Reference ranges** (from the five-tool scan-only benchmark already run in this repo,
`results/archive/2026-07-five-tool-benchmark/summary.md`):

| | Precision | Recall | Localization |
|---|---|---|---|
| Observed ceiling (security-audit-skill) | 100% | 100% | 100% |
| Observed strong-real-world (deepsec) | 100% | 90% | 100% |
| Observed floor for pattern-matching-only (raptor) | 100% | 20% | 50% |
| **Operative target for this harness's scanner** | ≥ 95% | ≥ 90% | ≥ 90% |

**Caveat that must travel with these numbers wherever they're cited:** n=10 ground-truth challenges
on one app. A single miss swings recall by 10 points, and all four completing tools hit 100%
precision partly because the fixed set is small enough that no tool happened to misfire on it — not
strong evidence precision is trivially easy at scale. Treat these numbers as directional anchors for
early relative comparisons ("did change X move recall up or down"), not statistically solid absolute
claims. **Decision:** keep the 10-item set for now, relative comparisons only; grow it later
(more challenges, more categories, ideally more than one target app) once absolute claims actually
matter — not a blocker to starting. **Decision:** the ≥95/≥90/≥90 row is the operative floor to
build against; the 100/100/100 ceiling is a reference point, not a claim that hitting it means done
— it may itself be an artifact of a small, possibly contamination-prone benchmark (see the scanner
plan's self-critique on Juice Shop familiarity).

**No existing cost/time baseline** — the five benchmarked tools were external CLIs, not
instrumented for token/cost accounting in a comparable way. This harness's own components must be
instrumented for tokens/cost/time from their very first version, and that first real run becomes
the self-established baseline future changes are diffed against. **Decision:** cost stays
informational-only (not a hard eval-failing ceiling) until the end-to-end pipeline exists and total
pipeline cost is a real number worth gating on; promote it to a hard ceiling at that point.

## Patcher/Fixer metrics

| Metric | Definition |
|---|---|
| Exploit-closure rate | % of targeted findings whose `exploitTest` fails (is blocked) after the fix |
| Class-coverage rate | % of *all* instances of the vulnerability pattern actually fixed, not just the one flagged instance — the direct measure of the project's stated "fix an entire class at once" goal |
| Functional-regression rate | % of pre-existing functional/unit/e2e tests that newly fail after the fix (lower is better — target ≈0%) |
| Fix invasiveness | lines/files touched relative to the minimum necessary — a proxy for surgical vs. sprawling changes |
| Iteration count to converge | number of RED→GREEN cycles needed before the fix is accepted |
| tokens / cost / time | as universal core |

**No reference range exists yet** — none of the five benchmarked tools were run in fix mode (this
project's own scan-only guardrail deliberately excluded that). Real gap, not an oversight: the
target is self-defined from this harness's own v1 patcher run, with only two targets assumed on
first principles: exploit-closure rate on anything the patcher *claims* fixed should be 100% (a
claimed-but-not-actually-closed fix is worse than no fix — it creates false confidence downstream),
and functional-regression rate should be as close to 0% as achievable.

## Verifier metrics

| Metric | Definition |
|---|---|
| Exploit-blocked detection accuracy | precision/recall of the verifier correctly confirming "exploit no longer works" |
| **False-confidence rate** | verifier reports "fixed" but the exploit still actually works — tracked as its own dedicated number, not folded into a generic accuracy figure |
| Functional-regression detection accuracy | precision/recall of the verifier correctly catching that a fix broke real functionality |
| tokens / cost / time | as universal core |

False-confidence rate is called out deliberately: it's the single most safety-critical number in
the whole harness (a verifier that lies "safe" is worse than a verifier that's merely slow), and its
target should be as close to 0% as the design can get, even at the cost of other metrics.

## End-to-end / pipeline metrics

| Metric | Definition |
|---|---|
| Full-cycle closure rate | % of ground-truth items that go scan → fix → verify all correctly, with no functional regression — the project's single north-star metric |
| Total pipeline cost & time | sum across all stages for a full run |
| Regression rate against the target app's own test/e2e suite | broader check than per-fix functional tests — did the *whole app* still work |
| Run-to-run stability | variance in findings/fixes across repeated runs on the same input (agentic components are stochastic) |
| Delta vs. previous harness version | trend across harness iterations over calendar time, not just within one component |

**Decision:** run-to-run stability is measured only at milestone points (e.g. before/after a major
architecture change), not on every incremental commit — repeating an eval N times multiplies its
cost by N, and this isn't worth paying for on every small change.

## The comparison mechanism (how "ground truth" and "prior metrics" actually get checked)

1. **Ground truth:** reuse and generalize `tools/scan-benchmark/score.py`'s approach — file/line
   matching with slack, precision/recall/F1/localization — as a shared `tools/eval/` engine, with
   per-component adapters (mirroring `adapters.py`'s existing per-tool-parser pattern) that
   normalize each component's native output into the shared comparison shape. For the
   patcher/verifier, "ground truth" isn't a file:line anymore but the `exploitTest` +
   `solveCondition` fields already present in the ground-truth schema — the same ground-truth
   entries drive scanner, patcher, and verifier evals, just checked differently per stage.
2. **Historical baseline:** every eval run appends a structured record (component, version, full
   metric set, cost, time, timestamp) to an append-only log (e.g.
   `results/eval-history/<component>.jsonl`), and the report renderer always computes the delta
   against the immediately-prior run *and* the best-known run to date for that component — so a
   regression is visible even if it's not the most recent comparison point.
3. **The decision rule, once a change is scored:** define, per metric, a `floor` (unacceptable —
   revert or block) and a `target` (the operative "good enough" bar above). Once a change is
   already at/above target, further chasing gains becomes a cost/benefit call (e.g. "is 5 more
   points of recall worth 3x the token cost"), not an automatic green light. This framework
   surfaces the numbers for that call; it doesn't automate the call itself.

## What this becomes in practice

1. `tools/scan-benchmark/` generalizes into `tools/eval/`, keeping `score.py`'s matching logic as
   the ground-truth engine and adding the historical-log/delta mechanism above.
2. Every component's stage-by-stage build plan folds in an explicit "run the eval, compare to
   target + baseline, decide keep/revert/iterate" step (see `docs/protocols/dev-loop-protocol.md` for the
   concrete loop mechanic that uses these metrics).
