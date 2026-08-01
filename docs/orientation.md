# Orientation — start here

For an agent or person opening this repository for the first time. Read this,
then `CLAUDE.md`, then whichever doc in the table at the bottom matches the task.
Fifteen minutes here saves a day of rediscovery.

## What this project is

A harness that scans a codebase for OWASP-categorized vulnerabilities, and is
intended to go on to fix them and prove the fix. **Only the scanner exists
today.** The patcher, verifier and Stage 4 output are designed, not built.

The target is OWASP Juice Shop. Accuracy is scored against a fixed 98-entry
answer key that lives in a **separate private repository** and is never present
here. **Metrics are reported over 97 of those entries** — one sits in a
denylisted file that no finding can ever cite, so it is unreachable by
construction; see `protocols/eval-howto.md`. See `protocols/blind-development.md` — this is the constraint that shapes
most of the repo's odd decisions, and it has been violated three times.

## The two "models", which are not the same thing

This trips up nearly everyone, including agents, so it is first.

| | What it is | Where it is configured |
|---|---|---|
| **Coding agent** | Writes and edits the harness source. Historically Qwen Code via `acpx qwen`, dispatched with briefs in `prompts/dispatch/`. Claude has also edited source directly when asked. | Not configured in this repo |
| **Inference model** | What the *scanner calls* while scanning. Currently `luna` / `gpt-5.6-luna`. | `tools/scanner/shared/models.json` — one JSON entry, nothing else |

Changing one has no bearing on the other. "Switch the model" almost always means
the second. `architecture/multi-model-architecture.md` §1 is the authority.

## How a change reaches the scanning model

There is **no deployment step**. The model receives exactly one thing: an HTTP
request carrying a prompt string, assembled in-process at
`stage2-hunt-lanes-perfile/src/hunt-executor.ts` → `buildHuntPrompt()`. Three
delivery mechanisms, and that is all:

1. **Compiled in** — prompt text and playbooks are TypeScript in this repo.
   They reach the model because `tsx` executes the file on disk.
2. **Read at startup** — `shared/vuln-classes.json`, `shared/signal-classes.json`,
   `shared/models.json`.
3. **Generated upstream** — Stage 0 and 0.5 artifacts under
   `runs/<provider>/<stage>/`, read by the next stage.

**Therefore: a change is in force if and only if it is in the working tree when
`run.sh` executes.** Nothing versions it, nothing declares it, nothing warns you.
A run from a stale branch looks completely normal and exits 0. This has already
produced one wrong baseline — see `protocols/running-a-scan.md` §1.

`prompts/dispatch/` records *what was asked for*. It is never read at runtime.

## Two tracks, both live

| | v1 | v2 (current) |
|---|---|---|
| Lane unit | one lane per category theme | one lane per file |
| Stage 0.5 | `stage05-lane-selector/` | `stage05-lane-selector-perfile/` |
| Stage 2 | `stage2-hunt-lanes/` | `stage2-hunt-lanes-perfile/` |
| Class model | none | 14 classes → 25 OWASP codes |
| Validator | Stage 3 works | **none — Stage 3 reads v1 output** |

All active work is v2. **Preserve v1 exactly** when changing v2; they share
`shared/` but v1 does not read the class registry. The v2 gap at Stage 3 is real
and unresolved: nothing downstream recovers v2 precision.

## The shape of a run

    Stage 0   recon              LLM           → architecture summary, file signals
    Stage 0.5 lane selector      deterministic → lane assignments (hunt | skip)
    Stage 1   budget governor    deterministic → token projection
    Stage 2   hunt lanes         LLM x2/lane   → candidate findings
    Stage 3   validate           LLM           v1 only

Stage 2 is two model turns per lane as of 2026-08-01: a hunt turn and a
follow-up turn in the same conversation that completes each finding's trace.
The arm is `HUNT_LOOP`, it defaults to `trace`, and it is **not** recorded in
the git sha — see `architecture/stage2-lane-loop.md`.

Only Stages 0 and 2 call a model. 0.5 and 1 are plain TypeScript, which is why
lane assignment is reproducible from the same recon output.

## Traps that have cost real time

- **Stage 2 resumes from its output directory.** Leaving a previous run's
  `candidate-findings.json` in place makes it skip every lane and report success
  with stale results. Clear it before launching.
- **A dispatch prompt is not evidence a change is in the tree.** Grep the file.
- **`npm test` used to rewrite committed artifacts** — a stage's `main()` ran at
  module scope. Fixed, but check entry-point guards when adding a stage.
- **A v2 component forked from v1 can silently miss a security import.** The
  seed denylist was correct in `shared/` and simply never wired into v2.
- **Recall is location-weighted.** 98 entries sit at 67 locations; the three most
  crowded carry 24 between them. One line swings the headline by up to 11 points.
- **The denominator is 97, not 98.** One entry is in a denylisted file and is
  unreachable by construction. Reporting it as a miss understates every run.

## Where to go next

| Question | Read |
|---|---|
| What are the rules I must not break? | `../CLAUDE.md` |
| How do I execute a scan, end to end? | `protocols/running-a-scan.md` |
| How do I score a run and compare it? | `protocols/eval-howto.md` |
| What has been run, and what did it show? | `run-history.md` |
| How do I add or switch an inference model? | `architecture/multi-model-architecture.md` |
| What may the scanner never see? | `protocols/blind-development.md` |
| What is being changed next, and why? | `protocols/recall-improvement-backlog.md` |
| What does one stage read and write? | `stages/<stage>.md` |
| How does a Stage 2 lane loop, and why is a null model mandatory? | `architecture/stage2-lane-loop.md` |
| What is the intended end state? | `architecture/scanner-plan.md` |
