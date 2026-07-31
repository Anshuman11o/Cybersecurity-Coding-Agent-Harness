# Patcher eval metrics — what gets measured, and what each number tells us to change

Blind-safe. Contains no challenge identifier, file, line, or per-case verdict.
Aggregate counts only, per the publishing rule in the root `CLAUDE.md`.

The scoring definitions live with the scorer on the sighted side. This document
exists so the people **building** the patcher know what it will be judged on and
which architectural lever each number moves. A metric nobody designs against is
a metric that only produces regret.

Companion to `DATASET-READINESS-AND-HANDOFF.md` (can we run at all — no, three
blockers) and `VERIFICATION-TECHNIQUES.md` (what the patcher may check itself,
in-sandbox).

---

## 1. Two axes, and why neither is reportable alone

A patch is judged on two independent questions:

| Axis | Question | Failure it catches |
|---|---|---|
| **A — remediation** | did the vulnerability actually stop working | a patcher that does nothing, or writes a plausible non-fix |
| **B — preservation** | does the application still work | a patcher that "fixes" by deleting the feature |

These pull in opposite directions, which is the point. Axis A alone is trivially
maximised by removing the route — a scoring strategy the patcher will find if A
is the only thing measured. Axis B alone is maximised by submitting an empty
diff. Only the **conjunction** means anything:

```
EFFECTIVE FIX  ==  vulnerability remediated  AND  workflow preserved
```

The headline is the conjunction rate. Axis A on its own is a numerator
diagnostic and is never quoted by itself.

### The counterintuitive part, stated once

The vulnerability oracle is **inverted**. It asserts the vulnerability *works*.
On an unpatched app it **passes**. A successful fix makes it **fail**. Axis A
counts pass→fail transitions, not passes.

You will not see this in the sandbox — the oracle is on the sighted side — but it
determines what "score went up" means, and it is why nobody should reason about
their own numbers by counting green ticks.

### Both axes are differential

The target app's suite is **not green** on the unpatched tree, and how far from
green is currently unmeasured. So a test failing after a patch is not evidence
the patch broke it. Every number is a transition against a frozen pre-patch
baseline. **No baseline, no metrics** — this is blocker 2 in
`DATASET-READINESS-AND-HANDOFF.md`, and it is why that blocker cannot be skipped
for a "quick first run."

---

## 2. Scope: targeted on A, global on B

This asymmetry is deliberate and it shapes what the patcher should optimise.

| | Axis A | Axis B |
|---|---|---|
| Tests run | only those attributed to the case being patched | the **whole** functional suite |
| Why | another case's oracle flipping must not be credited here | collateral damage appears where nobody predicted it |
| Rough size | 1–2 assertions per case | ~700 fast assertions, ~2000 including the frontend |

**The implication for the patcher: there is no such thing as a "safely out of
scope" file.** A patch is measured against every functional test in the app, not
against the tests near the file it edited. Editing shared middleware, a model, or
a utility to fix one finding is measured against everything that imports it.

Axis B is tiered by cost:

| Tier | Scope | Frequency |
|---|---|---|
| **T1 fast net** | backend suites, in-memory harness, no server boot | every case, every run |
| **T2 full net** | + frontend specs, + browser E2E if affordable | once per run, after all patches |

T1 gates each patch. T2 is the audit that catches what T1 structurally cannot
see. A T2 regression that T1 missed is bisected over the cases whose patch
touched a file in the failing spec's import graph; when bisection does not
resolve it, it is reported as unattributed rather than charged to a case.

---

## 3. The verdict buckets

Every attempted case lands in exactly one:

```
                          WORKFLOW
                          intact              regressed
                     ┌──────────────────┬──────────────────┐
   VULN  remediated  │  EFFECTIVE_FIX   │ DESTRUCTIVE_FIX  │
                     ├──────────────────┼──────────────────┤
         surviving   │  NO_FIX          │ HARMFUL_NO_FIX   │
                     └──────────────────┴──────────────────┘
```

Plus guards, never folded into any success or failure rate: `NOT_ATTEMPTED`,
`BUILD_FAILED`, and exclusions for cases with no automatable oracle.

**`DESTRUCTIVE_FIX` is not a partial success.** It is counted separately and the
gap between the remediation rate and the effective-fix rate is tracked as its own
number across runs. A rising gap is the signature of a patcher discovering that
deletion satisfies the vulnerability oracle.

---

## 4. Ground-truth reality, in aggregate

Measured on the sighted side, 2026-07-31, over the 98-entry ground truth. These
are the constraints the eval operates under; no locations are given.

| | |
|---|---|
| Entries with an automatable vulnerability oracle today | **89 / 98** |
| Ceiling after six cheap oracle drivers are authored | **96 / 98** |
| Entries whose only oracle requires a **browser E2E run** | **60 / 98** |
| Entries with **no** automatable vulnerability oracle | 9 / 98 → 2 permanently (different language toolchain) |
| Entries whose oracle depends on a live LLM call | 3 → scored, excluded from run-to-run comparison |
| Functional assertions available for axis B | ~2000, of which ~700 are in the fast tier |

Four consequences that matter to anyone building the patcher or planning a run:

