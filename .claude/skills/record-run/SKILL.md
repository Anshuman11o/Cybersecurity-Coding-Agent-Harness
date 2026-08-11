---
name: record-run
description: Keep a run's durable record complete across its whole lifecycle - before, during, immediately after, and after scoring. Use when a scanner or patcher run finishes, when asked to record, archive, log or write up a run, when a scoring or eval pass produces numbers, when a score exists only in the conversation, when back-filling a null score, and to check that every run on disk has a history row. Dispatches to archive-run or archive-patch-run for the archive step itself.
---

# Record a run

A run is finished when a later session — different container, none of this
conversation — can say what ran, from which tree, against which oracle set, what
it scored, and where the evidence is. Not when it exits.

`archive-run` and `archive-patch-run` own the archive step and are correct. Runs
still got partially lost, on **either side** of it:

- ~3M tokens of scanner work: never archived, overwritten in place.
- The subset 2 patcher run: archived nowhere durable, then the container went.
- Two patcher runs (`patch-run-subset-04`, `patch-run-subset-05`): **scored, and
  the score was never written to a file.** It was reported into a conversation
  and died there.

The full protocol is `docs/protocols/run-record-keeping.md`. This is the loop.

## 1. Which step are you at?

| Situation | Go to |
|---|---|
| about to launch | §2 |
| a run just finished | §3 |
| scoring just produced numbers | §4 |
| "is everything recorded?" | §5 |

## 2. Before the run — capture what cannot be recovered later

Run identity is only knowable at launch:

    git rev-parse --short HEAD                 # the tree that will run
    git merge-base HEAD origin/main            # and what it forked from
    git log --oneline HEAD..origin/main        # anything here is NOT in the run

Then **grep each change you believe is in force in the file it should be in.** A
dispatch prompt records what was asked for; only the commit records what ran.
This has already produced a baseline that measured a scanner missing three
changes that had been implemented and committed elsewhere.

Also pin, now: target sha, config digest / bug report id / playbook id, any
runtime env vars (for the scanner these change Stage 2's behaviour **without
changing the tree**, so the sha does not identify the run), the oracle set by
name and date, and what is known-broken at launch.

Archive the *previous* run and verify that archive before clearing its
checkpoint. Both Stage 2 and the v3 dispatcher resume from whatever is on disk
and will report success while handing back the previous run's work.

## 3. Immediately after the run — archive first

Before writing anything up, before answering what the run showed:

- scanner → invoke **`archive-run`**
- patcher → invoke **`archive-patch-run`**

Use the right one. `archive-run` is scanner-shaped and will file a patcher run
under the wrong metrics. Everything else can be rebuilt from the archive; the
archive cannot be rebuilt from anything.

## 4. After scoring — put the number in a file, this session

Scoring is sighted and happens in the answer-key repo. Only the `aggregate`
block of the result may come back; `per_case[]` stays there.

If you are archiving now, pass it straight through:

    python3 tools/patcher/src/archive_run.py --run-dir … --score <eval-result.json> …

If the run is **already archived** — the usual case, and the one that lost two
scores — append a rescore row:

    python3 tools/eval/run_records.py record-score \
        --run <run_id> \
        --score <sighted eval-result.json> \
        --ground-truth-set "<oracle set, by name and date>" \
        --defects "<known-broken during the run, or 'none known'>" \
        --located-detail-at "<answer-key repo, branch, commit>" \
        --notes "<what happened, including cost and failure>"

`--dry-run` first. It carries the run's identity forward from the row it
supersedes, reads only `aggregate`, and re-runs the archiver's publishability
guard before appending.

`--ground-truth-set` and `--defects` are required on purpose: **the
qualification travels in the row**, not in a footnote, not in a commit message,
not in this conversation. And never read two oracle sets as one trend — subset 2
went 2/10 → 10/23 without a single patch changing, because 13 driver-backed
oracles were added underneath it.

Also file the sighted per-case detail in the **answer-key repo** in the same
session, and put the pointer — branch and commit, never content — in
`--located-detail-at`. That repo is version controlled; the private store is
not.

## 5. Verify — commands, not attestations

    python3 tools/eval/run_records.py check --run <run_id>     # exit 0, no `unscored`
    python3 tools/eval/run_records.py check                    # no ERROR anywhere
    python3 -m pytest tools/patcher/tests/test_archive_run.py tools/patcher/tests/test_run_records.py -q
    wc -l results/eval-history/<component>.jsonl               # exactly one more row
    grep -rE "\bBUG-[0-9]+\b|[a-z][A-Za-z0-9]*Challenge\b" results/ docs/ prompts/

`check` reports `ERROR` (broken record, or a run on disk with no row), `LEAK` (a
committed row trips the guard), `GAP` (incomplete — above all `unscored`) and
`NOTE`. The repo-wide run currently exits 1 on seven pre-existing `LEAK`s in
append-only history; `--run <id>` is the gate for the run you just did. Full
checklist: `docs/protocols/run-record-keeping.md` §3.

## What you must not do

- Do not edit a committed row. Append-only, both history files; a correction is
  a new row carrying `rescore_of`. Each row cost a real run.
- Do not loosen the publishability guard in `tools/patcher/src/archive_run.py`.
  If it fires, rephrase the row.
- Do not put a bug id, challenge key, `file:line` or source path in the row, the
  notes, a doc, or a commit message. Two of this project's four recorded
  blind-boundary breaches came from eval write-up, because the useful conclusion
  is naturally phrased in terms of locations.
- Do not report a number without the defects that qualify it.
- Do not claim the private store is backed up. It is not a git repository at
  all — no remote, no version control. `docs/protocols/run-record-keeping.md` §5
  lists what survives a container reclaim and what does not.
