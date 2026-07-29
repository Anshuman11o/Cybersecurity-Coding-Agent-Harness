# Stage 2 v2 (per-file) under `luna` — run notes

**Run 5**, 2026-07-29T16:55Z, `c9c2cf0`. Complete: **541/541 hunt lanes**, 324
skip, **392 candidate findings**, 0 guard blocks, 0 blocked reads.

These notes describe the artifacts currently in this directory. Earlier runs are
archived; see `docs/run-history.md` for the comparison table.

## A clean single pass

| | |
|---|---|
| Wall clock | 4m38s (16:55:07Z → 16:59:45Z) |
| Concurrency | `HUNT_CONCURRENCY=16` |
| Lanes | 541/541, **0 fatal, 0 retries** |
| Tokens | 3,786,720 — 3,398,322 in / 388,398 out |
| Cost | **$5.73** at $1.00/M input, $6.00/M output |

Zero retries, against run 3's 54 at concurrency 4, because the org ceiling for
this model rose from 200,000 TPM to **2,000,000**. 16 puts the run at ~41% of
the new ceiling. `docs/protocols/running-a-scan.md` gives the formula for
deriving the setting rather than copying a number.

Because this was a single pass, the `laneRecordsV2` checkpoint defect that
qualified run 1 does **not** apply here. All three accounting sources agree
exactly:

| Source | Total tokens |
|---|---|
| `rollup` | 3,786,720 |
| `lanes[]` (541 entries, no duplicate `lane_id`, none `failed`) | 3,786,720 |
| `legacy_entries` (865 entries, 0 `ceiling_hit`) | 3,786,720 |

## What this run measured

Three playbook edits (PR #22), all acting on the same mechanism — which class a
finding is labelled with:

1. `injection` gains cross-site scripting (reflected, stored, DOM-based), with
   stored XSS reported at the persistence point.
2. `ssrf` gains open redirect and weak destination allow-listing.
3. `crypto-auth` gains the authentication-outcome anchor.

Stages 0 and 0.5 were carried over from run 3 unchanged, so the lane manifest
and per-lane class assignments are identical and the comparison is
single-variable. Their `meta.json` still records `git_sha c9e3e94`; that is
correct and expected.

Stage 1 re-ran (it makes no LLM call) and projected 3,040,003 input tokens
against run 3's 2,764,390 — **+10.0%**, the cost of the longer playbooks.

Playbook text actually sent, verified from `prompt_breakdown.segments`:
injection 5,993 chars (×213 lanes), ssrf 5,308 (×156), crypto-auth 4,604 (×239).

## Results

Localization **75.3% → 80.4%**, the best recorded, with hedging *falling*
1.538 → 1.518 — so the gain is better aim, not a wider net. The `FILE_ONLY`
bucket collapsed **13 → 2**. `injection`-class localization is 18/18 and
`ssrf`-class 3/3, both exactly as the pre-run arm predicted.

**Recall fell 50.5% → 43.3%, and that is not a detection regression.** Three
ground-truth lines carry 23 of the 97 reachable entries; run 3 won all 23 and
run 5 won 15. That −8 accounts for the entire delta. Excluding those three
lines, recall is flat (34.2% → 35.6%) and localization is 67.1% → 74.0%, the
best of any run.

The pre-run projection (localization ~86.6%, recall ~56.7%) was too optimistic
on both counts. Full accounting is in the run archive's `MANIFEST.md`.