1. **Axis A is browser-bound.** 60 of 98 cases need a booted app, a seeded
   database, and a real browser. Nothing in this project has measured that cost
   yet. Measure it on **one** case before planning a full-set run — it is the
   largest unknown in the eval budget.
2. **Some cases will never be scoreable, and that is correct.** Two need a
   toolchain we are not adding for two cases. Excluding them explicitly is
   honest; folding them into a denominator is not.
3. **`oracle_blind_rate` is reported every run** — attempted cases with no
   automatable oracle, over attempted. It keeps ground-truth debt visible instead
   of letting denominators quietly shrink.
4. **A small number of cases have no legitimate workflow to preserve** — the
   correct fix is removing the capability. Those score workflow-intact by
   definition. A patcher that deletes such an endpoint has done the right thing
   and is not penalised.

---

## 5. Execution-free diagnostics — the numbers that direct architecture

The three below need no test run, no baseline, and no oracle. They come from the
unified diff and the run log. They are the first things to build, because they
produce signal from the first patcher run even while blockers 1–3 are open, and
because they are the metrics that say *what to change* rather than *how well it
went*.

### 5.1 Fix-site localization — the direct analogue of scanner localization

The scanner eval asks how far the reported line was from the true line, in bands.
The patcher analogue asks **how far the edited hunk was from the true line**,
computed in the **same bands**, so the two agents sit on one scale:

```
exact  |  ±5 lines  |  ±20 lines  |  same file  |  wrong file  |  no edit
```

Plus `fix_site_precision` — changed lines inside the target function ÷ total
changed lines.

**Why this is the highest-value addition.** It has **98/98 coverage** — including
every case with no vulnerability oracle and the two permanently excluded ones. It
is the only per-case signal independent of all four ground-truth gaps, so it is
computable before the baseline exists.

More importantly it splits a failure the conjunction rate conflates:

| Observation | Diagnosis | Component to change |
|---|---|---|
| no fix, edit was at the exact site | found it, remediated it wrongly | remediation playbook for that class |
| no fix, edit was in the wrong file or absent | never found the site | finding intake, trace quality in the handoff |

Same metric value, opposite remedies. No aggregate rate distinguishes them.

### 5.2 Blast radius and deletion ratio

Files touched, lines added, lines removed — reported as **median and max**. The
max is where feature deletion hides; a median-only report will never show it.

`deletion_ratio = lines_removed / max(1, lines_added)` is an early-warning proxy
for a destructive fix that needs no test execution at all. High remediation rate
plus high deletion ratio plus falling preservation rate is the deletion
signature. A high deletion ratio on its own is enough to go read the diff.

**Design consequence:** the patcher should carry an explicit minimality
constraint, and the verifier should treat its own large-deletion diffs as
suspect. Both are cheap to add and both are measured here.

### 5.3 Failure-attribution histogram

One bucket per attempted case, each naming the component to change. This is the
artifact that turns a run into a decision instead of a score.

| Bucket | Component to change |
|---|---|
| no patch submitted | intake / handoff queue / class labelling |
| patch does not compile | code generation, and whether the build loop feeds back |
| no fix, wrong site | localization, trace quality in the handoff |
| no fix, right site | remediation playbook coverage for that class |
| fixed by breaking | scope discipline, minimality constraint |
| broke it and left the bug | usually both of the above |
| excluded | ground-truth work, not patcher work |

Read the histogram, not the headline, when deciding what to build next. The
headline says whether the last change helped; the histogram says what the next
change should be.

---

## 6. Deferred, with the reason

| Metric | Deferred because |
|---|---|
| Fix fidelity against reference fixes | covers a third of the set and needs hunk alignment. High signal — the dataset ships hand-authored *plausible-but-wrong* fixes, each with a written explanation, so landing on one is a documented human mistake — but not needed to interpret run 1 |
| Verifier calibration and false-confidence rate | there is no verifier yet. The moment one exists, false confidence becomes the most safety-critical number in the harness: a verifier that reports "fixed" on a live vulnerability is worse than one that is merely slow |
| Class-coverage rate | the direct measure of the project's "fix a whole class at once" goal, and the metric most likely to separate a good patcher from a mediocre one. Needs per-group rollup; build it for run 2 |
| Rounds to green, cost per effective fix | trivial from logs, only interpretable once the effective-fix rate is non-zero |
| Run-to-run stability | N× cost. Milestone points only |

---

## 7. No targets yet, and do not invent any

`docs/protocols/eval-framework.md` is explicit: none of the five externally
benchmarked tools was run in fix mode, so **no reference range exists** for any
patcher metric. Two targets follow from first principles and nothing else does:

- remediation on anything the patcher **claims** to have fixed → **100%**. A
  claimed-but-open fix creates false confidence downstream, which is worse than
  an honest failure.
- functional regression → **as close to 0% as achievable**.

Everything else is set by this harness's own first instrumented run. Until then,
use the numbers for **relative comparison only** — "did change X move the
effective-fix rate up or down" — never as absolute claims. And do not import
scanner targets: the tasks are not comparable.

One inherited rule applies with full force here: **if a number is qualified by a
known defect, state the defect next to the number.** Four ground-truth gaps are
open (§4). A first run will produce numbers; those numbers are not yet evidence
about the patcher's reasoning until the gaps are closed, and they must not be
cited later as if they were.
