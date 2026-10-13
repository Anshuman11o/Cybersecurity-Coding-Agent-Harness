# Dispatch — Playbook agent: web search in the class decision, and a decision loop

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

Builds on `2026-10-12__playbook-agent-owns-class-selection.md` (already merged on
this branch: the agent selects built-ins and additional classes and writes
`class-selection.json`).

## Why

The class decision is one model call with no tools. Additional classes are only
discovered if the model thinks of them in that single call, and it cannot search
while deciding. This change (a) makes web search available during the class
decision, and (b) follows the initial decision with a code-enforced loop of
review turns that may only add classes.

## Behaviour

```
decision = initialCall()                          // the existing coverage call, now with web_search available
decision = union(decision, turn1(decision))       // once
for pass in 1..MAX_PASSES:                        // SCANNER_PLAYBOOK_LOOP_PASSES, default 3
    next = union(decision, turn2(decision))
    if next adds no class id: break
    decision = next
decision = union(decision, turn3(decision))       // once
for each additional class not in the cache: researchCall(class)   // unchanged
```

`SCANNER_PLAYBOOK_LOOP=0` disables the turns: only the initial call runs (with
web search available). Any other value or unset = loop on.
`SCANNER_PLAYBOOK_LOOP_PASSES` must be a positive integer; anything else is an
error at startup. Both are read in `main.ts` and passed to `runPlaybookAgent` as
options (agent.ts reads no env).

## Changes

### 1. `tools/scanner/stage-playbook-agent/src/agent.ts`

**Decision calls (initial call and every turn):**
- `tools: [{ type: 'web_search', ...(allowedDomains filter as today) }]`,
  `tool_choice: 'auto'`, `include: ['web_search_call.action.sources']`,
  text format name `coverage_decision`, strict json_schema as today.
- No requirement that a search happened; the model decides.
- Record each call through `recordUsage` exactly as today (`searchTrace` already
  captures queries, sources and search count).

**Research calls:** unchanged (`tool_choice: 'required'`, `playbook` schema, the
existing `web_search_calls === 0` and cited-URL checks).

**Input layout (prompt caching):** build one `base` object once —
`{ recon, signal_counts, signal_classes, builtins, cached_classes }` — and make
every decision call's `input` `JSON.stringify({ ...base, task, ...extra })` so all
decision calls share an identical prefix. `extra` for turns is
`{ current_decision, searches_so_far: { queries, source_urls } }` where
`current_decision` is the union decision so far (`reason`, `builtin_classes`,
`classes`) and `searches_so_far` accumulates over all earlier decision calls.

**Initial call `task`** — replace the current string with exactly:

    Select the built-in classes that apply to this target and decide coverage against the built-ins. Return every applicable built-in class in builtin_classes and every additional class needed for this run in classes, including applicable cached classes. Use web search when you judge the built-in classes do not cover a surface recon shows. Reuse cached identifiers.

**Turn 1 `task`** — exactly:

    Decide which vulnerability classes this target needs. For every built-in class excluded go over the recon evidence behind it: platform, languages, frameworks, dependencies, file signals and category verdicts to reconcile your decision if applicable. Use web tool if applicable to find classes beyond built-ins if applicable. Include a class when the target has the kind of surface it covers. Exclude it only when recon shows that surface is absent, and name what shows it. If the target has a surface no built-in class covers, propose an additional class for it using web tool. Do not drop any class already selected.

**Turn 2 `task`** (each pass) — exactly:

    Reconsider every class you did not select: each excluded built-in, and any vulnerability family relevant to this platform that is not yet covered that you can use web tooling to search for. For each one, check recon's data again (platform, languages, frameworks, dependencies, file signals, category verdicts and architecture) and decide whether the target has a surface it applies to. Add it if recon supports it or does not rule it out. Do not drop any class already selected. Return the full updated decision in the same schema. If nothing is added, return the decision unchanged.

**Turn 3 `task`** — exactly:

    Do a final check of the complete class set against recon's data. Confirm that every surface recon describes is covered by at least one selected class, and that each additional class you proposed names a distinct vulnerability family that the built-ins do not already cover. Add any class still missing whether from remaining in built-ins or from the web. Do not drop any class already selected. Return the final decision in the same schema, with a list of anything added and why.

**Turn schema:** the existing decision schema plus a required property
`changes: array of strict objects { id: string, why: string }`. The initial call
keeps the existing schema (no `changes`).

**Validation:** every decision call's output is validated exactly as the initial
decision is today (built-in enum, no duplicates, non-empty reasons, overlay
validation of additional classes), before the union. Invalid output fails the
stage, as today.

