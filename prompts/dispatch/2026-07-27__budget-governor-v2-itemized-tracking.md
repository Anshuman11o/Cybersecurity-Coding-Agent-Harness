# Dispatch — Budget Governor for v2: itemized token accounting

Two components: `tools/scanner/stage2-hunt-lanes-perfile/` (instrumentation) and
`tools/scanner/stage1-budget-governor/` (estimation and reconciliation).

**Tracking only. Nothing in this task may limit, cap, truncate, skip or halt anything.** If you find
any existing code path that would stop a lane on budget grounds, report it rather than letting it
fire.

## Where things stand

`hunt-executor.ts` records one number per lane: `response.usage?.total_tokens`. Input and output are
not separated, so it is impossible to say what a lane's prompt actually cost, let alone which part
of the prompt cost it. The last run consumed 6,075,860 tokens and we cannot attribute a single one.

That matters now because prompt composition is the main cost lever. Playbook text alone is an
estimated 57% of prompt volume, and class narrowing just cut it — but "estimated" is doing real work
in that sentence, and it should not have to.

Stage 1 exists but is wired only into v1. The v2 executor contains no reference to it.

## Part 1 — Stage 2: itemize the prompt

`buildHuntPrompt` currently returns a string. Change it to return the string **and** a breakdown of
what went into it, measured in characters, one entry per contributing segment:

- `boilerplate` — headings, the assigned-classes list, the output-format section
- `playbook:<class-id>` — **one entry per class**, so the cost of each playbook is separately
  visible across the run
- `route_context` — the "How This File Is Reached" section, when present
- `arch_context` — the architecture summary section, when present
- `file_content` — the line-numbered target file for this chunk

Character counts must be exact and must sum to the prompt's total length. Assert that; a breakdown
that does not reconcile is worse than none.

Capture from the API response, per call, keeping them distinct:

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`

If the provider omits any of these, record `null` — do not substitute an estimate and do not fall
back to `total_tokens` for the other two. A missing measurement must look missing.

Derive a per-segment token attribution by distributing `prompt_tokens` across segments in proportion
to their character share. **Label this clearly as derived, not measured** — name the field so no
reader can mistake it, and say so in the file's own header or schema. It is an approximation: token
density varies between prose and code, so the playbook and file-content segments will not have the
same ratio. It is still the right approximation to publish, because the alternative is no
attribution at all — but it must never be presented as a measurement.

Record per chunk, then roll up per lane. A multi-chunk lane repeats the playbook and boilerplate in
every chunk, which is exactly the kind of cost that is currently invisible.

## Part 2 — the output file

Extend `output/budget-consumption.json`. Keep every field it has today, at the same path and with
the same meaning, so existing consumers keep working. Add:

Per lane: chunk count, per-chunk records with the segment breakdown and the three token counts, and
the lane's totals.

Run-level rollup, which is what will actually be read:

- total input tokens, total output tokens, total tokens
- input tokens by segment kind across the whole run, with each as a share of total input — so
  "playbooks accounted for N% of all input" is a fact, not an estimate
- input tokens by individual playbook class, ranked — so an expensive playbook is identifiable by
  name
- the 20 most expensive lanes, with their file, bytes, chunk count and segment breakdown
- tokens per byte of scanned source, so runs over different targets stay comparable
- counts of lanes by chunk count, and the repeated-boilerplate cost that multi-chunk lanes incur

Cost in currency: only if a price per million input and output tokens is supplied via environment
variables. If they are absent, omit cost entirely rather than inventing a rate. Record the model
identifier either way.

## Part 3 — Stage 1: estimate before, reconcile after

Give `tools/scanner/stage1-budget-governor/` a v2 mode. It must not modify v1 behaviour.

**Before a run**, from `lane-assignments.json` plus the playbook sizes plus
`shared/vuln-classes.json`, produce `output/budget-plan-v2.json`: a projected input-token cost per
lane, built from that lane's actual assigned classes, its file bytes and its chunk count. This is
the number that says what a run will cost before it is paid for.

**After a run**, read Stage 2's consumption file and emit a reconciliation: projected versus actual,
overall and per lane, with the largest divergences ranked. A projection that is consistently wrong
in one direction is a calibration bug worth seeing.

Neither mode enforces anything. There is no ceiling, no cutoff, no skip.

## What must not change

- `tools/scanner/stage2-hunt-lanes/` and `tools/scanner/stage05-lane-selector/` — v1. Do not touch.
- Stage 0 and Stage 0.5 outputs. **Do not re-run either.** Their current outputs are correct and a
  regeneration would invalidate checks already performed against them. Their output directories are
  listed in a `.gitignore` even though the files are tracked, so a search honouring ignore rules
  will not show them — read them by path.
- The vulnerability-class model, `finding_classes`, the per-lane class enum, `categories` as the
  union of alias codes, the response schema, the prompt's wording and section order.
- Chunking, concurrency, checkpointing, resume, retry, PEM sanitisation.
- `candidate-findings.json`'s shape.

**Do not run Stage 2.** No scan. Build and type-check only.

## Report back

- The diff.
- A **sample per-lane record** and the **full run-level rollup structure**, printed from your code
  against real inputs where possible, or with clearly-labelled placeholder values where a real run
  is required. Do not describe the shape in prose — print it.
- Proof that the character breakdown reconciles: for one built prompt, the segment sum against the
  prompt's actual length.
- The projected total input cost for the current 553 hunt lanes from Stage 1's v2 mode.
- Anything you find that contradicts this brief.

## Constraints

Work only inside this repository. `target-apps/` is read-only. Never search for, read, or reference
any answer-key or ground-truth material anywhere on this machine.
