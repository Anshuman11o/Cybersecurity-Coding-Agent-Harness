Build a NEW alternative Stage 2 (Hunt Lanes) component. The existing v1 component must be preserved untouched. DO NOT RUN ANY SCAN — no full pipeline run, no real hunting run. Build it, make it runnable, and report. Execution happens later under separate instruction.

FIRST: read PERFILE_LANE_CONTRACT.md at the root of this working directory. It defines the lane-assignment schema you consume, which is being produced in parallel by another task building the new Stage 0.5. Build against that schema as specified. Since that component may not exist on disk yet in this working directory, construct a small hand-written fixture matching the contract's schema to develop and smoke-test against.

WHAT TO BUILD

Create tools/scanner/stage2-hunt-lanes-perfile/ as a new, independently runnable package (own package.json with `npm run run`, own tsconfig, mirroring the existing stage packages). You may freely copy and adapt from tools/scanner/stage2-hunt-lanes/ — but that v1 directory must remain byte-for-byte unchanged when you are done.

INPUTS:
- Architecture summary (tools/scanner/stage0-recon/output/architecture-summary.json)
- Lane assignments from the new Stage 0.5 (tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json)
- Category playbooks (adapt from tools/scanner/stage2-hunt-lanes/src/playbooks/)
- Seed file contents, line-numbered

OUTPUTS: keep v1's shapes exactly — output/candidate-findings.json and output/budget-consumption.json.

THE CORE CHANGE

v1 spawned one lane per category theme, each holding many seed files, and each lane hunted its theme across all of them. v2 iterates the lane-assignment list and, for each entry, spawns one lane bound to exactly ONE target file, instructed to hunt ONLY the categories that lane assignment names for that file.

So the executor becomes roughly: for each lane assignment -> pull its target file and its assigned category list -> assemble a prompt from a template parameterized by (target file content, that file's assigned categories, the technical guidance for each of those categories) -> run the lane -> collect findings.

FOUR REQUIREMENTS ON THE PROMPT

1. Full file coverage. The lane must analyze 100% of its target file. Where the lane assignment carries a multi-chunk plan, run one pass per chunk and merge the results, rather than truncating. v1 silently cut every seed file at 15,000 characters and discarded the remainder — that behavior must not survive into v2. Line numbers shown to the model must remain the file's REAL line numbers in every chunk, including chunks that do not start at line 1, so cited locations are correct.

2. Only the assigned categories. The prompt tells the lane to hunt specifically the categories named for that file, and includes the technical guidance for exactly those categories — not the whole playbook library. This is what keeps the prompt small and focused now that there is one lane per file.

3. Guidance is about how to detect a vulnerability CLASS, never about this particular codebase. The category guidance may explain what the class looks like in general — what shapes of code create it, what to trace, what distinguishes a real instance from a false positive. It must NOT contain identifiers, file names, framework specifics, or any hint tied to the repository currently sitting in target-apps/. Anything target-specific that legitimately reaches the lane must arrive through the architecture summary input, which is generated per-run by recon — that is the only channel through which target knowledge is allowed to flow. Audit your playbook text for this before reporting: if a playbook string would not make equal sense against a Python or Go codebase, rewrite it.

4. Per-finding categories. Each emitted finding must name the vulnerability class ACTUALLY found, chosen from that lane's assigned categories. Do not copy the lane's whole category list onto every finding it produces. In v1 the code did exactly that (`f.categories = lane.categories`) and the prompt never asked the model to categorize its own finding — so a finding titled as one class carried the labels of four others. Ask for it explicitly in the output schema and use what the model returns.

ALSO CARRY FORWARD FROM V1

The v1 executor sanitizes PEM private-key material out of seed content before building the prompt (see sanitizePemPrivateKey). Keep that — it exists because raw key blobs tripped an upstream content-safety filter and silently zeroed out an entire lane. Keep v1's finding-validity rules too (non-empty trace, first step entrypoint, last step sink).

Track real token consumption per lane and emit budget-consumption.json as before. Do NOT enforce any ceiling or cut any lane off — this architecture deliberately measures rather than limits. A separate task is building the cost model those measurements will be compared against.

VERIFY (without running a real scan)

Confirm it compiles/typechecks, that it correctly assembles prompts from your fixture (including the multi-chunk case, with real line numbers preserved in later chunks), and that tools/scanner/stage2-hunt-lanes/ shows no modifications.

REPORT BACK: the structure you built, and — most important — paste the COMPLETE literal text of one fully-assembled example hunt-lane prompt, exactly as it would be sent, for a lane with a couple of assigned categories. Not a template with placeholders and not a summary: the real rendered string, with the file content section abbreviated in the middle if it is long (mark clearly where you abbreviated). This prompt is the main thing being reviewed. Also confirm explicitly what you did to satisfy requirement 3, and state anything the contract left ambiguous that you had to decide.

CONSTRAINTS: only this repository; target-apps/ is read-only; never search for, read, or reference any answer-key or ground-truth material anywhere on this machine.