**Union (code-enforced no-drop):**
- built-ins: union of ids; keep the first reason seen for an id.
- additional classes: union by `id`; the **first** definition of an id (framework,
  codes, signals, reason) is kept, a later turn cannot redefine it.
- `added` = ids (built-in or additional) present after the union but not before.
- `restored` = ids present before but missing from the turn's own output; they
  stay in the decision.
- `reason` of the decision = the latest turn's `reason`.

**Purposes** (for `recordUsage` and the meter): `coverage`, `turn1`,
`turn2:pass<N>`, `turn3`, `research:<class-id>`.

**Plan artifact:** `PlaybookPlan` gains
`turns: { purpose, added: string[], restored: string[], changes: {id, why}[], web_search_calls: number, queries: string[], source_urls: string[] }[]`
(one entry per turn, not for the initial call) and
`loop: { enabled: boolean, max_passes: number, passes_run: number }`.
`plan.decision` is the final union decision; `plan.reason` its reason;
`builtin_classes` / `selected_classes` / `class-selection.json` reflect the final
union. `plan.searched` stays "any call made a web search".

### 2. `tools/scanner/stage-playbook-agent/src/meter.ts` and `agent.ts`

The meter currently labels a ledger entry `research:…` whenever the request has
tools. That would mislabel every decision turn. Change `AgentOptions.create` to
`(request, purpose: string) => Promise<Response>`, have `agent.ts` pass the
call's purpose, and make `PlaybookMeter.call(request, purpose)` use it as the
ledger `label`. Pricing (including `webSearches`) is unchanged.

### 3. `tools/scanner/stage-playbook-agent/guidance.md`

Replace exactly this paragraph:

    Search when recon hints at an uncovered framework/runtime family or technology
    surface (GraphQL, WebSockets, message queues, mobile, smart contracts or
    infrastructure as code), or signals map to few applicable classes. Decide which
    families matter and how to research them yourself. When every surface is
    covered, return no new classes and explain why. Always record the reason.

with exactly:

    Use web_search during the class decision whenever you judge that the
    built-in classes do not cover a surface recon shows: an uncovered
    framework/runtime family or technology surface (GraphQL, WebSockets, message
    queues, mobile, smart contracts or infrastructure as code), or signals that map
    to few applicable classes. Use it to find which vulnerability families apply to
    that surface and to confirm a family is distinct from the built-ins before
    proposing it. Decide which families matter and how to research them yourself.
    When every surface is covered, return no new classes and explain why. Always
    record the reason.

Nothing else in `guidance.md` changes.

### 4. `tools/scanner/stage-playbook-agent/src/main.ts`

Read `SCANNER_PLAYBOOK_LOOP` and `SCANNER_PLAYBOOK_LOOP_PASSES`, pass them in, and
wire `create: (request, purpose) => meter.call(request, purpose)`. Log line after
success additionally reports turns run, e.g.
`Playbook agent: N class(es) selected (B built-in, A additional); turns=T; searches=S`.

### 5. Tests (`tools/scanner/stage-playbook-agent/src/*.test.ts`)

Update existing mocks for the new call sequence and add:
- decision calls carry `web_search`, `tool_choice: 'auto'`, the sources `include`;
  research calls are unchanged;
- the initial call's `task` equals the new string; turn tasks equal the spec strings;
- every decision call's input starts with the same `base` prefix;
- the loop order: coverage, turn1, turn2 passes, turn3; turn2 stops on the first
  pass that adds nothing; turn2 stops at `max_passes` when every pass adds;
- a turn that omits a previously selected class: the class is restored and
  appears in that turn's `restored`; it stays in `class-selection.json`;
- a turn cannot redefine an existing additional class's codes/signals;
- a class added in a turn that is uncached gets a research call; research input
  uses the final definition;
- `loop.enabled: false` makes exactly one decision call;
- ledger labels equal the purposes (coverage, turn1, turn2:pass1, turn3, research:<id>);
- searches made in decision calls are priced (ledger `cost_usd` includes them).

All model and web responses stay mocked. **Make no network call and run no stage
against a real model.**

### 6. `tools/scanner/stage-playbook-agent/README.md`

Update "Decision and cache" to describe web search in decision calls, the turn
sequence, the env switches and the no-drop union; list `turns`/`loop` under the
plan artifact.

## Do not touch

- `tools/scanner/stage0-recon/`, `tools/scanner/stage2-hunt-lanes*/`,
  `tools/scanner/stage05-lane-selector*/`, `tools/scanner/stage1-budget-governor/`,
  `tools/scanner/cli/`, `tools/scanner/shared/` (except nothing — no shared change
  is needed), `shared/*.json`, `run.sh`.
- Any prompt text other than the strings and the paragraph quoted above.
- The research call's task string, schema and validation.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, any judgement calls, and each
command's pass/fail counts verbatim.
