# Run analysis — 2026-07-27, commit `fb1c7ed`

Stage 0 → 0.5 → 1 → 2, all fresh. 553/553 lanes, zero failures, 549 findings,
4,095,795 tokens. Scored against 98 ground-truth entries.

Companion to `scanner-architecture-and-eval-report.pdf`, which carries the
history across all runs. This file explains one run in depth.

---

## 1. Where the recall misses go

Recall requires file match, the **exact** line, and a category intersection.
41/98 = 41.8%. The 57 misses decompose into five mutually exclusive buckets:

| Bucket | n | % of 98 | % of misses | What it means |
|---|---|---|---|---|
| **HIT** — exact line + category | 41 | 41.8% | — | counted |
| **MISS-1** — category right, off by 1–3 lines | 14 | 14.3% | **24.6%** | found it, named the wrong line |
| **MISS-2** — category right, off by 4–15 lines | 4 | 4.1% | 7.0% | same, further away |
| **MISS-3** — wrong class, a *floor* class took it | 8 | 8.2% | 14.0% | label noise |
| **MISS-4** — wrong class, two non-floor confused | 22 | 22.4% | **38.6%** | genuine class confusion |
| **MISS-5** — right file, >15 lines away | 9 | 9.2% | 15.8% | found the file, not the defect |

Two facts follow directly.

**18 of 57 misses (31.6%) are line-precision, not detection.** The scanner found
the right code and assigned the right class; it named a line 1–15 away from the
one ground truth chose. 14 of those are within **three lines**.

**30 of 57 (52.6%) are labelling.** The code was located within 15 lines and the
class was wrong. Every one of those 30 had the correct class present in its
lane's narrowed set, so narrowing removed none of them — the model chose wrong
from a set containing the right answer.

Detection proper — MISS-5 plus anything unfound — is 9 of 57. File-level
coverage is 98/98.

---

## 2. Token usage

| | tokens | share |
|---|---|---|
| **Input** | 3,786,854 | 92.5% |
| **Output** | 308,941 | 7.5% |
| **Total** | **4,095,795** | |

### Input by prompt segment

| Segment | tokens | % of input |
|---|---|---|
| **playbooks (14 modules)** | **2,216,014** | **58.52%** |
| file content | 1,241,146 | 32.78% |
| architecture context | 220,691 | 5.83% |
| boilerplate | 98,770 | 2.61% |
| route context | 10,233 | 0.27% |

### Input by individual playbook

| Playbook | tokens | % of input | floor? |
|---|---|---|---|
| misconfiguration | 331,287 | 8.75% | **floor** |
| insecure-design | 323,061 | 8.53% | **floor** |
| logging-monitoring | 290,799 | 7.68% | **floor** |
| general-catchall | 245,621 | 6.49% | **floor** |
| injection | 210,419 | 5.56% | |
| crypto-auth | 176,777 | 4.67% | |
| access-control | 167,792 | 4.43% | |
| ssrf | 146,001 | 3.86% | |
| resource-consumption | 134,397 | 3.55% | |
| api-property-auth | 90,962 | 2.40% | |
| integrity-failures | 53,543 | 1.41% | |
| client-side | 36,108 | 0.95% | |
| ai-llm-agency | 7,570 | 0.20% | |
| vulnerable-components | 1,677 | 0.04% | |

**The four floor classes cost 1,190,768 tokens — 31.4% of all input** — because
they are attached to every one of the 553 lanes regardless of evidence.

Other measures: 1.293 tokens per byte of scanned source; 6,479 tokens of
boilerplate re-sent across multi-chunk lanes; one lane
(`frontend/src/assets/private/three.js`, a vendored library with no application
logic) cost 653,989 tokens, **16% of the entire run**.

Per-segment token figures are **derived** by distributing the API's reported
`prompt_tokens` across segments in proportion to their exact character counts.
Character counts are measured and reconcile to the prompt length; the token
split is an approximation, because prose and code do not tokenize at the same
density.

### Projection accuracy

Stage 1 projected **7,363,669** input tokens against **3,786,854** actual —
**1.94× too high**. A calibration defect in the estimator, not in the run.

---

## 3. Class emission versus demand

How often each class was emitted, against how often ground truth needs it, and
how many lanes offered it:

| Class | emitted | GT needs | lanes offering | emit per lane |
|---|---|---|---|---|
| access-control | 110 | 16 | 267 | **0.412** |
| client-side | 16 | 0 | 30 | 0.533 |
| integrity-failures | 27 | 3 | 82 | 0.329 |
| injection | 63 | 18 | 219 | 0.288 |
| ai-llm-agency | 3 | 4 | 13 | 0.231 |
| ssrf | 35 | 3 | 157 | 0.223 |
| crypto-auth | 52 | 25 | 241 | 0.216 |
| api-property-auth | 33 | 4 | 153 | 0.216 |
| general-catchall | 72 | **0** | 553 | 0.130 |
| insecure-design | 72 | 13 | 553 | 0.130 |
| logging-monitoring | 66 | **1** | 553 | 0.119 |
| resource-consumption | 26 | 2 | 244 | 0.107 |
| misconfiguration | 56 | 17 | 553 | 0.101 |

`access-control` fires on 41% of the lanes that offer it — roughly triple the
rate of any floor class — and is emitted seven times more often than ground
truth needs it. That is the old API1 default-label bias reappearing at class
level.

`general-catchall` and `logging-monitoring` together produced 138 findings
against **one** ground-truth entry.

---

## 4. What is not measurable from this run

**Precision.** 460 findings do not localize to any ground-truth entry: 25 sit in
a ground-truth file more than 15 lines away, and **435 are in files with no
known vulnerability**. The benchmark covers 98 of the target's ~113 challenges,
so an unknown share of those 435 are real findings outside it. The precision
proxy fell from 24.9% to 16.2%, but calling that a precision regression would
overstate what the number can support. Settling it needs either a hand-audit of
a sample or Stage 3, which is not yet in the pipeline.

**Attribution.** Five changes landed in this run together — the vulnerability
class model, per-lane route context, architecture context, the reporting
threshold, and signal narrowing. No single one can be credited or blamed.

**Generalization.** The signal-to-class map was corrected after the pre-flight
gate failed at 24/98, and the gate reads ground truth. Every correction was
stated as a general property of the class rather than a per-file patch, which
limits the effect without eliminating it. These numbers are fitted to this
target until the harness is run against an application it has never seen.
