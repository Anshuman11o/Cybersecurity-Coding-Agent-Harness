# Running a scan

The operational runbook. `architecture/multi-model-architecture.md` §5 covers
what `run.sh` does mechanically; this covers what a person or agent has to do
around it, in order, including the checks that exist because skipping them has
already cost a run.

Everything below assumes the v2 track. Substitute the v1 stage names for a v1 run.

---

## 1. Verify the tree, not the intent

**Do this first, every time.**

    git fetch origin
    git merge-base HEAD origin/main | xargs git log -1 --oneline
    git log --oneline HEAD..origin/main      # anything here is NOT in your run
    git log --oneline origin/main..HEAD

Then confirm each change you believe is in force **by grepping the file it
should be in**, not by finding the brief that asked for it.

This exists because on 2026-07-28 three requested changes — playbook
adjacent-class disambiguation, removal of the two-class cap, and the
misconfiguration/insecure-design prompt work — were all implemented and
committed *before* a run started, but on a branch that run's tree had forked away
from. The run measured a scanner missing all three and exited 0. The cap was
demonstrably binding: 114 of that run's 247 findings sat exactly on the two-class
ceiling. A baseline measured from the wrong tree is worse than no baseline,
because it gets cited later as if the changes had been tested and had not worked.

## 2. Archive the previous run and clear the checkpoint

**Stage 2 resumes from whatever is in its output directory.** If the previous
run's `candidate-findings.json` is still there, the new run skips every lane it
already has, returns the old findings, and reports success. The log looks normal
and the output is well-formed.

The resume gate is `candidate-findings.json` + `budget-consumption.json` only.
`class-sweep.json` is written alongside them but is deliberately *not* part of
the gate, so a checkpoint from a build that predates the sweep is still
resumable. Clear all three anyway.

    ls tools/scanner/runs/<provider>/stage2-hunt-lanes-perfile/
    # candidate-findings.json and budget-consumption.json must NOT be there
    # class-sweep.json should go too — it is not part of the resume gate, but
    # leaving it behind mixes one run's sweeps into the next run's artifact

Invoke the `archive-run` skill first, confirm the archive is complete, then move
the two files aside — do not delete until the archive is verified. Stage outputs
are committed to git, so history is a second copy; `logs/` is gitignored and is
not.

## 3. Confirm the provider is reachable

    cd tools/scanner/shared
    NODE_USE_ENV_PROXY=1 SCANNER_PROVIDER=<provider> npx tsx preflight.ts

Costs a few tokens. Prints provider, model, sampling/token params and key length,
then does a plain completion and a `json_schema` round-trip. Exits non-zero on
failure, so it can gate a pipeline. `PASS` on the last line is what you want.

## 4. Confirm the corpus

    ls target-apps/juice-shop-blind | head

The scanner reads only through `readCorpusFile()`, whose allowlist is confined to
`target-apps/juice-shop{,-blind}` and which fails closed. Every stage records
`blocked_reads` in its `meta.json`; a non-zero value means something tried to
read outside the corpus and was stopped.

## 5. Launch

Scans outlive an agent session, so detach:

    LOG=<scratch>/stage2.log
    HUNT_CONCURRENCY=4 setsid nohup ./tools/scanner/run.sh <provider> stage2-hunt-lanes-perfile > "$LOG" 2>&1 &

`run.sh <provider> <stage|all|all-v2>`. The provider list comes from the registry,
not from the script. A cross-provider mutex allows concurrent runs of the *same*
provider but not of two different ones.

Stage order for v2:

    stage0-recon → stage05-lane-selector-perfile → stage1-budget-governor-perfile
    → stage2-hunt-lanes-perfile → reconcile-v2

`stage1-budget-governor-perfile` writes the pre-run projection
(`budget-plan-v2.json`): calls, input, output and cost for the arm the env
selects. `reconcile-v2` is the post-run pass over the same stage and writes
`usage-v2.json` — what the run actually spent, read from Stage 2's own
consumption artifact. It reports actuals only; it does not compare them to the
plan, because a gap between an estimate and a measurement is a fact about the
estimate and the number wanted afterwards is the cost.

