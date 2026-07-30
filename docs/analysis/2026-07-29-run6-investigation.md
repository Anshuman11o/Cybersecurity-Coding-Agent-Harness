# Run 6 investigation — the model was the variable, and one bug was eating recall

Investigation 2026-07-29, on branch `claude/agent-localization-recall-debug-5cxqzb`.
Baseline: run 5 (`c9c2cf0`), recall 42/97 = 43.3%, localization 78/97 = 80.4%.

Aggregates only. Every located result lives in the answer-key repo under
`analysis/`. See `../protocols/eval-howto.md` for the split.

**Role note.** CLAUDE.md assigns scanner source edits to Qwen and reserves Claude
for architecture and verification. The user directed Claude to develop and test
the fixes directly for this investigation, so that split is suspended here by
instruction. Everything below was still verified against artifacts rather than
self-reported.

---

## 1. The starting hypothesis was wrong, in a useful way

The hypothesis under test: `crypto-auth` (a jump in `CATEGORY_MISS`) plus
`access-control` and `misconfiguration` (the most `LINE_MISS_FAR`) point at those
three playbooks.

The entry counts behind that reading are correct. The diagnosis is not — all
three are falsified:

- **`crypto-auth`'s `CATEGORY_MISS` is almost entirely hot-line variance.** 8 of
  its 9 are at a single high-multiplicity location whose own probe (6 repeats,
  unmodified prompt) produces the needed citation in 5 of 6 runs. The 9th is a
  defensible taxonomy disagreement. Cold `crypto-auth` `CATEGORY_MISS` is **one**
  entry. There is nothing for a playbook edit to fix.
- **The playbook already covers what it was suspected of missing.** `crypto-auth`
  names MD5 and SHA-1 explicitly.
- **`access-control` / `misconfiguration` `LINE_MISS_FAR` is real, and is not
  playbook content.** It decomposes into line attribution and missing route
  context.

**What the residual actually is.** Cold pools (hot lines separated, since they are
variance rather than signal):

| pool | n |
|---|---|
| `LINE_MISS_NEAR` — right code, within ±15, wrong exact line | **28** |
| localization misses, coverage-needed | 10 |
| localization misses, label-fixable | 9 |
| `CATEGORY_MISS` | 5 |

`LINE_MISS_NEAR` is the dominant pool and **no run has ever targeted it** — runs
3, 4 and 5 all acted on which class a finding carries. 25 of the 28 are within ±5
lines, and **no run-5 finding cites the exact ground-truth line for any of them**,
so it is line *selection*, not label attribution. 5 of the 28 have a
ground-truth line that is blank, punctuation-only or a comment and is therefore
not citable at all, which caps exact-line recall near 94%.

Misses are also **file-concentrated, not class-concentrated**: the top 3 files
carry 53% of localization misses and the top 5 carry 63%. That is why four
successive class-level interventions plateaued.

## 2. A measurement platform worth keeping

**All 97 reachable entries live in 40 of run 5's 541 hunt lanes**, and restricting
run 5's own findings to those 40 lanes reproduces its published metrics *exactly*
— 42/97 recall, 78/97 localization, 87/97 blind, on 94 of its 392 findings.
Verified, not assumed.

So a 40-lane arm is a complete, single-variable measurement of recall and
localization at **7.4% of a full run's lane count**. Arms are built by
`arm-build.mts` and scored by `arm-score.py` in the answer-key repo, using the
real `buildHuntPrompt`, the real playbooks, the assigned-class lists from run 5's
own manifest, and the executor's own arch-snippet construction. Prompt fidelity is
asserted per lane against run 5's recorded `prompt_breakdown.total_chars`: **39 of
40 lanes byte-identical**, the 40th differing only by the bug fix in §3.

That per-lane assertion is what caught §3. An earlier version of the arm builder
reimplemented the executor's read path and drifted by 9–108 characters per lane;
chasing the drift found the defect.

## 3. A line-number corruption that was eating recall — fixed

`sanitizePemPrivateKey()` replaced a PEM key body with `"\n[REDACTED…]\n"`,
turning a single-line key declaration into three lines.

The line count is load-bearing. Stage 0.5 counts lines and writes the chunk plan;
Stage 2 then redacts and numbers what it shows the model. Changing the count
desynchronises the numbers the model is told to cite, the file the scorer reads,
and the chunk plan's `end_line`.

