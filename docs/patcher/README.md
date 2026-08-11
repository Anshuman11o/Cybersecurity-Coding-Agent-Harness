# Patcher / Verifier — harness-side documentation

Everything here is **answer-key free** and readable by any harness session,
including agents that build or run the patcher.

| Document | What it covers |
|---|---|
| `EVAL-METRICS.md` | **What the patcher is judged on**, in aggregate: the two axes, the verdict buckets, and which architectural lever each number moves |
| `DATASET-READINESS-AND-HANDOFF.md` | Whether the target app can be patched today (it cannot — three blockers), and the scanner→patcher data structure |
| `VERIFICATION-TECHNIQUES.md` | Candidate in-sandbox self-checks, both axes. **Unvalidated** — the adopted set must be chosen empirically |
| `GPT-SUBAGENT-PATCHER-PLAN.md` | Plan for using GPT-backed phase subagents while preserving the model-agnostic patcher loop |
| `ARCHITECTURE-V3.md` | **v3**: planning moves offline to a checked-in chunk map and the orchestrator becomes a dispatcher that only merges. Implemented in `tools/patcher/src/v3/`, never yet run against a model; states plainly what it gives up versus v2 |
| `contracts/` | Mirrored JSON Schemas for what the patcher and verifier emit |

## The agent itself

The remediation agent architecture — the task-wise loop, its prompts, its
gates, and the sandbox that enforces the blind boundary — lives in code at
**[`tools/patcher/`](../../tools/patcher/)**. Start with its `README.md` for the
shape and `ARCHITECTURE.md` for the loop specification.

It reads a bug report and a remediation playbook, and emits two things: an
aggregated report and one patched codebase. The numbers it produces are
in-sandbox self-measurements and are not eval results; scoring happens
afterwards, sighted, against the tree.

## What is NOT here, deliberately

Ground truth, scoring, and metric definitions live in the private answer-key
repo, because they pair challenge identifiers with files and lines:

- `patcher-ground-truth/README.md` — protocol and eval map
- `patcher-ground-truth/METRICS.md` — full metric catalogue and derivation
- `patcher-ground-truth/METRICS-V1.md` — the subset to build first
- `patcher-ground-truth/ORACLE-INVENTORY.md` — measured oracle coverage
- `patcher-ground-truth/TEST-COVERAGE-PLAN.md` — workflow-oracle gaps
- `docs/CONTAMINATION-CLEANUP.md` — deferred split-leak work order

No agent building or running the harness should open that repo. See the
blind-development boundary in the root `CLAUDE.md`.

## The corpus seed denylist (added 2026-08-10)

Three files inside the target app name every challenge for legitimate structural
reasons — the challenge model, the anti-cheat bookkeeping, and the seed-data
creator. The scanner has refused to read them since 2026-07-28, through
`SEED_DENYLIST` in `tools/scanner/shared/read-guard.ts`.

**The patcher had never picked that list up.** A grep for those filenames, or for
`DENYLIST`, in `tools/patcher/hooks/sandbox_guard.py` and
`tools/patcher/src/blind_guard.py` returned nothing, while a bug report placed a
bug in one of them and `server.ts` imports it — so an agent could open the file
either by assignment or while tracing a neighbouring fix. This is the same
failure mode as the third instance recorded in the root `CLAUDE.md`: the guard
existed and was correct, and a component built later silently never imported it.

Closed in two places:

- `hooks/sandbox_guard.py` denies every read *and* write of those paths, in every
  phase, for the Read/Edit/Write/Grep path fields and for Bash — including
  commands where the path is not its own token (`python3 -c`, `node -e`,
  heredocs), which are matched against the whole command line. Denials are
  recorded in the guard log under `kind: seed_denylist`, counted by
  `blind_guard.audit_run`, and noted in the report. They do not void a run: the
  read did not happen.
- `src/blind_guard.py` refuses a bug report (or `scoped_files`) that places work
  in one of them, at preflight, naming the file — so the run stops before
  anything is spent rather than dispatching a task the hook would then block.

**One source of truth.** Neither module carries its own copy of the list; both
parse `read-guard.ts` at load time (`blind_guard` through the hook). A parse
failure falls closed onto a floor of the known names and is surfaced as an audit
note. `tests/test_sandbox_guard.py` asserts the parsed list matches what
`read-guard.ts` actually contains, and that the floor is a subset of it, so the
two cannot drift apart unnoticed.

Residual, not closed: a broad content search over the whole tree
(`grep -r <ordinary term> .`) can still surface lines *from* those files in its
output. The path deny does not see it, because no denylisted path is named.

## What the bug report may carry (narrowed 2026-08-10)

A bug-report entry now carries exactly five things:

- `bug_id`
- `location` — file and line (plus optional `end_line` and `symbol`)
- `owasp` — the codes, capped at three
- `class` — the human-readable vulnerability class
- `playbook_ref`

It no longer carries the two prose fields it used to: `vulnerability` (what is
wrong) and `reproduction` (how it is exercised). Both were removed from every
shipped report, from the contract, and from the rendered prompt.

**Why.** The agent's own task loop already requires it to characterise the code
path and build an exploit probe from the source, and it is handed the exact file,
the exact line and the vulnerability class. Prose describing the defect and how
to trigger it did part of that work for it: it hints at the fix and hands over
the probe's shape. A narrower report makes the task harder and the result more
honest. Nothing was added to compensate — working from file, line and class alone
is the point.

Enforced in three places, so the narrowing is structural rather than a one-off
edit to the input files:

- `tools/patcher/contracts/bug-report.schema.json` — the two fields are gone from
  `definitions.bug.properties`, and that object is closed
  (`additionalProperties: false`).
- `tools/patcher/src/blind_guard.py` — `validate_bug_report` refuses an entry
  carrying either field, naming the field and the bug id, at preflight before
  anything is spent. It reads its allowed-key set from the schema, so any
  off-contract field — including a renamed carrier for the same prose — fails the
  same way, and the schema stays the single statement of what an entry may carry.
- `tools/patcher/src/prompts.py` — `_fmt_bug()` renders location and class only.
  A report that somehow reached it carrying the old fields would still not print
  them.

**Refused, not stripped.** The forbidden-key scrub removes a stray key and
records it; these are different. A report still emitting them is a generator
nobody has fixed, and trimming it silently would let every later run measure
something narrower than its input claimed while nothing said so.

**Not closed: the generator.** The tool that produces these reports lives outside
this repository and was not touched. The harness therefore *refuses* a wide
report; it does not stop one being emitted. Until the generator is given the same
treatment, a freshly generated report will fail preflight — which is the intended
failure, but it is a failure someone has to act on rather than a state that
maintains itself.

## Contracts are mirrors

`contracts/*.schema.json` are copies. The authoritative versions live with the
scorer in the answer-key repo. They contain no challenge, file, or line
reference, which is why they are safe to mirror — if the two ever diverge, the
scorer's copy wins.
