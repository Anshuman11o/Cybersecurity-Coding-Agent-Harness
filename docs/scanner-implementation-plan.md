# Scanner Implementation Plan — Vulnerability-Class Remediation Harness

## Context

This project (per `README.md`) is an AI coding-agent harness that scans a codebase for an
OWASP-categorized vulnerability class, fixes every real instance of that class at once, and proves
both that the exploit is closed and the app's real functionality still works. **This document
covers the scan/find half only** — the fix/verify half is future work, built after this component
is finished and approved.

**The dataset:** the proving ground is a modified OWASP Juice Shop app — `target-apps/juice-shop/`
(Node/Express/TypeScript backend, Angular frontend) plus a category-blind sibling copy,
`target-apps/juice-shop-blind/` (identical, except a config field that leaked OWASP category labels
has been neutralized — see `docs/dev-loop-protocol.md`). Juice Shop natively has 113 challenges
across 16 categories; 10 of them are elevated into a rich, hand-verified `benchmark_ground_truth`
schema (file/line, solve condition, reference fix, exploit test) held in a **separate, restricted
answer-key repo** that no scanner-building session may ever open (`docs/BLIND_DEVELOPMENT.md`). The
scanner itself must generalize to any production TypeScript web app — Juice Shop is the test
harness, not the target audience.

**The overall architecture:** Recon → Dynamic Lane Selection → Budget Governor (cross-cutting) →
Hunt Lanes → Validate → Output — five stages detailed below, arrived at from a five-tool benchmark
already run against this same app (see next section). Every stage of building this scanner is
measured against two companion, component-agnostic documents, already committed to this repo:

- **`docs/eval-framework.md`** — what gets measured for every component (precision/recall/cost/time
  and component-specific metrics), with target ranges anchored to the five-tool benchmark.
- **`docs/dev-loop-protocol.md`** — how much data a dev-time eval runs against (dataset tiers), the
  two-layer control model (temporary dev-improvement loop vs. permanent per-job runtime governor),
  and the concrete build→eval→iterate-or-stop loop every component's development follows.

Both documents are written generically and apply unchanged when the patcher/fixer and verifier are
built later — **this plan doesn't restate their content, only references it** at the points where
the scanner's own stages plug into them.

**Focus of this document:** the scanner's five stages, in enough implementation depth (exact
tool/technique, exact input/output, exact model tier, alternatives considered) to be buildable
directly. No open design questions remain below — every point that was genuinely ambiguous has
been resolved through review and is stated as a decision, not a question.

---

## Benchmark grounding (why this architecture, not another one)

A five-tool benchmark (already run, committed at `results/scan-benchmark-summary.md` and
`results/scan-benchmark-methodology.md`) scored five existing open-source AI security scanners
scan-only against the 10 hand-verified Juice Shop vulnerabilities:

| Tool | Precision | Recall | Localization | Why |
|---|---|---|---|---|
| security-audit-skill (Cloudflare) | 100% | 100% | 100% | Parallel LLM-reasoning lanes by attack class + a separate adversarial validator |
| deepsec (Vercel Labs) | 100% | 90% | 100% | Deterministic prefilter + real LLM investigation + revalidation |
| VulnHunter (Capital One) | 100% | 70% | 100% | Attacker-first forward analysis; hit an org Opus spend cap mid-run (operational, not reasoning failure) |
| raptor (community) | 100% | 20% | 50% | Semgrep-only, no LLM layer — missed every logic-heavy class |
| VVAH (Visa) | — | — | — | 11-stage exhaustive pipeline; timed out before ever emitting a report |

The conclusion this architecture is built on: real LLM reasoning across the codebase is
non-negotiable (pattern matching alone misses access control, auth bypass, and prompt injection
entirely); per-stage cost/time budgeting is a first-class architectural requirement, not an
afterthought (two of five tools failed on budget/time, not reasoning quality); and the winning
shape is **parallel, class-organized LLM reasoning with a separate blind validator** — not an
exhaustive multi-stage pipeline, not a pattern-matching-only scanner.

**A contamination gap found during planning, now fixed:** `results/scan-benchmark-summary.md` used
to contain the literal `challengeKey | category | file:line` ground-truth table directly in this
repo — the same information the private answer-key repo exists to protect, just exposed from
inside this repo instead. This has been redacted. Separately, `challenges.yml`'s `category` field
was a genuine in-code giveaway (readable OWASP-category labels sitting next to each challenge);
`target-apps/juice-shop-blind/` now exists specifically to remove that shortcut (see
`docs/dev-loop-protocol.md`).

