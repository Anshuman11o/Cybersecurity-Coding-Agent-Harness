This is a fresh, full end-to-end EXECUTION task, not a development task. Do NOT modify any source code in any stage.

GOAL: Run the complete scanner pipeline, Stage 0 through Stage 2 (Recon -> Dynamic Lane Selector -> Budget Governor -> Hunt Lanes), as ONE continuous fresh run against target-apps/juice-shop-blind/, in sequence, so every stage's output comes from the same coherent run. Stage 3 (Validate) is explicitly OUT of scope for this task -- stop after Stage 2.

The target app and the scanner code have both changed since the last run you may remember from a prior session -- treat this as fully fresh, do not assume anything about lane counts, seed files, or file contents from before.

STEPS (run each stage's existing entry point, in order, each consuming the previous stage's FRESH output as input -- do not reuse old output files from prior runs):

1. Stage 0 (Recon): cd tools/scanner/stage0-recon && npm run run

2. Stage 0.5 (Dynamic Lane Selector): cd tools/scanner/stage05-lane-selector && npm run run
   - Consumes Stage 0's fresh output. Produces lane-manifest.json.
   - Note: this stage now has a permanent denylist that excludes 3 specific infrastructure files (models/challenge.ts, lib/antiCheat.ts, data/datacreator.ts) from ever being seeded to any lane -- this is expected, intentional behavior, not a bug.

3. Stage 1 (Budget Governor): cd tools/scanner/stage1-budget-governor && npm run run
   - Consumes Stage 0.5's fresh lane-manifest.json. Produces budget-plan.json.

4. Stage 2 (Hunt Lanes): cd tools/scanner/stage2-hunt-lanes && npm run run
   - Consumes Stage 1's fresh budget-plan.json. Runs all lanes (Phase 1 hunt, Phase 2 orchestrator review, Phase 3 approved re-runs). Produces candidate-findings.json and budget-consumption.json.
   - This is the expensive step (real LLM calls across all lanes) -- let it run to completion, don't shortcut it.

Overwrite each stage's existing output/ directory with this fresh run's results -- that's expected and correct.

REPORT BACK, for each of the 4 stages:
- Did it complete without crashing? Any errors/warnings worth flagging?
- Real metrics: for Stage 0, category-applicability summary. For Stage 0.5, lane count + confirm none of the 3 denylisted files appear in any seed_files list. For Stage 1, token/time ceilings per lane, how many lanes flagged for escalation. For Stage 2: total candidate findings, findings per lane, total real tokens consumed, wall-clock time, how many lanes hit their budget ceiling, how many scope requests were made, how many escalation second-passes were approved and run.
- Total end-to-end wall-clock time and total tokens consumed across all 4 stages.

CONSTRAINTS (same as always): only this repo; target-apps/juice-shop-blind/ is read-only; never search for, read, or reference any answer-key/ground-truth material anywhere on this machine -- that scoring happens separately and is not your job.