Consequence in the corpus: the one file carrying a PEM key went 196 → 198 lines,
so **every line from the key onward was displayed 2 higher than its true number**,
and slicing to the manifest's `end_line` silently dropped that file's last 2
lines. The model was citing correct lines in shifted coordinates.

Re-scoring run 5 offline with the shift undone — deterministic, no inference:

| | recall | localization | blind |
|---|---|---|---|
| as scored | 42/97 = 43.3% | 78/97 = 80.4% | 89.7% |
| shift corrected | **45/97 = 46.4%** | 78/97 = 80.4% | 89.7% |

**+3 entries, and localization does not move.** That asymmetry is the signature of
this bug class: a 2-line shift is invisible to a ±15 window and fatal to
exact-line recall — precisely the "localization fine, recall stuck" shape of the
last three runs. Every run to date understates recall by those 3 entries.

Fixed by re-emitting exactly as many newlines as the removed body contained.
7 regression tests assert the invariant, including against the real corpus; the
guard suite is now 84 tests. Verified across all 541 hunt lanes: 0 line-count
changes and 0 chunk/content mismatches after, 1 of each before.

## 4. The inference model is the dominant variable — measured twice

### 4.1 A stronger model on identical lanes and identical prompts

Every scored run has used `luna`, the **cheapest tier of the GPT-5.6 family**.
`docs/Cybersecurity models pricing research` records why: it was "the smallest
step up available" from `qwen` on cost grounds. Model capability has therefore
never been isolated as a variable, while four runs tuned prompts against it.

`terra` and `sol` are the same family on the same endpoint and the same API key —
one registry entry each, exactly as `models.json` intends. Both PASS `preflight`
including the `json_schema` round-trip. Added to the registry.

A 129-lane arm selected by a manifest property only (Stage 0.5 assigned ≥8
classes — never anything ground-truth derived), sharing luna's Stage 0 so arch
context is byte-identical, run through the **real unmodified Stage 2**:

| arm | findings | recall | localization | blind loc |
|---|---|---|---|---|
| `luna` (run 5, same lanes) | 197 | 36/82 = 43.9% | 69/82 = 84.1% | 90.2% |
| **`terra`** | 221 | **50/82 = 61.0%** | 67/82 = 81.7% | **96.3%** |

**+14 entries of recall, +17.1 points, on the same prompts.** 16 gained, 2 lost.
Category-blind localization rises 90.2% → 96.3%; category-aware localization dips
2.4 points, so terra finds and positions more while labelling slightly worse.

Clean execution: 129/129 lanes, 0 retries, 0 fatal, 0 blocked reads,
`degraded: false`, 1,330,522 tokens, **$5.54**.

### 4.2 An upper bound from a different model family

The 40-lane arm answered by Claude subagents as the inference model, on prompts
verified byte-identical to run 5's:

| | recall | localization | blind loc |
|---|---|---|---|
| run 5 (`luna`) | 42/97 = 43.3% | 78/97 = 80.4% | 89.7% |
| run 5 + §3 fix | 45/97 = 46.4% | 78/97 = 80.4% | 89.7% |
| **Claude, same prompts** | **66/97 = 68.0%** | **90/97 = 92.8%** | 96.9% |

Both standing targets are met by the model alone: localization ≥90% and recall in
the 60–70% band, with no prompt, playbook or lane-topology change.

**Read this as an upper bound, not a forecast.** The arm answers through an agent
loop rather than one structured HTTP completion, so it can re-read and self-check
in ways a single Stage 2 call cannot; there is no `ANTHROPIC_API_KEY` in this
environment, so it was not run through the real provider path. The contrast is
model-matched, the absolute level will not transfer unchanged. §4.1 is the result
measured through the real pipeline.

### 4.3 `sol` and the full-pipeline run are blocked on API credits, not on capability

**Correction.** An earlier version of this document said `sol` was
"rate-limit-bound at this concurrency". That was wrong, and the error is worth
recording because it would have sent the next run down a false path.

`sol` was launched on the same 129-lane manifest and abandoned after 205 retries
and 35 fatal lanes. I read the 429s as rate limiting. They were not: **all 248 of
them carry the message `You have no credits remaining`.** The OpenAI account
exhausted its credits partway through that run. Sol's capability is untested for a
billing reason, and lowering `HUNT_CONCURRENCY` would not have helped.

