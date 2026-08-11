# Keeping a run

A run is expensive, unrepeatable, and is not finished when it exits. It is
finished when a later session — on a different container, with none of this
conversation — can say what ran, from which tree, against which oracle set, what
it scored, and where the evidence is.

Four things this project has already paid for did not reach that state:

| What was lost | How |
|---|---|
| A scanner run, ~3M tokens | never archived; the next run overwrote stage outputs in place |
| The subset 2 patcher run's records, transcripts, cost, disposition histogram | scored, then the container took the run store; only the sighted per-case table survived, in the answer-key repo |
| Two patcher scores (`patch-run-subset-04`, `patch-run-subset-05`) | both runs were scored and neither score was ever written to a file |
| Any run whose numbers are cited from `results/archive/` prose | qualification travelled in a footnote instead of the row |

`archive-run` and `archive-patch-run` cover the archive step, and cover it well.
The losses above happened **on either side of it**: identity that was never
captured before the run, and a score that arrived after the archive was already
written and had nowhere to go. This protocol is the whole lifecycle; the two
skills remain the authority for their own step.

---

## 1. The lifecycle

### Before — capture what cannot be recovered afterwards

A run's identity is only knowable while it is being launched.

| Capture | Why | Where it ends up |
|---|---|---|
| harness commit (`git rev-parse --short HEAD`) | a dispatch prompt records what was *asked for*; only the commit records what *ran* | row `version` |
| tree diff vs `origin/main` | see `../../CLAUDE.md` "verify the tree, not the intent" — three dispatched changes once were not in the tree that ran, and the run was cited as if they had been tested | run report / manifest |
| target sha | the app is a moving tree too | row `target_sha` |
| config digest, bug report id, playbook id | `config_digest()` in `tools/patcher/src/run_patcher.py` hashes the whole config; two runs with different digests are not the same experiment | row `inputs` |
| runtime env vars | for the scanner, four env vars change what Stage 2 does **without changing the tree**, so the sha does not identify the run (`running-a-scan.md` §5) | manifest, and stated in the report |
| oracle set, by name and date | a ground-truth change invalidates comparison across it | row `ground_truth_set` |
| defects known-broken at launch | a number without its caveats is re-read later as a clean measurement | row, at scoring time |

Then clear the previous checkpoint — **after** its archive is verified, never
before. Stage 2 and the v3 dispatcher both resume from whatever is on disk and
will report success while returning the previous run's work.

### During — checkpoint, so an interruption costs one unit

Runs outlive agent sessions. Launch detached (`setsid nohup`) and require the
component to write incrementally: the v3 run store writes `tasks.jsonl` at task
end and `phases/phase-<n>.json` after each merge queue, so a crash costs a phase
rather than the run (`tools/patcher/src/v3/run_store.py` explains which of the
two is authoritative and why both are kept).

Nothing else here can be fixed after the fact. A run that did not checkpoint and
died is simply gone.

### After — archive before anything else touches the disk

Invoke the skill for the component that ran:

- scanner → `archive-run`
- patcher → `archive-patch-run` (wraps `tools/patcher/src/archive_run.py`)

Do this **first**, before writing up results, before answering questions about
what the run showed. Everything else can be reconstructed from the archive; the
archive cannot be reconstructed from anything.

### After scoring — write the score into a file, in the same session

This is the step that had no home, and it is where three of the four losses
above happened.

Scoring is sighted: it happens in the answer-key repo, after the run has
completed independently. What comes back is an `eval-result.json` whose
`aggregate` block is publishable and whose `per_case[]` is not.

**Ordinary order — score, then archive.** Pass the sighted result to the
archiver, which reads `aggregate` and nothing else:

    python3 tools/patcher/src/archive_run.py --run-dir … --score <eval-result.json> …

