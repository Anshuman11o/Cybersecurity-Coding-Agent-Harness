# Verification techniques — candidate catalogue

**Status: UNVALIDATED.** Nothing here has been run. This is the menu of checks a
patcher/verifier *could* use in-sandbox, recorded so the choice can be made
empirically rather than by assumption. Expect to adopt some, combine several,
and discard the rest.

These are all **blind** checks — available inside the working copy, using no
answer-key material. They are what the patcher verifies *itself* with. They are
not the scorer; the scorer is `README.md` §5 and runs sighted, afterwards.

---

## The asymmetry to design around

The split removed the exploit oracle from the working copy. The consequence is
permanent and shapes everything below:

> **The patcher can *prove* it did not break anything.
> It can only *argue* that it fixed something.**

Functional verification is measurement — run the suite, diff against baseline,
count. Vulnerability verification is inference from the shape of the change,
unless one of V1–V6 below turns out to work.

Two design rules follow:

1. The verifier's report must **separate measured from argued**. Never let an
   argued remediation claim inherit the confidence of a measured regression
   result.
2. `uncertain` must stay a first-class verdict. "Workflow intact, remediation
   unproven" is the *correct* answer in many cases; scoring it as failure trains
   overclaiming, which is exactly what False Confidence Rate penalises.

---

## Axis F — Functionality ("did I break anything?")

Strong, cheap, and genuinely measured. This axis is close to solved.

| # | Technique | Command | Strength | Cost |
|---|---|---|---|---|
| **F1** | **Compile** | `npm run build` (tsc + frontend) | Deterministic, binary | Low |
| **F2** | **Differential suite run** | full suite pre-patch vs post-patch | **Strongest available** | Med |
| **F3** | Frontend unit specs | `npm run test:frontend` — 120 spec files | Strong | Med |
| **F4** | Server + API suites | `npm run test:server`, `test:api` | Strong | Med |
| **F5** | E2E | `npm run test:e2e` (cypress) | Moderate — flaky | High |
| **F6** | Lint | `npm run lint` | Weak, cheap | Low |
| **F7** | Smoke / boot | `test/smoke/smoke-test.sh` | Liveness gate | Low |

### F1 — Compile
Gate, not a metric. A patch that does not compile makes every other result
meaningless. Run first; on failure, emit `BUILD_FAILED` and stop.

### F2 — Differential suite run
**The one genuinely strong self-check the patcher has.** It holds both the
pre-patch and post-patch trees, so it can compute its own honest regression
number with no ground truth at all:

```
regressed = { it() : baseline PASS and post-patch FAIL }
```

This is real measurement. Make it the verifier's primary output. Note it is the
same computation the scorer uses for FRR — so the patcher's self-reported
regression figure can be checked directly against the scorer's, giving a clean
read on verifier honesty on at least one axis.

### F3 — Frontend unit specs
120 spec files the splitter never touched, so entirely intact. The largest
single block of functional coverage available and the cheapest strong signal
after F1. Angular component units; fast; low flake.

### F4 — Server + API
The functional halves left behind by the split. Directly paired with the
exploit halves the scorer will restore, which makes them the natural
per-case workflow oracle.

### F5 — E2E
Highest fidelity to real user workflows, highest flake and cost. Recommend
running at baseline (3× for flake detection) but treating per-case E2E results
as advisory unless a case has no other workflow coverage.

### F6 — Lint
Catches nothing security-relevant here — no security ESLint plugin is
configured. Keep it for hygiene; do not weight it.

### F7 — Smoke / boot
Docker boot check. Catches the class of patch that compiles and passes units but
prevents the app from starting. Cheap insurance.

---

## Axis V — Vulnerability ("did I actually fix it?")

Weak by construction. **All of these are candidates, none are proven.**

| # | Technique | Mechanism | Est. strength | Ships in working copy? | Setup needed |
|---|---|---|---|---|---|
| **V1** | **Differential self-PoC** | patcher's exploit: pre-patch MUST succeed → post-patch MUST fail | Moderate | n/a | none |
| **V2** | Payload-family probe | a family of payload variants, not one | Moderate–strong | n/a | generator |
| **V3** | `npm audit` differential | CVE count by severity, before/after | **Strong, deterministic** | ⚠️ needs lockfile | pin lockfile |
| **V4** | CodeQL differential | `security-extended` alert count, before/after | Strong | ✅ `.github/workflows/codeql-analysis.yml` | CI or local runner |
| **V5** | ZAP baseline differential | DAST against the running app | Moderate | ✅ `.github/workflows/zap_scan.yml` | retarget to local |
| **V6** | Semgrep differential | third-party ruleset | Moderate | ✗ | add dependency |

