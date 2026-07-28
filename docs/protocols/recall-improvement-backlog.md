# Recall-improvement backlog

Running list of changes proposed between the `scanner-2026-07-28-luna-a` baseline
and the next run. **Nothing here is implemented.** Items move to CONFIRMED only
on an explicit decision; everything else is a candidate with its evidence
attached so the decision can be made on numbers rather than intuition.

Baseline being improved on: recall **37/98 = 37.8%**, localization 66.3%,
file-level 94.9%, precision proxy 15.4% category-aware, cost $4.64.

---

## CONFIRMED

### C1 — Drop the `general-catchall` class

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
- **H3 — single pass.** One call per lane, no iterative deepening, so whatever
  the first pass surfaces is the whole output.

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

### D3 — Exact-line attribution *(user has flagged this as the next focus)*

Where the 61 misses actually go:

| cause | share of misses |
|---|---:|
| **Line precision** — right class, right file, wrong line | **55.7%** |
| Category mislabelling — right place, wrong label | 23.0% |
| Wrong place entirely (file-only) | 13.1% |
| Genuinely not found | 8.2% |

Only **5 of 98** entries had no finding anywhere in their file. 93 were located
to the right file. Recall would be **66.3%** at ±15 lines instead of exact, and
**80.6%** if labelling were also perfect.

Worst offenders on line precision specifically:

| class | localized | recalled | lost to line alone |
|---|---:|---:|---:|
| `access-control` | 12/16 | 4/16 | 10 |
| `crypto-auth` | 23/25 | 11/25 | 12 |
| `api-property-auth` | 4/4 | 1/4 | 3 |
| `ai-llm-agency` | 3/4 | 0/4 | 4 |

This is the single largest recoverable pool in the run.

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

## Constraints any change must respect

- **The 97/98 ceiling stands.** `data/datacreator.ts` is denylisted and holds
  one ground-truth entry. Do not "fix" recall by re-hunting it.
- **Comparability.** The next run must be diffed against
  `scanner-2026-07-28-luna-a`, not against `scanner-2026-07-27-a/-b` — those
  were not blind. Report hedging rate alongside any recall figure.
- **One change per run, or the attribution is lost.** C1 and D2 pull in opposite
  directions on precision; bundling them makes the result uninterpretable.
