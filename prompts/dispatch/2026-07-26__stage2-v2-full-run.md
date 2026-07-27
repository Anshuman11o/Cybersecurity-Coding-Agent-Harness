This is an EXECUTION task, not a development task. Do not modify any component's logic. Run the new per-file Stage 2 and report real metrics.

WHAT TO RUN

tools/scanner/stage2-hunt-lanes-perfile/ — the per-file hunt lane component. Install its dependencies first if needed (npm install inside that package directory), then run it via its `npm run run` entry point.

Run ONLY this stage. Do NOT run Stage 0, Stage 0.5, or Stage 3. Their outputs already exist on disk and are the correct, current inputs:
- tools/scanner/stage0-recon/output/architecture-summary.json
- tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json  (918 lanes: 553 hunt, 365 skip)

Do NOT regenerate either of those files. Do not re-run the lane selector. If the component would overwrite them, stop and report instead.

SCALE — READ THIS BEFORE STARTING

This is a large run: 553 lanes each making at least one real LLM call, plus extra passes for any file with a multi-chunk plan. It will take a long time — likely hours, not minutes. That is expected. Let it run to completion. Do not shortcut it, do not sample a subset, and do not add early-exit logic to make it finish faster.

There is deliberately NO budget ceiling in this architecture. No lane should be cut off, truncated, or skipped for cost reasons. Track usage, never limit it. If you find any enforcement path that would halt a lane on budget grounds, report it rather than letting it fire.

ROBUSTNESS EXPECTATIONS

With 553 lanes, some individual LLM calls will likely fail transiently (rate limits, timeouts, occasional content-filter rejections). A single failed lane must not abort the whole run. Ensure failures are caught per-lane, recorded, and the run continues. Report exactly how many lanes failed and why, grouped by cause — a run that silently drops lanes is worse than one that reports them.

Note the component has a startup validation that exits non-zero if any category's playbook module fails to load. If that fires, report the exact output and stop; do not work around it.

OUTPUTS EXPECTED
- tools/scanner/stage2-hunt-lanes-perfile/output/candidate-findings.json
- tools/scanner/stage2-hunt-lanes-perfile/output/budget-consumption.json
- any per-lane usage records the component emits

REPORT BACK, with real numbers read from the actual output files, not estimates:
- Did the run complete? Any crash, and at what point?
- Lanes attempted, lanes succeeded, lanes failed (grouped by failure cause)
- Total candidate findings, and the distribution of findings per lane (how many lanes produced 0, 1, 2, 3+)
- Total tokens consumed across the whole run, and the per-lane min / median / max
- Total wall-clock time for the run
- How many lanes ran more than one pass because their file was chunked, and the largest number of passes for a single lane
- Any lane where the reported token usage looks anomalous relative to its file size, which would indicate a bug worth investigating

CONSTRAINTS: only this repository; target-apps/ is read-only; never search for, read, or reference any answer-key or ground-truth material anywhere on this machine — scoring is handled separately and is not your job.
