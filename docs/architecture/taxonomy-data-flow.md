# Taxonomy data flow — signals, classes, codes

Four vocabularies move through this pipeline, and they are not
interchangeable. This document defines each one, names the file that owns it,
and traces where it is produced and consumed stage by stage.

Companion to `vulnerability-class-model.md`, which argues *why* the class model
exists. This one is about *where the data goes*.

---

## 1. The four vocabularies

| Vocabulary | Count | Owner file | What it describes |
|---|---:|---|---|
| **Signal** | 15 | `stage0-recon/src/signal-detector.ts` | a capability a file demonstrably has |
| **Class** | 15 | `shared/vuln-classes.json` | the unit of meaning; one playbook each |
| **Code** | 26 | `shared/vuln-classes.json` | OWASP label; an alias, never a unit of work |
| **Signal→class map** | — | `shared/signal-classes.json` | which classes a signal makes worth hunting |

They are deliberately separate. A signal is evidence about a **file**; a class
is a hypothesis about a **defect**; a code is a **name** for reporting. Collapsing
any two of them has caused a real defect in this project before.

### Signals (15)

`route_handler`, `db_query`, `model_schema`, `model_write`, `http_outbound`,
`auth_check`, `crypto_op`, `html_sink`, `dynamic_exec`, `deserialize`,
`file_io`, `llm_call`, `logging`, `config_file`, `dep_manifest`

Detected **deterministically** — regex and AST over file text, no model call, no
cost. A signal asserts only *"this file does X"*, never *"this file is
vulnerable."* Absence of signals is not a claim of safety: 349 of 918 files
carry zero signals and still receive the floor classes.

### Classes (15) and codes (26)

One class ≡ one playbook ≡ one lowercase-kebab id, and the playbook's filename
is the class id. Every code belongs to exactly **one** class, so the mapping is a
partition, not a lookup with overlaps.

| Class | Codes |
|---|---|
| access-control | A01, API1, API5 |
| crypto-auth | A02, A07, API2 |
| misconfiguration | A05, API8, API9 |
| ssrf | A10, API7 |
| ai-llm-agency | LLM01, LLM02, LLM03, LLM06, LLM10 |
| injection | A03 |
| insecure-design | A04 |
| vulnerable-components | A06 |
| integrity-failures | A08 |
| logging-monitoring | A09 |
| api-property-auth | API3 |
| resource-consumption | API4 |
| sensitive-business-flows | API6 |
| general-catchall | API10 |
| client-side | LLM05 |

Codes appear at exactly **two** boundaries — Stage 0's applicability output
coming in, and a finding's `categories[]` going out. Nowhere between.

---

## 2. Two axes of multiplicity — keep them apart

These are independent, and conflating them produces wrong conclusions.

**Axis A — alias breadth (within one class).** `access-control` carries A01, API1
and API5 because those three OWASP labels name the same defect from three
taxonomies. This is a naming fact. It costs nothing and means nothing about
difficulty.

**Axis B — genuine cross-class multiplicity.** One line can honestly be several
*different* classes: a handler that both concatenates caller input into a query
and fails to bind the record to its owner is injection *and* access-control.
This is a reasoning fact. It carried a cap of two until 2026-07-28; it is now
bounded only by the lane's assigned classes and by the requirement that each
class cite a trace step.

A class carrying many codes is **not** more likely to be confused with its
neighbours. Measured on the 2026-07-27 run, 16 of the 30 mislabelled entries had
a single-code class as the victim, and two of the four worst false attractors —
`injection` and `integrity-failures` — carry one code each. Axis A does not
predict Axis B. This is why the adjacent-class disambiguation sections were added
to all 15 playbooks rather than only the five multi-code classes.

---

## 3. Stage by stage

### Stage 0 — Recon

*Produces signals and codes. Consumes neither.*

| Artifact | Vocabulary | How |
|---|---|---|
| `file-signals.json` | signals | deterministic, per file, all 918 |
| `category-applicability.json` | **codes** | LLM probe, present/absent/uncertain per code |
| `architecture-summary.json` | — | route table, persistence map, dependencies |

