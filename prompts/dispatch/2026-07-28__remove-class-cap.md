# Dispatch — remove the two-class cap on findings

Two edits in one file: `tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.ts`.
Nothing else changes. Do not run any stage.

## Why

A finding may currently name at most two vulnerability classes. That cap was chosen
before there was evidence about how the model actually behaves. The evidence now says the
model rarely reaches it — 467 of 549 findings in the last run named a single class — so
the cap is not what is constraining output. The prompt is. Both are being lifted so a
finding can carry every class its trace establishes.

## Edit 1 — the schema

In `buildHuntSchema()`, delete the `maxItems` line from `finding_classes`:

```diff
   finding_classes: {
     type: 'array',
     minItems: 1,
-    maxItems: 2,
     items: {
```

Leave `minItems: 1` in place. Leave the per-lane `enum` on `class` exactly as it is — a
lane's assigned classes remain the only values a finding may name, and that enum is what
now bounds the maximum.

## Edit 2 — the prompt

One paragraph is replaced. It currently reads:

```
List every class this finding genuinely belongs to. A single line can legitimately be more than one class — a render sink reached by attacker-controlled data is both an injection and a client-side finding. Only list a second class if the **same trace** establishes it; if a second class would need a different entrypoint or a different sink, it is a separate finding, not a second label. For each class you list, give the index of the trace step that establishes it.
```

Replace it with exactly this, as a single line, preserving the surrounding blank lines:

```
List every class that your scanning of this file establishes for this finding, using the playbooks, the file content, and the context you were given. There is no limit on how many — list all the evidence supports, and do not narrow to a single label when several genuinely apply. A single line can legitimately be more than one class: a render sink reached by attacker-controlled data is both an injection and a client-side finding. For each class you list, give the index of the trace step that establishes it.
```

Transcribe it character for character. It contains an em dash and a colon and no backticks
or dollar-brace sequences; if you think something needs escaping you have mistranscribed
it. Do not re-wrap it across multiple lines.

## What must not change

- The `justified_by_step` field, and the fact that it is required.
- The per-lane `class` enum built from the lane's assigned classes.
- `minItems: 1`.
- `unionCodesForClasses()` and the derivation of `categories[]` — it already unions
  however many classes arrive and needs no change.
- The runtime validation that drops findings with empty or invalid `finding_classes`,
  and the fatal error on an empty `categories` union.
- Every other paragraph of the prompt, the rest of the schema, chunking, concurrency,
  checkpointing, retry.
- `tools/scanner/stage2-hunt-lanes/` — that is v1. Do not touch it.

## Report back

- The diff.
- The full `finding_classes` schema block after the edit.
- The full replaced paragraph as it now appears in the file, so it can be compared
  against the text above character for character.
- Confirmation that `maxItems` no longer appears anywhere in `buildHuntSchema()`.
- The `tsc --noEmit` result for `stage2-hunt-lanes-perfile`.
- Anything you find that contradicts this brief.

## Constraints

Work only inside this repository. `target-apps/` is read-only. Never search for, read, or
reference any answer-key or ground-truth material anywhere on this machine.
