# Recall-improvement backlog

Running list of changes proposed between the `scanner-2026-07-28-luna-a` baseline
and the next run. Items move to CONFIRMED only on an explicit decision;
everything else is a candidate with its evidence attached so the decision can be
made on numbers rather than intuition. Items marked **SHIPPED** are already in
the tree and need no further work.

Baseline being improved on: recall **37/97 = 38.1%**, localization 67.0%,
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

## ⚠ Read this before citing run 3 as a baseline

The 2026-07-29 localization investigation
(`../analysis/2026-07-29-localization-investigation.md`) found that **three
source lines carry 23 of the 97 reachable entries**, and that whether those 23
score turns on whether one finding at each line carries one class.

Run 2 won 5 of those 23. Run 3 won **23 of 23**. Run 4 won 5.

Excluding those three lines, run 3's recall is **34.2%** against run 2's
**35.6%** — no better. **The +17-entry recall gain credited to F1 below came
almost entirely from a single favourable draw on three lines**, not from a broad
improvement. F1's localization gain outside them is real (58.9% → 67.1%); its
recall headline is not.

Two consequences for everything in this file:

- Run 3 is an optimistic baseline; its configuration's *expected* recall is
  roughly 11 entries below what it measured.
- The headline metric carries **~10 points of run-to-run variance** from those
  three labels. An A/B smaller than that cannot be read unless the hot lines are
  reported separately. Run-to-run churn is otherwise about ±2 entries per 42.

Located detail — which lines, which runs, which labels — is in the answer-key
repo at `analysis/2026-07-29-localization-located.md`.

## CONFIRMED — from the run-2 analysis

Baseline for these is run 2, on the 97 reachable entries: recall 32/97 = 33.0%,
localization 58.8%, category-blind recall 48.5%, hedging 1.240. One of the 98
answer-key entries is in a denylisted file and can never be cited, so every
ground-truth denominator here is 97. See `../run-history.md`.

### F1 — Stop the playbooks instructing a single label — **SHIPPED**

**Files:** all 14 in `stage2-hunt-lanes-perfile/src/playbooks/`.

Every playbook closes its disambiguation section with a singular imperative —
`Choose <x> when …` — after a list framed as `This finding belongs to another
class if:`. That is pick-one guidance. It is longer, more specific, and closer to
the decision than the prompt's "list every class … there is no limit", so it
wins.

**What the evidence does and does not show.** Co-labelling fell uniformly, in
every class without exception:

| | run 1 | run 2 | | | run 1 | run 2 |
|---|---|---|---|---|---|---|
| access-control | 62% | 28% | | injection | 77% | 35% |
| api-property-auth | 78% | 24% | | insecure-design | 69% | 41% |
| client-side | 100% | 42% | | misconfiguration | 60% | 46% |
| crypto-auth | 81% | 66% | | resource-consumption | 19% | 6% |