This is the only stage that emits raw OWASP codes as a *judgement*. It is one of
the two code boundaries.

### Stage 0.5 — Lane Selector (per-file)

*Consumes signals + codes. Produces classes.*

One lane per file. For each file:

```
classes(file) = floor ∪ ⋃ { signal-classes[s] : s ∈ signals(file) }
```

The **floor** — `insecure-design`, `logging-monitoring`, `general-catchall`,
`misconfiguration` — attaches to **every** lane unconditionally. These four are
absences or settings rather than code shapes, so no signal can evidence them and
narrowing them away would make them unreachable.

Current distribution over 553 hunt lanes:

| classes | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| lanes | 176 | 28 | 113 | 30 | 74 | 53 | 55 | 18 | 5 | 1 |

Coverage ledger: 918 inventory = 553 hunt + 365 skip, 0 unaccounted. The ledger
is the guarantee that narrowing never silently drops a file.

The lane also carries `signals`, `class_basis` (which signal justified which
class) and `categories` (the alias codes, for legacy consumers).

### Stage 1 — Budget Governor

*Consumes classes. Produces no taxonomy.*

Projects per-lane input cost from that lane's **actual assigned classes** ×
playbook byte size × file bytes × chunk count. Classes are a cost driver here
and nothing more — the governor never reasons about what they mean.

### Stage 2 — Hunt Lanes (per-file)

*Consumes classes. Produces classes, then converts to codes on the way out.*

Each lane's prompt contains one playbook per assigned class. The response schema
is built **per lane**, with the class enum restricted to that lane's classes — so
the model cannot name a class it was not given:

```ts
finding_classes: {
  type: 'array', minItems: 1,          // no upper bound since 2026-07-28
  items: { properties: {
    class:             { type: 'string', enum: classIds },   // this lane's classes
    justified_by_step: { type: 'integer' } } }
}
```

On emit, `unionCodesForClasses()` expands the chosen classes to the union of
their alias codes and writes that to `categories[]` — the second and last code
boundary. There is **no** silent fallback: a finding whose classes expand to an
empty code set is a fatal error, not a defaulted label.

The class count is Axis B, and it is not a limit on how many *codes* a finding
carries — a single `access-control` finding already emits three.

### Evaluation

*Consumes both, and must be told which.*

| Tool | Uses |
|---|---|
| `preflight_class_coverage.py` | classes — offline, zero-token check that every ground-truth entry's class is still reachable in its file's lane |
| `score_scanner.py` | codes for matching; classes for per-class recall and hedging rate |

Two guards matter here. `MIN_CODE_EXTRACTION_RATE = 0.95` refuses to score if
`categories[]` stops holding code strings — a schema fault otherwise reads as a
reasoning collapse. And `--alias-expand` widens both sides to full class alias
sets, which is **required** for any comparison spanning the class-model boundary
(before/after 2026-07-27); without it the newer run wins partly by labelling
consistently.

---

## 4. Invariants

1. Every code belongs to exactly one class. `vuln-classes.json` is the only
   place this is written down; TypeScript and Python both read it, so they
   cannot drift.
2. Playbook filename ≡ class id. No exceptions, no aliases.
3. Codes appear only at the two boundaries named above.
4. The floor is never narrowed away.
5. The coverage ledger must balance: hunt + skip = inventory, unaccounted = 0.
6. A finding's `categories[]` is derived, never chosen. It is a pure function of
   `finding_classes[]`.
7. Adding a code means editing `vuln-classes.json` only. Adding a **class** means
   a new playbook, a new `signal-classes.json` entry, and a re-run of the
   pre-flight gate.

---

## 5. Cross-references

- `docs/architecture/vulnerability-class-model.md` — why the model exists
- `docs/architecture/perfile-lane-contract.md` — the per-file lane shape
- `docs/architecture/dual-model-architecture.md` — provider isolation
- `tools/scanner/shared/vuln-classes.json`, `shared/signal-classes.json`