**A second contamination risk with no clean fix, kept as a standing caveat:** OWASP Juice Shop is
one of the most heavily publicly documented deliberately-vulnerable apps in existence. A model
running recon may recognize it from pretraining and reconstruct known bugs from memory rather than
genuine analysis, regardless of how generically this scanner's own prompts are written. Three past
sessions in this project's own history already took a version of this shortcut (documented in the
Design Notes section below). The only real mitigation — a held-out validation pass against an
obscure/synthetic app the model has no public familiarity with — is out of scope for this plan but
should happen before trusting these numbers as proof of generalization, not just a plausibility
check.

---

## Stage 0 — Recon

**Technique:** A hybrid of (a) deterministic AST-based static extraction via **ts-morph** (a
TypeScript Compiler API wrapper) over the entry-point file(s) and `package.json`/lockfile, and (b)
parallel LLM subagents synthesizing that deterministic output into an architecture summary —
mirroring security-audit-skill's own multi-agent recon pattern, but seeded with real extracted data
instead of a blank directory listing. A fourth, narrower LLM pass — the **OWASP-category-
applicability probe** — reads the synthesized summary plus a compact per-category evidence
checklist and emits a present/absent/uncertain verdict per category (full per-category logic in
Design Notes §1).

**Context given to recon:** nothing but the code itself. No repo name, no "this may be a
training/demo app" framing, no prior briefing of any kind — recon has to reach a verdict from
source alone. There is no developer-questionnaire fallback anywhere in this design; an "uncertain"
verdict is handled entirely by Stage 0.5, not by asking a human anything.

**How it works in this codebase specifically:** ts-morph loads `server.ts`'s `SourceFile` and walks
`CallExpression` nodes matching `app.<method>(...)` to deterministically enumerate every route
registration (this app has ~170), each with its handler import and middleware arguments —
`server.ts` is the single place all routing happens (no decorators, no per-feature router
mounting), so one file yields a complete route table. It also walks the `finale.resource({...})`
loop over a local `autoModels` array literal: a light literal-evaluation pass (not full symbolic
execution) resolves each call to a concrete `/api/<Model>` CRUD pair and its `excludeAttributes`
list, surfacing the auto-generated CRUD surface as first-class route-table rows rather than
something an LLM has to notice unprompted. Diffing that AST-derived table against `swagger.yml`'s
declared paths shows the documented spec (`/b2b/v2/*` only) covers neither the hand-written routes
nor the auto-CRUD layer — a deterministic signal fed straight to the API-Security-Top-10
applicability check. The LLM synthesis agents read `routes/chat.ts` and apply the tool-calling
detection heuristic (Design Notes §1) to decide LLM Top 10 applicability, and grep Angular's
escape-hatch APIs (`bypassSecurityTrustHtml`, `innerHTML`) across the frontend — cheap and
framework-fixed, so it runs unconditionally, surfacing `search-result.component.ts`'s two calls as
recon output rather than something Stage 2 has to rediscover.

For **Next.js**: no single entry file — the route table comes from the `app/`/`pages/` directory
convention plus `middleware.ts`, and Server-vs-Client-Component boundaries add a trust boundary this
app doesn't have. For **NestJS**: routes come from `@Controller()`/`@Get()` decorator metadata —
ts-morph must read decorator arguments and follow DI/module wiring, not flat call expressions. For
**Fastify**: closer to Express's flat style, but plugin registration (`fastify.register(...)`) adds
a cross-file encapsulation layer to follow.

**Inputs / outputs:** Input = repo root. Outputs: an architecture summary (route table with
method/path/handler/middleware/auth, persistence-layer map, dependency list) and a
`category-applicability` table (one row per OWASP Top 10 / API Security Top 10 / LLM Top 10
category: present/absent/uncertain, evidence pointer, confidence). Consumed by Stage 0.5 (lane
instantiation) and Stage 1 (budget sizing needs the route/seed-file inventory).

**Model tier:** The AST pass is free (no model). Synthesis and applicability classification default
to a mid-tier model — security-audit-skill's benchmarked recon hit 100/100/100 downstream without
frontier-tier reasoning here, since this stage is breadth-first extraction, not adversarial
reasoning. Escalate to frontier-tier only when the architecture is unusually complex (multi-service
monorepo, dynamic plugin loading) — an "uncertain" applicability verdict does *not* trigger
escalation; that's Stage 0.5's job.

