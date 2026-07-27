Follow-up fixes to the stage2-hunt-lanes-perfile component you built. Do NOT run any scan. Build, verify structurally, report.

FIX 1 (the important one) — PLAYBOOK COVERAGE GAP

Your CATEGORY_CODE_TO_PLAYBOOKS mapping references 16 playbook modules, but only 4 exist on disk: injection, crypto-auth, misconfiguration, general-catchall. The other 12 are dangling references. Worse, loadPlaybooksForCategories() only emits a console.warn when a module fails to import, so lanes for those categories would silently run with NO technical guidance at all and nobody would notice.

Measured in category terms: v2 currently has guidance for only 4 of the 26 category codes (A02, A03, A05, A07). It is missing guidance for 22 codes: A01, A04, A06, A08, A09, A10, API1, API2, API3, API4, API5, API6, API7, API8, API9, API10, LLM01, LLM02, LLM03, LLM05, LLM06, LLM10 — including all of access control, all of mass assignment, and the entire LLM family.

You do NOT need to invent this guidance or research the OWASP standards. The v1 component at tools/scanner/stage2-hunt-lanes/src/playbooks/ already contains 18 playbooks whose declared coverage spans all 26 codes with zero gaps. Your job is to PORT the missing ones into your v2 directory, applying the same dataset-agnostic rewriting you already did successfully for the 4 you wrote.

Port every remaining v1 playbook so that all 26 codes resolve to a real, existing module. Keep the same four-section structure the playbooks already use (Scope / OWASP Categories Covered / Sink Patterns to Hunt For / Distinguishing Real Findings from False Positives / Hunting Discipline) — that structure is working and downstream prompt assembly depends on it.

Most v1 playbooks are already written generically and port nearly as-is. Only four contain framework-specific language that must be rewritten the way you rewrote injection: client-side.ts (names Angular bypassSecurityTrustHtml/innerHTML and React JSX), injection-sql.ts (names sequelize.query/knex.raw/Sequelize literal), injection-nosql.ts, and ssrf.ts. Describe the general shape instead of naming a specific library's API, exactly as you did before ("raw query execution, ORM escape-hatch methods" rather than naming one ORM).

Keeping your consolidation of v1's three injection playbooks (sql/nosql/code) into a single A03 injection playbook is correct — do not split them back out.

FIX 2 — FAIL LOUDLY INSTEAD OF WARNING

Replace the silent console.warn on a failed playbook import with a hard startup validation: before any lane runs, assert that every category code in CATEGORY_CODE_TO_PLAYBOOKS resolves to a module that actually loads. If any does not, print exactly which codes and modules are unresolved and exit non-zero. A missing playbook must never again be able to degrade a run silently.

FIX 3 — DUPLICATED CATEGORY CODE IN THE PROMPT

The rendered prompt currently reads "A03: A03: Injection, A05: A05: Security Misconfiguration". The code prefix is being prepended to a name that already contains it. Render each category exactly once.

FIX 4 — CONSTANT ALIGNMENT

You set SINGLE_PASS_LINE_BUDGET = 2000. The Stage 0.5 component that actually produces the chunk plans also uses 2000, so this is consistent — just confirm your value matches and that your executor treats the chunk plan it is given as authoritative rather than recomputing its own.

FIX 5 — REMOVE YOUR FIXTURE FROM ANOTHER COMPONENT'S OUTPUT PATH

You wrote a fixture to tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json. That path belongs to the real Stage 0.5 component, which now genuinely produces that file, and your fixture will collide with it. Move your fixture into your own package (a fixtures/ subdirectory is fine) and delete it from the stage05 output path entirely.

VERIFY BEFORE REPORTING
- Every one of the 26 codes resolves to a playbook module that imports successfully. State the count explicitly.
- Run your own audit for framework/library-specific terms across ALL v2 playbooks (not just the new ones) and report what you searched for and what you found. Anything that would not make equal sense against a Python, Go, or Java codebase must be rewritten.
- It still type-checks.
- tools/scanner/stage2-hunt-lanes/ (v1) remains byte-for-byte unchanged.
- tools/scanner/stage05-lane-selector-perfile/output/ contains none of your files.

REPORT BACK: how many playbooks now exist and which codes each covers, confirmation that all 26 codes resolve, the result of your dataset-agnostic audit, and a short rendered snippet of the corrected "Assigned Categories" prompt line showing the duplication is gone.

CONSTRAINTS: only this repository; target-apps/ is read-only; never search for, read, or reference any answer-key or ground-truth material anywhere on this machine.
