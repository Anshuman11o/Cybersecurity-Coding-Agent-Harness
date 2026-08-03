# Stage 0.5 — Lane Selector

Decides what gets hunted and with which playbooks. Two implementations, both
live. **v2 is the current track.**

---

## v2 — one lane per file (current)

`tools/scanner/stage05-lane-selector-perfile/src/lane-selector-perfile.ts`

One lane per file in Stage 0's inventory. Output:
`runs/<provider>/stage05-lane-selector-perfile/lane-assignments.json`, schema in
`../architecture/perfile-lane-contract.md`.

Fully deterministic — **zero LLM calls**. Given the same Stage 0 artifacts it
produces byte-identical assignments, which is what makes a Stage-2-only A/B a
single-variable comparison.

### Signal-based class assignment

This is the part that decides which playbooks a lane loads, and it is not a
category lookup. Stage 0 emits `file-signals.json` — what each file *does*. This
stage turns that into a class list through `shared/signal-classes.json`:

    lane.classes = floor ∪ ( classes of each signal the file carries )

- **`floor`** is the set of classes assigned to *every* hunt lane regardless of
  signal, so a file whose signals were missed is never left with nothing.
- Each signal contributes its own classes; the result is a union, then sorted.
- **`class_basis`** records *why* each class is on the lane — a map from `floor`
  or a signal name to the classes it contributed. Assignment is auditable after
  the fact rather than being a black box.
- Every referenced class is validated against `shared/vuln-classes.json` and an
  unknown one **throws**, rather than silently producing a lane whose playbook
  cannot be loaded.

`categories` is still written on every lane as the full code universe; Stage 2
prefers `classes` and only falls back to collapsing `categories` when a lane
predates this mechanism.

### Dispositions

Checked in this order, and the order matters:

1. **Denylist first**, so no later branch can undo it. A file on `SEED_DENYLIST`
   (from `shared/read-guard.ts`) is skipped with an explicit reason. One lane per
   file means a hunt disposition would paste the answer set straight into the
   prompt — this is the blind-development boundary, and v2 was forked from v1
   before the denylist moved into `shared/` and silently never picked it up.
2. **Non-executable language** → skip, with a language-specific reason.
3. **Executable language** → hunt.
4. **Unknown language** → hunt, with a warning. Deliberately fail-open:
   under-assigning hides vulnerabilities, over-assigning only costs tokens.

Skipped lanes are written with empty `signals`, `classes` and `class_basis`, so a
skip cannot masquerade as an assignment.

### Chunk plans

`SINGLE_PASS_LINE_BUDGET = 2000`, `CHUNK_OVERLAP = 20`.

A file at or under the budget gets one chunk covering lines 1..N. A longer file is
tiled: each chunk is at most 2000 lines, each subsequent chunk starts 20 lines
before the previous one ended, the first chunk starts at line 1 and the last ends
at the file's final line. Stage 2 re-asserts both endpoints before running.

This replaces v1's silent truncation at 15,000 characters, which had hidden 5
ground-truth entries.

**Do not lower `SINGLE_PASS_LINE_BUDGET` to window long files into more lanes.**
It was tested as a matched A/B: findings per file rose 39% and category-aware
localization did not move at all. See
`../analysis/2026-07-29-localization-investigation.md` §2.3.

### Assertions — the stage exits non-zero rather than warning

- **Coverage ledger.** `assigned_hunt + assigned_skip == total_files_in_inventory`
  and `unaccounted == 0`. Every exclusion is auditable.
- **Lane count matches inventory** exactly.
- **No denylisted file holds a hunt disposition** — re-derived independently after
  assignment rather than trusting the loop that set it. `guard.test.ts` asserts
  the same property against any manifest already on disk.
- **Every category family appears somewhere** across the lanes.

It also logs the denylisted skips by name — deliberately loud, because it is a
known coverage gap every downstream recall number has to be read against — plus
the classes-per-lane and signals-per-lane distributions.

---

## v1 — category-themed lanes (preserved, not current)

`tools/scanner/stage05-lane-selector/src/lane-selector.ts`

One lane per applicable category, each seeded with many files. Output:
`runs/<provider>/stage05-lane-selector/lane-manifest.json` (`lane_id`,
`categories[]`, `subsystem_scope`, `seed_files[]`, `playbook_reference`).

Deterministic instantiation plus one LLM "orchestrator review" pass that can
dispute a verdict and route uncertain categories. Carries the same seed denylist,
and shards unclassified files into size-capped lanes.

**Known defect:** lane selection matched on the `framework` display string
(`c.framework === 'LLM Top 10'`). Recon's wording for that field varies between
runs, and when it changed, the entire LLM lane silently disappeared — no error, no
warning. v2 matches on the category code instead.

---

## Input

| | v1 | v2 |
|---|---|---|
| `architecture-summary.json` | yes | yes |
| `category-applicability.json` | yes | yes |
| `file-signals.json` | — | **yes, required** |

## Measured

Assignment correctness against ground truth: does every ground-truth file get a
hunt lane carrying a correct class? v2 scores 97/97 — the 98th entry is in a
denylisted file that is given a skip lane by design, and is therefore unreachable
by construction rather than missed.