(share of a class's appearances that were as a co-label rather than sole label)

It is **not** the specific adjacency rules routing specific pairs. Pairs named in
each other's disambiguation fell 46%; pairs *not* named fell **52%** — slightly
more — and the adjacent:non-adjacent ratio rose 5.71x → 6.42x. A pair-targeted
mechanism predicts the opposite. Dropping `general-catchall` explains only 13 of
114 run-1 multi-class findings; excluding it, run 1 still hedges 1.447 vs run 2's
1.237. **The cause is the pick-one posture the framing induces, not the content
of any rule.** Do not "fix" the adjacency bullets — they are good.

**Why it costs recall, precisely.** Where two classes are two separable defects,
the model now emits two findings instead of one dual-labelled finding. That is
harmless, arguably better, and is most of the aggregate change: across the 174
lanes producing in both runs, distinct classes per lane barely moved (1.764 →
1.713). Where two classes are two *properties of the same statement*, there is
nothing to split into, so the secondary class is simply dropped. At the
benchmark's most crowded location the lane named the secondary class in run 1 and
named it **nowhere in the file** in run 2 — 10 entries lost, with the model's own
trace description explicitly noting the evidence for the class it declined to
name.

**The change.** Keep every disambiguation bullet. Replace the singular closer so
it selects *evidence for a class*, not *the class*, and state that one trace may
establish several. Pattern, per playbook:

> Name access-control when a check is present and reachable but does not bind the
> resource or the function to the identity of the caller. These classes are not
> mutually exclusive: the bullets above tell you when a *different* class also
> applies, not when to drop this one. If the same trace establishes more than one
> class, name them all.

**As shipped (decided 2026-07-28): the whole section was deleted, not reworded.**
All 14 playbooks lose `## Distinguishing From Adjacent Classes` in full — bullets
and closer alike — returning them to their run-1 shape, 22% smaller (49,137 →
38,061 chars). The multi-class instruction now lives only in the executor prompt,
strengthened to carry it alone:

> List every class from your assigned classes list that this finding establishes.
> There is no limit on how many, and the classes are not mutually exclusive —
> naming one never rules out another.
>
> Do not hold back. If you have some or enough evidence that more than one
> assigned class is involved, name them all. One statement is often several
> classes at once… Choosing the single best label discards the others and gains
> nothing — a class you can see and do not name is a class you did not find.

The targeted work from `95cd259` is unaffected — misconfiguration keeps its sweep
procedure and insecure-design its de-suppressed scope line, since neither lived
in the deleted section.

**Known risk accepted with this choice.** misconfiguration (7/17 → 10/17) and
insecure-design (2/12 → 5/12) were the only two classes to improve in run 2,
and both had targeted adjacency bullets. Deleting the section may give part of
that back. Watch those two classes specifically; if they regress, the bullets
were carrying real guidance and should return without the singular closer.

**Targets:** 12 of 15 `CATEGORY_MISS` and 12 of 16 `FILE_ONLY` — ~24 of 66 misses
sit one label away from a hit, with position already correct.

**Verification:** hedging rate must rise from 1.240; co-label share must rise per
class; scored recall must converge toward category-blind recall (47 entries), which is
the ceiling this change can reach. If hedging rises and scored recall does not,
the labels are wider without being righter and the change should be reverted.

#### Result — run 3, `c9e3e94`. Criteria met; do not revert. Two corrections.

Measured in isolation against run 2: Stage 0.5's `lanes[]` is byte-identical, so
nothing upstream moved.

| Criterion | Required | Measured |
|---|---|---|
| Hedging | rise from 1.240 | **1.538** |
| Co-label share | rise per class | **rose in 10 of 12** (fell only `logging-monitoring` 35%→21%; `ssrf` flat at 0%) |
| Recall converges on category-blind | — | **gap 15.3 → 3.1 points** |

Recall 32/97 → 49/97, localization 57/97 → 73/97. The revert condition did not
trigger.

**Correction 1 — "the ceiling this change can reach" was wrong, because F1 was
not label-only.** Category-blind recall was expected to stay at 47 entries; it rose
to 52 (48.5% → 53.6% on the 97 basis), with findings 354 → 407 and producing lanes 228 → 250. Deleting the whole
section removed 22% of playbook text, which changes what the model *hunts for*,
not only how it labels. The "adds no detection" prediction was inherited from the
reword proposal and does not hold for the delete. **A section deletion is never a
pure labelling intervention — budget for a detection delta whenever prompt volume
moves.**

**Correction 2 — most of the headline is one line.** The 49 hits span 23 distinct
locations against run 2's 32 over 24. The benchmark's 11-entry location went 1/11
→ 11/11, which is 10 of the 17-point gain; `crypto-auth` 0/25 → 19/25 is
predominantly the same line. Excluding it, recall rose 31/86 → 38/86 (+8.2
points) — real, broad, and about half the headline. This is exactly the failure
mode `eval-howto.md` warns about, in the direction that flatters the change.

**The foreseen regression landed.** misconfiguration 10/17 → 8/17,
insecure-design 5/12 → 4/12, with category-blind localization holding in both.
Per the paragraph above, the bullets carried real guidance. **Next action: restore
the misconfiguration and insecure-design adjacency bullets without the singular
closer** — F3, below the line. Restoring them everywhere would re-run the run-2
experiment; restoring them in the two classes that measurably lost is the smaller
test.

**Cost.** Precision proxy 20.3% → 18.4% category-blind, with no v2 validator to
recover it. Findings below confidence 0.7 rose 109 → 131.

### F3 — Force a per-class sweep before findings — **FAILED (run 4), REVERTED**

**Files:** `stage2-hunt-lanes-perfile/src/hunt-executor.ts`, `.../types.ts`.

**The gap F1 could not close.** F1 drained `CATEGORY_MISS` 15 → 3 but barely moved
`FILE_ONLY` 16 → 13, and the two buckets fail for different reasons. F1's
instruction reads *"List every class ... that **this finding** establishes"* and
sits in the Output Format block — it is a **serialization** rule, applied to a
finding that already exists. `CATEGORY_MISS` is a serialization failure, so F1
fixed it. `FILE_ONLY` is a **hunting** failure: no finding of that class was ever
formed, and no serialization rule can conjure one.

The only per-class sweep anywhere in the prompt was the empty-array guard —
*"If you are about to return an empty array, re-read the file once against your
assigned class list"* — which fires **only when zero findings are emitted**. All
13 `FILE_ONLY` lanes emitted at least one finding, so it never ran for any of
them.

**The scale of what is not being checked.** Across 541 hunt lanes Stage 0.5
assigns **3,005 lane-class pairs; only 503 produced anything — 16.7%.** Utilisation
per producing lane is 0.310, and **0 of 250** producing lanes emitted every
assigned class. Today "checked and clean" and "never looked" are indistinguishable,
which is why neither the playbooks nor Stage 0.5's assignment can be tuned.

| class | assigned | emitted | used |
|---|---|---|---|
| logging-monitoring | 541 | 32 | 5.9% |
| misconfiguration | 541 | 88 | 16.3% |
| insecure-design | 541 | 103 | 19.0% |
| injection | 213 | 20 | 9.4% |
| ssrf | 156 | 6 | 3.8% |
| vulnerable-components | 4 | 0 | 0.0% |

**The change, in three parts.** All three are required; any one alone fails.

1. **Schema — `class_sweep` declared *first*, before `findings`.** The ordering is
   the mechanism, not decoration. Generation is autoregressive, so a sweep emitted
   first means the findings are generated *conditioned on* those verdicts.
   Declared last it is post-hoc narration: observable, but changing nothing.
   Each entry is `{class, verdict: found|absent, evidence_line, reason}`.
   `evidence_line` is 0 when absent — `strict` mode forbids optional fields.
2. **Prompt — a procedure with an order**, replacing the empty-array guard:
   work the assigned list in order, one verdict per class, `absent` requires
   naming the construct examined *in this file*, findings only after every class
   has a verdict.
3. **Mechanical invariants**, recorded per lane in `class-sweep.json`:
   `missing_classes`, `offlist_classes`, `duplicate_classes`,
   `inconsistent_classes` (named in a finding but not swept `found`),
   `found_without_finding`. **Recorded, not enforced** — dropping findings on an
   inconsistent sweep would move recall for a reason unrelated to the hypothesis.
   Enforce once the base rates are known.

**The ordering assumption was verified, not assumed.** A single live lane against
`gpt-5.6-luna` returned key order `class_sweep, findings` (indices 1 and 1116),
all assigned classes swept, and `absent` reasons that cite specific lines. Had the
provider reordered keys, the fallback is a two-call design — sweep, then findings
conditioned on it — which costs roughly double the input.

**Cost.** Sweep output is ~110–170 tokens/lane on top of ~709, so ≈ +$0.35–0.55
against run 3's $5.48. Output tokens ~+20%; input essentially unchanged.

**Verification, and the control that decides attribution:**

- utilisation must rise from **0.310**; `FILE_ONLY` must fall from **13**
- category-aware localization should rise toward **86**, and **category-blind
  localization must stay flat at 86** — 86 is the arithmetic ceiling for
  labelling-only work (the blind−aware gap of 13 is exactly
  `9 FILE_ONLY + 3 CATEGORY_MISS + 1 LINE_MISS_FAR`). **If category-blind
  localization also rises, the change added detection and the result is confounded
  — report it that way rather than claiming a clean labelling win.** This is
  precisely the trap F1 fell into.
- precision proxy is 11.8% category-aware with no v2 validator to recover it;
  forcing consideration of every class will raise emission. Watch it with hedging
  and co-label share.
- **Revert if** utilisation rises but `FILE_ONLY` does not — the sweep is being
  filled in without changing what is hunted.

**Second-order value.** A class swept `absent` in ~95% of the lanes it is assigned
to is being over-assigned by the signal→class map, and can be dropped from those
lanes to reclaim prompt budget. `logging-monitoring` (5.9%) and `ssrf` (3.8%) are
the first candidates — but only the sweep distinguishes over-assignment from
under-hunting. The `found` verdicts with line citations should also be useful to
the patcher; treat `absent` reasons more carefully, as they are unverified claims.


#### Result — run 4, `bab0ad2`. Hypothesis falsified. **Reverted 2026-07-29.**

The schema, prompt and invariants were reverted to run 3's source
(`hunt-executor.ts` and `types.ts` restored from `c9e3e94`, byte-identical), and
`runs/luna/` was restored to run 3's archived artifacts. **Run 3 is the baseline
for both architecture and results.** Run 4's artifacts, logs, eval JSON and
`class-sweep.json` are preserved in the answer-key repo under
`runs/2026-07-29T02-23Z__stage0-2-v2-perfile-F3__luna__bab0ad2/` — the sweep file
holds the model's explicit per-class reasoning for all 3005 lane-class pairs and
is the most detailed record of *why* a class was declined that this project has.

**The mechanism worked perfectly and changed nothing.** Sweep conformance across
541 lanes: **3005/3005 lane-class pairs swept (100%)**, zero `missing`,
`offlist`, `duplicate`, `inconsistent` or `found_without_finding`. Per-class
coverage went from an implicit ~17% to an explicit 100%.

**`FILE_ONLY` did not move: 13 → 13.** Not one entry converted.

| Bucket | Run 3 | Run 4 | | Metric (97 basis) | Run 3 | Run 4 |
|---|---|---|---|---|---|---|
| HIT | 49 | **29** | | Recall | 50.5% | **29.9%** |
| CATEGORY_MISS | 3 | **21** | | Localization | 75.3% | **49.5%** |
| LINE_MISS_NEAR | 24 | 18 | | Loc, cat-blind | 88.7% | 81.4% |
| LINE_MISS_FAR | 8 | 15 | | Findings | 407 | 311 |
| FILE_ONLY | 13 | **13** | | Utilisation | 0.310 | **0.267** |
| NOT_FOUND | 0 | 1 | | Cost | $5.48 | **$6.46** |

The stated revert criterion was "utilisation rises but FILE_ONLY does not".
Utilisation did not even rise — it **fell**, 0.310 → 0.267. Unambiguous revert.

**`LINE_MISS_NEAR` 24 → 18 is not a gain.** It is drainage downward: of run 3's
24, only **1** improved to HIT, while **6** fell to `LINE_MISS_FAR` and **2** to
`FILE_ONLY`. Run 4's 18 even contains **2 entries that fell from HIT**. Across the
whole benchmark the run-3 → run-4 movement is **3 improved, 64 unchanged, 30
worsened** — run 4 gained on no dimension. A bucket shrinking is only good news
when its entries moved *up*; always check the transition, not the count.

**Why it failed — two mechanisms.**

1. **The sweep gated instead of checking.** `inconsistent_classes` and
   `found_without_finding` are both 0 everywhere: verdicts and labels are in
   perfect lockstep. Requiring that any class in a finding be swept `found` turned
   a cheap early "absent" into a hard block on labelling that class later. The
   sweep **replaced** the model's richer implicit consideration with a cheaper
   explicit one and locked in the result — only 372/3005 pairs (12.4%) came back
   `found` against run 3's 503 (16.7%) actually emitted. `CATEGORY_MISS` 3 → 21
   and `crypto-auth` 19/25 → 1/25 are the damage.
2. **F3 also deleted the anti-suppression nudge** ("Most files in a real
   application do contain something…") and replaced it with text legitimising
   empty output. Findings 407 → 311, producing lanes 250 → 202. **A second
   variable inside a change billed as single-variable** — a self-inflicted
   confound; part of the regression is not attributable to the sweep.

**What this eliminates.** `FILE_ONLY` is *not* a coverage failure. The model does
consider every assigned class when told to, and still does not produce the
finding. So the remaining explanations are that the playbook does not describe
the shape well enough for that file, or the defect needs cross-file context the
per-file lane cannot supply. **Neither is addressable by prompt sequencing**, which
retires that whole family of interventions.

**What to keep.** The instrumentation, made **non-binding**: keep
`class-sweep.json` and the five invariants, drop the "any class in a finding must
have been swept `found`" rule, and restore the emission nudge. That preserves the
Stage 0.5 feedback signal (a class swept `absent` in ~95% of its lanes is
over-assigned) at no measured cost, since conformance was already perfect.

**Process lesson.** Two prompt edits shipped as one change and the confound was
only spotted mid-run. When editing prompt text, diff it and count the *behavioural*
edits, not the commits.

### F2 — Anchor access-control to the authorization decision

**File:** `stage2-hunt-lanes-perfile/src/playbooks/access-control.ts`.

Access-control is the one class whose misses are **not** the labelling problem.
4 of 16 hit; the other misses are spread by line: deltas
`16, 16, -63, 21, -25, 3, 2, -1, 14`, only 4 of 9 within ±15. The model is
pointing at a different construct, not a neighbouring line.

The cause is structural. An access-control defect is an *absence* — a check that
should exist and does not — so there is no sink to anchor on. The playbook's
Hunting Discipline step 4 asks for "the absence of a per-resource ownership check
between lookup and response" and then says nothing about which line to cite for
an absence. The model lands on whatever it can trace: sometimes the route
registration far above, sometimes the mutation far below. The signed deltas run
both ways, which is what an unanchored choice looks like.

**The change.** Add a "Which line to cite" section (full before/after in the
commit). Substance: cite the line where the authorization decision **is made or
should have been made** — the route registration if the guard belongs in the
middleware chain, the handler's first statement if it belongs at entry, the
lookup call itself if it should have carried an owner predicate — never the
response, the mutation, or the enclosing declaration.

**Expected gain is bounded and should be stated honestly:** at most the 4
near-misses plus some of the 5 far ones, so 25% → perhaps 50–55% for this class,
worth ~4–6 points of overall recall. The far misses may not move at all — a
63-line error is not a specificity problem.

**Verification:** access-control's signed-delta spread must narrow; its
`LINE_MISS_FAR` count must fall. Recall for the class is the goal, but the delta
spread is the diagnostic, because recall can move for unrelated reasons.

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

### D2 — Raise emission rate — **RETIRED, see the run-2 entry below**

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
a confound. The 2–3-finding bucket's 54.9% is substantially **one file, which
produced 2 findings and carries 11 ground-truth entries at a single line**, all
11 recalled. (Which file is located evidence and lives in the answer-key repo,
`analysis/2026-07-29-localization-located.md`.) Excluding it:

| bucket | recall |
|---|---:|
| 1 finding | 31.0% (n=29) |
| 2–3 findings, as reported | 54.9% (n=51) |
| 2–3 findings, excluding that file | **42.5% (n=40)** |

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

D3's ceiling is today's localization: **65/97 = 67.0%**. It converts *localized*
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

### D5 — Zero-signal lanes: hunt or skip? — **answered; cost only, not recall**

170 of 541 hunt lanes carry only the floor set. They produced 18 of 354 findings
across 15 lanes and contain **1** ground-truth entry, which is missed anyway.
Dropping them saves 31% of Stage 2 lanes — roughly $1.80 and 6 minutes a run —
and all three floor classes remain assigned to the other 371 lanes, so nothing
is reassigned and no class is lost.

**This is a cost optimisation, not a recall change**, and it should not be
bundled with a recall run: it changes the denominator of every emission metric
and would confound the comparison. Park it until the label and line work is done.

### D2 — Emission rate — **retired, was never the bottleneck**

Run 2 settles this. 313 of 541 hunt lanes emitted nothing, and **zero
ground-truth entries live in any of them**. All 41 GT-bearing files produced
findings; 180 of the 313 silent lanes are test or spec files and 216 are frontend
components. The silence is correct behaviour.

C4 raised producing lanes 33.6% → 42.1% and bought no recall. Emission volume is
not a recall lever and should not be treated as one again.

### D6 — Revert C5 (confidence bands)

C5 produced **109** findings below confidence 0.7. They uniquely account for
**4** ground-truth entries — every other entry they touch was already hit by a
higher-confidence finding. Category-aware precision in the 0.40–0.69 band is
**5.8%** against 14.3% above 0.7.

That is ~105 false positives for 4 entries, with no v2 validator downstream to
absorb them. Precision proxy fell 15.4% → 11.9% across the run and this is a
large part of it.

Reverting restores the prompt's previous confidence sentence. The 4 entries are a
real loss and should be stated as such, but they are recoverable through F1/F2,
which cost no precision at all.

### Retired detail

The pre-run-2 D5 write-up (class-count distribution, the open question about
whether ground truth lived in a zero-signal file) is superseded. The answer is
above: one entry, and it is missed regardless. Figures there predate C1 and used
a 4-class floor; the floor is now 3.

Still true and worth keeping: `categories[]` is dead weight in v2 — all 541 lanes
receive the identical 25-code list and no lane used the categories fallback path.
Narrowing happens entirely through `classes[]`.

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

- **The denominator is 97, and the ceiling is 97/97.** `data/datacreator.ts` is
  denylisted and holds one ground-truth entry that no finding can ever cite. As
  of 2026-07-29 that entry is excluded from every ground-truth denominator rather
  than scored as a permanent miss — so a perfect run reads 97/97, not 97/98. Do
  not "fix" recall by re-hunting it; the fix was to stop counting it.
- **Comparability.** The next run must be diffed against
  `scanner-2026-07-28-luna-a`, not against `scanner-2026-07-27-a/-b` — those
  were not blind. Report hedging rate alongside any recall figure.
- **One change per run, or the attribution is lost.** C1 and D2 pull in opposite
  directions on precision; bundling them makes the result uninterpretable.
- **The tree must be verified before the run, not after.** `git merge-base` and a
  diff against `main` are part of run setup. A dispatch prompt in
  `prompts/dispatch/` records what was asked for; only the commit graph records
  what the run will execute.

---

## TESTED 2026-07-29 — localization investigation

Full write-up and method: `../analysis/2026-07-29-localization-investigation.md`.
Located evidence: answer-key repo, `analysis/2026-07-29-localization-located.md`.

### P1 — Add cross-site scripting to the `injection` playbook — **WORKS, not shipped**

The playbook claims to cover A03 "all variants" and contains no XSS content.
OWASP 2021 merged XSS into A03 (CWE-79); every XSS entry in the benchmark is
coded A03. Stored XSS is the widest part of the gap: the defect is introduced at
the persistence point while the render sink sits in a file the lane cannot see.

Measured (arm `expc`, real Luna run, 217 lanes, 92 entries): `injection`-class
localization **14/18 → 18/18**. Hedging unchanged.

### P2 — Add open redirect to the `ssrf` playbook — **WORKS, not shipped**

The playbook covers A10 but is written entirely around outbound requests, with
nothing on redirect destinations or weak allow-list matching (substring, prefix,
suffix, unanchored pattern).

Measured, same arm: `ssrf`-class localization **1/3 → 3/3**.

Combined P1+P2: FILE_ONLY 13 → 4, category-blind localization 90.2% → 93.5%,
11 entries gained category-aware localization, 6 became exact-line hits,
hedging 1.550 → 1.536.

### P3 — Authentication-outcome anchor in `crypto-auth` — **WORKS, not shipped**

`crypto-auth` described defects *in* auth mechanisms only. A defect of another
class sitting on an authentication path also establishes A07. This is the lever
for the hot lines described at the top of this file.

Measured (three highest-multiplicity lanes, 4 repeats each): cells producing the
needed class at the exact line **7/12 → 11/12**. Hedging did not rise
(1.704 vs 1.800 on the same files) while findings per lane rose 1.67 → 2.25.

### W1 — Window long files into multiple lanes — **FALSIFIED**

The obvious reading of the length/recall correlation. Stage 2 already implements
multi-chunk lanes; only `SINGLE_PASS_LINE_BUDGET = 2000` stops them firing.

Tested with a matched control (arm `expa` whole-file vs arm `expb` at a 120-line
window, same 180 files, 417 chunks vs 180): findings/file +39%, trace-lines/file
+35%, files with ≥3 findings doubled — and **category-aware localization was
identical (25/42) while category-blind localization fell 76.2% → 71.4%**. The
largest file went from 6 findings to 19 and its miss count rose.

Windowing produces more findings about what the model already reports.
**Do not lower `SINGLE_PASS_LINE_BUDGET`.**

### R1 — Add A03 to `client-side`'s codes — **correct, worth zero**

`LLM05` appears zero times in the ground truth, so `client-side` findings can
never score. Adding A03 is right on the OWASP mapping. Simulated offline against
run 3: **no entry moves** — 12 of 13 `client-side` findings already co-label
`injection` and so already carry A03. Cleanup only.

### S1 — Fewer classes per lane (class-split lanes) — **WORKS, not shipped, dose untested**

Run 3 assigns 5.55 classes per lane and the model emits 2.01; no lane of 250
emitted every class it was assigned. A lane carrying eight playbooks answers
about the two or three that dominate the file.

Matched A/B on the 19 (file, needed-class) pairs run 3 failed to localize, same
playbooks and context in both arms, same inference model in both arms:

| arm | recovered | label gap | coverage gap |
|---|---|---|---|
| focused, 1 class/lane | **18/19** | 10/10 | 8/9 |
| full list, 8.26 classes/lane | 13/19 | 8/10 | 5/9 |

Focused-only wins 5, full-only wins 0. **The only tested intervention that moves
both halves of the gap**, and therefore the only route to 90%+ localization.

Cost: splitting does not multiply playbook tokens (each class playbook is
already sent once per file it is assigned to); it re-sends file content, arch
and boilerplate per class. Groups of ~3 classes 1.32x ($7.24), groups of ~2
1.62x ($8.86), one lane per (file,class) 2.47x ($13.51). Only the extremes
were measured — **measure the dose before committing to the full split**.

Caveat: the A/B was answered by a different inference model than the scanner
runs under, to keep spend down. The contrast is model-matched; the absolute
level will not transfer.
