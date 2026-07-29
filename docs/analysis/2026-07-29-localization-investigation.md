# Localization investigation — what actually moves recall and localization

Investigation run 2026-07-29. Baseline: run 3 (`c9e3e94`, v2 per-file, luna).

Aggregates only. Every located result — which entry, which file, which line —
lives in the answer-key repo under `analysis/`. See
`docs/protocols/eval-howto.md` for the split.

**Scope of this branch.** Only the three playbook edits of §4 are here — they
are what run 5 measures. The experiment scaffolding that produced the evidence
(three `exp*` provider entries in `shared/models.json`, and the `runs/exp{a,b,c}/`
artifact trees) is deliberately **not** on this branch; it lives on
`claude/luna-recall-localization-exploration` (PR #21) so the raw arms stay
reproducible without shipping experiment providers into `main`.

---

## 1. What the gap is made of

Run 3, on the 97 reachable entries:

| metric | run 3 |
|---|---|
| recall (file + exact line + category) | 49/97 = 50.5% |
| localization (±15 + category) | 73/97 = 75.3% |
| localization, category-blind | 86/97 = 88.7% |
| file-level | 97/97 = 100% |

The 24 localization misses split cleanly in two, and the split is the thing
that matters:

| | count | meaning |
|---|---|---|
| **label-fixable** | 13 | a finding already sits within ±15 of the entry; it does not carry a matching code |
| **coverage-needed** | 11 | no finding of any class sits within ±15 |

Label-only work therefore caps at 86/97 = 88.7%. Coverage-only work caps
similarly. **Clearing 90% requires moving both**, which is why single-lever
attempts (F1, F3) plateaued.

Ten of the eleven coverage-needed entries are in files of 100 lines or more.

---

## 2. Results

Four interventions were tested against run 3. Two work, one is falsified, one is
correct but worthless.

### 2.1 Playbook coverage gaps — WORKS

Two playbooks did not cover ground their own stated scope claims:

- **`injection`** declares it covers "OWASP A03: Injection (all variants: SQL,
  NoSQL, OS command, LDAP, XPath, SSTI, code execution, etc.)" and then contains
  **no cross-site-scripting content at all**. OWASP 2021 merged XSS into
  A03:2021-Injection (CWE-79). Every XSS entry in the benchmark is coded A03,
  and the playbook could not lead the model to any of them. The gap is widest
  for *stored* XSS, where the defect is introduced at the persistence point
  (a model field or schema entry accepting free-form user text) while the render
  sink is in another file the lane cannot see.
- **`ssrf`** covers A10 but is written entirely around outbound requests, with
  no open-redirect content and nothing about weak destination allow-listing
  (substring / prefix / suffix / unanchored-pattern matching).

Both were filled in. Measured on a real Luna run (arm `expc`, 276 lanes
selected by "has `injection` or `ssrf` assigned" — a manifest property, not a
ground-truth one; 217 lanes completed, 59 lost to rate limits; scored against
run 3 restricted to the identical file set, 92 entries):

| | run 3 | patched playbooks |
|---|---|---|
| localization, `injection`-class entries | 14/18 | **18/18** |
| localization, `ssrf`-class entries | 1/3 | **3/3** |
| FILE_ONLY bucket | 13 | **4** |
| localization, category-blind | 90.2% | **93.5%** |
| hedging (classes/finding) | 1.550 | 1.536 — unchanged |

11 entries gained category-aware localization; 6 of those became exact-line
hits. Hedging did not rise, so this is added coverage rather than a wider net.

### 2.2 The authentication-outcome anchor — WORKS

The `crypto-auth` playbook described defects *in* authentication mechanisms and
had no notion that a defect of some *other* class, sitting on an authentication
path, also establishes A07. An injection flaw in a credential-verification
query is both an injection finding and an authentication finding; the model was
reliably reporting the first and only sometimes the second.

This matters far more than it looks, because of §3 below.

An "authentication-outcome anchor" was added: a defect that lets an attacker
reach an authenticated state, skip a credential check, or influence an identity
decision establishes this class **in addition to** the class of the mechanism it
abuses, with the qualifying code shapes listed structurally.

