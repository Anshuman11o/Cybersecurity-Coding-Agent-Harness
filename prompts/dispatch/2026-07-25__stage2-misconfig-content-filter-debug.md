This is a debugging + fix task, not a rewrite. Root-cause a specific failure in Stage 2 (Hunt Lanes) and fix it durably.

SYMPTOM (from the last full run, tools/scanner/stage2-hunt-lanes/output/):
The "misconfiguration" lane's LLM call failed with HTTP 400: "Input data may contain inappropriate content." As a result this lane produced 0 findings and 0 tokens_used (confirmed in budget-consumption.json: {"lane_id": "misconfiguration", "tokens_used": 0, "seconds_elapsed": 23.192, "ceiling_hit": false}). Every other lane succeeded.

This lane's seed files (from tools/scanner/stage05-lane-selector/output/lane-manifest.json) are:
lib/config.schema.ts, lib/insecurity.ts, lib/xml.ts, routes/fileServer.ts, routes/fileUpload.ts, routes/keyServer.ts, routes/logfileServer.ts, routes/quarantineServer.ts, server.ts (all under target-apps/juice-shop-blind/).

YOUR TASK:
1. Reproduce the failure. Run the misconfiguration lane in isolation (or the full Stage 2 run if that's simpler) against the current target-apps/juice-shop-blind/ and confirm you see the same HTTP 400 content-filter rejection.
2. Root-cause it: figure out which specific seed file(s) and/or which specific content (literal strings, path names like /ftp/, /encryptionkeys/, /support/logs/, or something else entirely) is triggering the upstream content-safety filter when assembled into this lane's prompt. Look at how tools/scanner/stage2-hunt-lanes/src/hunt-executor.ts assembles the prompt (seed file content interpolation), the lane's playbook at tools/scanner/stage2-hunt-lanes/src/playbooks/misconfiguration.ts, and the API call wrapper in tools/scanner/stage2-hunt-lanes/src/llm-client.ts.
3. Fix it durably -- not a retry-with-backoff band-aid that just hopes the filter doesn't trigger next time. If it's a specific string/pattern being read verbatim into the prompt in a way that looks like exfiltration/credential-dumping intent, consider how the content is presented (e.g. clearer framing/escaping around file paths and content) or whether the lane's scope should be split so one problematic file doesn't take down the whole category. Use your judgement on the right fix once you've found the actual root cause -- don't guess blindly.
4. Verify your fix: re-run the misconfiguration lane (or full Stage 2) and confirm it now completes with real tokens_used > 0 and produces findings (or a clean legitimate zero-findings result, not an HTTP 400).
5. Confirm the rest of the pipeline still works -- don't let a fix to this one lane break others.

REPORT BACK: the specific root cause you found (with evidence -- which content, which file), exactly what you changed and why, and the verification re-run's result (tokens_used, findings count, any remaining errors).

CONSTRAINTS (same as always): only this repo; target-apps/juice-shop-blind/ is read-only; never search for, read, or reference any answer-key/ground-truth material anywhere on this machine -- that's not your job and not accessible to you anyway.
