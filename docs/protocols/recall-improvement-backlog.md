# Recall-improvement backlog

Running list of changes proposed between the `scanner-2026-07-28-luna-a` baseline
and the next run. Items move to CONFIRMED only on an explicit decision;
everything else is a candidate with its evidence attached so the decision can be
made on numbers rather than intuition. Items marked **SHIPPED** are already in
the tree and need no further work.

Baseline being improved on: recall **37/98 = 37.8%**, localization 66.3%,
file-level 94.9%, precision proxy 15.4% category-aware, cost $4.64.

### ⚠ The baseline ran without three dispatched changes

`scanner-2026-07-28-luna-a` executed from `claude/luna-5.6-model-setup-g80khc`,
which had forked before three dispatched changes landed on `main` via the
remediation branch:

| dispatch | commit | committed | in the baseline's tree? |
|---|---|---|---|
| `2026-07-27__playbook-adjacent-class-disambiguation` | `44e01ad` | 07-27 23:31 | no |
| `2026-07-28__remove-class-cap` | `510dcb6` | 07-28 03:18 | no |
| `2026-07-28__misconfiguration-sweep-and-insecure-design-desuppression` | `95cd259` | 07-28 03:45 | no |

All three were committed *before* Stage 2 started (07-28 04:59) but on a branch
the run never contained. The output confirms the cap was in force and biting:
**max 2 classes on any of 247 findings, with 114 of 247 — 46.2% — sitting exactly
on the ceiling** (compare the 15% that justified writing the dispatch). All three
are merged in now.

This has two consequences. C2 and C3 below were proposals for work already done,
and are re-marked SHIPPED. And the 37.8% baseline is a *pre-dispatch* number: the
next run's delta will include these three changes whether or not anything else
is applied, so it cannot be attributed to the confirmed list alone.

**Check for recurrences by diffing this branch against `main` before every run**,
not just at merge time. A dispatch prompt on disk is evidence of intent, not of
presence in the tree that runs.

---

## CONFIRMED

### C1 — Drop the `general-catchall` class — **SHIPPED**

v2 only. `vuln-classes.json` loses the class (15 → 14), `signal-classes.json`
loses it from the floor (4 → 3), the v2 playbook module is deleted, `API10` comes
out of the expected-code set in `validateAllPlaybooks()` (26 → 25) since the class
was its only carrier, and `ssrf.ts`'s "never fall back to general-catchall" line
is reworded now that there is nothing to fall back to. v1 keeps its own
`general-catchall` lane and playbook untouched — v1 has no class model and does
not read either JSON file.

| | |
|---|---|
| Assigned to | 541/541 lanes (floor class) |
| Lanes that emitted it | 33 — **6.1%** |
| Findings produced | 34 (13.8% of all output) |
| Ground-truth entries carrying it | **0** |
| Precision | **3%** — lowest of any class by 4x |

It is carried in every prompt, produces a seventh of all output, and nothing it
finds corresponds to a benchmark entry. Removing it cuts noise and prompt cost
with no measurable recall exposure.

Note it maps to `API10`, so dropping the class means `API10` becomes
unemittable. No ground-truth entry carries API10, so recall is unaffected — but
`vuln-classes.json` and `signal-classes.json` must both be updated or the
selector's validation will fail on a dangling reference.

### C2 — Remove the per-finding class cap — **SHIPPED** (`510dcb6`, 07-28 03:18)

Already in the tree. Dispatched as `2026-07-28__remove-class-cap.md`; the edit
below is exactly what shipped. It was absent from the baseline's branch, which is
why the measured run still shows the cap. Nothing further to do.

**File:** `tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.ts:160`

```diff
  finding_classes: {
    type: 'array',
    minItems: 1,
-   maxItems: 2,
    items: { ... }
```

