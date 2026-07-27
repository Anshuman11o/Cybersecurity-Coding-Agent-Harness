# Dispatch — Reporting threshold, architecture-summary path fix, empty-section fix

Target component: `tools/scanner/stage2-hunt-lanes-perfile/`

Three changes to one file, plus a wording change across the playbooks. No behavioural change to
chunking, concurrency, checkpointing, the class model, or the response schema.

---

## Change 1 — Fix the architecture summary path (a silent, total failure)

`hunt-executor.ts:1003`:

```ts
const archPath = join(REPO_ROOT, assignments.source_stage0_run)
```

`source_stage0_run` is an **absolute** path. Node's `path.join` concatenates rather than replacing,
so this produces `REPO_ROOT` followed by the entire absolute path again — a path that does not
exist. `loadArchSummarySnippet` then returns `undefined` on a missing file without saying anything,
and `buildHuntPrompt` only emits its `## Architecture Context` section when the snippet is defined.

The consequence: the last full run sent **no architecture context in any of its 553 lanes**. The run
log contains zero occurrences of that section heading. Nothing reported an error.

Fix both halves:

1. Resolve the path correctly — use it as-is when it is already absolute, and resolve it against
   `REPO_ROOT` only when relative. Apply the same treatment everywhere `archPath` is used (there is
   a second `existsSync(archPath)` site nearby).
2. Make the failure loud. If the architecture summary cannot be found or cannot be parsed, log a
   clear warning naming the resolved path, and print whether architecture context is present or
   absent in the run's startup banner. A component that silently drops a whole prompt section is
   worse than one that refuses to start.

---

## Change 2 — Do not render an empty route section

`renderRouteContext` currently emits the "this file's exported handlers are registered as the
following routes" heading and paragraph even when no hand-written routes matched, leaving an empty
list before the auto-CRUD block. `models/user.ts` renders exactly that today.

Emit each block only when it has content:

- hand-written routes matched → the routes paragraph and its list
- auto-CRUD entries matched → the CRUD paragraph and its list
- neither → return `undefined`, so no section appears at all

The closing "Consider whether each route's protection matches…" paragraph should appear whenever
either block did.

---

## Change 3 — The reporting threshold

This is the substantive change. A lane sees exactly one file, and is currently told:

> Only include findings where you can construct a complete entrypoint-to-sink trace. If you find
> nothing exploitable, return an empty array — being conservative is correct.

For a model file, a utility, or any file that is called rather than routed to, the attacker-facing
entrypoint is **structurally in another file**. The lane cannot satisfy that instruction, so it
correctly returns nothing. 429 of 553 lanes produced zero findings in the last run — 78%. In one
measured case a file contains an `if` branch that is empty where the `else` branch sanitises, so
input is stored unsanitised whenever the condition holds; the whole file was sent, 9,717 tokens were
spent, and the lane reported nothing.

Replace the opening of the `## Output Format` section — the two sentences quoted above — with
exactly this text. Do not paraphrase it, do not add to it, and do not reorder it:

> Respond with a structured JSON object containing a "findings" array.
>
> You are seeing one file. The attacker-facing entrypoint is often in a different file — a route
> handler, a caller, a framework hook — and you will not be able to see it. That does not make a
> defect in this file unreportable. When the entrypoint is outside this file, begin the trace where
> this file receives data from outside it: an exported function's parameter, a setter, a handler
> argument. Say in that step's description that the caller is outside this file.
>
> Report a defect when the code in front of you is wrong on its own terms — a check that is absent,
> a weaker control chosen where a stronger one sits beside it, input reaching a dangerous operation
> without validation — even if you cannot see who calls it. Use "confidence" to express how sure you
> are: a defect you can see clearly but whose reachability you cannot confirm from this file is a
> real finding at moderate confidence, not something to withhold.
>
> Do not invent findings. An empty array is right for a file that genuinely has no defect. But do
> not stay silent about something you can see merely because the surrounding context is missing.

Everything after that in `## Output Format` — the `finding_classes` instruction, the per-field list,
the trace shape — stays exactly as it is.

### The same gate in the playbooks

All 15 modules under `src/playbooks/` end their `## Hunting Discipline` section with a variant of:

> Only report what you can construct a concrete entrypoint-to-sink trace for.

Left as-is, this re-imposes in the playbook the exact gate the output section just lifted. In every
playbook, replace that one sentence with:

> Report what you can trace. When the entrypoint lies outside this file, begin the trace at the
> point where this file receives outside data and say so in that step.

Change only that sentence. Do not touch the numbered steps that follow it, the sink patterns, or the
false-positive guidance — those are the technical content and they are correct.

---

## What must not change

- `tools/scanner/stage2-hunt-lanes/` (v1), Stage 0, Stage 0.5.
- **Do not run Stage 0 or Stage 0.5.** Their outputs already exist on disk at
  `tools/scanner/stage0-recon/output/` and
  `tools/scanner/stage05-lane-selector-perfile/output/`. Those directories are listed in a
  `.gitignore` even though the files are tracked, so a file search that honours ignore rules will
  not show them — read them by path directly. If you believe an input is missing, stop and report
  rather than regenerating it.
- The class model: `finding_classes`, the per-lane class enum, `categories` as the union of alias
  codes, `maxItems: 2`, and the startup validation.
- The response schema, the trace shape, and the per-field list in `## Output Format`.
- The route-context work just added — `extractExportedSymbols`, `matchRoutesForFile`,
  `renderRouteContext` — apart from Change 2.

## Report back

- The diff.
- The **full rendered `## Output Format` section** for any lane, printed by your code, so the new
  wording can be read in place.
- The rendered route section for `models/user.ts`, confirming the empty routes block is gone and the
  auto-CRUD block still appears.
- Proof that the architecture summary now resolves: print the resolved path and whether it exists,
  and show the `## Architecture Context` section rendered into a prompt.
- A count confirming all 15 playbooks were updated, and one before/after excerpt.

Do not run a scan. Build and type-check only.

## Constraints

Work only inside this repository. `target-apps/` is read-only. Never search for, read, or reference
any answer-key or ground-truth material anywhere on this machine.