### V1 — Differential self-PoC
The patcher writes an exploit and runs it against **both** trees:

```
PoC on UNPATCHED tree  →  MUST succeed    (proves the PoC exercises the vuln)
PoC on PATCHED tree    →  MUST fail       (proves the patch blocks it)
```

**The pre-patch success leg is the whole point.** A PoC that never demonstrably
worked proves nothing — it may be failing for unrelated reasons (wrong endpoint,
bad auth, typo). Requiring it converts hand-waving into evidence. Costs nothing
extra; both trees are already available.

*Residual weakness, unfixable:* the patcher chooses the payload, so it can pick
one it knows its own fix blocks. This is precisely the gap FCR measures.

### V2 — Payload-family probe
Instead of one payload, generate a family spanning encodings, nesting, casing,
and alternate sinks for the same class. Harder to game than V1 because the
patcher must anticipate variants it did not write the fix against. Reduces but
does not remove the self-selection bias.

Open question for the experiment: does family generation actually surface
signature-based fixes (blacklisting a token) versus structural ones
(parameterising a query)? If yes, this is the most valuable item on the list.

### V3 — `npm audit` differential
A real, deterministic vulnerability oracle. For any dependency/A06 fix, the CVE
count before and after is a **direct measurement**, not an inference — the only
item on this axis that can say so.

**Blocker:** no `package-lock.json` is committed in the working copy (only
`ftp/package-lock.json.bak`, which is a challenge artifact). A lockfile must be
generated and pinned **before** baseline capture, or the counts are not
comparable across runs.

Narrow scope — only helps the dependency-shaped subset of cases.

### V4 — CodeQL differential
Already configured in the working copy with `security-extended` queries. Running
it pre/post gives an alert-count differential from a third-party ruleset the
patcher did not author, which makes it meaningfully independent of the patcher's
own reasoning.

Note the workflow carries `paths-ignore: data/static/codefixes` — a dangling
reference to a directory the split removed. Harmless, but a hint that the config
predates the split.

### V5 — ZAP baseline differential
DAST. Requires the app running, so it is the most expensive item here, but it
observes actual runtime behaviour rather than source patterns — the only
candidate that does. The shipped workflow targets a hosted preview instance and
would need retargeting at a local container.

### V6 — Semgrep differential
Not shipped; would need adding. Included for completeness because it is cheap to
run and rule-transparent, which makes failures easy to explain.

---

## Two cautions before adopting V4 / V6

**Correlated oracle.** CodeQL and Semgrep are the *same class of tool* as the
scanner being evaluated. If the scanner found something CodeQL also finds,
CodeQL confirming the fix is weaker evidence than it appears — they share blind
spots. Different implementations, so still informative, but do not treat it as
independent confirmation.

**This is a capability decision, not just a verification one.** Giving the
patcher CodeQL / ZAP / Semgrep changes what is being benchmarked: "LLM patcher +
static analysis + DAST" is a different system from "LLM patcher". That may be
the system you want. It must be a deliberate choice recorded in the run
metadata, not something that creeps in through the verification layer.

Record the adopted set explicitly in every run record, e.g.:

```json
"verification_stack": { "functionality": ["F1","F2","F3","F4"],
                        "vulnerability": ["V1","V3"] }
```

Two runs with different stacks are not comparable.

---

## How to validate these empirically

The point of this catalogue is that the choice should be **measured**, not
argued. Once the scorer exists, every technique can be scored against scorer
truth, because the scorer knows the real verdict and the technique does not.

For each technique, over a case set:

| Quantity | Meaning |
|---|---|
| **Detection rate** | of cases the scorer marks `NO_FIX`, what fraction did this technique flag? |
| **False alarm rate** | of cases the scorer marks `EFFECTIVE_FIX`, what fraction did this technique flag anyway? |
| **Coverage** | fraction of cases where the technique produced *any* signal (V3 will be low) |
| **Cost** | wall-clock and tokens per case |
| **Marginal value** | detection gained when added to an existing stack — the number that matters for combinations |

Marginal value is the one to optimise. A technique with a high standalone
detection rate that flags only cases an existing technique already catches adds
nothing but cost.

Suggested first experiment, once the scorer and a case set exist:

1. Run the patcher once. Freeze its patches.
2. Score with the sighted scorer → ground truth verdicts.
3. Replay **each** technique independently against the same frozen patches.
4. Build the table above, then search combinations for best marginal value.

Replaying against frozen patches is what makes this cheap: one patcher run, N
technique evaluations.

---

## Recording results

When a technique is validated or rejected, update its row here with the measured
numbers and a verdict — `ADOPTED`, `REJECTED`, or `CONDITIONAL` — plus the run
id the finding came from. This file should become the record of what was tried,
not just what was imagined.
