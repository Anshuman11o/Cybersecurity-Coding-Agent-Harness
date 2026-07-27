One targeted fix to the stage05-lane-selector-perfile component you built, then re-run it to regenerate its output.

THE BUG

Your evidence-to-category mapping assigns files with `client_render` evidence ONLY the category LLM05 (Improper Output Handling). That is too narrow and it is losing real coverage.

A frontend escape-hatch render sink (the kind of call that disables a framework's automatic output sanitization) is first and foremost a classic cross-site-scripting sink — which belongs to A03 (Injection). LLM05 only applies in the narrower case where the untrusted content specifically originated from a language-model output. By assigning LLM05 alone, any file whose escape-hatch sink is reached by ordinary user-controlled input rather than model output gets hunted for the wrong class entirely, and the XSS is structurally unfindable.

Fix: files with `client_render` evidence must receive BOTH A03 and LLM05, since either class can legitimately manifest at that sink.

WHILE YOU ARE IN THERE — SANITY-CHECK THE OTHER EVIDENCE MAPPINGS

Apply the same reasoning to your other `category_basis` mappings and widen any that are similarly over-narrow. The governing principle: an evidence signal tells you a category is *especially likely* for that file — it does not tell you other categories are impossible. Under-assigning silently hides vulnerabilities, whereas over-assigning only costs tokens, and cost is explicitly not the constraint being optimized right now. When in doubt, include the category.

Note for context: 545 of your 553 hunt lanes already fall to `universe_default` and receive all 26 categories. Only 8 lanes are narrowed by evidence at all, so widening them is a negligible cost change and removes a whole class of risk.

DO NOT CHANGE anything else: the per-file lane model, the ledger, the chunk-plan logic, the skip rules, and the deterministic no-LLM design all stay exactly as they are.

THEN RE-RUN

Re-run the component against the existing Stage 0 outputs so output/lane-assignments.json is regenerated with the corrected categories.

VERIFY
- Ledger still balances: assigned_hunt + assigned_skip == total_files_in_inventory, unaccounted == 0.
- Still exactly one lane per file, no duplicate target_file values.
- Chunk plans still tile every non-empty file completely (first chunk starts at line 1, last chunk ends at the final line).
- Files with client_render basis now carry both A03 and LLM05.
- tools/scanner/stage05-lane-selector/ (v1) remains byte-for-byte unchanged.

REPORT BACK: what you changed in the evidence-to-category mapping and why, the new distribution of categories per basis, and confirmation of each verification above.

CONSTRAINTS: only this repository; target-apps/ is read-only; never search for, read, or reference any answer-key or ground-truth material anywhere on this machine.