**Alternatives rejected:** Pure-LLM recon with no AST pass — rejected as the sole method because
it's exactly the "the auditor already had detailed knowledge of this codebase" shortcut two of the
five benchmarked tools' own runs took (Design Notes §4); a deterministic route table anchors the
summary in something checkable regardless of whether the model recognizes the target. Trusting a
declared API spec as the sole surface map — rejected because `swagger.yml` here documents only one
of three real surfaces.

---

## Stage 0.5 — Dynamic Lane Selector

**Technique:** A deterministic instantiation function — a lookup over Stage 0's
`category-applicability` table, not an LLM call — that spawns one hunt lane per category marked
present, splitting a category into multiple lanes when the architecture summary shows it spans
structurally distinct subsystems. On top of that lookup, **one lightweight LLM reasoning pass by
the orchestrator** double-checks the lookup's own work before lanes are actually spawned: does the
present/absent/uncertain call for each category look right given the architecture summary, and for
anything still marked uncertain, does it warrant its own targeted lane, or should it be folded into
a general/catch-all lane so that section of the code isn't left unscanned? This is a basic
sanity-check pass, not a new decision framework — the only handling for an uncertain category is
"orchestrator decides: specific lane, or general lane," full stop.

**How it works here:** Injection is present with two structurally distinct sink types (raw SQL via
`sequelize.query`, NoSQL operator injection via the marsdb-style store's `$where`/`$set`) — because
the persistence-layer evidence is structurally distinct, this becomes two lanes, not one, so a
single playbook doesn't blur SQL-string concerns with NoSQL-operator concerns. Broken Access
Control gets its own lane keyed off the route table's auth-middleware column. Security
Misconfiguration gets a lane once recon's flag-grep surfaces the XML parser's entity-resolution
settings. LLM Top 10 gets a lane (or several, by subsystem: prompt-injection/agency vs.
output-handling) once the tool-calling heuristic fires on `chat.ts`. API Security Top 10 gets a
lane once two undocumented surfaces are detected. For **Next.js/NestJS/Fastify** the evidence
sources change (e.g. NestJS's `@UseGuards()` presence as the access-control signal) but the
instantiation logic — read the table, spawn a lane per present row, split by subsystem where
evidence shows a structural split — is framework-agnostic.

**Inputs / outputs:** Input = `category-applicability` + architecture summary. Output = a lane
manifest (category, subsystem scope, seed file list, playbook reference per lane). Consumed by
Stage 2 (lane assignments) and Stage 1 (needs lane count + seed footprint to size budget).

**Model tier:** The instantiation lookup is free. The orchestrator's verification/uncertain-category
pass is one cheap mid-tier LLM call over the (already small) category-applicability table and
architecture summary — not per-category, one pass total — so this stays inexpensive regardless of
how many categories are present. No escalation trigger by design; a category still uncertain after
this pass gets the general/catch-all lane, not a bigger model thrown at it.

**Alternatives rejected:** A fixed lane count regardless of recon (what security-audit-skill's and
VulnHunter's benchmarked runs both effectively did) — rejected because raptor's fixed-coverage
failure shows fixed scoping misses categories that don't fit the mold, and because this project's
own benchmark twice saw scope pre-decided by an operator who already knew the answer categories —
precisely what this stage exists to structurally prevent by deriving lane count from per-run
evidence.

**Decision — an uncertain category always gets something spawned:** the orchestrator's
verification pass decides whether that's a specific targeted lane or a general/catch-all lane,
specifically so no section of the code goes unscanned just because recon couldn't confidently name
its category. There's no third option (no deferral, no skip, no questionnaire) — this one
lightweight check is the entire mechanism.

---

## Stage 1 — Budget Governor (cross-cutting)

**This is "Layer 2" in the two-layer control model** (full contrast in `docs/dev-loop-protocol.md`):
this stage is the permanent, always-on runtime governor for every real scan job, completely
separate from the dev-improvement loop (which only runs while the architecture itself is being
tuned, and stops entirely once a human signs off that it's good enough). This stage must alert and
stop a job cleanly whenever it hits its turn/token/time ceiling, regardless of the target
codebase's size — that requirement doesn't relax once development is "done"; if anything it matters
more in production, against unknown-size real codebases, than against the fixed Juice Shop
benchmark.

**Technique:** A pre-run cost estimator plus per-lane token/wall-clock ceilings enforced by the
orchestration layer — not model behavior. Modeled directly against two documented failure modes:
VVAH's own `estimate` command correctly predicted ~4M input tokens/pass across 9 stages *before
running*, but the pipeline had no mechanism to act on that and scope down, so it died mid-pipeline
having produced nothing; VulnHunter's failure was a single **org-wide** spend cap that killed the
entire run rather than degrading gracefully lane-by-lane.

**How it works here:** Before Stage 2 starts, the governor sums file sizes across each lane's seed
list from the 0.5 manifest. This app's per-lane seed sets are small and targeted (the
Injection/SQL lane's seeds are a couple of route files plus model files, not a repo-wide sweep) —
nothing like VVAH's flat whole-repo pass per stage. Budget is sized per-lane from that lane's actual
seed footprint, which is the structural reason this design avoids VVAH's failure mode by
construction rather than by hoping an estimate gets acted on.

**Live reporting + hard stop:** the estimated token/time cost is shown to the user live as the run
progresses, not just at the end. The run always stops — never silently continues past either
boundary — at whichever comes first: (a) a cap the user pre-set, or (b) the governor's own
calculated minimum-needed estimate for the remaining work. At that stop point the human is alerted
and looped in, with options framed around what the system actually knows: if the governor is
confident it just needs a specific, bounded increase to finish (e.g. "one more lane needs ~20% more
budget to complete its trace"), it asks for exactly that; if the shortfall looks larger or
architectural, that gets reported instead so the human can decide differently. No top-up is ever
auto-approved silently — this is deliberately a stop-and-ask design, not an auto-approve-up-to-N
design. The entire point is preventing a silent spend spiral: every step is estimated ahead of time
and checked against what's actually being spent, not discovered after the fact the way
VulnHunter's org-wide cap or VVAH's timeout were.

**Inputs / outputs:** Input = lane manifest + per-lane seed file sizes. Output = per-lane
`{model_tier, token_ceiling, wall_clock_ceiling, escalation_flag}`. Consumed by Stage 2 (enforces
its own ceiling, reports partial results at exhaustion) and reported at Stage 4, so the final output
can distinguish "this lane ran to completion, a null result is a real negative" from "this lane was
budget-capped, treat as inconclusive."

**Model tier:** The estimator is arithmetic (file size × depth multiplier) — no model call. Each
lane defaults to mid-tier per Stage 2's rationale; escalation triggers *per lane*, specifically so
one stuck lane can't exhaust budget earmarked for the others the way VulnHunter's global cap did.

**Alternatives rejected:** A single global spend cap shared across lanes (VulnHunter's actual
failure) — no visibility into which lane is expensive until the whole run dies. A fixed per-stage
token allowance regardless of app size (closer to VVAH's fixed pipeline) — doesn't scale down for
small apps or up for large ones.

---

## Stage 2 — Hunt Lanes

**Technique:** N parallel LLM subagents, each given: the architecture summary verbatim, a
category+subsystem playbook drawn from a generic playbook library (written against OWASP's public
taxonomy, never against a specific target), its seed file list, its Stage 1 budget ceiling, and the
discipline "only report what you can construct a concrete entrypoint→sink trace for." A lane *may*
run Semgrep first over its own seed scope as a hint generator — mechanics in Design Notes §2.
**When a lane wants to look outside its assigned seed scope,** it checks in with the orchestrator
(the process coordinating all the lanes) rather than just going and looking, or refusing outright.
The orchestrator reasons about the extent of what's being asked — how far outside scope, how
directly it connects to the lane's actual trace — and either lets the lane proceed or tells it not
to, case by case. This is the same orchestrator role that runs Stage 0.5's category check and
Stage 1's budget alerts.

**How it works here:** The Injection/SQL lane traces query-param/body-field inputs to raw
`sequelize.query` sinks; the Injection/NoSQL lane's playbook separately covers the marsdb-style
store's `$where`/`$set` pattern — deliberately not folded into the SQL playbook since the sink type
differs — and is told to also check `chat.ts`'s tool handlers, since a NoSQL sink reached through
an LLM tool argument is still primarily a NoSQL-injection finding, cross-referenced by the AI/LLM
lane for the agency angle rather than duplicated as its own class. The Access-Control lane is seeded
with the route table's auth-middleware column and told explicitly to check *ownership*, not just
authentication — the exact distinction a pattern-matching-only scan structurally cannot represent,
and the class raptor's benchmarked run scored 0% on. The AI/LLM lane gets `chat.ts` plus a
tool-argument-injection/confused-deputy/excessive-agency playbook, explicitly told "the model can be
prompt-injected" is not itself a finding — it must name the boundary crossed. The Client-Side lane
greps Angular's escape-hatch APIs as its own cheap prefilter, surfacing
`search-result.component.ts`'s two `bypassSecurityTrustHtml` calls as candidates, then reasons
whether each is actually reachable with unsanitized attacker content.

For **Next.js**: injection/SSRF playbooks apply the same way to API routes/Server Actions, but the
Client-Side lane must additionally reason about Server/Client-Component serialization boundaries.
For **NestJS**: Access-Control reasoning shifts to guard/interceptor decorator ordering and
DI-scoped providers. For **Fastify**: broadly similar to Express, with plugin encapsulation as the
added wrinkle.

**Inputs / outputs:** Input = architecture summary + lane assignment + playbook + seed files +
budget ceiling (+ optional Semgrep hints as context, never as a filter). Output = per-lane candidate
findings, each with a concrete entrypoint→sink trace, structured enough to carry
file/line/description/proposed-severity into Stage 3.

**Model tier:** Mid-tier default per lane — security-audit-skill's 100/100/100 run used
general-purpose subagents without a frontier-only mandate, and deepsec's 90%-recall run explicitly
used a reduced thinking level and still scored well, suggesting a well-scoped seed list plus a
category playbook does most of the reasoning-scaffolding work. Escalate a *specific* lane to
frontier-tier when it reports genuine difficulty (can't build a trace within its first budget
increment but believes one exists) or its subsystem is unusually deep (e.g. a large multi-role
permission matrix).

**Alternatives rejected:** A Semgrep/CodeQL-first pipeline where lanes only investigate prefilter
hits (raptor's actual design) — raptor's own benchmarked result (20% recall, missing every
logic-heavy class) is the direct evidence against it. One omniscient hunting agent covering all
categories in a single context window — parallel focused lanes outperform a single broad pass, and
a single lane can't be independently budgeted/escalated under Stage 1.

**Decision — scope check-ins, not a fixed rule:** neither unilateral expansion nor a hard wall — the
lane checks in with the orchestrator, which reasons about the specific request (how far out of
scope, how justified) and approves or denies case by case.

---

## Stage 3 — Validate

**Technique:** A separate LLM subagent per finding (or per finding-cluster from the same code area,
batched), given *only* the finding's claimed trace and impact — not the hunting lane's reasoning
transcript, not which lane produced it — instructed to independently re-read the cited code and try
to disprove it. This mirrors security-audit-skill's blind-adversarial validation design, the piece
this project's benchmark names explicitly as central to the winning shape.

**How it works here:** For an SQLi finding, the validator gets only "claim: X reaches
`sequelize.query` via string interpolation" and independently confirms the line and checks whether
any upstream middleware actually neutralizes it — a length cap is not a sanitizer, a conclusion it
must reach itself, not by trusting the hunter's characterization. For an Access-Control finding, it
independently re-verifies the absence of a per-resource ownership check. For an AI/LLM finding, it
applies the rule directly: attacker and victim must differ, or the capability must exceed what the
user already has — otherwise reject. For a Client-Side finding, it independently confirms both an
escape-hatch call *and* an attacker-controllable source reaching it unsanitized, not merely that the
hunter labeled a parameter "raw."

**Inputs / outputs:** Input = one finding's claim (trace + impact), not the hunter's
chain-of-thought. Duplicate/overlap reconciliation (Design Notes §3) runs as a consolidation pass
*before* dispatch to validators. Output = CONFIRMED (with the validator's own evidence) or REJECTED
(with the specific factual error) per finding, feeding Stage 4.

**Model tier:** Mid-tier default, same rationale as Stage 2 — this project's benchmark record notes
the reference tool "lightened phase 3 and skipped phase 6 entirely and still hit 100/100/100," and
deepsec explicitly skipped its optional revalidate step under budget pressure without recall
dropping. Escalate to frontier-tier for findings needing deep multi-hop reasoning to confirm/reject,
or when a first-pass validator itself returns "uncertain."

**Alternatives rejected:** No independent validation step (raptor's design, which has none) — false
positives directly hurt precision, and the benchmark's headline conclusion is that the winning
tools pair hunting with independent adversarial validation. The same agent validating its own
finding — hunting agents are biased toward finding things, exactly why an independent check exists
in the reference design.

**Decision — deferred to evals, not decided by upfront debate:** start with the full independent
validation stage as designed above (the safe default), then let the dev-loop eval process (per
`docs/dev-loop-protocol.md`) answer whether to lighten or drop it empirically. If a build iteration
that lightens this stage still hits the target precision/recall on the eval runs, that's real
evidence it's safe to lighten — if it doesn't, that's the answer too.

---

## Stage 4 — Output

**Technique:** A custom schema modeled closely on security-audit-skill's `report-schema.json` (full
justification in Design Notes §5) rather than SARIF as the primary artifact, with a thin SARIF
projection generated *from* the custom schema for interop, plus a scoring adapter matching the
`Finding(file, line, title, description)` shape `tools/scan-benchmark/adapters.py` already expects.

**How it works here:** Each CONFIRMED finding is assembled into the schema's `trace[]` using the
evidence Stage 3's validator (not the original hunter alone) checked — e.g. an SQLi finding's trace
is a direct `entrypoint`→`sink` pair; a NoSQL-via-chat-tool finding's trace has an `entrypoint` at
the chat handler, a `propagation` step through the tool's callback, and a `sink` at the query — a
case this app concretely exercises and the plain trace shape already accommodates. `conditions[]`
captures prerequisites (e.g. "requires the target resource's ID be guessable").
`remediation.code_changes` stays strategy-level prose only, since designing/writing fixes is
explicitly out of scope for this phase.

**Inputs / outputs:** Input = Stage 3's CONFIRMED/REJECTED verdicts + evidence. Output = a
schema-validated `findings.json` (structural validation only, not a correctness check) plus a
human-readable summary. Consumed by the out-of-scope fix+verify stage and, for scoring, by a thin
adapter into `score.py`'s `Finding` shape — which already tolerates absolute/relative path
differences and does suffix-based file matching, so the adapter needs almost no normalization logic
of its own.

**Model tier:** No model call needed for schema assembly if Stage 3 already produces schema-shaped
fields; otherwise a cheap mid-tier reformatting pass. No realistic escalation trigger — needing
frontier-tier reasoning to *reformat* an already-validated finding is a sign Stage 3 didn't actually
finish deciding it.

**Alternatives rejected:** SARIF as the primary/only schema (full reasoning in Design Notes §5),
kept as a secondary projection since two of the five benchmarked tools already emit SARIF natively
and the existing adapter code already has a generic SARIF parser.

**Decision — stay flexible for now:** the only requirement right now is that the schema is good
enough to run evals against and legible to a human reviewing results — not locked to whatever the
fixer stage will eventually need.

---

## Design Notes

### §1 — Stage 0's OWASP-category probe, per category

**Hybrid overall, and the mix differs by category.** Deterministic evidence-gathering (AST/grep for
specific markers) runs for every category; an LLM classification step decides applicability from
that evidence for most categories; a few categories are close to pure-checklist (evidence alone is
dispositive) and a few are close to pure-judgment (evidence can't decide on its own — these fall to
Stage 0.5's orchestrator check, which spawns either a targeted or a general/catch-all lane; there's
no human questionnaire anywhere in this design).

**OWASP Top 10 2021**
- **A01 Broken Access Control** — hybrid, defaults present. Evidence: any authenticated,
  resource-scoped route (auth middleware + an owner-shaped model column, accessed via an
  `:id`-style param). Presence of any such route is enough for applicability; whether ownership is
  actually checked is Stage 2's job.
- **A02 Cryptographic Failures** — hybrid. Evidence: weak-hash function names near password/token
  handling, absence of bcrypt/argon2/scrypt where a password field exists, string literals adjacent
  to crypto/sign/hmac calls. LLM judgment decides whether a hit is security-critical.
- **A03 Injection** — hybrid. Evidence: raw query-builder escape hatches per detected persistence
  layer, `eval`/`Function(`/`child_process.exec` repo-wide, template literals inside any of those
  calls. Any hit anywhere is enough for applicability; reachability is Stage 2's job.
- **A04 Insecure Design** — LLM-judgment-heavy; no deterministic marker for "is the overall design
  sound." Best handled as a permanent slice of a Business-Logic lane; if evidence still can't
  decide, this is what the general/catch-all lane exists for.
- **A05 Security Misconfiguration** — hybrid. Evidence: known-dangerous config flags by literal
  name, permissive CORS, absence of a helmet-equivalent, multiple config files with no clear
  production indicator. LLM judgment decides whether a gap actually matters.
- **A06 Vulnerable/Outdated Components** — nearly pure-deterministic (lockfile + CVE/OSV lookup) —
  essentially SCA, not an LLM-reasoning category, true by default for any app with dependencies. May
  not warrant an LLM hunting lane at all.
- **A07 Identification/Authentication Failures** — hybrid. Evidence: auth library detected, absence
  of rate-limiting on login/reset, algorithm-confusion-shaped patterns, weak password hashing
  (overlaps A02).
- **A08 Software/Data Integrity Failures** — hybrid, weak default signal. Evidence: unsafe
  deserialization, unsigned webhook/CI config, auto-update/plugin-loading code. Often genuinely
  uncertain from source alone — falls to Stage 0.5's orchestrator check, typically resolving to the
  general/catch-all lane.
- **A09 Logging/Monitoring Failures** — mostly LLM-judgment; deterministic pre-check is just "is
  there a logging module at all." Whether logs reach a monitored destination in production is a
  deployment fact the code alone can't prove either way — same resolution as A08.
- **A10 SSRF** — mostly deterministic evidence, LLM confirms taint. Evidence: outbound HTTP calls
  where the URL argument isn't a config/literal value.

**API Security Top 10** (only spawned if recon detects a REST/GraphQL/RPC surface distinct from
server-rendered pages)
- **API1 BOLA** — same evidence as A01, scoped to API routes with an ID-shaped param used as a DB
  lookup key.
- **API2 Broken Authentication** — same evidence as A07, API-scoped.
- **API3 Broken Object Property Level Authorization** — its own distinct marker: request-body
  spread directly into a create/update call without an explicit allow-list; an auto-CRUD
  framework's per-model exclude/include list (already read for route extraction) turns "is mass
  assignment possible" into a largely deterministic diff.
- **API4 Unrestricted Resource Consumption** — evidence: absence of rate-limiting on expensive
  endpoints, absence of pagination on list endpoints (readable from the same auto-CRUD
  configuration block used for API3 — one AST pass answers both).
- **API5 Broken Function Level Authorization** — same evidence as A01/API1, scoped to role-check
  functions and which routes call them.
- **API6 Unrestricted Sensitive Business Flows** — largely LLM-judgment (domain-specific);
  deterministic evidence limited to flagging write-ops on financially/authorization-relevant nouns.
- **API7 SSRF** — same as A10, API-scoped.
- **API8 Security Misconfiguration** — same as A05, API-scoped.
- **API9 Improper Inventory Management** — nearly pure-deterministic: diff the AST-derived route
  table against the declared API spec's paths. No LLM judgment needed for applicability, only
  severity.
- **API10 Unsafe Consumption of APIs** — evidence: outbound calls to third-party APIs whose response
  drives control flow without a schema check; LLM judgment confirms trust-without-validation.

**LLM Top 10** (only spawned if recon's tool-calling detection heuristic fires — genuine agentic
tool-calling with real capabilities, not merely an "AI-sounding" route name or a plain
text-completion call with no tools)
- **LLM01 Prompt Injection** — hybrid. Evidence: tool-calling plus a system prompt built by
  concatenating a value traceable to conversation history/user fields. LLM judgment decides whether
  any concatenated span crosses into the trusted instruction channel unfenced.
- **LLM02 Sensitive Information Disclosure** — hybrid. Evidence: keyword scan of system-prompt
  literals and tool return values for unfiltered fields. LLM judgment decides whether a hit is
  genuinely sensitive vs. a generic assistant-prompt leak.
- **LLM03 Supply Chain** — the AI-specific slice of A06: deterministic dependency/CVE check on AI
  SDK packages, plus LLM judgment on whether the model provider/base URL is pinned vs. dynamically
  configurable from an untrusted source.
- **LLM04 Data/Model Poisoning** — almost entirely inapplicable to a static source scanner (a
  training-time concern) unless the app itself implements RAG-ingestion/fine-tuning code — an
  honest scoping call, not a gap.
- **LLM05 Improper Output Handling** — deterministic half: does model output ever reach an
  HTML-rendering sink client-side (cross-references the Client-Side lane's escape-hatch grep); LLM
  judgment confirms lack of sanitization.
- **LLM06 Excessive Agency** — deterministic evidence: any tool handler performing a
  state-changing/privileged action without independently re-deriving authorization from the
  caller's identity inside that handler. LLM judgment confirms whether prompt text is doing
  enforcement instead of code — itself the finding.
- **LLM07 System Prompt Leakage** — largely the same evidence as LLM02. **Decision (default, not
  yet empirically tested): merge into LLM01/02's lane** rather than spawn a dedicated one, given the
  evidence overlap; revisit via the dev-loop eval process if this turns out to hide a real gap.
- **LLM08 Vector/Embedding Weaknesses** — applicable only if recon detects an actual vector
  store/embedding pipeline. Absence, detected purely deterministically, is itself a clean
  not-applicable.
- **LLM09 Misinformation** — almost entirely inapplicable to a source-exploitability scanner — an
  honest scoping exclusion, not a detection gap.
- **LLM10 Unbounded Consumption** — deterministic evidence: presence/absence of a step/turn cap on
  the tool-calling loop and any per-request budget (overlaps API4). Represents "present but
  apparently mitigated, confirm in Stage 2" rather than flat present/absent.

### §2 — "Prefilter can hint, never gate," mechanically

**Configurable per category, decided ahead of time by the playbook itself** — not a blanket "every
lane runs Semgrep" rule. Each playbook carries a `prefilter: none | semgrep-hint` flag set once,
based on whether the category's failure mode is syntactically pattern-representable at all:

- **`semgrep-hint` categories** (SQL/NoSQL injection sinks, hardcoded secrets, dangerous function
  calls, missing security headers, dangerous XML/YAML parser flags): Semgrep runs scoped to that
  lane's seed files; hits become additional prompt context. The lane's actual scope is still the
  playbook + seed list, never the Semgrep hit list — hits are additive context only.
- **`none` categories** (Access Control/IDOR; Business Logic; Prompt Injection/Excessive Agency): the
  lane runs with zero prefilter, by design. This exact axis — syntactic-pattern-representable vs.
  not — is what separates raptor's 100%-caught SSRF/secrets from its 0%-caught
  IDOR/prompt-injection/SSTI.
- Even in `semgrep-hint` categories, zero Semgrep hits does not let a lane skip its own reasoning
  pass — it still reads its seed files from scratch. Hits are a floor, never a ceiling.

### §3 — Duplicate/overlapping findings across categories

A **pre-validation consolidation pass**, run once across all lanes' raw candidates before Stage 3
dispatches individual findings to validators. Mechanically: group candidates by sink-location
overlap using the **same ±15-line slack** `score.py`'s `LINE_SLACK` constant already uses for
ground-truth matching. Overlapping findings merge into one candidate before validation; multi-lane
agreement on the same sink becomes a mild confidence signal carried into Stage 3.

For a finding straddling categories: emitted once, tagged by its *primary* category but carrying
**secondary category tags**, not forced into a single bucket.

### §4 — Testing against Juice Shop without re-encoding Juice-Shop-specific assumptions

This project's own history already contains three concrete, documented instances of exactly this
mistake (past benchmark runs where recon was written/bootstrapped directly by an operator who
already knew the codebase, rather than delegated to independent analysis). Not fixable by scanner
design alone: the model running recon almost certainly has real pretraining exposure to OWASP Juice
Shop specifically. This is categorically different from, and not addressed by,
`docs/BLIND_DEVELOPMENT.md`'s guardrail, which only prevents reading the literal `answer-key.json`
file; it does nothing about the model's own prior familiarity with the target's public identity.

**Where this document itself risks the same mistake:** every "how it works here" section above uses
this app's concrete facts as worked examples — appropriate for grounding, but it would be exactly
this mistake if those specifics ended up hardcoded into the actual playbook library's default
behavior instead of emerging from Stage 0's per-run evidence on whatever repo is handed to it.

### §5 — Findings schema: SARIF, or custom?

**Decision: adopt security-audit-skill's schema essentially as-is, with two additive fields — not
SARIF as primary.**

**Full field list to adopt**: `verdict` (confirmed|rejected), `title`, `description`, `root_cause`,
`intended_behavior`, `trace[]` (`{kind: entrypoint|propagation|sink, file, line, scope,
description}`, first step must be entrypoint, last must be sink), `conditions[]` (`{kind,
description}`), `execution` (`{attacker_perspective, payloads[], instructions[], expected_result}`),
`remediation` (`{strategy, code_changes[]: {file_name, fixed_code}}`), `severity`
(`{likelihood:{score,reason}, impact:{score,reason}, overall_severity}`), `confidence` (`{score,
reason}`).

**Two additive fields**: `categories[]` (a list of OWASP/API/LLM tags, replacing a forced single
category) and `lane_provenance` (which hunt lane(s) produced the candidate, for audit trail).

**Decision — `remediation.code_changes[].fixed_code` stays empty for now**: keep the field for
schema forward-compatibility, but populate only `strategy` prose in this scan-only phase.

---

## Critical files for implementation

- `tools/scan-benchmark/adapters.py` and `score.py` — the exact interface any Stage 4 output must
  feed via a thin adapter; `LINE_SLACK`/`normalize_path`/`file_match` are the conventions to reuse.
- `docs/BLIND_DEVELOPMENT.md` — the guardrail every scanner-building session must re-read before
  touching the target app.
- `target-apps/juice-shop-blind/server.ts` — the concrete route-registration and `finale-rest`
  auto-CRUD structure Stage 0's AST-extraction approach is designed against; use the blind copy, not
  the original.
- `docs/eval-framework.md` and `docs/dev-loop-protocol.md` — read before building any stage.