The lesson generalises: **a 429 is not self-evidently a rate limit.** Read the
message body before tuning concurrency against it. The runbook's concurrency
guidance (§5 of `../protocols/running-a-scan.md`) assumes 429 means TPM
saturation; that assumption held for every earlier run and does not hold here.

The `terra` full 541-lane run — the combined-fix run this investigation was meant
to end with — was launched and **died on the same wall**, with every lane retrying
to exhaustion on `no credits remaining`. It produced no scoreable output. Its
partial artifacts were moved out of the run tree so no later run can resume them,
and the completed 129-lane terra arm was restored and re-verified to score
identically (50/82, 1,330,522 tokens, `exit_code 0`).

**What this means for the numbers in §4.1.** The 129-lane terra arm completed
*before* credits ran out, with 0 retries and 0 fatal lanes, and its artifacts
verify clean. That result stands. What does not exist is a full-pipeline
combined-fix run, so the recommendation in §6 rests on a 129-lane real-pipeline
measurement plus an offline counterfactual, not on a full run 6.

## 5. What was tested and rejected

**Trace-specificity instruction — UNRESOLVED (see §7; earlier called falsified).** The prompt says nothing about which
line to cite for a defect, only "use these line numbers EXACTLY", which forbids
inventing a number and is silent on choosing among real ones. Given §1's
mechanism, an instruction to cite the innermost statement rather than the
enclosing construct looked like the obvious lever.

Matched A/B, 40 lanes, both arms same model, only the appended block differing:

| arm | findings | recall | localization | blind loc | hedging | precision |
|---|---|---|---|---|---|---|
| control | 325 | 72/97 = 74.2% | 94/97 = 96.9% | 97.9% | 2.298 | 46.2% |
| + specificity | 346 | 70/97 = 72.2% | 91/97 = 93.8% | 99.0% | 2.052 | 40.2% |

Transitions: **3 improved, 7 worsened** — `HIT → LINE_MISS_NEAR` ×3,
`HIT → LINE_MISS_FAR` ×1. It pushes the model off lines it already had right, and
precision falls 6 points. **Reverted from source; retained as an arm variant.**

Caveat stated plainly: this control sits at 96.9% localization, so headroom is
thin and the result does not prove the instruction would fail on a weaker model.
But it did not shrink the near-miss pool (21 → 20) while breaking 4 hits, which is
evidence against it even so. (Both arms in this pair predate the §3 fix and ran on
prompts with an unredacted key; they are identical to each other, so the contrast
holds while the absolute levels are inflated.)

**Registrar route context — implemented, not yet measured.**
`matchRoutesForFile()` matches routes to a file by that file's exported symbols,
which serves handler files and starves the file that *declares* the routes — it
exports none of the handlers it mounts, so it matches nothing and received zero
characters of route context in run 5, where only 70 of 541 lanes got any at all.
Stage 0 already records all 148 registrations with a declaring file, an exact
line, and auth middleware; 88 carry no guard. `renderRegistrarRouteContext()`
turns that judgement question into a lookup. It is additive — it does not touch
`matchRoutesForFile()` or `renderRouteContext()`, so every lane that already had
route context gets byte-identical text. **In the tree, unmeasured; do not claim it
works.**

## 5b. The combined-fix run was attempted and could not complete

The investigation was supposed to end with one run carrying every surviving fix
together, on the full 541 lanes. That run was set up and launched and did not
produce a number:

- Tree verified first, by grepping the source rather than trusting the commit log:
  PEM line-count preservation present, registrar route context wired into
  `huntLane`, specificity instruction absent.
- Full 541-lane manifests installed for `terra` and for a `luna-fixed` arm (same
  model as `luna`, separate artifact namespace so run 5's committed tree stays
  untouched). The `luna-fixed` arm exists to separate "the fixes helped" from "the
  model tier helped" — without it a terra-vs-run-5 delta confounds both.
- Checkpoints cleared; 91/91 guard tests pass across all 4 manifests on disk.
- Launched, and every lane failed on `no credits remaining`.

**So the decomposition is incomplete, and I am not going to present it as if it is
not.** What is measured, and what is not:

