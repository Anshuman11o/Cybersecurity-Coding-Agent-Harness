A previous attempt at this run was killed partway through and produced NOTHING usable. Fix that fragility first, then relaunch. Two problems to solve.

WHAT WENT WRONG

The run reached 159 of 553 lanes and consumed roughly 3 million tokens, then died. Two independent causes, both fixable:

1. PROCESS LIFETIME. The scan was started as a background child of an agent session. When that session was cleaned up, the whole process group was killed with it. There was no out-of-memory condition and no crash — the process was simply reaped along with its parent.

2. NO INCREMENTAL OUTPUT. The executor only writes candidate-findings.json and budget-consumption.json at the very end, after all lanes finish. So when it died at lane 159, roughly 3 million tokens of completed, perfectly good work evaporated — no output directory was ever created. That is the more serious defect: a long run that can only produce results if it survives start to finish is not an acceptable design at this scale.

FIX 1 — CHECKPOINT INCREMENTALLY (do this before relaunching)

Modify tools/scanner/stage2-hunt-lanes-perfile/ so results are durable as they are produced:

- After EACH lane completes, append or rewrite its results to disk immediately. Do not buffer everything in memory until the end.
- On startup, detect existing partial results and RESUME: skip lanes already completed and continue from where it stopped. Print how many lanes were resumed from the checkpoint.
- The final candidate-findings.json and budget-consumption.json must have exactly the same shape as before, so downstream consumers are unaffected. A partial file must still be valid, parseable JSON, not a truncated fragment.
- Keep everything else about the component's behavior identical. No budget enforcement, no ceilings, no lane skipping for cost.

This means a future interruption costs only the lane in flight, not the whole run.

FIX 2 — LAUNCH FULLY DETACHED

Start the run so it cannot be killed when your session ends. Use setsid together with nohup so the process gets its own session and process group, fully detached from yours, with output redirected to a log file. Something along the lines of:

  cd tools/scanner/stage2-hunt-lanes-perfile
  setsid nohup npm run run > /tmp/stage2-run-v2.log 2>&1 < /dev/null &

Confirm after launching that the process is genuinely detached: report its PID and show that its parent process ID is 1 (or otherwise not your shell). If it is still parented to your shell, it will be killed again — fix that before proceeding.

THEN: DO NOT POLL

Once you have confirmed the process is running and detached, report back IMMEDIATELY with: the checkpointing change you made, the PID, proof of detachment, and the current lane count from the log. Then end your turn.

Do NOT sit in a loop waiting for it to finish. Do NOT repeatedly grep the log. The previous attempt wasted its entire turn polling. The run takes roughly an hour; it will be monitored externally. Your job is to make it durable, start it, prove it is detached, and stop.

INPUTS (already correct, do not regenerate):
- tools/scanner/stage0-recon/output/architecture-summary.json
- tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json  (918 lanes: 553 hunt, 365 skip)

Do not re-run Stage 0 or Stage 0.5. Do not modify lane-assignments.json.

CONSTRAINTS: only this repository; target-apps/ is read-only; never search for, read, or reference any answer-key or ground-truth material anywhere on this machine.