A lane must be free to emit as many classes as genuinely fit. The cap is
arbitrary and **46.2% of findings (114/247) sit exactly at it**, which is what a
binding constraint looks like. The natural bound is already the lane's own
assigned list — the schema `enum` restricts `class` to the classes Stage 0.5
assigned, so the ceiling is the lane's 4–13, not 15, and not 2.

v1 (`stage2-hunt-lanes`) has no `maxItems` and no class model at all, so this is
a v2-only change and v1 stays byte-identical.

### C3 — Rewrite the class-selection prompt — **SHIPPED** (`510dcb6`, 07-28 03:18)

Already in the tree, in the same commit as C2. The rationing rule is gone and the
replacement paragraph is in place — **but the shipped wording is not the wording
proposed below**, so read the "as shipped" text as authoritative:

> List every class that your scanning of this file establishes for this finding,
> using the playbooks, the file content, and the context you were given. There is
> no limit on how many — list all the evidence supports, and do not narrow to a
> single label when several genuinely apply. A single line can legitimately be
> more than one class: a render sink reached by attacker-controlled data is both
> an injection and a client-side finding. For each class you list, give the index
> of the trace step that establishes it.

One substantive difference from the proposal: the shipped text asks for
`justified_by_step` but does **not** carry the explicit "if you cannot point to a
step, do not list it" instruction. The schema still requires the field and
runtime validation still drops findings with invalid `finding_classes`, so the
constraint is enforced mechanically — it is just no longer stated to the model.
Whether to add that sentence back is an open question best answered by the
hedging rate on the next run; it is not worth a run of its own.

**File:** `tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.ts:400`

Remove the "second class / separate finding" rule. The lane's job is to pick
which of its assigned classes fit the defect — not to ration labels.

**Current:**

> List every class this finding genuinely belongs to. A single line can
> legitimately be more than one class — a render sink reached by
> attacker-controlled data is both an injection and a client-side finding. **Only
> list a second class if the same trace establishes it; if a second class would
> need a different entrypoint or a different sink, it is a separate finding, not
> a second label.** For each class you list, give the index of the trace step
> that establishes it.

**Proposed replacement — ready to drop in:**

> List every class from your assigned classes list that this finding genuinely
> belongs to. There is no limit on how many. A single defect often spans several
> classes: a render sink reached by attacker-controlled data is both an injection
> and a client-side finding; a hardcoded key used to sign session tokens is both
> a crypto-auth and a misconfiguration finding.
>
> For each class you list, set `justified_by_step` to the 0-based index of the
> trace step that establishes that class. If you cannot point to a step in this
> finding's own trace that establishes a class, do not list it — a label you
> cannot tie to the trace is noise, not coverage.

Justification per class is deliberately kept. It is the non-arbitrary constraint
— a class must be tied to a specific trace step — and it replaces the cap as the
thing preventing indiscriminate labelling.

#### ⚠ This changes how the next run must be scored

`eval-framework.md` makes hedging rate mandatory precisely for this case:
"emitting more labels matches more ground truth partly by widening the net."
Scored recall requires a **category intersection**, and a finding's `categories`
is the union of its classes' OWASP codes. A finding naming 6 classes could carry
~12 codes, at which point intersecting with any ground-truth entry is close to
automatic.

So a recall jump after C2+C3 is **not** by itself evidence of better detection.
The comparison must lead with:

- **category-blind recall** (40.8% baseline) — immune to hedging, this is the
  real detection signal
- **hedging rate** (1.462 baseline) — if it rises in step with recall, the gain
  is labelling, not finding
- **precision proxy, category-aware** (15.4% baseline) — the direct cost

If scored recall rises while category-blind recall is flat, the change improved
labelling and found nothing new. That is still a legitimate result, but it must
be reported as such.

### C4 — Resolve the instruction conflict *(addresses H1)* — **SHIPPED**

**File:** `tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.ts:398`

The emission-suppressing sentence and the emission-encouraging sentence sit two
lines apart, and the suppressing one comes last:

**Current (line 398):**

