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

