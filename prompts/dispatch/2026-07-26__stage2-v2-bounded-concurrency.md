Add bounded concurrency to the per-file hunt executor, then cleanly restart the currently-running scan so the remaining lanes run in parallel.

CURRENT SITUATION

A scan is running right now: PID 20395, fully detached (PPID 1), logging to /tmp/stage2-run-v2.log. It has completed 153 of 553 hunt lanes, and its results are already durable on disk in tools/scanner/stage2-hunt-lanes-perfile/output/ thanks to the checkpointing you added. 400 lanes remain.

The executor processes lanes strictly sequentially — a plain for-of loop with `await huntLane(...)` inside it. At ~5 seconds per lane that means ~33 minutes remaining, almost all of it idle waiting on network round-trips. These lanes are completely independent of each other: each reads one file and produces its own findings, with no shared state and no cross-lane phases. So they parallelize cleanly.

STEP 1 — ADD BOUNDED CONCURRENCY

Modify the hunt loop in tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.ts to run several lanes concurrently, with a configurable ceiling. Use a named constant (default 8) and allow override via an environment variable so it can be tuned without a code change.

Important correctness note so you do not over-engineer this: Node executes JavaScript on a single thread, and the existing checkpoint writer uses synchronous fs calls (writeFileSync then renameSync). Synchronous calls cannot interleave with each other, so the existing checkpoint logic is already safe under promise-based concurrency — you do NOT need to add a mutex or lock. Keep those writes synchronous. Likewise, pushing to the shared findings/consumption arrays is safe for the same reason.

Preserve every existing behavior:
- Checkpoint after each lane completes, and resume from an existing checkpoint on startup.
- No budget enforcement, no ceilings, no skipping lanes for cost.
- Identical output file shapes.
- Per-lane failures must be caught and recorded without aborting the run — this matters more with concurrency, since one rejected promise must not tear down the whole pool.

Add retry with backoff on transient failures (rate limiting, timeouts). Running 8 calls at once against the same endpoint makes upstream throttling considerably more likely than it was sequentially, and a lane lost to a 429 is a lane silently missing from the results. Keep the default concurrency modest for that reason.

Log lines will now interleave between lanes. Make sure each line still identifies which lane it belongs to, so the log stays readable and attributable.

STEP 2 — STOP THE RUNNING SCAN CLEANLY

Send SIGTERM to PID 20395 (not SIGKILL) and give it a moment to settle, then confirm the process is gone. Then verify the checkpoint files in tools/scanner/stage2-hunt-lanes-perfile/output/ are still valid, parseable JSON and report how many lanes they contain. Expect roughly 153. The single lane that was in flight when you stopped it will be redone on resume, which is fine and expected.

STEP 3 — RELAUNCH DETACHED

Restart it fully detached so it survives your session ending:

  cd tools/scanner/stage2-hunt-lanes-perfile
  setsid nohup npm run run > /tmp/stage2-run-v3.log 2>&1 < /dev/null &

Confirm from the new log that it detected the checkpoint and RESUMED — it must report skipping the already-completed lanes and start from the remainder, not from lane 1. If it starts over from the beginning, stop immediately and report, because that would mean the resume path is broken and we would be paying for 153 lanes twice.

Report the new PID and confirm its parent process ID is 1.

STEP 4 — REPORT AND STOP. DO NOT POLL.

Report back immediately with: the concurrency change you made and its default, confirmation the old process is stopped, the checkpoint lane count, the new PID with proof of detachment, and the log lines showing it resumed rather than restarted. Then end your turn.

Do NOT wait for the run to finish. Do NOT loop grepping the log. It will be monitored externally.

Do not modify Stage 0 or Stage 0.5, and do not regenerate lane-assignments.json.

CONSTRAINTS: only this repository; target-apps/ is read-only; never search for, read, or reference any answer-key or ground-truth material anywhere on this machine.