> **Do not invent findings. An empty array is right for a file that genuinely has
> no defect.** But do not stay silent about something you can see merely because
> the surrounding context is missing.

66.4% of lanes returned an empty array. Whether or not that instruction caused
it, it is the last word the model reads on the subject and it authorises
silence.

**Proposed replacement — ready to drop in:**

> Do not fabricate. Every finding must point at code that is actually present in
> the file in front of you, and every trace step must cite a real line.
>
> Subject to that, report what you see. An empty array is a strong claim — it
> says this file contains no weak control, no unvalidated input reaching a
> dangerous operation, and no defect of any assigned class. Most files in a real
> application do contain something. If you are about to return an empty array,
> re-read the file once against your assigned class list before you do.

The distinction being drawn is between *fabricating* (forbidden) and *reporting
something uncertain* (wanted). The current text collapses the two.

### C5 — Confidence is an annotation, not a gate *(addresses H2)* — **SHIPPED**

**File:** `tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.ts:396`

**Current (line 396), second half:**

> Use "confidence" to express how sure you are: a defect you can see clearly but
> whose reachability you cannot confirm from this file is a real finding at
> moderate confidence, not something to withhold.

Luna emitted **nothing below 0.7** across 247 findings, so this sentence did not
take. It describes the scale but never says the low end is usable.

**Proposed replacement — ready to drop in:**

> Set "confidence" to how sure you are, and use the whole range. It is a label on
> the finding, not a threshold for reporting it:
>
> - **0.8–1.0** — you can see the defect and the path to it in this file.
> - **0.4–0.7** — the defect is visible but something is unconfirmable from here:
>   the caller, the reachability, whether a control exists elsewhere.
> - **0.1–0.3** — the shape is suspicious and you would want a second opinion,
>   but you cannot establish it from this file alone.
>
> Report findings in all three bands. A 0.2 finding is useful output; a withheld
> one is not. Do not raise a number to make a finding look more solid, and do not
> suppress a finding because its number would be low.

Explicit bands are used rather than a general encouragement, because the general
encouragement is what is already in the prompt and it produced a hard floor at
0.7.

#### ⚠ Precision exposure — unresolved

C4 and C5 raise emission by design, and **v2 has no validator**: Stage 3 reads
`stage2-hunt-lanes` (v1), not the `-perfile` output. Precision proxy is already
15.4% category-aware. There is nothing downstream to recover what these give up.

Two ways out, both open:
1. Accept the precision drop as the price of recall at this stage, and gate on
   recall alone for now.
2. Port Stage 3 onto the v2 artifacts first, so the extra low-confidence
   findings have somewhere to be killed.

**Verification for C4+C5:** the confidence distribution is the primary
diagnostic, ahead of recall. If findings below 0.7 still do not appear, the edit
did not take regardless of what recall did. Also track share of empty lanes
(66.4% baseline) and findings per producing lane (1.36 baseline).


---

## CANDIDATES — evidence gathered, decision pending

### D1 — Trim the floor class set

The floor is applied to **every** hunt lane regardless of signals, and is
**61% of all class assignments** (2164 of 3546).

| floor class | assigned | lanes emitting | emit rate | GT entries |
|---|---:|---:|---:|---:|
| `general-catchall` | 541 | 33 | 6.1% | 0 |
| `logging-monitoring` | 541 | 6 | **1.1%** | 1 |
| `insecure-design` | 541 | 42 | 7.8% | 13 |
| `misconfiguration` | 541 | 53 | 9.8% | 17 |

Floor classes emit at **6.2%**; signal-derived classes emit at **13.1%** —
over twice as productive per assignment.

`logging-monitoring` is the strongest additional candidate: 1.1% emission, one
ground-truth entry, which the run missed anyway. `insecure-design` and
`misconfiguration` carry 30 ground-truth entries between them and should not be
dropped — if anything they should become signal-gated rather than floor.

