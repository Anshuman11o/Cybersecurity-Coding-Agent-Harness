# Playbook agent precision experiments (2026-10-13)

Goal set by the project owner: precision of 75% or more on both held-out tests,
with recall at 100%, through simple, generic changes to the playbook agent's
loop, turns, prompts and evidence handling. At most 5-7 changes; then stop and
report.

Protocol:

- Every change is generic. No prompt, schema or code names a target, a class
  expected on a target, or anything learned from either answer key. Changes are
  judged on aggregate scores only, and on general patterns in the agent's own
  output (its reasons and turn records), never on class-by-class answer-key
  detail.
- Each iteration: one or two changes, a dispatch spec under
  `prompts/dispatch/`, mocked tests, then one run of each test (recon plus
  playbook agent, `luna6`) scored with the private `score.py --level combined`.
  Test 2 starts each run from an empty playbook cache.
- Aggregates go to `results/eval-history/playbook-agent.jsonl`; located detail
  stays in the answer-key repos.

Branches:

- Checkpoint (full recall, before any precision change):
  `claude-anshuman/playbook-agent-checkpoint-recall100` at `914e5a7`
  (scanner code `78cbf46`). Not to be modified.
- This work: `claude-anshuman/playbook-agent-precision`.

Test 1 = aigoat-clean-LLM @ 9c62129 (8 present classes). Test 2 =
androgoat-clean-mobile @ 723a653 (7 present classes). Precision targets:
Test 1 needs all 8 present classes within at most 10 chosen; Test 2 needs all
7 within at most 9.

## Results

One run per test per row. A single run moves Test 2 recall by about 14 points
when one class is or is not picked, so single-run differences are noisy.

| Iter | Commit | Change | T1 recall | T1 precision | T2 recall | T2 precision | Cost T1 / T2 |
|---|---|---|---|---|---|---|---|
| checkpoint | 78cbf46 / ab3f0bd | decision loop (coverage, turn1, turn2 x up to 3, turn3), all add-only | 8/8 | 8/13 (61.5%) | 7/7 | 7/16 (43.8%) | - / $0.1604 |
| P1 | c61dbe2 | turn3 prunes classes with no recon evidence; turn2 one pass | 8/8 | 8/13 (61.5%) | 6/7 | 6/12 (50.0%) | $0.0456 / $0.1528 |
| P2 | 8f07d9e | turn2 adds only with named recon evidence; turn3 re-thinks from turn2's evidence (keep, include, remove with explanation) | 8/8 | 8/13 (61.5%) | 6/7 | 6/13 (46.2%) | $0.0458 / $0.0822 |
| P3 | 4b37673 | turn3 rates each class's likelihood (high/medium/low) from recon evidence; code drops low | 5/8 | 5/10 (50.0%) | 3/7 | 3/8 (37.5%) | $0.0452 / $0.1654 |
| P4 | 735a086 | decision calls see the source of signal-flagged files (12 KB per file, 120 KB total); turn3 rates from source and recon | 7/8 | 7/8 (87.5%) | 5/7 | 5/9 (55.6%) | $0.1046 / $0.1139 |
| P5 | b7d0e6c | excerpts cover the whole codebase (flagged files first, 200 KB total) | 7/8 | 7/8 (87.5%) | 5/7 | 5/10 (50.0%) | $0.0419 / $0.1832 |
| P6 | cf3675a | turn3 rates every built-in (unselected high/medium included); low requires a source check | 7/8 | 7/9 (77.8%) | 5/7 | 5/12 (41.7%) | $0.0662 / $0.1599 |

The Test 1 checkpoint row is the last Test 1 run (`ab3f0bd`, same decision loop;
its later commits changed research only, which Test 1 never reaches).

## Diagnosis before P3

- In both tests nearly every built-in is selected by the first decision call;
  Test 1 selects all 13 every run. Later turns rarely change anything.
- The agent's reasons are surface-presence statements ("the feature is present;
  exposure is unknown"). Hedged reasons were no more often wrong than plain
  ones (aggregate over five runs), so wording alone does not separate them.
- Recon's category verdicts and file-signal counts do not separate correct from
  wrong picks either, so no deterministic filter on them is viable.
- The prompts ask whether a class *applies* (its surface exists). That is true
  of almost every class for a real application.
- The recall misses in P1 and P2 were built-ins no decision call picked, a
  different one each time: run-to-run variance in the first calls, not removals.

## Iterations

### P3: likelihood rating in turn3 (4b37673)

Change: turn3 rates every class high / medium / low for how likely the target
contains an exploitable vulnerability of it, judged from recon; code drops low.
Spec: `prompts/dispatch/2026-10-13__playbook-agent-p3-likelihood-turn3.md`.

Result: recall fell on both tests. turn3 removed 3 classes in each; 5 of those
6 were present classes. The model's recon-only judgement of which classes are
likely is not just weak but leans the wrong way: recon is summary-level
("feature present, controls not described") and gives it nothing concrete to
separate on. Conclusion: a prune needs better evidence, not a stricter question.

