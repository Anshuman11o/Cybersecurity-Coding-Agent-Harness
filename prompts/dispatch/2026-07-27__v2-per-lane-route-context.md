# Dispatch — Give each hunt lane its own route context

Target component: `tools/scanner/stage2-hunt-lanes-perfile/`

A prompt-assembly change against data Stage 0 already produces. No new stage, no extra LLM call,
no change to Stage 0 or Stage 0.5, and no re-run of either.

## The problem

`loadArchSummarySnippet()` builds **one** architecture snippet, once, and hands the identical text
to all 553 lanes. Its route section is:

```ts
const routeSummaries = rt.hand_written_routes.slice(0, 20).map((r: any) =>
  `  ${r.method} ${r.path} → ${r.handler} (${r.file})`
).join('\n')
```

Three defects in that one expression:

1. `.slice(0, 20)` of 110 hand-written routes. 90 are never shown to anything.
2. The 20 shown are the same 20 for every lane, so they are almost never the lane's own routes.
3. `r.auth` is dropped on the floor — the single most security-relevant field recon extracts.

The consequence is measurable. Several files were scanned, given the right categories, given real
token budget, and produced zero findings because the evidence needed is not in the file. A
representative case is a fifteen-line route handler that calls `res.sendFile()` on a hardcoded path
under an `assets/private/` directory. Nothing in that file is wrong. What is wrong is that the
route registering it has no authentication, which is recorded in the route table and never reaches
the lane.

Recon already has exactly what is needed:

```json
{ "method": "GET", "path": "/...", "handler": "servePremiumContent",
  "auth": null, "middleware": ["servePremiumContent()"],
  "file": "target-apps/juice-shop-blind/server.ts", "line": 644 }
```

## The change

Replace the single global snippet with **per-lane route context**, resolved for each lane's own
target file.

### Matching

`route_table[].file` is the *registration* site (the server entry file), not the file that defines
the handler, so the path cannot be matched directly. Match by handler identifier instead:

1. Extract the exported symbol names from the lane's target file — exported functions, consts and
   classes. A light regex over `export function X`, `export const X`, `export class X`, plus
   `export { X, Y }` lists, is sufficient; do not add a parser dependency.
2. A route entry belongs to this lane when any of those symbols appears as its `handler` or as a
   whole-word occurrence inside any of its `middleware` strings.
3. Match whole words only. A substring match would attach `serveEasterEgg` to `serveEasterEggLevelTwo`.

Also match **auto-CRUD routes** for model files: when the target file's exported symbol or its
basename matches an `auto_crud_routes[].model`, that entry belongs to the lane. Those carry
`excludeAttributes`, `hasPagination` and `hasCustomHooks`, all directly relevant to property-level
authorization and resource consumption.

### Prompt section

Insert a new section **before** `## Target File Content`, and only when at least one route matched.
A file with no matching routes must not receive an empty or placeholder section.

```
## How This File Is Reached
This file's exported handlers are registered as the following routes. Auth middleware is listed
exactly as the application declares it; "none" means no authentication or authorization middleware
is applied to that route.

  GET  /some/path  ->  serveThing()          auth: none
  POST /api/thing  ->  createThing()         auth: isAuthorized()
    middleware: uploadToMemory.single('file'), checkFileType

Auto-generated CRUD surface for this file's model:
  /api/Things  excludes: password, totpSecret  pagination: yes

Consider whether each route's protection matches what the handler actually does and what it
exposes. A handler that is correct in isolation can still be a finding if it is reachable without
the authorization its behaviour requires.
```

Render `auth` as `none` when it is `null`, absent or empty. Do not editorialise beyond the wording
above — do not label anything as vulnerable, do not add severity hints, and do not name any
vulnerability class. The section states facts and asks a question; the playbooks do the reasoning.

Omit the `middleware:` sub-line when the middleware list contains nothing beyond the handler call
itself, so the common case stays one line per route.

### Bounding

A file may back many routes. Cap the rendered list at **15 routes**, chosen by relevance rather than
file order: routes with `auth: none` first, then the rest. If any were dropped, say so explicitly —
`(N further routes not shown)` — rather than silently truncating. Truncation that does not announce
itself has already cost this project a lane.

### Keep

The existing global architecture snippet stays as it is, in its own section. This adds context; it
does not replace what is there. Keep its route sample too — it gives the model a sense of the
application's overall shape, which the per-lane section deliberately does not.

## What must not change

- Stage 0, Stage 0.5, `architecture-summary.json`, `lane-assignments.json` — read-only inputs.
- `tools/scanner/stage2-hunt-lanes/` (v1) — do not touch.
- The vulnerability-class model landed in `9dab1e7`: `finding_classes`, the per-lane class enum,
  `categories` as the union of alias codes, and the startup validation.
- Chunking, concurrency, checkpointing, resume, retry, PEM sanitisation, budget tracking.
- The `## Output Format` section and the response schema.

## Report back

- The diff.
- The **complete rendered `## How This File Is Reached` section** for three specific lanes:
  `routes/premiumReward.ts`, `routes/basketItems.ts`, and `models/user.ts`. Print the real rendered
  text produced by your code against the real `architecture-summary.json`, not a hand-written
  example of what it would look like.
- How many of the 553 hunt lanes match at least one route, and the distribution of matched routes
  per lane (how many lanes match 0, 1, 2-5, 6-15, more than 15).
- The measured change in prompt size for a lane that matches routes.
- Anything you find that contradicts this brief.

Do not run a scan. Build and type-check only.

## Constraints

Work only inside this repository. `target-apps/` is read-only. Never search for, read, or reference
any answer-key or ground-truth material anywhere on this machine.