Measured by repeating the three highest-multiplicity lanes 4× each and asking
whether a finding at the exact ground-truth line carries the needed class:

| | cells producing the needed class |
|---|---|
| baseline (4 independent prior runs) | 7/12 |
| **anchored (4 repeats)** | **11/12** |

Hedging on those lanes did **not** rise (1.704 vs run 3's 1.800 on the same
files) while findings per lane rose 1.67 → 2.25. Better-aimed, not wider.

### 2.3 Windowing long files into multiple lanes — FALSIFIED

The most obvious reading of the data was that long files get too little
attention: findings per file are near-constant (1.45 → 2.00) while file length
grows 5×, so the share of a file lying within ±15 of any trace step collapses
from 75.8% to 28.6%. Recall by file length falls 72.7% → 33.3% → 0% → 0%.

Stage 2 already implements multi-chunk lanes; only Stage 0.5's
`SINGLE_PASS_LINE_BUDGET = 2000` keeps them from firing. Lowering it is a
one-constant change.

It was tested properly — arm `expa` (180 long files, whole-file, a faithful
re-run of run 3's configuration) against arm `expb` (the same 180 files at a
120-line window, 20-line overlap, 417 chunks):

| | findings | recall | localization | blind loc | findings/file | trace lines/file |
|---|---|---|---|---|---|---|
| run 3 | 187 | 9/42 | 25/42 = 59.5% | 76.2% | 1.91 | 5.7 |
| arm A (control) | 187 | 9/42 | 25/42 = 59.5% | 78.6% | 1.73 | 5.3 |
| arm B (windowed) | 269 | 10/42 | **25/42 = 59.5%** | **71.4%** | 2.66 | 7.7 |

The mechanism worked and the metric did not move. Findings per file rose 39%,
trace lines per file 35%, files with ≥3 findings doubled — and category-aware
localization was identical while category-blind localization *fell*. The
nearest-cited-line distance per entry was unchanged (10 entries closer, 12
farther, 20 unchanged).

The reason is visible per file: the largest file in the corpus went from 6
findings to 19 and its miss count went *up*. Windowing produces more findings
about the things the model already reports, not about the things it is missing.

**File length correlates with missing, but intra-file coverage is not the
causal mechanism. Do not lower `SINGLE_PASS_LINE_BUDGET`.**

Arm A is independently useful: it reproduced run 3's aggregate exactly on the
same files (187 findings, 9/42, 25/42) with 2 entries gained and 2 lost.
**Run-to-run variance is about ±2 entries on a 42-entry set**; effects smaller
than that are not interpretable.

### 2.4 Fewer classes per lane — WORKS, and it is the lever for the residual

Run 3 assigns a mean of **5.55 classes per lane** and the model emits **2.01**;
utilisation is 0.31 and **no lane out of 250 emitted every class it was
assigned**. The hypothesis: a lane carrying eight playbooks answers about the
two or three that dominate the file and never engages the rest.