**Open question:** does trimming the floor actually raise recall, or only cut
cost? It cannot raise recall directly. The hypothesis is indirect — a shorter
class list per lane may improve attention on the classes that remain. That is
untested and should be measured, not assumed.

### D2 — Raise emission rate  *(plan below)*

#### The problem, measured

```
confidence across all 247 findings
  0.7:  7    0.8: 43    0.9: 99    1.0: 98
  mean 0.911      below 0.7: 0      below 0.5: 0
```

Luna emitted **nothing below 0.7**, despite a prompt that says a defect whose
reachability cannot be confirmed from the file "is a real finding at moderate
confidence, not something to withhold." 66.4% of hunt lanes returned nothing;
producing lanes averaged 1.36 findings.

There is **no schema cap on findings per lane** — the outer `findings` array has
no `maxItems`, and no per-lane class limit exists anywhere in the executor. The
only cap is `maxItems: 2` on `finding_classes` *per finding*
(`hunt-executor.ts:160`), which is deliberate: the prompt says a second class is
only allowed when the *same trace* establishes it. Note **46.2% of findings sit
exactly at that cap**, so whether it binds is an open question worth probing.

*(An earlier version of this document claimed a "structural ceiling of 2.71
classes per lane". That was circular — it multiplied the per-finding cap by the
observed findings-per-lane, which is an output, not a constraint. Withdrawn.)*

#### Why it plausibly moves recall — and the honest ceiling

Exact-line recall by how much output landed in the ground-truth entry's file:

| findings in file | GT entries | recalled | rate |
|---|---:|---:|---:|
| 0 | 5 | 0 | 0.0% |
| 1 | 29 | 9 | **31.0%** |
| 2–3 | 51 | 28 | **54.9%** |
| 4–7 | 13 | 0 | 0.0% |

The 0→1→2–3 trend supports "more shots on goal": a lane that reports two or
three defects is ~24 points more likely to land one on the exact line. **The 4–7
row is not interpretable** — it is two files (`lib/insecurity.ts`, `server.ts`),
both dense and large, and both did localize (3 and 4 entries within ±15). Do not
read it as "more findings hurt".

**Realistic ceiling, stated honestly:** only **5 of 98** entries have no finding
in their file at all, so D2's *direct* pool is 5. Its *indirect* pool is the 29
entries sitting in 1-finding files; moving them to 2–3-finding behaviour is
worth about +7. **Total plausible gain ≈ +8 to +12 points of recall**, not the
"biggest lever" this document previously called it. D3 addresses a pool of 34.

#### Root-cause hypotheses (not yet separable)

- **H1 — instruction conflict.** "Do not invent findings. An empty array is
  right for a file that genuinely has no defect" may dominate the
  moderate-confidence sentence that precedes it.
- **H2 — confidence used as a gate.** The model may treat the confidence field
  as a reporting threshold rather than an annotation, suppressing anything it
  would score below ~0.7 instead of emitting it with a low number.
- **H3 — single pass.** *(demoted — see below.)* One call per lane, no
  iterative deepening, so whatever the first pass surfaces is the whole output.

**H3 was mislabelled and its evidence does not hold up.** H1 and H2 are
hypotheses about *why* the model under-emits; H3 is a proposed *remedy*
(second-look elicitation), not a cause. Listing it alongside them was a category
error.

Its supporting evidence was the findings-density table above, and that table has
a confound. The 2–3-finding bucket's 54.9% is substantially one file:
`routes/login.ts` produced 2 findings and carries **11 ground-truth entries at a
single line**, all 11 recalled. Excluding it:

| bucket | recall |
|---|---:|
| 1 finding | 31.0% (n=29) |
| 2–3 findings, as reported | 54.9% (n=51) |
| 2–3 findings, excluding `routes/login.ts` | **42.5% (n=40)** |

The gap shrinks from 23.9 points to **11.5**. Still directional, but weak at
these sample sizes, and it no longer supports "more shots on goal" strongly
enough to justify the cost — a second pass per lane roughly **doubles Stage 2
spend, ~$4.64 → ~$9.3**.

