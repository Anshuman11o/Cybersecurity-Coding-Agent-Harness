# Stage 0.5 — Lane Selector

Decides what gets hunted and by whom. Two implementations, both live.

## v1 — category-themed lanes
`tools/scanner/stage05-lane-selector/src/lane-selector.ts`

One lane per applicable category, each seeded with many files. Output:
`runs/<provider>/stage05-lane-selector/lane-manifest.json` (`lane_id`, `categories[]`, `subsystem_scope`,
`seed_files[]`, `playbook_reference`).

Deterministic instantiation plus one LLM "orchestrator review" pass that can
dispute a verdict and route uncertain categories.

Carries a permanent seed denylist for benchmark-infrastructure files, and shards
unclassified files into size-capped lanes.

**Known defect:** lane selection matched on the `framework` display string
(`c.framework === 'LLM Top 10'`). Recon's wording for that field varies between
runs, and when it changed, the entire LLM lane silently disappeared — no error,
no warning. v2 matches on the category code instead.

## v2 — one lane per file
`tools/scanner/stage05-lane-selector-perfile/src/lane-selector-perfile.ts`

One lane per file in the inventory, carrying the categories recon's evidence
associates with that file, plus a chunk plan covering the whole file.

Output: `runs/<provider>/stage05-lane-selector-perfile/lane-assignments.json`, schema in
`docs/architecture/perfile-lane-contract.md`.

Fully deterministic — **zero LLM calls**.

Three properties that matter:

- **Coverage ledger.** `assigned_hunt + assigned_skip == total_files_in_inventory`
  and `unaccounted == 0`, asserted in code. Skipped files still appear with a
  stated reason, so every exclusion is auditable.
- **Chunk plans tile the file.** First chunk starts at line 1, last ends at the
  final line, 20-line overlap between chunks. This replaces v1's silent
  truncation at 15,000 characters, which had hidden 5 ground-truth entries.
- **Evidence widens, never narrows to nothing.** A file with no specific
  evidence receives the full category universe. Under-assigning hides
  vulnerabilities; over-assigning only costs tokens.

## Input (both versions)
Stage 0's `architecture-summary.json` and `category-applicability.json`.

## Measured
Assignment correctness against ground truth: does every ground-truth file get a
hunt lane carrying a correct category? v2 currently scores 97/97 — the 98th
entry is in a denylisted file that is given a skip lane by design.