**When the score arrives after the archive**, which is the common case, the row
already exists and append-only means it cannot be edited. The score arrives as a
rescore row:

    python3 tools/eval/run_records.py record-score \
        --run <run_id> \
        --score <sighted eval-result.json> \
        --ground-truth-set "<oracle set, by name and date>" \
        --defects "<what was known-broken, or 'none known'>" \
        --located-detail-at "<answer-key repo, branch, commit>" \
        --notes "<what happened, including cost and failure>"

It carries the run's identity forward from the row it supersedes, takes only the
`aggregate` block, re-runs the publishability guard, and appends. `--dry-run`
prints the row without writing.

`--ground-truth-set` and `--defects` are **required arguments**, not because the
tool needs them but because a score whose oracle set and caveats are not in the
row is a number that will be read as a trend.

A score reported to a human and not written to a file does not exist. The
session ends and it is gone — which is exactly what happened twice.

---

## 2. Where each artefact goes

```
aggregate   ->  results/eval-history/<component>.jsonl   committed, publishable
located     ->  <private store>/<stamp>/                 outside the repository
                answer-key repo                          sighted per-case detail
```

`tools/patcher/src/archive_run.py` is **the authority** on which half a given
field belongs to. It builds the row from an explicit allowlist, never walks
`tasks[]`, and re-checks the finished row against the forbidden patterns: a bug
id, a challenge key, a `file:line` reference, a source path, or a key that
carries located material by construction. `tools/eval/run_records.py` imports
that guard rather than restating it — a second copy of the pattern list would
drift, and the drifted copy would be the permissive one.

If the guard fires, **rephrase the row. Never loosen the guard.** Four
blind-boundary breaches are recorded in the root `CLAUDE.md` and two came from
eval write-up rather than from code, because the useful conclusion is naturally
phrased in terms of locations.

Both history files are **append-only**. Each row cost a real run and cannot be
reconstructed. A correction is a new row carrying `rescore_of`, never an edit —
a rewritten history cannot be trusted to show a regression.

---

## 3. The completion checklist

Each item is a command whose output settles it. Do not attest to any of them.

| # | Check | Command | Settled by |
|---|---|---|---|
| 1 | the tree that ran is the tree you think | `git merge-base HEAD origin/main` + grep the change in the file it should be in | your eyes, on the file — not on a dispatch prompt |
| 2 | the archive exists and is complete | file count printed by the archiver vs. `find <archive> -type f \| wc -l` | equality |
| 3 | the manifest names the defects in force | `grep -A3 'Defects in force' <archive>/MANIFEST.md` | non-empty, and not the placeholder |
| 4 | the history gained exactly one row | `wc -l results/eval-history/<component>.jsonl` before and after | difference of 1 |
| 5 | the row is publishable | `python3 -m pytest tools/patcher/tests/test_archive_run.py -q` | pass |
| 6 | **this run's record is complete** | `python3 tools/eval/run_records.py check --run <run_id>` | exit 0, no `unscored` |
| 7 | no run on disk lacks a row | `python3 tools/eval/run_records.py check` | no `ERROR` |
| 8 | the ledger's own invariants hold | `python3 -m pytest tools/patcher/tests/test_run_records.py -q` | pass |
| 9 | nothing located reached the repository | `grep -rE "\bBUG-[0-9]+\b\|[a-z][A-Za-z0-9]*Challenge\b" results/ docs/ prompts/` | no output |