**Disposition:** H3 is a fallback, attempted only if I1/I2 (free prompt edits
that test the same emission problem) fail to lift the confidence floor. It also
does nothing for D3's 34-entry line-attribution pool, which is both larger and
better evidenced.

#### Interventions — one per iteration, never bundled

| # | Change | Tests |
|---|---|---|
| I1 | Rebalance the prompt: state that low-confidence candidates are wanted and that confidence is an annotation, not a filter | H1, H2 |
| I2 | Ask for a minimum number of candidate *observations* per lane, with confidence carrying the uncertainty | H2, H3 |
| I3 | Raise `finding_classes` `maxItems` 2 → 3 | whether the cap binds (46.2% sit at it) |

C1 and D2 must not ship in the same run — they push precision in opposite
directions and the delta becomes unattributable.

#### **Blocking constraint: v2 has no validator**

`STAGES_V2` is `stage0 → stage05-perfile → stage1-perfile → stage2-perfile →
reconcile`. Stage 3 reads `stage2-hunt-lanes` (v1), not the `-perfile` output —
confirmed at `validator-orchestrator.ts:531`.

So the usual argument for trading precision for recall — "Stage 3 kills the
false positives" — **does not hold for v2 today**. Precision proxy is already
15.4% category-aware. Any D2 iteration either accepts a raw precision drop with
nothing downstream to recover it, or is preceded by porting Stage 3 onto the v2
artifacts. That port is a prerequisite decision, not a detail.

#### Verification

Reuse the committed Stage 0 / 0.5 / 1 artifacts unchanged — they are
deterministic and provider-scoped, so **only Stage 2 varies** and the delta is
attributable. Re-running Stage 2 alone costs ~$4.64 and ~25 min at concurrency
8, or ~40 min at 3 to stay under TPM.

Gate on all three, per `eval-framework.md`:

| metric | direction | note |
|---|---|---|
| **recall** | up, primary gate | vs 37.8% baseline |
| **precision proxy** (both) | must not collapse | 15.4% cat-aware / 22.3% cat-blind today |
| **hedging rate** | must stay ~flat | 1.462 today; a recall gain that tracks hedging is a wider net, not better detection |

Report category-blind recall alongside scored recall — that is what separates
"found more" from "labelled better". Also record: findings per producing lane,
share of lanes emitting nothing, and the full confidence distribution. If
confidence still has a hard floor at 0.7, the intervention did not take, whatever
recall did.

Per `dev-loop-protocol.md`: **max 3 iterations**; stop early if a round gains
<3 points on recall while still below target; stop immediately if any round
regresses against the 37.8% baseline.

### D3 — Exact-line attribution  *(plan below)*

> **Located evidence lives outside this repo.** The version of this section that
> named specific (file, line) locations, quoted ground-truth source lines, and
> gave per-location entry counts was moved to the answer-key repo at
> `analysis/d3-exact-line-attribution.md` on 2026-07-28. It was a
> blind-development violation: `docs/protocols/blind-development.md` forbids any
> pairing of a benchmark entry with a file and line inside this repository, and
> that is exactly what it was. What remains here is everything needed to decide
> and verify the change, with nothing that localizes a benchmark entry.

#### The problem

34 of the 61 misses are **right file, right class, wrong line** — 55.7% of all
misses and the largest recoverable pool. **26 of the 34 are within ±5 lines.**

D3's ceiling is today's localization: **65/98 = 66.3%**. It converts *localized*
into *recalled*; it cannot find anything new.

#### It is not an off-by-one bug — checked

Signed delta (`model_line − gt_line`) of the closest category-matching step:

```
 -20:1   -11:1   -7:1   -4:1   -3:3   -2:3   -1:6
  +1:3    +2:1   +3:9         |delta|>20: 5  (-53,-47,-38,-25,+42)
median -1   mean -4.5   earlier 20 / later 14   within +-5: 26/34
```