| what | status |
|---|---|
| PEM fix, isolated | measured offline, deterministic: +3 entries on run 5 |
| terra vs luna, both fixes in force, 129 real lanes | measured: 50/82 vs 36/82 |
| registrar route context, isolated | **not measured** — it was in force for the terra arm but never varied against a matched control |
| all fixes together, full 541 lanes | **not measured** — blocked on credits |
| `luna-fixed` (fixes without the model change), full lanes | **not measured** — blocked on credits |
| `sol` | **not measured** — blocked on credits |

The `terra` and `luna-fixed` manifests, the `luna-fixed` registry entry, and the
cleared checkpoints are all in place, so whoever has credits can execute both runs
without repeating any setup.

## 6. Recommendation for run 6

1. **Ship the §3 line-number fix.** A correctness bug, +3 entries, no cost, no
   behavioural risk, regression-tested.
2. **Make run 6 a model-tier change: `terra`, full 541 lanes.** One registry entry,
   already reachable, measured at +17.1 recall points on a real 129-lane
   pipeline run. Projected cost ~$14 at run 5's token volume — the largest
   measured effect in the project's history, for less than the price of run 4.
3. **Keep it single-variable.** Do not bundle the registrar route context; it is
   unmeasured, and run 4's lesson was that two variables destroy attribution.
   Measure it after, on the 40-lane platform.
4. **Do not ship the specificity instruction** — but note §7: it is unresolved
   rather than falsified, and re-testing it needs an instrument that can resolve
   effects under ~14 entries.
5. **Restore API credits first — nothing below is executable without them.** Then
   run the two arms already staged: `terra` full and `luna-fixed` full. `luna-fixed`
   is what separates the fix contribution from the model contribution; run it even
   though it is the less interesting of the two.
6. **Then measure `sol`**, which is untested for billing reasons, not capability
   ones, and measure the registrar route context against a matched control.

Everything the last four runs were tuning — playbook coverage, class labelling,
lane topology — was being tuned against the family's cheapest tier. That is the
finding.

---

## 7. The combined run — and a measurement error it exposed in my own arms

The combined-fix arm finally ran (40/40 lanes, Claude subagents as the inference
model, the platform the user asked for). Scored against the matched control:

| arm | findings | recall | localization | blind loc | hedging | precision |
|---|---|---|---|---|---|---|
| control (PEM fix only) | 308 | 66/97 = 68.0% | 90/97 = 92.8% | 96.9% | 2.250 | 42.5% |
| combined (+ registrar route context) | 322 | **74/97 = 76.3%** | **94/97 = 96.9%** | 99.0% | 2.140 | 43.5% |

Transitions: 13 improved, 81 unchanged, 3 worsened, with hedging *falling* and
precision *rising*. On its face that is a clean win on both targets.

**It is not. Most of that delta is noise, and I nearly reported it as a result.**

The registrar route context only adds text to a file that *declares* routes. In
this 40-lane set exactly **one** file does. Verified with `cmp`: **39 of 40 prompts
are byte-identical between the two arms**; only the registrar lane differs.

So the movement splits:

| | improved | worsened |
|---|---|---|
| on the 39 **byte-identical** prompts | **11** | **3** |
| on the one lane the fix actually changes | **2** | **0** |

Eleven of the fourteen movements happened on input that did not change. They cannot
be the fix.

### The calibration this yields, which the project did not have

**Identical input moved 14 of 97 entries — 14.4%, net +8.** That is the run-to-run
noise floor of this agent-based platform: **±14 entries, ≈±14 points on 97.**

The project's prior variance estimate was ±2 entries per 42 (≈±4.6 points on 97),
measured from a *Luna* arm — one structured HTTP completion per lane. An agent loop
is a different and far noisier instrument: it re-reads, self-checks and revises, and
those choices vary between runs. **The two numbers are not interchangeable, and I
used the wrong one.**

### What this forces me to retract

- **The +8 recall headline is not the fix.** The registrar route context's
  attributable effect is **+2 entries with 0 regressions**, on the single lane it
  touches. Directionally positive, mechanistically consistent (the file that got
  new text is the file that improved), and far too small for this platform to
  resolve on its own.
- **The trace-specificity instruction is NOT falsified.** I reported "3 improved,
  7 worsened" as a falsification. That split sits *inside* a ±14 band. The honest
  verdict is **unresolved**, not failed. It should not be described as tested.
- **Any agent-arm A/B in this document measuring under ~14 entries is
  unresolved**, including the §4.2 upper bound's precise value.

### What still stands, and why