Tested as a matched A/B on the 19 (file, needed-class) pairs run 3 failed to
localize. Both arms use the real `buildHuntPrompt`, the same playbooks, the same
arch and route context; the only difference is the assigned-class list — one
class versus run 3's assignment (mean 8.26 on these files). **Both arms were
answered by the same inference model** (Claude subagents, to keep Luna spend
down at the user's request), so the contrast is model-matched even though the
absolute level will not transfer.

| arm | recovered | label gap | coverage gap |
|---|---|---|---|
| **focused, 1 class/lane** | **18/19** | 10/10 | 8/9 |
| full list, 8.26 classes/lane | 13/19 | 8/10 | 5/9 |

Focused-only wins **5**; full-only wins **0**. The dominance is complete — focus
never loses a probe the full list wins — which is what makes 19 probes enough to
read (sign test on the 5 discordant pairs, p ≈ 0.03).

It moves **both** halves of the gap, which nothing else tested does. An earlier
single-arm probe on Luna recovered 12/19 against run 3's 0/19 on the same
entries, consistent in direction; its control was invalidated by rate-limit
failures and was not repeated on Luna.

**Cost.** Splitting does *not* multiply playbook tokens — each class's playbook
is already sent once per file it is assigned to. The added cost is re-sending
file content, arch context and boilerplate per class:

| configuration | calls | input | cost | vs run 3 |
|---|---|---|---|---|
| run 3 (one lane per file) | 541 | 3.18M | $5.48 | 1.00× |
| groups of ~3 classes | 1,001 | 4.25M | $7.24 | 1.32× |
| groups of ~2 classes | 1,502 | 5.41M | $8.86 | 1.62× |
| one lane per (file, class) | 3,005 | 8.91M | $13.51 | 2.47× |
| ditto, arch context dropped | 3,005 | 7.74M | $12.34 | 2.25× |

Wall clock at `HUNT_CONCURRENCY=4` scales with call count — the full split is
roughly 90 minutes against run 3's 17, and 3,005 calls will press harder on the
200k TPM ceiling than 541 did.

**Only the extremes have been measured (1 class vs 8.26).** The grouped middle
is an interpolation. Recommend measuring the dose before committing to the full
split — the 1.32× option may capture most of the benefit.

### 2.5 `client-side` → A03 — correct, worth nothing

The `client-side` playbook is a competent XSS playbook whose only code is
`LLM05`. `LLM05` appears **zero times** in the ground truth, so findings from
that class could never score. Adding A03 is factually right (OWASP 2021 folds
XSS into A03).

Simulated offline against run 3's findings: **zero entries move.** 12 of the 13
`client-side` findings already co-label `injection`, so they already carry A03.
Worth doing as a correctness cleanup; worth nothing as a recall lever. It is not
included in the proposal.

---

## 3. The finding that reframes the baseline

The benchmark is not uniformly distributed over locations. **Three source lines
carry 24 of the 97 reachable entries (24.7%)** — one carries 11 by itself.
Whether those 24 score depends on whether *one finding at each of three lines*
carries *one class*.

Tracking those three lines across every v2 run:

| run | entries won from the three lines | recall/97 | recall excluding those lines |
|---|---|---|---|
| run 2 | 6/24 | 33.0% | 35.6% |
| **run 3** | **24/24** | **50.5%** | **34.2%** |
| run 4 | 6/24 | 30.2% | 31.9% |

**Run 3's recall on the rest of the benchmark is not better than run 2's — it is
marginally worse (34.2% vs 35.6%).** The entire +17-entry recall gain credited
to F1 came from those three lines, in a single favourable draw. Localization
outside them did genuinely improve (58.9% → 67.1%), so F1 was not worthless, but
its recall headline was an artifact.

Consequences:

1. **Run 3 is an optimistic baseline.** Its configuration's expected recall is
   roughly 11 entries below what it measured.
2. **The headline metric carries ~10 points of run-to-run variance** from a
   single label on a single line. Any A/B smaller than that is unreadable
   unless the hot lines are controlled for.
3. **Stabilising those labels is the highest-value single intervention
   available**, which is exactly what §2.2 does.

This is why F3 (run 4) read as a catastrophe and F1 (run 3) as a triumph when
the difference between them outside these lines was a couple of entries.

---

## 4. What is being changed for run 5 — APPROVED

**Approved 2026-07-29: the three playbook edits, and nothing else.** This is
what is in the tree for run 5.

No architecture change, no new stage, no schema change, no change to Stage 0,
0.5 or 1. The entire behavioural diff is three files under
`tools/scanner/stage2-hunt-lanes-perfile/src/playbooks/`.

**Cost.** The three playbooks grow by 5,417 characters in total, which Stage 1
projects as **+275,613 input tokens, +10.0%** (2,764,390 → 3,040,003) — about
**+$0.28** on a $5.48 run. An earlier draft of this document said "~0.2%";
that was wrong by a factor of fifty and is corrected here. The absolute cost is
still small, but 10% is the number to plan against, not 0.2%.

1. **`injection`**: add cross-site scripting — reflected, stored, and
   DOM-based — with an explicit instruction to report stored XSS at the
   persistence point when the render sink is outside the file.
2. **`ssrf`**: add open redirect and weak destination allow-listing, with the
   four bypassable matching styles named.
3. **`crypto-auth`**: add the authentication-outcome anchor.

### Recorded but NOT being made

| | why not |
|---|---|
| windowing long files (§2.3) | falsified by a matched control — do not lower `SINGLE_PASS_LINE_BUDGET` |
| class-split lanes (§2.4) | works, but costs 1.3–2.5× and the dose is untested; held back deliberately |
| `client-side` → A03 (§2.5) | correct, moves zero entries |
| any schema or output-ordering change | F3's family, retired by run 4 |

Holding the class-split back is what keeps run 5 a **single-variable
measurement**. Run 4's lesson was that shipping two variables at once destroys
attribution; three playbook edits that all act on the same mechanism (which
class a finding is labelled with) are one variable. Adding a lane-topology
change on top would not be.

### Expected effect

Stage 1 — the three playbook edits, on 97 entries, against run 3 as measured:

| | run 3 | projected | basis |
|---|---|---|---|
| localization | 73/97 = 75.3% | **84/97 ≈ 86.6%** (±3) | +11 measured in arm C |
| recall | 49/97 = 50.5% | **55/97 ≈ 56.7%** (±3) | +6 measured in arm C |

Against the configuration's *expectation* rather than run 3's lucky draw, the
anchor is worth a further ~+9.5 entries; the gain over an average run-3-config
run is therefore larger than the table shows, and the variance is much smaller.

**Stage 1 lands at roughly 87% localization — short of the 90% target.** The
residual was measured directly (arm C, excluding the hot line the anchor
repairs): 12 misses on 92 entries — 6 label-fixable, 6 coverage-needed, spread
thinly across misconfiguration (4), insecure-design (2), integrity-failures (2),
access-control (2) and crypto-auth (2). No single remaining playbook lever is
worth more than about 4 entries.

Stage 2 — class-split lanes, **not being made now**. This is the only tested
intervention that moves both halves of the residual (§2.4: label 10/10,
coverage 8/9 against 8/10 and 5/9). If it transfers to Luna at even half the
rate measured, it closes 6 of the 12 residual entries and puts localization at
**90/97 ≈ 92%**. That is the route to the target; it costs 1.3–2.5× depending
on dose, and the dose is untested.

Honest summary: **run 5 as configured reaches ~87% on measured evidence.
Clearing 90% needs the class-split, whose direction is proven but whose
magnitude on Luna and whose cheapest working dose are not.** Run 5 measures the
playbook edits alone; whether to spend on the class-split is a decision best
made against run 5's actual residual rather than against a projection.

### Caveats

- The three edits have been measured **separately**, never together. Arm C
  carried edits 1–2 without 3; the anchor was measured on three lanes, not a
  corpus. A full run is what confirms the combination.
- Arm C lost 59 of 276 lanes to rate limits (my own probes were competing for
  the same TPM budget); it is scored only on the 217 that completed.
- The anchor's evidence is 12 lane-runs. The direction is clear; the magnitude
  is not tightly bounded.
- The XSS and open-redirect edits close gaps that are objectively present
  against the playbooks' own stated scope. The anchor is closer to the line —
  it is defensible security reasoning (authentication bypass is CWE-290, squarely
  A07) but it was chosen after looking at which classes were being missed, and
  it should be read with that in mind.

---

## 5. Reproducing

Experiment arms are provider-isolated under `tools/scanner/runs/exp{a,b,c}/` on
the exploration branch (`claude/luna-recall-localization-exploration`, PR #21),
not on this one.
Each arm's manifest is generated from run 3's by a scratch script and selects
hunt lanes by a manifest property only — file length, or which classes Stage 0.5
assigned — never by anything derived from the answer key.

Playbook edits are verifiable after the fact from
`budget-consumption.json`: `prompt_breakdown.segments` records exact character
counts per playbook, so which text a run actually used is a matter of record,
not of trust. That check caught nothing here but confirmed arm B ran entirely on
pre-edit playbooks despite being in flight when the files changed — Node's ESM
loader caches every playbook at process start, before the first lane.