No dominant offset and no directional bias, so line numbering is sound. The
`+3:9` spike is a single multi-entry location, not nine independent errors.
Closest step was a `sink` in 22 of 34, `propagation` in 9, `entrypoint` in 3.

#### Root causes

Three patterns, each confirmed against the actual lines (examples in the
answer-key analysis):

1. **Sink-vs-control.** The model cites where the damage lands; ground truth
   marks where the control is missing or weak. Both readings are defensible;
   ground truth is consistent about choosing the weak check.
2. **Container-vs-element.** The model cites an enclosing declaration or array
   literal; ground truth the specific line inside it.
3. **Signature-vs-body.** The model cites a function signature; ground truth a
   statement within the body.

Pattern 1 is the largest. Note this is *not* the whole story: of six near-miss
multi-entry locations, only one is sink-vs-control. Two have structurally
trivial ground-truth lines (a bare brace, a `catch` clause) where the model's
cited line is arguably the better answer.

#### Where the leverage is

The 98 entries occupy only **67 distinct (file, line) locations**; 44 entries
share a location with another. **Six multi-entry near-miss locations are worth
+18.3 points** — 37.8% → 56.1% — with no new detection at all. Which six is in
the answer-key analysis.

#### Interventions — **proposed only, not approved**

| # | Change | Targets |
|---|---|---|
| E1 | Prompt rule: cite the line where the control is **absent or weak**, not where the consequence occurs | cause 1 (largest) |
| E2 | Prompt rule: cite the **most specific** line — never an enclosing declaration, array literal, or function signature when a statement inside carries the defect | causes 2, 3 |
| E3 | Require the `sink` step's description to quote the exact expression at the line it cites | forces specificity, makes E1/E2 checkable |

E1 and E2 are one prompt edit and should ship together — they are the same
instruction from two directions and cannot be attributed apart anyway.

#### Verification

Stage 2 only, reusing the committed Stage 0/0.5/1 artifacts. ~$4.64, ~25 min.

Primary gate: **recall**, against 37.8%. Ceiling is 66.3%.

The decisive diagnostic is **the signed-delta distribution collapsing toward
zero** — recompute it and compare against the histogram above. Recall can move
for unrelated reasons; the delta histogram cannot.

**Localization must not fall.** D3 converts localized→recalled, so localization
should hold near 66.3% while recall climbs toward it. Localization dropping
means the change moved lines without improving them.

Precision proxy should be roughly flat — this changes *where* a finding points,
not how many are emitted.

#### Measurement note that applies to every future run

98 entries occupy only **67 distinct locations**, and the three most crowded
carry 11, 8 and 5 entries — **24 entries at 3 lines**. Recall is
location-weighted, not challenge-weighted, so a single line landing or slipping
swings the headline by up to 11 points. Report the distinct-location count
alongside recall, and treat small deltas between runs as noise unless the delta
histogram moved too.

Run 2 demonstrated this exactly: scored recall fell 5 points, but excluding the
single 11-entry location it *rose* 5. See `docs/run-history.md`.

### D4 — Revisit the three zero-recall classes

`ai-llm-agency` 0/4, `resource-consumption` 0/2, `logging-monitoring` 0/1.

**These are not detection failures** and should not be treated as broken
playbooks. `ai-llm-agency` localizes 3 of 4 with 100% precision — it finds the
right thing and misses the line. `resource-consumption` localizes 1 of 2.
`logging-monitoring` is n=1. All three collapse into D3.

---

### D5 — Zero-signal lanes: hunt or skip?

**170 of 541 hunt lanes (31.4%) carry exactly 4 classes** — the floor set and
nothing else. Those files fired **zero signals** in Stage 0, so they get a
generic prompt with no file-specific narrowing, hunted only on floor classes
that emit at 6.2%.

Class-count distribution across hunt lanes:

