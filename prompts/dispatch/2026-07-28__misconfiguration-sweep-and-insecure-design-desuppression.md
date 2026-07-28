# Dispatch — two playbook prompt changes: misconfiguration and insecure-design

Two files in `tools/scanner/stage2-hunt-lanes-perfile/src/playbooks/`. Exact text supplied
below; insert and replace verbatim. Do not paraphrase or reword. Do not run any stage.

## Why

These are the two worst-performing classes by recall on the measured run — 18% and 8% —
and between them they account for half of all wrong-class misses. They fail for opposite
reasons, so they get opposite treatment.

`misconfiguration` has good sink patterns (six of its seven describe markers visible in
the text) but no procedure for finding them in an ordinary code file. Five of its
seventeen ground-truth entries were never located at all. It is being read as a class that
only applies to files named like configuration.

`insecure-design` argues against its own class in four places, three of which use the
*size of the fix* as the diagnostic test. It emitted 72 findings run-wide, so it is not
reticent in general — it fires in the wrong places and declines in the right ones.

---

## File 1 — `misconfiguration.ts`

One insertion. Nothing is removed or reworded.

Insert immediately **after** the line `## Sink Patterns to Hunt For` and **before** the
line beginning `1. Exposed internal resources:`, separated by blank lines exactly as
shown:

```
### How to sweep a file for this class
Configuration is a value, not a file type. Work through this file and list every place
it does any of the following:
  - constructs or initialises a library, framework, parser, server, or client
  - passes an options object, flag, mode, or boolean literal into such a call
  - sets a header, permission, limit, timeout, or origin
  - declares a credential, key, endpoint, or environment default

That list is your candidate set. Test each entry against the patterns below: is this
particular value the unsafe one? Most dangerous settings are a single argument inside
an otherwise ordinary call, in a file with an entirely ordinary name.
```

Preserve the two-space indentation on the four bullet lines.

---

## File 2 — `insecure-design.ts`

Three changes in this file.

### 2a — the Scope line

Replace this line:

```
Scope: Detect business-logic-level design flaws that cannot be fixed by adding a single security control.
```

with:

```
Scope: Detect defects where the code works exactly as designed, and the design itself permits the abuse.
```

### 2b — a new anchor paragraph

Insert immediately **after** the line
`## Sink Patterns to Hunt For (Business Logic Level)` and **before** the line beginning
`1. State transition inconsistencies:`, separated by blank lines:

```
Start by naming what this file is responsible for enforcing: a sequence that must be
followed, a quantity that must be conserved, or a fact the server must decide rather
than accept from the caller. If the file enforces no such rule, this class has no
finding here. If it does, test whether that rule can be broken while every individual
operation still succeeds and returns normally.
```

### 2c — three of the four false-positive bullets

The `## Distinguishing Real Findings from False Positives` section currently has four
bullets. Replace the **first**, **third** and **fourth**. **Keep the second exactly as it
is**, in its current position.

Replace bullet 1:

```
- This is the hardest category to score. The finding must demonstrate a concrete way an attacker achieves something the application's own logic should prevent, not just "the design could be better."
```

with:

```
- The finding must show a concrete way an attacker achieves something the application's own logic should prevent. "The design could be better" is not a finding.
```

Keep bullet 2 untouched:

```
- A design that is suboptimal but not exploitable is not a finding. The finding requires a concrete attack scenario.
```

Replace bullet 3:

```
- "Missing input validation" is an implementation flaw, not a design flaw. A design flaw is one where even correct implementation of the current design enables an attack.
```

with:

```
- Missing validation on one field is an implementation flaw. A rule the design never established — an amount that is never bounded, an ordering that is never enforced, a value the server never re-derives — is a design flaw.
```

Replace bullet 4:

```
- The fix for an insecure design finding typically requires architectural changes, not a single line of code.
```

with:

```
- The test is whether the current design, implemented correctly, still permits the attack. Do not use the size of the fix as the test — a design flaw can have a one-line remedy, and an architectural fix does not make something a design flaw.
```

The four bullets must remain four bullets, in the same order and the same position in the
file.

---

## What must not change

- Every other line of both files: the categories list, the remaining sink patterns, the
  `## Distinguishing From Adjacent Classes` sections added earlier, and the
  `## Hunting Discipline` sections.
- The other 13 playbooks.
- `tools/scanner/stage2-hunt-lanes/src/playbooks/` — that is v1. Do not touch it.
- `hunt-executor.ts`, the response schema, `vuln-classes.json`, `signal-classes.json`.
- Any stage output directory.

None of the text above contains backticks or dollar-brace sequences. If you believe
something needs escaping, you have mistranscribed it — re-read the source.

## Report back

- The diff.
- For `misconfiguration.ts`: the three lines before and after the inserted block.
- For `insecure-design.ts`: the complete
  `## Distinguishing Real Findings from False Positives` section as it now reads, so all
  four bullets can be checked in order.
- Byte size of both files before and after.
- Confirmation that the other 13 playbooks and the v1 directory are unmodified.
- `tsc --noEmit` result for `stage2-hunt-lanes-perfile`.
- Anything you find that contradicts this brief.

## Constraints

Work only inside this repository. `target-apps/` is read-only. Never search for, read, or
reference any answer-key or ground-truth material anywhere on this machine.