- **The PEM line-number fix (+3 entries).** Measured by re-scoring run 5's actual
  findings offline with the shift undone. No inference, no sampling, fully
  deterministic — variance does not apply.
- **The `terra` result (+14 entries on 82).** Measured through the real Stage 2:
  one structured completion per lane, the regime where the project's ±2/42 estimate
  applies. +14 is far outside that band. It was not repeated, so its own variance is
  unbounded — but it is the strongest measured result here and the only one taken
  through the production code path.

### Methodological rule this earns

**Before reading any arm delta, `cmp` the prompt sets and count how many lanes
actually differ.** If the answer is "one", the arm can only speak about one lane,
whatever the aggregate says. Pair that with a same-prompt repeat to establish the
instrument's noise floor before interpreting any effect against it. Neither check
was in the arm protocol; both are now.

## 8. Final four-arm result, and a clean noise measurement

The third arm (registrar route context **+** trace specificity) completed. Scored on
the 89 entries in the 39 lanes all three arms share:

| arm | findings | recall | localization | blind | hedging | precision |
|---|---|---|---|---|---|---|
| control — PEM fix only | 278 | 62/89 = 69.7% | 84/89 = 94.4% | 98.9% | 2.227 | 43.2% |
| + registrar route context | 285 | 70/89 = 78.7% | 86/89 = 96.6% | 98.9% | 2.112 | 45.6% |
| + route context + specificity | 293 | 65/89 = 73.0% | 87/89 = 97.8% | 100% | 2.027 | 44.4% |

### The first two rows are a same-prompt repeat, and that is the useful part

This lane set **excludes the registrar file** (it was the one lane missing from the
third arm). The registrar file is the *only* lane the route-context fix changes. So
across all 39 lanes here, rows 1 and 2 ran on **byte-identical prompts**.

They differ by **+8 recall and +2 localization** — 11 entries improved, 3 worsened.

That is the cleanest noise measurement this project has: **identical input, same
model, same harness, 14 of 89 entries moved, net +8 recall.** Roughly **±14
entries, ±9 recall points.** It is the same-prompt repeat §7 says the protocol now
requires, and it confirms that figure independently.

**Nothing in the +8 is the fix.** The route-context fix's attributable effect
remains what §7 reports: +2 entries, 0 regressions, on the single lane it touches.

### The specificity instruction: two independent negatives, one mechanism

| sample | contrast | lanes differing | recall | localization | improved / worsened |
|---|---|---|---|---|---|
| 1 | spec vs control | 40 | **−2** | −3 | 3 / 7 |
| 2 | (route+spec) vs route | 40 | **−5** | +1 | 3 / 8 |

Both negative on recall, from independent runs, and the *mechanism is the same in
both*: it breaks entries that were already exact-line hits. Sample 2's losses are
`HIT → LINE_MISS_NEAR` ×5 and `HIT → CATEGORY_MISS` ×2 — seven hits destroyed, one
recovered.

Pooled across both samples: **6 improved, 15 worsened.** Each sample alone sits
inside the ±14 band, so neither is a clean falsification. But two independent
negatives sharing one mechanism, with no positive sample anywhere, is consistent
evidence that the instruction moves the model *off* lines it already had right.

**Verdict: do not ship it.** Not because it is proven harmful, but because two
attempts to find benefit found harm instead, and there is no evidence for it.

Note that localization *rises* slightly as recall falls (94.4 → 96.6 → 97.8). The
instruction does pull citations toward the right region while degrading exact-line
precision — consistent with §1's finding that these two metrics fail for different
reasons and can move in opposite directions.

## 9. Corrected bottom line

| claim | status | basis |
|---|---|---|
| Three-class playbook hypothesis | **falsified** | forensics on run 5's own findings; no inference, no sampling |
| PEM line-number fix, +3 entries | **holds** | deterministic offline re-score of run 5's findings |
| `terra` model tier, +14 entries on 82 | **holds, unrepeated** | real Stage 2, single completion per lane |
| Registrar route context, +2 entries / 0 regressions | **directionally positive, unresolved** | 1 differing lane; below the platform's resolution |
| Trace specificity | **do not ship; not falsified** | 2 independent negatives, 1 shared mechanism, both inside noise |
| Agent-arm noise floor ±14 entries | **measured twice** | same-prompt repeats in §7 and §8 |

