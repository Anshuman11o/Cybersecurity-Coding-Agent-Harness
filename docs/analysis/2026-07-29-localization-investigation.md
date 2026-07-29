# Localization investigation — what actually moves recall and localization

Exploration branch `claude/luna-recall-localization-exploration`, 2026-07-29.
Baseline: run 3 (`c9e3e94`, v2 per-file, luna).

Aggregates only. Every located result — which entry, which file, which line —
lives in the answer-key repo under `analysis/`. See
`docs/protocols/eval-howto.md` for the split.

**Nothing here has been merged.** The playbook edits described below are on the
exploration branch only, and the three `exp*` provider entries added to
`shared/models.json` are experiment scaffolding that must be removed before any
merge to `main`.

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

### 2.4 `client-side` → A03 — correct, worth nothing

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
carry 23 of the 97 reachable entries (23.7%)** — one carries 11 by itself.
Whether those 23 score depends on whether *one finding at each of three lines*
carries *one class*.

Tracking those three lines across every v2 run:

| run | entries won from the three lines | recall/97 | recall excluding those lines |
|---|---|---|---|
| run 2 | 5/23 | 33.0% | 35.6% |
| **run 3** | **23/23** | **50.5%** | **34.2%** |
| run 4 | 5/23 | 30.2% | 31.9% |

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

## 4. Proposal

Three playbook edits. No architecture change, no new stage, no schema change,
no cost increase beyond ~0.2% more input tokens.

1. **`injection`**: add cross-site scripting — reflected, stored, and
   DOM-based — with an explicit instruction to report stored XSS at the
   persistence point when the render sink is outside the file.
2. **`ssrf`**: add open redirect and weak destination allow-listing, with the
   four bypassable matching styles named.
3. **`crypto-auth`**: add the authentication-outcome anchor.

Deliberately **not** proposed: windowing (falsified, §2.3), `client-side` → A03
as a recall lever (worth zero, §2.4), and any schema or output-ordering change
(F3's family, retired by run 4).

### Expected effect

On 97 entries, against run 3 as measured:

| | run 3 | projected | basis |
|---|---|---|---|
| localization | 73/97 = 75.3% | **84/97 ≈ 86.6%** (±3) | +11 measured in arm C |
| recall | 49/97 = 50.5% | **55/97 ≈ 56.7%** (±3) | +6 measured in arm C |

Against the configuration's *expectation* rather than run 3's lucky draw, the
anchor is worth a further ~+9.5 entries; the gain over an average run-3-config
run is therefore larger than the table shows, and the variance is much smaller.

**This lands at roughly 87% localization, short of the 90% target.** The
residual after both changes was measured directly (arm C, excluding the hot line
the anchor repairs): 12 misses on 92 entries — 6 label-fixable, 6
coverage-needed, spread thinly across misconfiguration (4), insecure-design (2),
integrity-failures (2), access-control (2) and crypto-auth (2). There is no
single remaining lever worth more than about 4 entries.

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

Experiment arms are provider-isolated under `tools/scanner/runs/exp{a,b,c}/`.
Each arm's manifest is generated from run 3's by a scratch script and selects
hunt lanes by a manifest property only — file length, or which classes Stage 0.5
assigned — never by anything derived from the answer key.

Playbook edits are verifiable after the fact from
`budget-consumption.json`: `prompt_breakdown.segments` records exact character
counts per playbook, so which text a run actually used is a matter of record,
not of trust. That check caught nothing here but confirmed arm B ran entirely on
pre-edit playbooks despite being in flight when the files changed — Node's ESM
loader caches every playbook at process start, before the first lane.