Running stage by stage, with a check between each, is preferred over `all-v2`
when anything upstream has changed.

### Selecting the lane agent loop and the model parameters

**The shipped arm is `HUNT_LOOP=trace` with the registry's `reasoning_effort:
high` and its 24,000-token cap. A plain `run.sh luna stage2-hunt-lanes-perfile`
gets you that and needs no env var.** To reproduce runs 1–5 instead:

    HUNT_LOOP=none SCANNER_REASONING_EFFORT= SCANNER_MAX_OUTPUT_TOKENS=8000

Four env vars change what Stage 2 does without changing the tree, so **the git
sha does not identify the run** — this is the "verify the tree, not the intent"
hazard in its runtime form. All four are recorded in `meta.json`; state them in
the run report as well.

| var | default | what it does |
|---|---|---|
| `HUNT_LOOP` | **`trace`** | `none` \| `trace` \| `gap` \| `reflect` \| `sweep` — see `../architecture/stage2-lane-loop.md` |
| `HUNT_LOOP_PASSES` | `1` | follow-up turns per chunk; the loop stops early on an unproductive turn |
| `HUNT_LOOP_STRICT_TRACE` | unset | `1` selects the stricter completion wording — **measured worse**, recall 66.0% → 52.6% |
| `HUNT_SWEEP_GROUP` | `3` | classes per group in `sweep` mode |

And two that override the registry for one invocation, so an A/B does not need
`models.json` edited, committed and reverted between arms:

| var | what it does |
|---|---|
| `SCANNER_REASONING_EFFORT` | `low` \| `medium` \| `high`, or empty to send none at all (what runs 1–5 did) |
| `SCANNER_MAX_OUTPUT_TOKENS` | output cap; **must move with the effort** |

The last pairing is the one to get right. At `reasoning_effort: high` a cap of
8,000 truncates 42% of lanes, and a truncated body is unparseable JSON that this
stage records as *a lane that found nothing* — measured recall 63.9% → 37.1%
with nothing in the log to say why. Raising the cap past ~16,000 buys nothing:
the highest completion measured is 14,584.

### Concurrency and rate limits

`HUNT_CONCURRENCY` (default 8) caps concurrent lanes. **Derive it from the
current rate limit rather than copying a number out of this file** — the limit
has already changed once by 10x, and a setting tuned to the old ceiling is
either needlessly slow or a lane-loss risk.

#### Current limits for `gpt-5.6-luna` (as of 2026-07-29)

| | |
|---|---|
| tokens per minute | **2,000,000** |
| requests per minute | 5,000 |
| tokens per day | 20,000,000 |

#### How to pick a value

Run 3 is the calibration point: 541 lanes, 3,558,386 tokens in 17m12s at
`HUNT_CONCURRENCY=4`. That is **~51,700 TPM and ~7.9 RPM per unit of
concurrency** — scale linearly from there.

    C  =  (target share of TPM ceiling) / 51,700

**Target 40–50% of the TPM ceiling, not 90%.** The headroom is not waste: lanes
do not arrive uniformly, and a batch of large files landing together spikes well
above the mean. RPM is never the binding constraint at this lane size — at the
2M ceiling it sits under 3%.

At the current ceiling that gives **`HUNT_CONCURRENCY=16`** (~828k TPM, 41% of
ceiling, ~4 min wall clock). Run 5 used it: **541/541 lanes, 0 fatal.**

**That 51,700 figure is a default-effort number and does not carry.** At
`reasoning_effort: high` a call spends far longer producing far more tokens, and
the throughput per unit of concurrency collapses. Measured on the 40-lane
platform at `HUNT_CONCURRENCY=8`:

| arm | tokens | wall clock | TPM | TPM per unit of concurrency |
|---|---|---|---|---|
| `none`, effort `high` | 603,017 | 5m11s | 116k | **14,500** |
| `trace`, effort `high` | 1,210,802 | 9m30s | 127k | **15,900** |

So the shipped arm is ~16k TPM per unit, a third of the default-effort rate.
Re-derive from that table, not from the run-3 line above, for any high-effort
run: `C = (target share of ceiling) / 16,000`.

History, for calibration: at the old **200,000 TPM** ceiling, 8 lost 52 of 541
lanes and 4 was the safe value — 4 already sat at ~207k TPM, right on that
ceiling, which is why run 3 still took 54 retries to get through cleanly.

Each 429 asks for a **1–4 second** wait.

So no individual backoff was ever too short. What killed the run was `maxRetries`
being 3 — three retries could not outlast a *sustained* saturation period. It is
now 5, with the backoff cap raised from 15s to 60s (waits 2+4+8+16+32 = 62s,
crossing a full TPM window).

**Avoiding a failed lane matters more than it looks.** A second pass triggers a
known defect: `laneRecordsV2` is not restored from the checkpoint, so `lanes[]`
and `rollup` in `budget-consumption.json` cover only the final pass. On the
2026-07-28 run that made the rollup understate the total by ~6x. A clean single
pass sidesteps it. `legacy_entries` is always complete.

## 6. Watch it

Do not poll with foreground sleeps. Wait on a condition:

    until grep -qE "exited [0-9]+" "$LOG"; do sleep 30; done

Useful counters while it runs:

    grep -cE '→ [0-9]+ finding' "$LOG"    # lanes complete
    grep -cE '\[RETRY\]'        "$LOG"    # transient errors, recovered
    grep -cE '\[FATAL\]'        "$LOG"    # lanes lost — should be 0

Retries are healthy flow control. Fatals are not.

## 7. Verify before believing

Never report a stage result without reading the artifacts. At minimum:

    meta.json                provider, model, git_sha, exit_code,
                             blocked_reads (0), degraded (false)
    coverage ledger          hunt + skip == inventory, unaccounted == 0
    consumption entries      one per lane, no duplicate lane_id, no failed:true
    rollup vs legacy_entries totals agree (they will not if the run resumed)

For Stage 0.5 also confirm the three denylisted files are `skip` and that no
denylisted file was given a hunt disposition — `guard.test.ts` asserts this
against any manifest on disk, so run it:

    cd tools/scanner/stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts

## 8. Commit artifacts — but only when the stage has exited

Stage outputs are committed. **Do not commit a stage's artifacts while it is
still writing them.** A half-written `candidate-findings.json` is still valid
JSON, and committing it alongside a `meta.json` claiming `exit_code: 0` produces
provenance that does not match what the stage produced. Wait for the exit line.

## 9. Score and archive

See `eval-howto.md` for the metrics, then invoke the `archive-run` skill. The
next run overwrites stage outputs in place; one run has already been lost this
way (~3 million tokens).

---

## Reference: a full v2 run, 2026-07-28

Concrete numbers for calibration.

| | |
|---|---|
| Corpus | 1102 files, 865 in inventory |
| Lanes | 541 hunt, 324 skip |
| Stage 0 | ~1 min |
| Stage 0.5 / Stage 1 | seconds each, deterministic |
| Stage 2 | 20m19s at `HUNT_CONCURRENCY=4`, 541/541, 0 failures, 62 retries |
| Tokens | 4,022,526 — 3,663,606 in / 358,920 out |
| Cost | **$1.16** at $0.20/M input, $1.20/M output (restated; published at the time as $5.82 under a rate that was 5x high — see `../run-history.md` "A pricing correction") |

A prior run at concurrency 8 took a similar wall clock but lost 52 lanes and
needed a second pass. Throughput is bounded by TPM, not by concurrency, so
lowering concurrency costs little time and buys reliability.