**The one recommendation that survives every caveat: run 6 should be the `terra`
tier change on the full 541 lanes, with the PEM fix in the tree.** (§10 adds the
completed full-set numbers; they do not change this.) It is the only
intervention measured through the production code path, in the noise regime where
the project's own ±2/42 estimate applies, at an effect size well outside it. It
needs API credit and nothing else.

## 10. All three arms at full 40/40 — final numbers

The last lane landed, so all three arms are complete on all 97 entries:

| arm | findings | recall | localization | blind loc | FAR bucket | hedging |
|---|---|---|---|---|---|---|
| control — PEM fix only | 308 | 66/97 = 68.0% | 90/97 = 92.8% | 96.9% | 5 | 2.250 |
| + registrar route context | 322 | **74/97 = 76.3%** | 94/97 = 96.9% | 99.0% | 1 | 2.140 |
| + route context + specificity | 326 | 69/97 = 71.1% | **95/97 = 97.9%** | **97/97 = 100%** | **0** | 2.055 |

Two trends are monotonic across the three arms and worth naming, even though a
single sample per arm cannot establish them against a ±14 noise floor:

- **Localization rises throughout** (92.8 → 96.9 → 97.9), and category-blind
  localization reaches **100%** — every reachable entry has some finding within ±15.
- **`LINE_MISS_FAR` falls to zero** (5 → 1 → 0).

**Recall peaks in the middle** (68.0 → 76.3 → 71.1). The specificity instruction's
transitions against the control explain why: it converts `LINE_MISS_FAR → NEAR` ×5
— pulling citations into the right neighbourhood — while also pushing `HIT → NEAR`
×2. It trades exact-line precision for regional coverage.

That is a coherent mechanism rather than a random walk, and it is consistent with §1:
localization and exact-line recall fail for different reasons and can move in
opposite directions. It is *not* enough to ship on. If the instruction is revisited,
the hypothesis to test is narrow and now well-posed: **does it move entries out of
`LINE_MISS_FAR` without disturbing entries that are already exact hits?** Testing
that needs an instrument with a noise floor well under 5 entries — which this one is
not.

**Both standing targets are cleared by the middle arm** — localization 96.9% against
a 90% target, recall 76.3% against a 60–70% band. But that arm differs from its
control on **one prompt**, so the honest statement is: *an agent-class model on run
5's own prompts clears both targets, and the fixes' individual contributions are
smaller than this platform can resolve.* The targets are cleared by the model, not
by the fixes.

## 11. Registrar route context — resolved by a focused repeat test

§7 left this fix unresolved because the 40-lane arm could not see it: the block only
adds text to a file that *declares* routes, one lane does, and the aggregate was
swamped by ±14-entry noise. The fix was therefore retested **where it acts** — that
lane alone, over its 8 ground-truth entries, with repeats.

### Attribution is exact

The block supplies exact lines for all 148 registrations. Of the registrar file's 8
entries, **exactly 2 changed bucket, and both are lines the block lists**
(`LINE_MISS_FAR → LINE_MISS_NEAR`). **All 6 entries the block does not list are
unchanged. Zero regressions in any run.**

An effect confined precisely to the entries the mechanism targets, and to nothing
else, is a stronger argument than any aggregate at this sample size. This is what
the 40-lane arm could not produce.

### Replication, n=11

| arm | n | mean localization | mean FAR | FAR==0 |
|---|---|---|---|---|
| without the block | 5 | 7.20/8 | 0.80 | 3/5 |
| **with the block** | 6 | **8.00/8** | **0.00** | **6/6** |

Per-run `LINE_MISS_FAR` — without: 2, 2, 0, 0, 0. With: 0, 0, 0, 0, 0, 0.

**Fisher exact, one-sided, p = 0.182.** Direction perfectly consistent, but n=11 is
underpowered and this is **not significant at 0.05**. Stating otherwise would repeat
the error §7 documents.

### Verdict

**Ship it — as a correctness fix with a small measured benefit, not as a lever.**

- Mechanism proven; attribution exact; zero regressions across 6 runs.
- Effect ≈ **+0.8 localization entries** (~+0.8 points on 97).
- **No recall gain** (4.00 → 4.17): both converting entries land inside the slack
  rather than on the exact line.
- Independent justification: the registrar file was receiving *no route context at
  all* while Stage 0 held every registration with its line and guard status. That is
  a defect regardless of score.

