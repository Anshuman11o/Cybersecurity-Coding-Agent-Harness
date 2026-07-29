# Dispatch — Luna run 5: three playbook coverage fixes

**Standing constraint, non-negotiable:** never search for, read, or reference
any answer-key or ground-truth material anywhere on this machine.

## What ran

Stages 1 and 2 only, v2 per-file, provider `luna`. Stage 0 and Stage 0.5
outputs were carried over from run 3 unchanged — the only edit is to Stage 2
playbook text, so reusing them keeps the comparison single-variable.

Harness commit `c9c2cf0` (merge of PR #22).

## The change under test

Three playbook edits, all acting on one mechanism — which class a finding is
labelled with. Each closes a gap objectively present against the playbook's own
stated scope, and each was measured on a subset before being proposed.

1. **`injection`** declared it covers A03 "all variants" and contained no
   cross-site-scripting content at all. OWASP 2021 merged XSS into A03
   (CWE-79). Added reflected, stored and DOM-based XSS, with stored XSS
   reported at the persistence point — the render sink is usually in another
   file the lane cannot see, and its absence was being read as absence of the
   defect.

2. **`ssrf`** covered A10 but was written entirely around outbound requests.
   Added open redirect and weak destination allow-listing, naming the four
   bypassable matching styles, and corrected the false-positive rule that
   treated any allow-list as a valid control.

3. **`crypto-auth`** described defects *in* authentication mechanisms only.
   Added an authentication-outcome anchor: a defect of another class sitting on
   an authentication path also establishes A07.

## Run parameters

    HUNT_CONCURRENCY=16 setsid nohup ./tools/scanner/run.sh luna stage2-hunt-lanes-perfile

16 was derived from the current ceiling (2,000,000 TPM), not copied: run 3
measured ~51,700 TPM per unit of concurrency, so 16 lands at ~41% of ceiling,
leaving headroom for bursts. Result: 0 retries, 0 fatal, 541/541 lanes.

## Pre-run checks performed

- `git merge-base HEAD origin/main` confirmed; scanner source diffed clean
  against `origin/main`
- all three edits confirmed **by grepping the playbook files**, not by finding
  this prompt on disk
- run 3's Stage 2 outputs verified byte-identical to their archive, then moved
  aside so no stale checkpoint could be resumed
- coverage ledger reconciles; no denylisted file holds a hunt lane
- `guard.test.ts` 63/63; all 14 classes load, 25 codes covered, 0 duplicates
- preflight PASS

## Outcome

Localization 75.3% → 80.4% (best recorded), `FILE_ONLY` 13 → 2, hedging fell
1.538 → 1.518. Recall 50.5% → 43.3%, entirely attributable to three
high-multiplicity ground-truth lines where run 3 drew 23/23 and run 5 drew
15/23; excluding them recall is flat and localization rose 67.1% → 74.0%.