| classes | lanes | % |
|---:|---:|---:|
| 4 (floor only, no signal) | **170** | **31.4%** |
| 5 | 28 | 5.2% |
| 6 | 112 | 20.7% |
| 7 | 29 | 5.4% |
| 8 | 73 | 13.5% |
| 9 | 52 | 9.6% |
| 10 | 54 | 10.0% |
| 11–13 | 23 | 4.2% |

min 4, max 13, mean 6.55. No lane receives all 15 classes.

Skipping zero-signal files would cut roughly a third of Stage 2's cost. **Open
question, not yet checked:** does any ground-truth entry live in a zero-signal
file? Stage 0's eval reported signal→class coverage of 98/98, which suggests
not — but that measured whether the entry's *class* was implied, not whether the
file had any signal at all. Check before deciding; this one can be answered
against the answer key without a run.

Note also that `categories[]` is dead weight in v2: **all 541 lanes receive the
identical 25-code list**, and `[CLASS RESOLUTION]` confirmed 0 lanes used the
categories fallback path. Narrowing happens entirely through `classes[]`.

## Sequencing — revised now that three dispatch changes are in the tree

The confirmed items move two axes, and each inflates scored recall by a
*different* mechanism, so shipping them together makes a recall delta
unattributable. The merge adds a third group that is already in the tree and will
be measured by the next run whether or not anything else changes.

**All six are now in the tree.** The sequencing question is no longer *what to
implement* but *whether to measure them in one run or two* — and splitting now
means reverting shipped code, which is not worth doing.

| axis | items | effect on scored recall |
|---|---|---|
| label space | C1, C2, C3, playbook disambiguation, misconfig/insecure-design | up, via wider intersection and better class choice |
| emission volume | C4, C5 | up, via more findings — and down on precision |

| run | contains | primary diagnostic |
|---|---|---|
| **A** (recommended) | all six | **category-blind recall** (40.8% baseline) and **hedging rate** (1.462). Scored recall will rise mechanically once the cap is gone; category-blind is what says whether anything new was *found*. Then: **confidence distribution** — findings below 0.7 must appear at all — plus empty-lane share (66.4%) and findings per producing lane (1.36). Per-class recall for `misconfiguration` (18%) and `insecure-design` (8%) gives partial attribution, since only those two have class-targeted changes. |

One run at ≈ $4.64. The cost of bundling is that a run-level recall delta is not
attributable to any single change. That attribution was already lost when three
of the six went in unmeasured; the honest move is to say so in the report rather
than to spend a second run recovering a split that the branch divergence had
already destroyed.

If the bundled result is ambiguous — recall up but category-blind flat, or
precision collapsed — the follow-up run should revert the emission-volume axis
(C4, C5) only, which is two paragraphs in one file and cleanly separable.

**Before either run, diff the branch against `main`.** The reason this section
had to be rewritten is that a run executed from a tree three commits behind the
changes it was meant to test.

**Nothing from D3 is in this sequence.** E1, E2 and E3 remain candidates and are
not approved.

If they are approved later they form a further axis — line placement — and would
slot in as another cumulative run with the signed-delta histogram as its primary
diagnostic.

## Constraints any change must respect

- **The 97/98 ceiling stands.** `data/datacreator.ts` is denylisted and holds
  one ground-truth entry. Do not "fix" recall by re-hunting it.
- **Comparability.** The next run must be diffed against
  `scanner-2026-07-28-luna-a`, not against `scanner-2026-07-27-a/-b` — those
  were not blind. Report hedging rate alongside any recall figure.
- **One change per run, or the attribution is lost.** C1 and D2 pull in opposite
  directions on precision; bundling them makes the result uninterpretable.
- **The tree must be verified before the run, not after.** `git merge-base` and a
  diff against `main` are part of run setup. A dispatch prompt in
  `prompts/dispatch/` records what was asked for; only the commit graph records
  what the run will execute.