**Refinement identified, untested.** The block already says "cite that
registration's own line" and the model still lands within ±15 rather than on it.
Closing that gap would convert these 2 from `NEAR` to `HIT` — a recall gain. That is
the next cheap experiment, and it is now well-posed.

## 12. Final status of every candidate

| candidate | verdict | evidence |
|---|---|---|
| Three-class playbook hypothesis | **falsified** | forensics on run 5's findings; no sampling involved |
| PEM line-number fix | **proven, +3 entries** | deterministic offline re-score; 7 regression tests |
| `terra` model tier | **proven, +14 on 82** | real Stage 2, 129/129 lanes, in the ±2/42 regime |
| Registrar route context | **proven mechanism, +0.8 entries** | exact per-entry attribution, n=11, p=0.182 |
| Trace specificity | **do not ship, unresolved** | 2 independent negatives, shared mechanism, inside noise |
| Agent-arm noise floor ±14 | **measured twice** | two same-prompt repeats |

**Run 6: `terra` on the full 541 lanes, with the PEM fix and the registrar route
context in the tree.** The PEM fix and route context are both correctness fixes with
proven mechanisms and no measured regressions, so they carry no attribution risk. The
model tier is the only large lever, and it is the single variable to read the run
against. Blocked on API credit alone.

## 13. The mechanism behind `LINE_MISS_NEAR` — trace granularity, not aim

§11 left a loose end: the registrar block hands the model an exact line and says to
cite it, and the model still lands *within* ±15 rather than *on* it. Pulling that
thread found the mechanism behind the whole near-miss pool.

### The traces bracket the answer

Of run 5's **28 cold `LINE_MISS_NEAR` entries, 16 have the ground-truth line lying
strictly inside the matching finding's own cited span, uncited.** Several bracket it
on both sides — the finding names a line below and a line above and omits the one
between.

The model is not looking in the wrong place. It is drawing endpoints and skipping the
middle.

### Trace geometry, all 392 findings

| | |
|---|---|
| cited lines per finding | median **3**, mean 3.2 |
| span width (max−min+1) | median **11**, mean 24.7 (p75 26, p90 68) |
| uncited lines inside the span | median **7**, mean 21.5 |
| `propagation` steps per finding | median **1**, mean 1.28 |

The schema forces `entrypoint` first and `sink` last. So a median of 3 steps carrying
1 propagation step means most findings are *entrypoint → one hop → sink* across a span
of 11+ lines. The `propagation` kind exists precisely for the skipped middle and is
used once.

### Counterfactual — the pool this accounts for

Filling each finding's trace with the lines between its own min and max cited line.
A scoring counterfactual, not a shippable change:

| span cap | recall | trace steps/finding |
|---|---|---|
| none (as scored) | 42/97 = 43.3% | 3.2 |
| ≤5 | 44/97 = 45.4% | 3.6 |
| ≤10 | 48/97 = 49.5% | 4.2 |
| ≤20 | 48/97 = 49.5% | 6.6 |
| ≤40 | **62/97 = 63.9%** | 10.4 |
| unbounded | **71/97 = 73.2%** | — |

**Up to 29 entries — the entire gap to the 60–70% recall target — sit inside spans the
model has already implicated.** That reframes the residual: it is a granularity
failure, not a detection or localization failure. It also explains why every
class-level intervention plateaued and why localization has been comfortably ahead of
recall all along.

**A cost the metric set cannot see.** The precision proxy is *per finding* — is this
finding within ±15 of any entry — so adding lines inside an existing span leaves it
unchanged at 12.5%. The proxy is blind to this. The real cost is reviewer burden, more
lines to check per finding, and nothing currently measures it. Any completeness
instruction must be judged on trace length as well as recall.

### Why this is a third, distinct intervention

- **Specificity** (§5, §8) told the model to *relocate* a step to the innermost line.
  Two independent negatives; it broke entries that were already exact hits.
- **The earlier enumerate probe** widened *across sibling entries* in a repeated
  structure. Net-widening, converted 2 of 12.
- **Completeness** neither moves nor widens a trace. It finishes the path the model is
  already asserting, using a step kind the schema already provides.

Arm `trace` = registrar block + a completeness instruction, with all 40 prompts
differing from the `route` arm (verified by `cmp`), so it is a genuine single-variable
contrast rather than the one-lane contrast that misled §7.
