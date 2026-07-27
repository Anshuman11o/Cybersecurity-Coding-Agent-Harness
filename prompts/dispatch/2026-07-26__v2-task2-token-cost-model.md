This is an ANALYSIS + INSTRUMENTATION task. You are producing a cost model and a tracking mechanism — you are NOT running the scanner pipeline and NOT making any real LLM calls to measure things.

FIRST: read PERFILE_LANE_CONTRACT.md at the root of this working directory. It describes a new per-file lane architecture being built in parallel: instead of a few category-themed lanes each holding many files, there is now ONE lane per file, and every lane must analyze 100% of its target file (chunking into multiple passes where the file is too large for one).

PART A — BUILD A TOKEN COST MODEL FOR THE NEW ARCHITECTURE

Goal: answer "if we spawn one agent per file and each fully scans its file, what is the total expected token usage?" This does not need to be exact. It needs to be defensible, transparent about its assumptions, and bucketed so it generalizes to other codebases.

Calibration data you should use — these are REAL measurements from completed runs of the existing v1 pipeline, which you can and should verify yourself from the committed output files:
- tools/scanner/stage1-budget-governor/output/budget-plan.json (per-lane seed byte counts)
- tools/scanner/stage2-hunt-lanes/output/budget-consumption.json (per-lane real tokens consumed)
- tools/scanner/stage05-lane-selector/output/lane-manifest.json (which files were in which lane)

Important subtlety when calibrating: the v1 hunt executor truncated each seed file at 15,000 characters before building the prompt (see the MAX constant in tools/scanner/stage2-hunt-lanes/src/hunt-executor.ts, and note it line-numbers each line first, which inflates length). So the naive ratio of nominal-seed-bytes to tokens UNDERSTATES real cost, because much of the nominal bytes never entered a prompt. Compute the ratio against bytes ACTUALLY sent, replicating that truncation, to get a truthful tokens-per-byte figure. For reference, doing this correctly should land somewhere near 0.35 tokens per byte actually sent — if your independent calculation lands far from that, investigate and explain the discrepancy rather than assuming one of us is right.

Your model must account for, and state separately:
- Per-lane fixed prompt overhead (instructions, output-format spec, architecture summary excerpt) — this is paid once per lane regardless of file size, and with one lane per file it is now paid ~900 times instead of ~16, which is a first-order cost driver worth quantifying on its own.
- Per-lane variable cost driven by the file content itself.
- Playbook/category-guidance cost, which scales with how many categories a lane is assigned. Quantify this specifically, because the contract's fail-open rule means files with no specific evidence receive the ENTIRE category universe, and that could dominate total cost.
- Chunking multiplier: a file needing N passes re-pays the fixed overhead N times, and the overlap region is sent twice.
- Expected output tokens per lane (findings JSON), which you can calibrate from the existing candidate-findings.json relative to the runs that produced it.

Deliver the model as SIZE BUCKETS (e.g. under 2 KB, 2-8 KB, 8-20 KB, 20-50 KB, over 50 KB — choose sensible boundaries and justify them from the actual file-size distribution in the target). For each bucket: file count, expected tokens per file, and bucket subtotal. Then an overall total.

Produce the estimate for BOTH of these scenarios, since the difference is decision-relevant:
- SCENARIO NARROW: lanes only carry the categories recon's evidence specifically associates with that file.
- SCENARIO BROAD: every lane carries the full category universe (the contract's fail-open default for files with no specific evidence).

Also report what fraction of total cost comes from files that are pure non-executable config/style/markup, since the contract marks those "skip" — quantifying what skipping actually saves.

You will need the file inventory (sizes, languages, counts). It is in tools/scanner/stage0-recon/output/architecture-summary.json under file_inventory. You may also stat files directly under target-apps/ (read-only) for exact sizes.

Write the model as a runnable, re-usable script (tools/eval/ is a reasonable home) so it can be re-run against a different codebase later, plus a written report of its output. Do not hardcode anything specific to the repository currently in target-apps/ — bucket boundaries and ratios are fine; file names and directory names are not.

PART B — ADD USAGE TRACKING (NO ENFORCEMENT)

The new architecture deliberately does NOT enforce budget ceilings — no lane should ever be cut off or refused. What we need instead is measurement, so a later real run can be compared against the Part A prediction.

Design and implement the tracking side of this: a per-lane record capturing at minimum the lane id, its target file, the file's size bucket, the categories it was assigned, its predicted token cost from the Part A model, and fields for actual tokens consumed and actual wall-clock time. The predicted-vs-actual comparison is the entire point, so the record must carry both.

Where the consuming Stage 2 component does not exist yet (it is being built in parallel by another task), define the contract cleanly and provide the emitter/aggregator so it can be wired in later — do not try to modify that component yourself, and do not create files under tools/scanner/stage2-hunt-lanes-perfile/, which another task owns right now.

Keep the existing v1 budget governor at tools/scanner/stage1-budget-governor/ unchanged.

REPORT BACK: the bucket table with counts and subtotals, the totals for both scenarios, the breakdown of fixed-overhead versus content versus playbook cost, the chunking multiplier's contribution, what skipping non-executable files saves, and your calibrated tokens-per-byte figure with the reasoning behind it. Flag clearly any assumption that, if wrong, would move the total significantly.

CONSTRAINTS: only this repository; target-apps/ is read-only; never search for, read, or reference any answer-key or ground-truth material anywhere on this machine.