### P4: source code evidence for decision calls (735a086)

Change: every decision call receives the source of the files recon flagged with
content signals (read through the corpus guard; 12000 bytes per file, 120000 in
total); research calls do not. turn3's likelihood wording points at that source.
Spec: `prompts/dispatch/2026-10-13__playbook-agent-p4-source-evidence.md`.

Result: with code to look at, turn3's removals became mostly right: 6 removed
on Test 1 (5 absent classes), 3 on Test 2 (2 absent). Test 1 precision reached
87.5%, but each test lost one present class to a removal, and Test 2 also never
picked one present class. All excerpt files were read (none unreadable or
blocked).

Next: the agent sees only signal-flagged files (25 of 98 on Test 1). A class
whose evidence sits in an unflagged file can only be rated low. P5 widens the
excerpts to the whole codebase within a larger cap.

### P5: whole-codebase source evidence (b7d0e6c)

Change: excerpts take signal-flagged files first, then every other non-test
source file by path (stylesheets and unflagged json excluded), cap 200000 bytes.
Spec: `prompts/dispatch/2026-10-13__playbook-agent-p5-whole-codebase-evidence.md`.

Result: Test 1 unchanged from P4 (one present class still removed). On Test 2
every turn3 removal was now right, but two present classes were never picked
by any call, and the three additional classes all scored as unknown names.

Next: turn3 only re-rates what is already selected, so a class the earlier
calls left out is never judged against the code. And "low" means "only the
feature exists", a weak bar for removing a class. P6 makes turn3 rate every
built-in, selected or not, and requires checking the source before rating low.

### P6: turn3 rates every built-in; low needs a source check (cf3675a)

Change: turn3 returns every built-in, selected or not, with a likelihood; an
unselected built-in rated high or medium is included; low only after checking
the relevant source. Spec:
`prompts/dispatch/2026-10-13__playbook-agent-p6-turn3-rates-all-builtins.md`.

Result: no gain. Test 1 kept one more absent class (7/9) and still lost the
same present class. On Test 2 turn3 judged every built-in against the code and
still rated the two missed present classes low.

## Status: stopped, goal not met

Stopped after six iterations (about ten individual changes), per the owner's
limit. Goal: precision of at least 75% with recall 100% on both tests.

Best configurations:

- P4/P5 (source evidence plus turn3 likelihood): Test 1 precision 87.5%,
  recall 7/8; Test 2 precision 50-56%, recall 5/7. P5 is cheaper on Test 1.
- Checkpoint: recall 100% on both, precision 61.5% / 43.8%.

What was learned:

1. Recon-only judgement cannot separate present from absent classes. Recon is
   summary-level; asked to rate likelihood from it (P3), the model removed
   mostly present classes.
2. Source code is the lever that works. With source excerpts (P4-P6) turn3's
   removals were right 16 times out of 20 across both tests, and Test 1
   precision reached 87.5%.
3. The remaining recall loss is systematic, not noise: with the code in front
   of it, the model rates the same present classes absent in every iteration
   (one on Test 1, two on Test 2). Any generic rule that rescues them
   would have to keep more classes in general, which costs the precision
   gained. Fixing them specifically would need knowledge of the answer key,
   which the protocol forbids.
4. On Test 2 every additional class the agent has ever proposed (0 of 10
   across all runs) scored as an unknown name. That alone caps Test 2
   precision. Whether those classes are wrong, or are right but named outside
   the scorer's taxonomy, is a question for the scorer and its aliases, not
   for the agent's prompts.
5. turn1 and turn2 (add-only) contributed almost nothing correct once the first
   call and turn3 had source evidence.

Single runs per test throughout; a one-class change moves Test 2 recall by
about 14 points.

## Decision: the checkpoint is the final architecture

The project owner chose to keep the checkpoint architecture (scanner code
`78cbf46`, full recall on both tests) as the playbook agent's final design. On
`claude-anshuman/nifty-goldberg-q8g8lp` the whole of
`tools/scanner/stage-playbook-agent/` was restored byte for byte to the
checkpoint; nothing else under `tools/` had changed.

Kept for future reference, not in force:

- every change tried, as code: branch `claude-anshuman/playbook-agent-precision`
  (P1 `c61dbe2`, P2 `8f07d9e`, P3 `4b37673`, P4 `735a086`, P5 `b7d0e6c`,
  P6 `cf3675a`), and its draft PR against the checkpoint branch;
- every change tried, as a spec: `prompts/dispatch/2026-10-13__playbook-agent-*`;
- every run: aggregate rows in `results/eval-history/playbook-agent.jsonl`,
  located detail in the answer-key repos under
  `evaluations/2026-10-13-playbook-agent-luna6-*`;
- the checkpoint itself: branch `claude-anshuman/playbook-agent-checkpoint-recall100`
  at `914e5a7`.

If precision work resumes, the most promising starting point is P4/P5 (source
code evidence for the decision calls); see the status section above for the
recall loss it still carries.
