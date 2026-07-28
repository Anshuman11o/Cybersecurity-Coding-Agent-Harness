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

### D2 — Raise emission rate: the confidence floor

This is the most promising recall lever found so far.

```
confidence distribution across all 247 findings
  0.7:   7     0.8:  43     0.9:  99     1.0:  98
  mean 0.911        below 0.5: 0        below 0.7: 0
```

**Luna emitted nothing below 0.7.** The hunt prompt explicitly says a defect
whose reachability cannot be confirmed from the file "is a real finding at
moderate confidence, not something to withhold" — and Luna withheld anyway.
There is no low-confidence tail to recover, so the misses are not sitting in the
output waiting to be un-filtered; they were never emitted.

Supporting shape:

| | |
|---|---|
| Hunt lanes producing nothing | 359 / 541 = **66.4%** |
| Findings per producing lane | 1.36 |
| Distinct classes per producing lane | 1.73 |
| Structural ceiling (schema `maxItems: 2` × 1.36 findings) | 2.71 |

So emission sits at 64% of its structural ceiling — the binding constraint is
**findings per lane**, not the two-class cap. The schema is not what is limiting
output.

Directions, none yet chosen:
- Prompt change explicitly requesting moderate-confidence candidates, given
  Stage 3 exists to kill false positives. Recall is the scarce resource at this
  stage; precision is recoverable downstream.
- Ask for a fixed minimum number of candidate observations per lane, letting
  confidence carry the uncertainty rather than suppression.
- Re-check `samplingParams` — `luna` declares empty sampling (GPT-5.x rejects
  non-default values inconsistently), so there is no temperature lever without
  verifying the model accepts one.

**Caution:** this trades precision for recall by design. Precision proxy is
already 15.4%. Measure both, and measure the hedging rate — a recall gain that
tracks hedging is a wider net, not better detection.

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

## Constraints any change must respect

- **The 97/98 ceiling stands.** `data/datacreator.ts` is denylisted and holds
  one ground-truth entry. Do not "fix" recall by re-hunting it.
- **Comparability.** The next run must be diffed against
  `scanner-2026-07-28-luna-a`, not against `scanner-2026-07-27-a/-b` — those
  were not blind. Report hedging rate alongside any recall figure.
- **One change per run, or the attribution is lost.** C1 and D2 pull in opposite
  directions on precision; bundling them makes the result uninterpretable.
