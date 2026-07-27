Build a NEW alternative Stage 0.5 component. The existing v1 component must be preserved untouched.

FIRST: read PERFILE_LANE_CONTRACT.md at the root of this working directory. It defines the exact output schema, the directory layout, the category-association rules, the disposition rules, and the chunk-plan rules. It is a binding interface — two other components are being built against it in parallel right now, so do not deviate from the schema. If something in it is genuinely unworkable, implement your best interpretation and say so clearly in your report rather than silently changing the shape.

WHAT TO BUILD

Create tools/scanner/stage05-lane-selector-perfile/ as a new, independently runnable package (its own package.json with an `npm run run` script, its own tsconfig, mirroring how the existing stage packages are structured). You may freely copy and adapt code from tools/scanner/stage05-lane-selector/ as a starting point — but that v1 directory must remain byte-for-byte unchanged when you are done.

INPUTS (identical to v1 — read from the existing Stage 0 output):
- tools/scanner/stage0-recon/output/architecture-summary.json
- tools/scanner/stage0-recon/output/category-applicability.json

OUTPUT: tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json, exactly matching the contract's schema.

THE CORE CHANGE

v1 spawned a small number of category-themed lanes, each seeded with many files. v2 does the opposite: iterate the complete file inventory from architecture-summary.json and emit ONE lane per file. Each lane names a single target file plus the list of vulnerability categories recon's evidence associates with that specific file.

This is intended to be mostly deterministic bookkeeping. It does not need an LLM call at all if you can derive everything from the Stage 0 outputs — and a purely deterministic implementation is strongly preferred, because it makes the output reproducible and cheap. Do not add an LLM call unless you hit something genuinely underivable, and if you do, explain in your report exactly what forced it.

THREE THINGS THAT MATTER MOST

1. Every file accounted for. The contract's coverage_ledger must balance: assigned_hunt + assigned_skip == total_files_in_inventory, and unaccounted must be 0. Assert this in code and fail loudly if it does not hold. Silent file loss is the specific failure mode this design exists to prevent.

2. 100% file coverage via chunking. A lane must be able to analyze its entire target file. Where a file exceeds the single-pass line budget, emit a chunk plan whose ranges tile the whole file with the specified overlap. Assert the tiling property (first chunk starts at line 1, last chunk ends at the final line, no gaps). This directly replaces a v1 behavior where oversized files were truncated and the remainder was silently discarded.

3. Category matching by code, never by display string. Match on the leading category code token (A01, API3, LLM01, ...) parsed out of the category name. Do NOT compare recon's `framework` field against an exact expected string — recon's wording for that field varies between runs, and exact-string matching on it has already caused a real bug where an entire category family silently produced zero lanes. Your implementation must be robust to that field's wording changing.

VERIFY BEFORE REPORTING (structural only — correctness scoring is handled separately and is not your job)

Run your component against the existing Stage 0 output and confirm:
(a) the ledger balances and unaccounted is 0;
(b) total lanes equals the inventory's total_source_files;
(c) every chunk plan tiles its file completely, with no gaps or out-of-range lines;
(d) the number of distinct categories appearing across all lanes is consistent with recon's present/uncertain set — in particular, confirm that every category family present in recon's output (OWASP A-codes, API codes, LLM codes) actually appears on at least one lane. If a whole family is missing, that is the bug described in point 3 and you should find it before reporting;
(e) tools/scanner/stage05-lane-selector/ shows no modifications (git status clean for that path).

REPORT BACK: total lanes emitted, the hunt/skip split with the reasoning behind the skip class, how many lanes fell into each category_basis value, how many files required chunking and the largest chunk count for a single file, the ledger figures, and confirmation of each verification above. Also state plainly anything you had to interpret or decide that the contract did not fully specify.

CONSTRAINTS: only this repository; target-apps/ is read-only; never search for, read, or reference any answer-key or ground-truth material anywhere on this machine. No repository-specific identifiers, filenames, or hints anywhere in your code — it must work unchanged against an arbitrary codebase in an arbitrary language.