`check` reports at four severities: `ERROR` (a record is broken, or a run exists
on disk with no row), `LEAK` (a committed row trips the guard), `GAP` (a record
exists but is incomplete — above all, unscored) and `NOTE` (a fact that is
nobody's mistake). It exits 1 on `ERROR`/`LEAK`, and on `GAP` only under
`--strict`, because the standing list of unscored runs is the deliverable rather
than a failure.

### Known state of the repo-wide check

`check` with no `--run` currently exits 1 on **seven pre-existing `LEAK`
findings**: six scanner rows name a denylisted source file in prose, and one
patcher row carries a `bugs` key. Both files are append-only, so these cannot be
fixed by editing and are an architect's decision, not a test's. `check --run
<id>` is the per-run gate and is unaffected.

Rows timestamped before `PROTOCOL_EFFECTIVE` (in `run_records.py`) are not held
to the conventions this protocol introduces — `archived_to` and a named oracle
set. They are held to everything else. A checker that prints twenty findings
nobody can act on gets switched off, and an ignored check is worse than no
check: it looks like coverage.

---

## 4. Qualifications travel in the row

Not in a footnote, not in a commit message, not in the conversation the number
came from. `docs/benchmarking-results.md` states the same rule for its own table.

Two qualifications are permanently open for the patcher and belong beside every
number it produces:

- **no committed lockfile** for the target tree (`.npmrc` sets
  `package-lock=false`), so the dependency set is whatever resolved that day and
  cross-run comparison is uncontrolled;
- **no frozen pre-patch baseline** — the suite has never been run green on the
  unpatched tree, so any "regressions introduced" figure is differenced against
  an unmeasured starting point.

**Never read two oracle sets as one trend.** Subset 2 went from 2/10 to 10/23
effective fixes without a single patch changing, because the ground truth grew 13
driver-backed oracles underneath it. State which denominator a rate uses:
effective fixes over *scoreable* cases and over *all* bugs are different metrics
and differ by several points.

For the scanner the equivalent boundary is the vulnerability-class model
(2026-07-27) and the 97-vs-98 denominator re-base (2026-07-29); see
`eval-howto.md`.

---

## 5. The durability gap — open risk, not solved

**`/home/user/harness-private/` is not a git repository.** No remote, no version
control, no copy off this machine. It is an ordinary directory on container
disk.

That is deliberate in its cause and unresolved in its effect. Located detail
pairs a bug id with a file and a line, so it may not be committed here; the
answer-key repo is the only version-controlled home for the sighted half, and
nothing automatically puts a run's located detail there.

What survives a container reclaim:

| Artefact | Survives | Because |
|---|---|---|
| aggregate rows in `results/eval-history/*.jsonl` | **yes** | committed here |
| scanner stage outputs | **yes** | committed under `tools/scanner/runs/<provider>/` |
| the eval report PDF | **yes** | regenerated from the history files |
| sighted per-case tables that were filed in the answer-key repo | **yes** | committed there |
| patcher run store: per-task records, transcripts, guard logs, cost detail | **no** | private store only |
| scanner run logs (`logs/` is gitignored), retry and rate-limit history | **no** | private store only |
| per-challenge hit/miss detail not filed in the answer-key repo | **no** | private store only |

So a number in a history row is durable, and the evidence behind it usually is
not. `run_records.py check` reports `archive-not-on-this-disk` for every row
whose archive is already gone — that finding is the risk made visible, not a
mistake to fix.

Two mitigations exist and both are manual:

1. commit the sighted per-case detail to the **answer-key repo** in the same
   session it is produced, and put the pointer (branch and commit) in the row's
   `located_detail_at`. A pointer, never content.
2. keep the row rich enough to stand alone. Everything in `in_sandbox`,
   `cost`, `wall_clock_time` and `blind_audit` is aggregate and publishable —
   if it is in the row, losing the store costs evidence but not the result.

Nothing here makes the private store durable. Do not write a protocol step that
pretends otherwise.

---

## 6. What this protocol cannot close

- **Whether the caveats in a row are the true caveats.** A check can require
  `--defects` to be non-empty. It cannot know that the defect you named is the
  one that mattered.
- **Whether two rows are comparable.** The tool can require an oracle set to be
  named; only a person can notice that the oracle set changed underneath.
- **Whether the archive is a *correct* copy of the run.** File counts match, and
  the contents are never inspected — deliberately, since inspecting them here
  would mean reading located material into this repository.
- **A run that died before writing a report.** There is nothing to record; say
  what was lost and what it cost, per `../../CLAUDE.md` "Reporting".
- **The private store's durability.** §5.
