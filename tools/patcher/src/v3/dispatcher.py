#!/usr/bin/env python3
"""
The dispatcher: v3's orchestrator, and deliberately the least intelligent
component in the system.

v1's orchestrator ran the gates and decided when a task was done. v2's computed
a wave plan at runtime and re-measured every unit at the barrier. v3's does
neither. The plan arrived offline, checked in; the judging moved inside the
chunk agent. What is left is five jobs:

    1. spawn one agent per chunk, all with the SAME generic prompt
    2. hand each agent its slice -- ordered tasks, write boundary, playbook refs
    3. monitor liveness, timeout and the cost ceiling
    4. own the merge queue, serially
    5. advance to the next phase when every chunk in the bracket has merged,
       and run the full suite once after the last one

It never reads an agent's intermediate output to decide anything. The only
artefacts it opens are the two the submission contract names -- the attestation
and the declarations -- and it opens those to RECORD them, not to grade them.

THE FIX PHASE, AND WHAT "THE ORCHESTRATOR IS NOT A JUDGE" DOES AND DOES NOT MEAN

v3's architecture always specified the reconcile loop: fix, verify, hand the
failure back, up to `loop.reconcile_rounds`. What it shipped with was that loop
described in a prompt and nothing enforcing it -- the dispatcher spent one
invocation and then read `rounds_used` out of `attestation.json`. That is an
under-implementation, not a smaller design. The budget was unverifiable: an agent
could close the vulnerability, leave a workflow assertion red, write down that
the assertion is illegitimate, exit after one round, and no field in the record
could tell that apart from a fix that reconciled to green.

Wiring the fix phase to `task_loop.run_fix_loop` -- the SAME loop v1 uses --
makes the implementation match the architecture that was already written down.
The dispatcher invokes the agent, runs V1..V4 itself at the ROUND BOUNDARY, hands
the structured failure back, and stops on one of exactly three machine-checked
conditions: measured green, the round budget, the wall clock. An anti-oracle
claim in the attestation is not one of them; it is recorded and acted on by
nothing.

None of that makes the orchestrator a judge inside a round, and the distinction
is load-bearing. It does not write code, does not choose or narrow the fix, does
not run tests IN PLACE OF the agent's own self-verification -- the agent still
runs the typecheck, the workflow test, the probe and the net itself, inside its
turn, and is still the only party that decides what to change. What the
orchestrator owns is the boundary between rounds and the measurement taken there.
"The orchestrator runs the gates" is not "the orchestrator interferes with the
agent's loop"; it is the difference between a budget that is spent and a budget
that is claimed.

The cost is real: the gates run once per round per task, so wall time per task
rises and `loop.chunk_timeout_s` may need raising before a run.

    characterise   writes workflow.test.ts + exploit.probe.ts + characterisation.json,
                   source read-only. Kept as its own invocation for one reason:
                   it is the unit that CHARACTERISATION REUSE skips. Folded into
                   the fix call it could not be skipped, and reuse is the only
                   mitigation v3 has for the bug-wise cost regression (§6 of the
                   architecture doc). Its gates G1/G2 are still the agent's own
                   report -- characterisation stays ATTESTED.
    fix/reconcile  1..(reconcile_rounds + 1) invocations, the budget the
                   architecture always specified, now actually spent and counted.
                   The disposition that comes out of it is MEASURED.

CHARACTERISATION REUSE

Bug-wise tasks undo the file-wise batching win: a file with 11 bugs becomes 11
tasks and therefore 11 characterise phases re-reading the same file. Measured on
the opposite move, per-bug -> per-file on the 24-bug subset: 24 tasks -> 8,
~10.4 h -> ~4-5 h, ~$190 -> ~$95. That is the size of what bug-wise gives back.

The mitigation, behind `reuse_characterisation` (default on): within one chunk,
a task on a file that an earlier task in the SAME CHUNK already characterised
reuses the artefacts already sitting in that chunk's tree instead of paying for a
fresh characterise phase. Same chunk, same tree, same file, artefacts on disk.

The three conditions are all load-bearing and the tests pin each:
  same chunk  -- another chunk's artefacts are in another tree entirely, and
                 handing them over would put a second chunk's oracle inside this
                 sandbox
  same file   -- a workflow test written for one file is not the record of
                 correct behaviour for another
  reuse on    -- the flag exists so the saving can be MEASURED against a run
                 without it, rather than assumed. It is a real trade: the reused
                 workflow test was written to characterise a different bug in
                 that file, so it is a weaker oracle for this one.

WHAT THIS STILL RECORDS PER TASK, AND WHY

Who takes the measurement at a round boundary has never been what the task record
is for. `ARCHITECTURE.md` §2 defines seven terminal dispositions and is
explicit that `fixed` and `fixed_workflow_only` are never summed; §5.1 says the
report carries one record per bug. Both are what the eval reads, and neither is a
consequence of WHO ran the gates -- so v3 emits a record per bug with a
disposition from exactly that seven-value set, and the denominator stays whole
even for a task the run never reached.

Every record still carries `disposition_basis`, and it differs by phase:

    measured   the dispatcher observed it itself -- the gates it ran between the
               agent's rounds, the invocation returning or not, the artefacts
               being on disk or not, the task changing source files or not, the
               chunk's submission merging or being rolled back byte for byte.
    attested   it rests on the agent's own report in `characterisation.json`.

Every disposition reached by the fix phase is MEASURED, from `V1..V4` run by this
process, exactly as v1 reaches its own. It read `attested` for v3's first three
runs because the loop was not wired up, not because the fix phase was designed to
rest on a self-report. The one disposition still recorded as ATTESTED is
`already_remediated`, which is decided before the fix phase from
`characterisation.json` alone.

One attested INPUT survives inside a measured disposition, and it is stated
rather than hidden: whether the probe demonstrated the defect BEFORE the fix is
the agent's report, and it is what makes V3 a live gate rather than a skipped
one -- so it is still what separates `fixed` from `fixed_workflow_only`. v1
measures that pre-fix verdict and v3 does not, which is why a v3
`fixed_workflow_only` population is larger than v1's would be on the same bugs.

`measured.rounds`, `measured.rounds_to_green` and `measured.final_gates` are
populated per task, exactly as v1 populates them.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import threading
import time
from dataclasses import dataclass, field

import blind_guard
import prompts
import task_loop
import testmap
import verify
import workspace

from . import boundary
from . import chunk_map as chunk_map_mod
from . import merge_queue as mq

# Not seeded into a chunk tree, and therefore never part of a submission.
#
# `logs` is here because the application writes into it as soon as it starts, and
# every chunk agent starts it to run a probe. Anything a chunk creates that the
# phase base does not have is a file the three-way merge has no common ancestor
# for, so two chunks in one phase each producing their own copy is an
# unresolvable conflict -- and the SECOND chunk to reach the queue loses its
# whole submission over it. That is measured, not hypothetical: it cost
# patch-run-subset-05 a chunk.
#
# The other runtime artefacts the app restores at startup -- ftp/legal.md, the
# promo subtitle track and i18n/*.json -- are NOT excluded here. Excluding them
# would hide real edits to files an agent may legitimately touch. They are put
# into the base tree instead, by `setup/prepare_env.sh`, so the merge has an
# ancestor for them and they simply never appear as changes.
SEED_EXCLUDES = ('.patcher-snapshots', workspace.SCRATCH_DIRNAME, 'logs')

# The phase name is not a label. It is the argument the sandbox hook is launched
# with (`agent.ClaudeCliRunner._settings_path` -> `sandbox_guard.py --phase`), and
# the hook's whole phase-dependent behaviour keys off these two exact strings:
#
#   'characterise'  source is read-only, so the baseline cannot be captured from
#                   code the agent has already edited
#   'fix'           workflow.test.ts and exploit.probe.ts are frozen, so an agent
#                   that cannot pass its own gate cannot edit the gate instead
#
# v3 originally sent 'v3-characterise' and 'v3-patch'. `sandbox_guard.main()`
# declares `--phase` with `choices=[characterise, fix, reconcile, other]`, so
# argparse rejected them, the guard exited 2 having written no decision, and every
# tool call in the run took the fail-path of a PreToolUse hook that never
# answered. Even had it parsed, neither string matches `phase == 'characterise'`
# or `phase in ('fix', 'reconcile')`, so characterisation would have been free to
# edit source and the fix phase free to rewrite its own oracle.
#
# This is the v2 denylist failure repeated: a guard that existed, was correct, and
# was never wired into the fork. The names below are the hook's vocabulary and
# must stay that way; the per-phase log FILENAMES below still say 'characterise'
# and 'patch', which is where the v3-specific naming belongs.
CHARACTERISE_PHASE = 'characterise'
PATCH_PHASE = 'fix'

# ARCHITECTURE.md §2. Nothing else is permitted, in v1 or here.
DISPOSITIONS = ('fixed', 'fixed_workflow_only', 'fixed_workflow_red',
                'already_remediated', 'abandoned', 'partial', 'agent_failed',
                'blocked')
# `fixed_workflow_red` is deliberately NOT here. It is a fix submitted over a
# workflow assertion the agent left failing; whether that assertion was an
# anti-oracle or real breakage is exactly what the record cannot say, so summing
# it with `fixed` would restore the ambiguity the disposition exists to remove.
GREEN_DISPOSITIONS = ('fixed', 'fixed_workflow_only')

# v1 also reverts `abandoned`, because there it means "the orchestrator's gates
# were still red when the budget ran out". v3 has no such gate, so `abandoned`
# here only ever means "this task changed nothing" or "its chunk was rolled back
# at the merge queue" -- in both cases there is nothing left to revert.
REVERT_DISPOSITIONS = frozenset({'agent_failed', 'blocked'})

MEASURED = 'measured'
ATTESTED = 'attested'


# ----------------------------------------------------------------------------
# The generic prompt
# ----------------------------------------------------------------------------

SLICE_HEADER = """\
You are a security remediation engineer working inside `{tree}`.

{standing}

## Your slice

You are agent for chunk **{chunk_id}** (bracket {bracket}, phase {phase}).
{reason}

You own these files and are the only agent editing them:

{owned}

You have {n_tasks} bug(s) to fix, in this exact order. Do them one at a time and
in order; do not batch them and do not reorder them.

{task_list}

## Write boundary

- The files above: write freely.
- `{shared_zone}`: shared extension zone. You may write here, but you MUST first
  add the file, the bug you are fixing and your reason to `{declarations}`.
  Several chunks legitimately extend the same view or config, so a chunk that
  writes here is merged last.
- Any other file: same rule -- declare it in `{declarations}` before you write it.
  Reaching outside your files is allowed and sometimes necessary; a correct CSRF
  fix in this codebase spans four files to plumb a token into a view. What is not
  allowed is doing it silently.
- `{never_writable}`: never, under any circumstances.

Each entry in `{declarations}` is `{{"file": ..., "bug_id": ..., "reason": ...}}`.
The reason is not paperwork: the chunk that owns that file runs after you and is
shown what you wrote and why, so a file you touched does not read to it as damage.

{landed}{house_rules}
"""

# The forward feed. A declared write lands in the trunk, and the chunk that OWNS
# that file is seeded from the trunk one phase later -- seeing modified code with
# nothing to say why it looks that way. Measured in the first v3 run: a chunk
# read an earlier chunk's landed remediation as damage and restored what it had
# removed, reopening a defect the run had already closed while the task that
# closed it stayed recorded as `fixed`.
#
# The wording is deliberately not a prohibition. Forbidding further change here
# would block legitimate hardening of a file that has only just been touched --
# the same "restrict the solution space and still look successful" failure the
# write boundary exists to avoid. What it asks for instead is that an agent which
# does undo one of these says so, so the reversal is in the record rather than
# silent.
LANDED_BLOCK = """\
## Landed work already in your files

{entries}

None of that is damage or leftovers. Each one is an earlier chunk's fix that the
merge queue accepted, so it is part of the tree you were seeded from -- code that
looks as though something was removed, or a check that seems to have arrived from
nowhere, is that fix. Read it as correct existing code and work on top of it.
Hardening these files further is still your job; if your own fix genuinely needs
to change or undo one of them, do it and say so in your attestation rather than
restoring what was there before.

"""

CHARACTERISE_BODY = """\
## This step: characterise bug {bug_id} ({file}:{line})

{bug}

**The source tree is read-only for this step.** Write only into `{scratch}`.

Produce exactly three files in `{scratch}`:

- `workflow.test.ts` — a `node:test` file exercising the LEGITIMATE behaviour of
  the cited code path. It must pass on the tree as it stands now. This is the
  recorded ground truth of correct behaviour, and it is what tells you later
  whether your fix broke the product.
- `exploit.probe.ts` — a standalone script that exercises the vulnerable path and
  prints exactly `PROVEN` or `NOT_PROVEN` as its last line. It should print
  `PROVEN` now. If you cannot make it print `PROVEN`, say so honestly below: the
  defect is still real, you have just not found the way to trigger it, and that
  gets recorded rather than papered over. Do not fake a `PROVEN`.
- `characterisation.json` — **exactly these keys**:

```json
{{"bug_id": "{bug_id}",
  "correct_behaviour": "what a legitimate user of this code path is entitled to",
  "defect_mechanism": "why the current code is exploitable, in your own words",
  "workflow_test_written": true,
  "workflow_test_passes_now": true,
  "probe_written": true,
  "probe_result_now": "PROVEN" | "NOT_PROVEN",
  "probe_notes": "if NOT_PROVEN, what you tried and where it stopped; else null",
  "related_test_files": ["existing test files under test/ that exercise this path"],
  "intended_change": "the shape of the fix you expect to make",
  "risk_to_workflow": "which legitimate behaviour your change could plausibly break"}}
```

Three of those keys are read by the orchestrator and none of them can be
recovered later, so spell them exactly. `related_test_files` becomes the
regression net you are handed in the next step — name the files that genuinely
exercise this code, because nothing else will find them for you.
`workflow_test_passes_now` and `probe_result_now` are the only record of whether
this task had a working oracle at all; they are recorded as YOUR report, and a
run that reports what it intended to observe rather than what it observed is
worse than a run that reports a failure.

Run them yourself and confirm before you finish:

    {workflow_cmd}
    {probe_cmd}
"""

CHARACTERISE_RETRY = """\

---

## Your previous attempt did not satisfy this step

{problems}

Fix these and finish the step. Do not modify application source.
"""

PATCH_BODY = """\
## This step: fix bug {bug_id} ({file}:{line})

{bug}

{playbook}

Your frozen gate artefacts for this bug are already written:

- `{workflow_rel}` — the record of correct behaviour. It passed before your
  change and must pass after it. You may not edit it.
- `{probe_rel}` — must print `NOT_PROVEN` when you are done. You may not weaken it.
{reuse_note}
### Run your own loop

Run these steps yourself, in order, before you finish:

1. fix the defect, inside your owned files where possible
2. self-verify: `{typecheck_cmd}`, then `{workflow_cmd}`, then `{probe_cmd}`,
   then **the regression net, which you run yourself and must leave clean**:
{net_block}
   One exception, and it is the only one: a test that was ALREADY FAILING before
   your change is not yours to fix. It was red when you arrived and it is red
   now, and nothing you do to it is part of this task.

   A test that appears to REQUIRE THE ATTACK TO SUCCEED is **not** an exception.
   It is an input to step 3. Take it there.
3. if any of those is red, reconcile and go back to 2 — up to {max_rounds}
   rounds. The workflow test is the record of what correct behaviour looks like;
   use it to find a change that satisfies both axes. Do not edit the test to
   match the code, weaken the probe, or delete the feature.

   A red assertion you believe encodes the vulnerable behaviour itself is the
   HARDEST case of this step, not an exemption from it. Spend the rounds on it:
   look for a change that closes the path AND leaves that assertion green. Such
   an assertion is usually about the FEATURE the vulnerable code happens to
   provide rather than about the attack — it asserts that some legitimate call
   still returns something, and it goes red because the fix was broader than the
   defect. A narrower fix, one that closes only the path the probe takes and
   leaves the legitimate shape of the behaviour alone, frequently satisfies
   both. "No correct fix can satisfy this" is a conclusion to reach with the
   rounds spent, not on round one.
4. when green, or when the budget is spent, write `{attestation_path}`:

```json
{{"bug_id": "{bug_id}", "status": "fixed" | "not_fixed", "confidence": 0.0,
  "what_changed": "one sentence", "why_it_closes_the_path": "one or two sentences",
  "why_the_workflow_still_works": "one or two sentences",
  "residual_risk": "what could not be closed, or null",
  "workflow_red": ["<test file> :: <it() title>"],
  "antioracle_claims": [{{"test": "<test file>", "it_title": "<exact it() title>",
                         "why": "why this assertion encodes the vulnerable
                                 behaviour rather than legitimate behaviour"}}],
  "rounds_used": 0}}
```

`workflow_red` lists every workflow assertion still failing when you finish, and
is `[]` when the workflow test is fully green. Silence is a claim of green, so a
submission with anything red must list it. Any of those you believe asserts the
vulnerable behaviour itself — an anti-oracle — must ALSO appear in
`antioracle_claims`, with the reasoning. Both lists are recorded, not
adjudicated: nothing accepts or rejects the claim, and listing an assertion
neither helps nor hurts you. Omitting one only makes a red submission
indistinguishable from a clean one.

**If your rounds run out while you are holding a fix that closes the path but
leaves an assertion red, KEEP THE FIX.** Do not weaken it and do not revert it to
buy back a green gate: a reopened vulnerability is the worse of the two
outcomes, and the record has a place for the red assertion. List every one of
them in `workflow_red` and finish.

### How this is measured, said plainly rather than sprung on you

The orchestrator runs `{typecheck_cmd}`, the workflow test, the probe and the
regression net **itself**, after your turn ends, and it counts the rounds itself.
Two consequences, and neither is a trap:

- `rounds_used` in your attestation is recorded but not believed. The number
  that reaches the record is the number of rounds this process ran.
- if a gate is still red and rounds remain, you will simply be invoked again
  with the exact failure output. Declaring yourself finished early buys nothing;
  saying honestly what is still red costs nothing.

Then move to your next bug. Do not stop to report; the whole chunk is submitted
to the merge queue once, at the end.
"""

# Appended to the fix prompt on every round after the first. The agent gets the
# same slice, the same boundary, the same landed block and the same submission
# contract it had on round 0 -- and then the failure the ORCHESTRATOR measured,
# which is the only thing that is new. Built here rather than through
# `prompts.build_reconcile` because that renders a whole v1-shaped prompt and
# would drop the chunk header, the write boundary and the landed-work block; the
# failure formatter and the per-kind guidance are shared with v1 so the two
# tracks tell an agent the same thing about the same red gate.
RECONCILE_BLOCK = """\

---

## Round {round_no} of {max_rounds}: your change did not pass its gates

This is not a review of your reasoning. The commands below were run by the
orchestrator against the tree exactly as you left it, after your turn ended.

### Your change so far

```diff
{diff}
```

### What was measured

{failures}

### What to do about it

{guidance}

Both of these must hold when you finish, and neither one alone counts:

- **the vulnerability is closed** — the probe prints `NOT_PROVEN`
- **the application still works** — the workflow test passes, and no related
  test that was passing at the start of this task is failing now

Still forbidden, and still enforced: editing the workflow test or the probe;
weakening or reverting the security fix to make a gate go green; deleting the
feature to quiet the probe. If you believe a red assertion cannot be satisfied
by any correct fix, keep the fix, spend the round looking for the narrower
version anyway, and record the assertion in `workflow_red` — do not work around
it quietly.

Update `{attestation_path}` before you finish this round.
"""

REUSE_NOTE = """\
These artefacts were written while characterising `{from_bug}`, which is in the
same file and the same chunk. They are reused rather than rewritten, so they were
NOT authored with this bug in mind: read them before you trust them, and if the
probe does not exercise THIS defect, say so in your attestation rather than
treating a `NOT_PROVEN` as evidence.
"""


# ----------------------------------------------------------------------------
# Assignments
# ----------------------------------------------------------------------------

@dataclass
class Assignment:
    """One chunk's slice. This is the whole of what an agent is told."""

    chunk_id: str
    bracket: str
    phase: int
    reason: str
    tasks: list                      # bug dicts from the report, in map order
    boundary: object                 # boundary.WriteBoundary
    playbook_refs: list = field(default_factory=list)

    def as_record(self) -> dict:
        return {'chunk_id': self.chunk_id, 'bracket': self.bracket,
                'phase': self.phase, 'reason': self.reason,
                'bug_ids': [b['bug_id'] for b in self.tasks],
                'owned_files': sorted(self.boundary.owned),
                'playbook_refs': self.playbook_refs}


def assignments(cmap, bugs, playbook=None) -> list:
    """One Assignment per chunk, in the map's deterministic chunk order.

    A task carries the bug dict from the REPORT, not the summary in the map. The
    map holds file and line so it can be validated offline; the rest of what the
    agent is given -- the OWASP codes, the class, the playbook ref -- only exists
    in the report, and duplicating it into a checked-in artefact would create two
    statements of the same fact that can drift.
    """
    by_id = {b.get('bug_id'): b for b in (bugs or [])}
    out = []
    for c in cmap.chunks:
        picked, refs = [], []
        for t in c.tasks:
            bug = by_id.get(t.bug_id)
            if bug is None:
                raise chunk_map_mod.ChunkMapError(
                    f'chunk {c.chunk_id!r} names bug {t.bug_id!r}, which is not in the '
                    'bug report')
            picked.append(bug)
            ref = bug.get('playbook_ref')
            if ref and ref not in refs:
                refs.append(ref)
        out.append(Assignment(chunk_id=c.chunk_id, bracket=c.bracket, phase=c.phase,
                              reason=c.reason, tasks=picked,
                              boundary=cmap.boundary_for(c.chunk_id),
                              playbook_refs=refs))
    return out


# ----------------------------------------------------------------------------
# Prompt rendering
# ----------------------------------------------------------------------------

def _cmd(cfg, key, rel):
    return (cfg.get('commands', {}).get(key) or '').replace('{file}', rel)


def task_id_for(chunk_id: str, bug_id: str) -> str:
    """Scratch directory name. Chunk-qualified so two chunks' artefacts for the
    same bug id can never land on one path after a merge."""
    return f'{chunk_id}-{bug_id}'


def render_landed(inherited) -> str:
    """The landed-declaration block, or nothing at all.

    Nothing at all is the common case and it stays literally empty: an empty
    section under a heading is noise in a prompt that is already long, and an
    agent that learns the section is usually vacuous stops reading it on the run
    where it is not.

    Exactly four fields are rendered -- the file, the chunk, the bug it was
    fixing and the reason it wrote. `file` and `bug_id` the agent already had in
    its own slice, and `reason` is agent-authored from the blind tree. Nothing
    else may be added here: this is the one path that carries text from one
    chunk's prompt into another's, so anything class- or playbook-derived would
    cross a chunk boundary the boundary map exists to keep closed.
    """
    lines = []
    for d in inherited or ():
        who = f"chunk {d.get('chunk_id')}"
        phase = d.get('phase')
        when = f' in phase {phase}' if phase is not None else ''
        bug = d.get('bug_id')
        why = (d.get('reason') or '').strip()
        lines.append(
            f"- `{d.get('file')}` — {who} changed this file{when} while fixing "
            + (f'{bug}' if bug else 'one of its own bugs')
            + (f'. Its reason: {why}' if why else '.'))
    if not lines:
        return ''
    return LANDED_BLOCK.format(entries='\n'.join(lines))


def _header(a: Assignment, tree: str, cmap, inherited=()) -> str:
    owned = '\n'.join(f'- `{f}`' for f in sorted(a.boundary.owned)) or '- (none)'
    tasklist = '\n'.join(
        f"{i + 1}. **{b['bug_id']}** — `{b['location']['file']}:{b['location']['line']}` "
        f"— {b.get('class') or 'unclassified'}"
        for i, b in enumerate(a.tasks))
    return SLICE_HEADER.format(
        tree=tree, standing=prompts.STANDING_CONSTRAINT, chunk_id=a.chunk_id,
        bracket=a.bracket, phase=a.phase,
        reason=(a.reason or ''), owned=owned, n_tasks=len(a.tasks),
        task_list=tasklist,
        shared_zone=', '.join(cmap.shared_extension_zone),
        never_writable=', '.join(cmap.never_writable),
        declarations=f'{workspace.scratch_rel(a.chunk_id)}/declarations.json',
        landed=render_landed(inherited),
        house_rules=prompts.HOUSE_RULES)


def build_characterise_prompt(a: Assignment, bug: dict, *, tree, cfg, cmap,
                              scratch_rel: str, inherited=()) -> str:
    # The block belongs here as much as in the fix prompt. The failure it exists
    # to stop was a reading formed during characterisation -- the agent decided
    # the file had lost something before it wrote a line of code, and the fix
    # phase only carried out what that reading implied.
    return _header(a, tree, cmap, inherited) + '\n' + CHARACTERISE_BODY.format(
        bug_id=bug['bug_id'], file=bug['location']['file'],
        line=bug['location']['line'], bug=prompts._fmt_bug(bug),
        scratch=scratch_rel,
        workflow_cmd=_cmd(cfg, 'run_test_file', f'{scratch_rel}/workflow.test.ts'),
        probe_cmd=_cmd(cfg, 'run_probe', f'{scratch_rel}/exploit.probe.ts'))


def net_commands(cfg: dict, related_files) -> list:
    """The regression net as commands the agent can actually run.

    Naming the files is not enough. An agent handed a list of paths invents its
    own command and picks the wrong test environment, so the command goes in --
    the same conclusion v2 reached in `prompts.build_fix`. It matters more here:
    v3 runs no per-task regression net of its own, so this in-prompt run is the
    ONLY per-task check that damage did not happen.
    """
    out = []
    for rel in related_files or ():
        rel = str(rel).strip().lstrip('./')
        if not rel:
            continue
        key = ('run_server_test_file' if testmap.env_for(rel) == 'server'
               else 'run_test_file')
        cmd = _cmd(cfg, key, rel)
        if cmd:
            out.append(cmd)
    return out


def _net_block(cmds) -> str:
    if not cmds:
        return ('\n   (the characterisation named no existing test files, so there is no\n'
                '   net to run — say so in `residual_risk`, because a task with no\n'
                '   regression net is a task nothing checked for collateral damage)\n')
    return '\n```\n' + '\n'.join(cmds) + '\n```\n'


def _reconcile_block(round_no, max_rounds, failures, diff, attestation_path) -> str:
    """The measured failure, handed back. Empty on round 0, which has none."""
    if not round_no:
        return ''
    kinds = []
    for f in failures or ():
        k = f.get('kind')
        if k and k not in kinds:
            kinds.append(k)
    guidance = '\n\n'.join(prompts.RECONCILE_GUIDANCE[k] for k in kinds
                           if k in prompts.RECONCILE_GUIDANCE) \
        or prompts.RECONCILE_GUIDANCE['harness_error']
    return RECONCILE_BLOCK.format(
        round_no=round_no, max_rounds=max_rounds,
        diff=(diff or '(no change recorded yet)')[:30000],
        failures=prompts._fmt_failures(failures), guidance=guidance,
        attestation_path=attestation_path)


def build_patch_prompt(a: Assignment, bug: dict, *, tree, cfg, cmap, playbook,
                       scratch_rel: str, reused_from: str | None,
                       max_rounds: int, related_files=(), inherited=(),
                       round_no: int = 0, failures=(), diff='') -> str:
    """The fix prompt, and on a reconcile round the same prompt plus the failure.

    Deliberately additive rather than a second prompt: the write boundary, the
    landed-work block and the submission contract are as load-bearing on round 3
    as on round 0, and a reconcile prompt that dropped them would let an agent
    reach outside its files, or read a landed fix as damage, precisely when it is
    under the most pressure to do something drastic.
    """
    entry, how = (blind_guard.select_entry(playbook, bug) if playbook else (None, 'none'))
    attestation_path = f'{scratch_rel}/attestation.json'
    return _header(a, tree, cmap, inherited) + '\n' + PATCH_BODY.format(
        bug_id=bug['bug_id'], file=bug['location']['file'],
        line=bug['location']['line'], bug=prompts._fmt_bug(bug),
        playbook=prompts._fmt_playbook(entry, how,
                                       (playbook or {}).get('general_guidance')),
        workflow_rel=f'{scratch_rel}/workflow.test.ts',
        probe_rel=f'{scratch_rel}/exploit.probe.ts',
        reuse_note=('\n' + REUSE_NOTE.format(from_bug=reused_from) if reused_from else ''),
        typecheck_cmd=cfg.get('commands', {}).get('typecheck', ''),
        workflow_cmd=_cmd(cfg, 'run_test_file', f'{scratch_rel}/workflow.test.ts'),
        probe_cmd=_cmd(cfg, 'run_probe', f'{scratch_rel}/exploit.probe.ts'),
        max_rounds=max_rounds,
        net_block=_net_block(net_commands(cfg, related_files)),
        attestation_path=attestation_path) + _reconcile_block(
            round_no, max_rounds, failures, diff, attestation_path)


# ----------------------------------------------------------------------------
# The task record
# ----------------------------------------------------------------------------

def _record_skeleton(chunk_id: str, bug: dict, task_id: str) -> dict:
    """One record per bug, in the shape `ARCHITECTURE.md` §5.1 names.

    `measured` holds what the dispatcher observed by looking or by running;
    `attested` holds what the agent said. The two are never merged, and the null
    defaults below mean NOT MEASURED rather than measured-and-false. A consumer
    that treats `probe_proven_pre_fix: null` as falsey under-reports probe
    coverage, which is the safe direction; one that treated a null
    `rounds_to_green` as zero would over-report, so it stays null and
    `gates_run` says how many gate suites actually ran.

    The defaults describe a task that never reached the fix phase. A task that
    did overwrites `rounds`, `final_gates`, `rounds_to_green`, `rounds_used`,
    `label` and `gates_run` with what the loop measured.
    """
    loc = bug.get('location') or {}
    return {
        'bug_id': bug.get('bug_id'),
        'chunk_id': chunk_id,
        'file': loc.get('file'),
        'task_id': task_id,
        'location': {'file': loc.get('file'), 'line': loc.get('line')},
        'class': bug.get('class'),
        'characterised': False,
        'reused_from': None,
        'attempted': False,
        'related_test_files': [],
        'disposition': 'blocked',
        'disposition_basis': MEASURED,
        'disposition_reason': 'the task record was never completed',
        'merge_verdict': None,
        'measured': {
            'characterisation': {
                # G1 IS measured, from the baseline sweep taken just before the
                # fix loop: the workflow test is run against the untouched tree.
                # G2 is not -- the probe is not re-run pre-fix, so
                # `probe_proven_pre_fix` stays null here and the agent's report
                # lives in `attested_characterisation`.
                'workflow_green_pre_fix': None,
                'probe_proven_pre_fix': None,
                'workflow_test_written': False,
                'probe_written': False,
                'characterisation_parsed': False,
                'attempts': 0,
                'workflow_test_path': None,
                'exploit_probe_path': None,
                'related_test_files': [],
                'baseline_failures': [],
            },
            'rounds': [],
            'final_gates': {},
            'rounds_to_green': None,
            # The count this process ran, never `attestation.json → rounds_used`.
            'rounds_used': 0,
            # The loop's own four-square verdict on the round whose tree was
            # kept: green / vuln_only / workflow_only / neither / agent_failed.
            'label': None,
            'deadline_exceeded': False,
            'gates_run': 0,
            'gates_not_run_reason':
                'this task never reached the fix phase, so no gate suite ran for '
                'it. See docs/patcher/ARCHITECTURE-V3.md §7.',
            'wall_s': 0.0,
            'cost_usd': 0.0,
            'invocations': [],
        },
        'attested_characterisation': None,
        'attested': None,
        'attestation_delta': None,
        'diff_stats': {'files_touched': [], 'lines_added': 0, 'lines_removed': 0,
                       'touched_outside_bug_file': False, 'net_deletion': False},
        'violations': [],
    }


def _unreached_record(chunk_id: str, bug: dict, why: str) -> dict:
    """A bug the chunk never got to.

    It gets a record anyway. `chunk_map` refuses a map whose bugs do not add up
    precisely because a denominator that quietly shrinks makes a run read as a
    BETTER result than it is, and a chunk that stopped on its cost ceiling would
    do exactly that if its remaining bugs simply vanished from `tasks[]`.
    """
    rec = _record_skeleton(chunk_id, bug, task_id_for(chunk_id, bug.get('bug_id')))
    rec['disposition'] = 'blocked'
    rec['disposition_basis'] = MEASURED
    rec['disposition_reason'] = (
        f'the chunk stopped ({why}) before this task was reached. Nothing was '
        'attempted and nothing was measured; it is recorded so the denominator '
        'still matches the map.')
    return rec


def attested_characterisation(char: dict | None) -> dict | None:
    """The agent's own account of whether it had a working oracle.

    v1 measures this: it runs `workflow.test.ts` and `exploit.probe.ts` against
    the untouched tree itself. v3 cannot, so it reads what the agent reported --
    and the ONLY reason it is worth reading is that `fixed` versus
    `fixed_workflow_only` turns on it. Dropping it would collapse the two into a
    single "fixed" count, which is the exact false-confidence failure
    `docs/patcher/EVAL-METRICS.md` exists to catch.
    """
    if not isinstance(char, dict):
        return None
    probe = str(char.get('probe_result_now') or '').strip().upper()
    return {
        'basis': ATTESTED,
        'workflow_green_pre_fix': bool(char.get('workflow_test_passes_now')),
        'probe_proven_pre_fix': probe == verify.PROVEN,
        'probe_result_now': probe or None,
        'probe_notes': char.get('probe_notes'),
    }


def _dispose(rec: dict, disposition: str, basis: str, reason: str | None) -> dict:
    assert disposition in DISPOSITIONS, disposition
    rec['disposition'] = disposition
    rec['disposition_basis'] = basis
    rec['disposition_reason'] = reason
    return rec


# The four gate names, in order. `verify.VerifyResult.fail` also writes a bare
# `V1`..`V4` marker beside the long name, which is a duplicate and not a fifth
# gate -- so anything reading gates for a HUMAN reads these four and nothing else.
GATE_NAMES = ('V1_typecheck', 'V2_workflow', 'V3_probe_blocked', 'V4_no_regression')


def _gate_summary(gates: dict) -> str:
    return ', '.join(f'{g}={gates[g]}' for g in GATE_NAMES if g in gates) \
        or 'no gate result'


def _rounds_to_green(records) -> dict:
    """The distribution, never a mean -- the mean hides the tail and the tail is
    where the cost is. `never` counts tasks that reached a fix phase and did not
    go green; a task that never reached one is in neither bucket."""
    hist: dict = {}
    values = []
    for r in records:
        m = r.get('measured') or {}
        if not (m.get('rounds') or []):
            continue
        n = m.get('rounds_to_green')
        key = 'never' if n is None else str(n)
        hist[key] = hist.get(key, 0) + 1
        if n is not None:
            values.append(n)
    values.sort()
    median = None
    if values:
        mid = len(values) // 2
        median = (values[mid] if len(values) % 2
                  else (values[mid - 1] + values[mid]) / 2)
    return {'histogram': hist, 'median': median,
            'max': max(values) if values else None}


def disposition_counts(records) -> dict:
    counts = {d: 0 for d in DISPOSITIONS}
    for r in records:
        d = r.get('disposition')
        if d in counts:
            counts[d] += 1
    return counts


# ----------------------------------------------------------------------------
# Results
# ----------------------------------------------------------------------------

@dataclass
class ChunkResult:
    chunk_id: str
    bracket: str
    phase: int
    tree: str
    tasks: list = field(default_factory=list)
    dispositions: dict = field(default_factory=dict)
    stopped: str | None = None
    cost_usd: float = 0.0
    invocations: int = 0
    wall_s: float = 0.0
    declared: list = field(default_factory=list)
    boundary_review: dict | None = None
    changed_files: list = field(default_factory=list)

    def as_record(self) -> dict:
        d = dict(self.__dict__)
        d['cost_usd'] = round(self.cost_usd, 4)
        d['wall_s'] = round(self.wall_s, 1)
        return d


# ----------------------------------------------------------------------------
# The dispatcher
# ----------------------------------------------------------------------------

class Dispatcher:
    """Spawn, monitor, merge, advance. Nothing else."""

    def __init__(self, cmap, *, bugs, playbook, runner, trunk, run_dir,
                 cfg=None, trees_root=None, log=print,
                 reuse_characterisation: bool = True,
                 chunk_timeout_s: int | None = None,
                 cost_ceiling_usd: float | None = None,
                 build_gate=None, final_suite=None,
                 seed_tree=None, store=None):
        self.cmap = cmap
        # Durable run store, or None. When present, every task, chunk and phase
        # is written to disk as it completes, and `run()` resumes from the last
        # completed phase. Without one the run exists only in the returned dict
        # and a lost session is a lost run -- the way subset 2 was lost.
        self.store = store
        self.bugs = bugs
        self.playbook = playbook
        self.runner = runner
        self.trunk = os.path.abspath(trunk)
        self.run_dir = run_dir
        self.cfg = cfg or {}
        self.log = log
        self.reuse_characterisation = reuse_characterisation
        loop = self.cfg.get('loop', {})
        self.chunk_timeout_s = chunk_timeout_s if chunk_timeout_s is not None \
            else loop.get('chunk_timeout_s')
        self.cost_ceiling_usd = cost_ceiling_usd if cost_ceiling_usd is not None \
            else loop.get('cost_ceiling_usd')
        self.max_rounds = int(loop.get('reconcile_rounds', 4))
        self.build_gate = build_gate or mq.always_ok
        self.final_suite = final_suite
        self.seed_tree = seed_tree or self._default_seed
        self.trees_root = trees_root or os.path.join(
            os.path.dirname(self.trunk), 'v3-chunk-trees')
        self.assignments = {a.chunk_id: a for a in assignments(cmap, bugs, playbook)}
        self._spend = 0.0
        self._lock = threading.Lock()
        self.started_order: list = []
        # Out-of-boundary writes that are IN THE TRUNK: one entry per declaration
        # of a chunk whose submission the merge queue accepted, in the order the
        # phases landed. Appended to only at the end of a phase, so a chunk can
        # never be told about work that is still running beside it -- concurrent
        # chunks in one phase see nothing of each other, which is correct, because
        # a submission that is later rejected is rolled back byte for byte and its
        # declarations describe a tree that no longer exists.
        self.landed_declarations: list = []

    # -- trees -------------------------------------------------------------

    def _default_seed(self, trunk: str, dest: str) -> None:
        workspace.prepare(trunk, dest, (self.cfg.get('target') or {}).get('node_modules'),
                          force=True, exclude=SEED_EXCLUDES)

    def chunk_tree(self, chunk_id: str) -> str:
        return os.path.join(self.trees_root, chunk_id)

    # -- budget ------------------------------------------------------------

    def _charge(self, amount) -> float:
        with self._lock:
            self._spend += float(amount or 0.0)
            return self._spend

    @property
    def spend_usd(self) -> float:
        return round(self._spend, 4)

    def _over_ceiling(self) -> bool:
        return (self.cost_ceiling_usd is not None
                and self._spend >= float(self.cost_ceiling_usd))

    # -- one chunk ---------------------------------------------------------

    def run_chunk(self, a: Assignment) -> ChunkResult:
        """Run this chunk's tasks strictly in sequence, in its own tree.

        Parallelism in v3 exists only ACROSS chunks. Two tasks in one chunk may
        share a file -- that is the normal case, since a chunk is a group of files
        and their bugs -- so running them at once would reintroduce exactly the
        intra-file collision the ownership map exists to remove.
        """
        t0 = time.time()
        tree = self.chunk_tree(a.chunk_id)
        with self._lock:
            self.started_order.append(a.chunk_id)
        self.seed_tree(self.trunk, tree)
        res = ChunkResult(chunk_id=a.chunk_id, bracket=a.bracket, phase=a.phase,
                          tree=tree)
        inherited = self.inherited_declarations(a)
        if inherited:
            self.log(f'  [{a.chunk_id}] inherits {len(inherited)} landed '
                     f'declaration(s) on file(s) it owns: '
                     + ', '.join(sorted({d['file'] for d in inherited})))
        characterised: dict = {}        # file -> the bug whose artefacts are on disk
        guard = os.path.join(self.run_dir, 'guard', f'{a.chunk_id}.jsonl')
        os.makedirs(os.path.dirname(guard), exist_ok=True)

        # file:line -> the bug whose fix already changed that location in THIS
        # chunk's tree. ARCHITECTURE.md §③ G2: a probe that will not fire at a
        # location an earlier task already edited means the defect was closed
        # upstream, not that this task fixed it. Bug-wise tasks make that the
        # common case rather than the exotic one -- a chunk IS a file and its
        # bugs -- so v3 needs it more than v1 did.
        remediated: dict = {}

        for i, bug in enumerate(a.tasks):
            stop = None
            if self._over_ceiling():
                stop = 'cost_ceiling'
                self.log(f'  [{a.chunk_id}] stopping: cost ceiling '
                         f'${self.cost_ceiling_usd} reached at ${self.spend_usd}')
            elif self.chunk_timeout_s and (time.time() - t0) > self.chunk_timeout_s:
                stop = 'timeout'
                self.log(f'  [{a.chunk_id}] stopping: chunk timeout '
                         f'{self.chunk_timeout_s}s exceeded')
            if stop:
                res.stopped = stop
                res.tasks.extend(_unreached_record(a.chunk_id, b, stop)
                                 for b in a.tasks[i:])
                break

            rec = self._run_task(a, bug, tree, characterised, remediated, guard, res,
                                 inherited)
            res.tasks.append(rec)
            # Streamed the moment the task ends, from this chunk's worker thread.
            # Pre-merge: the queue may still overturn this disposition, and the
            # phase record is what carries the final one.
            if self.store is not None:
                self.store.record_task(rec)

        res.dispositions = disposition_counts(res.tasks)
        res.declared = read_declarations(tree, a.chunk_id)
        # A declarations file that exists, parses, and yields nothing is the
        # shape this went wrong in once: the artefact was there and correct, the
        # parser looked for a different key, and the run recorded the write as
        # undeclared without anything going red. Say it out loud rather than
        # letting an empty list mean both "declared nothing" and "we could not
        # read what you declared".
        if not res.declared and os.path.isfile(
                os.path.join(tree, workspace.scratch_rel(a.chunk_id),
                             'declarations.json')):
            self.log(f'  [{a.chunk_id}] !! declarations.json exists but yielded no '
                     'entries -- check its shape; a declared write will be '
                     'recorded as undeclared and will not reach the chunk that '
                     'owns the file')
        res.changed_files = self._changed(tree)
        res.boundary_review = a.boundary.review(
            res.changed_files, [d['file'] for d in res.declared]).as_record()
        res.wall_s = time.time() - t0
        if self.store is not None:
            self.store.record_chunk(res.as_record())
        return res

    def inherited_declarations(self, a: Assignment) -> list:
        """The landed declarations that touch files THIS chunk owns.

        That intersection is exactly the collision set: a declaration on a file
        this chunk does not own describes code it is not going to edit, and
        putting it in the prompt would only be more text to read past. A
        declaration on a file it DOES own is the case that produced the revert --
        the only writer of that file, reading a change it did not make.
        """
        owned = a.boundary.owned                 # already normalised, by WriteBoundary
        return [d for d in self.landed_declarations
                if boundary.normalise(d.get('file')) in owned]

    def _run_task(self, a, bug, tree, characterised, remediated, guard, res,
                  inherited=()) -> dict:
        """One bug, start to finish, in this chunk's tree.

        The steps and their order are `ARCHITECTURE.md`'s, unchanged: record what
        correct behaviour is before touching anything, then fix, then verify
        against that record, then reconcile, then attest. Verify and reconcile
        are the ORCHESTRATOR's again -- `task_loop.run_fix_loop`, the same loop
        v1 runs -- so what ends the fix phase is a machine-checked exit condition
        rather than the agent's own account of its budget.
        """
        t0 = time.time()
        bug_id = bug['bug_id']
        rel_file = bug['location']['file']
        loc_key = f"{rel_file}:{bug['location'].get('line')}"
        reused_from = characterised.get(rel_file) if self.reuse_characterisation else None
        task_id = task_id_for(a.chunk_id, reused_from or bug_id)
        scratch_rel = workspace.scratch_rel(task_id)
        rec = _record_skeleton(a.chunk_id, bug, task_id)
        rec['reused_from'] = reused_from
        rec['attempted'] = True
        ch = rec['measured']['characterisation']

        # The task's own baseline, so `diff_stats` describes THIS bug rather than
        # everything the chunk has done so far, and so a failed invocation's
        # half-edit can be taken back out of a tree the next task inherits.
        snap = workspace.snapshot(tree, f'task-{a.chunk_id}-{bug_id}')
        try:
            char = self._characterise(a, bug, tree, task_id, scratch_rel, guard,
                                      rec, res, snap,
                                      inherited) if reused_from is None else None
            if reused_from is not None:
                self.log(f'  [{a.chunk_id}] {bug_id}: reusing characterisation from '
                         f'{reused_from} ({rel_file})')
                char = _read_json(
                    os.path.join(tree, scratch_rel, 'characterisation.json'))
                # The artefacts are the earlier task's, but they ARE on disk and
                # they ARE what this task is measured against. Recording them as
                # absent would read as a blocked characterisation.
                wf_rel = f'{scratch_rel}/workflow.test.ts'
                probe_rel = f'{scratch_rel}/exploit.probe.ts'
                wf_here = os.path.isfile(os.path.join(tree, wf_rel))
                probe_here = os.path.isfile(os.path.join(tree, probe_rel))
                ch.update({'workflow_test_written': wf_here,
                           'probe_written': probe_here,
                           'characterisation_parsed': isinstance(char, dict),
                           'workflow_test_path': wf_rel if wf_here else None,
                           'exploit_probe_path': probe_rel if probe_here else None})
            else:
                characterised[rel_file] = bug_id

            attested_ch = attested_characterisation(char)
            # A reused oracle was authored for a different defect in this file, so
            # its PROVEN says nothing about THIS one. Recorded as the other bug's
            # evidence rather than borrowed as this bug's.
            if reused_from is not None and attested_ch:
                attested_ch = dict(attested_ch, reused_from=reused_from,
                                   probe_proven_pre_fix=False,
                                   probe_notes='probe was authored for '
                                               f'{reused_from}, not for this bug')
            rec['attested_characterisation'] = attested_ch

            # The regression net, resolved before the patch prompt is built. v3
            # runs no per-task net of its own, so what goes into this prompt is
            # the only per-task check for collateral damage that exists.
            # Agent-named files are unioned with a static scan for the same reason
            # v2 does it: the agent misses tests it did not think to look for, the
            # scan misses tests that reach the code through indirection.
            related = testmap.select(tree, [rel_file],
                                     (char or {}).get('related_test_files') or [])
            rec['related_test_files'] = related
            ch['related_test_files'] = related

            skip = self._pre_fix_disposition(rec, ch, attested_ch, loc_key,
                                             remediated, reused_from)
            if not skip:
                loop = self._run_fix_loop(a, bug, tree, task_id, scratch_rel, guard,
                                          rec, res, snap, related, attested_ch,
                                          reused_from, inherited, t0)
                changed = workspace.changed_files(tree, snap)
                self._post_fix_disposition(rec, loop, attested_ch, changed,
                                           reused_from)
                # `fixed_workflow_red` counts as remediated here for the same
                # reason `partial` does: the location was edited and the defect is
                # believed closed, so a later task at the same file:line is
                # `already_remediated` rather than a second independent fix. What
                # is unresolved about it is the workflow, not the vulnerability.
                if rec['disposition'] in GREEN_DISPOSITIONS or \
                        rec['disposition'] in ('partial', 'fixed_workflow_red'):
                    remediated[loc_key] = bug_id

            self._close_out(rec, tree, snap, bug)
        finally:
            workspace.discard_snapshot(snap)
        rec['measured']['wall_s'] = round(time.time() - t0, 1)
        return rec

    # -- the phases of one task -------------------------------------------

    def _characterise(self, a, bug, tree, task_id, scratch_rel, guard, rec, res, snap,
                      inherited=()):
        """Phase ①, with the half of its gate set the dispatcher can evaluate.

        `G3` -- the three artefacts exist and `characterisation.json` parses -- is
        a file-system fact and is checked and retried here, up to
        `loop.characterise_rounds`, exactly as ARCHITECTURE.md specifies. `G1` and
        `G2` need the artefacts RUN against the untouched tree, which is a patcher
        gate, so in v3 they are the agent's report and are recorded as attested.

        The source-read-only rule is enforced twice for the same reason v1
        enforces it twice: the hook denies the write, and anything that got past
        it is reverted here, because a baseline captured from code the agent had
        already edited is not a baseline.
        """
        ch = rec['measured']['characterisation']
        workspace.ensure_scratch(tree, task_id)
        max_attempts = max(1, int(self.cfg.get('loop', {}).get('characterise_rounds', 2)))
        base = build_characterise_prompt(a, bug, tree=tree, cfg=self.cfg,
                                         cmap=self.cmap, scratch_rel=scratch_rel,
                                         inherited=inherited)
        feedback, char = '', None

        for attempt in range(1, max_attempts + 1):
            ch['attempts'] = attempt
            suffix = '' if attempt == 1 else f'-{attempt}'
            inv = self.runner.run(
                base + feedback, cwd=tree, phase=CHARACTERISE_PHASE, task_id=task_id,
                log_path=os.path.join(self.run_dir, 'logs',
                                      f'{task_id}-characterise{suffix}.json'),
                guard_log=guard)
            self._note(rec, res, inv)
            rec['characterised'] = True

            stray = workspace.changed_files(tree, snap)
            if stray:
                workspace.restore(tree, snap)
                rec['violations'].append({
                    'kind': 'source_edited_in_characterise',
                    'detail': f'{len(stray)} source file(s) modified during '
                              f'characterisation: {", ".join(stray[:6])}',
                    'phase': CHARACTERISE_PHASE, 'auto_reverted': True})

            char = _read_json(os.path.join(tree, scratch_rel, 'characterisation.json'))
            wf_rel = f'{scratch_rel}/workflow.test.ts'
            probe_rel = f'{scratch_rel}/exploit.probe.ts'
            wf_here = os.path.isfile(os.path.join(tree, wf_rel))
            probe_here = os.path.isfile(os.path.join(tree, probe_rel))
            ch.update({'workflow_test_written': wf_here, 'probe_written': probe_here,
                       'characterisation_parsed': isinstance(char, dict),
                       'workflow_test_path': wf_rel if wf_here else None,
                       'exploit_probe_path': probe_rel if probe_here else None})

            problems = []
            if not wf_here:
                problems.append(f'`{wf_rel}` was not written. Without it nothing can '
                                'tell a fixed defect from a broken feature.')
            if not probe_here:
                problems.append(f'`{probe_rel}` was not written.')
            if not isinstance(char, dict):
                problems.append(f'`{scratch_rel}/characterisation.json` is missing or '
                                'is not valid JSON.')
            if not problems:
                break
            if attempt < max_attempts:
                feedback = CHARACTERISE_RETRY.format(
                    problems='\n'.join(f'- {p}' for p in problems))
                self.log(f'  [{a.chunk_id}] {bug["bug_id"]}: characterisation attempt '
                         f'{attempt} incomplete ({len(problems)} problem(s)); retrying')
        return char

    def _baseline(self, tree, related, workflow_rel, rec) -> dict:
        """Run the net and the workflow test against the tree BEFORE the fix.

        Not optional, and v3 went without it for its first three runs. `verify`
        charges a related test as a regression when it fails now and was not
        recorded as failing before -- and with no baseline, "before" is an empty
        dict, so EVERY red row in the net counts, including the ones that were
        already red when the task started. A task with one pre-existing failure
        anywhere in its net would then be labelled `vuln_only` no matter what the
        agent did, and `vuln_only` is the label that becomes
        `fixed_workflow_red`. That is a measurement reporting damage that was
        there before the patcher arrived.

        The workflow test is swept with the net, which is where the measured half
        of G1 comes from: it is run once against the untouched tree, so a task
        whose oracle was ALREADY red is identifiable afterwards instead of having
        its V2 failures silently attributed to the fix.
        """
        files = list(related)
        if workflow_rel and workflow_rel not in files:
            files.append(workflow_rel)
        outcomes = verify.collect_outcomes(self.cfg, tree, files) if files else {}

        ch = rec['measured']['characterisation']
        ch['baseline_failures'] = sorted(
            f'{rel}: {title}'
            for rel, r in outcomes.items()
            for title, status in r['outcomes'].items() if status == 'fail')
        wf = outcomes.get(workflow_rel) if workflow_rel else None
        if wf is not None:
            ch['workflow_green_pre_fix'] = bool(wf['exit_ok'])
        return outcomes

    def _run_fix_loop(self, a, bug, tree, task_id, scratch_rel, guard, rec, res,
                      snap, related, attested_ch, reused_from, inherited, t0):
        """Phases ②③④, driven by the orchestrator, and the record of what it saw.

        Four things here are easy to get subtly wrong and each has a test:

        * `max_rounds` is a TOTAL and includes round 0. `self.max_rounds` is
          `loop.reconcile_rounds`, a count of RECONCILES, so the loop is given
          one more than that -- passing it raw gives v3 one round fewer than the
          config asks for and nothing anywhere would say so.
        * the loop never restores the tree. It snapshots the best round and hands
          the path back; keeping or reverting is policy, and policy is here. v3
          keeps the best round, because a chunk is submitted whole and there is
          no per-task revert that would not also drop the tasks around it.
        * the snapshot is the caller's to discard, every path, or a long chunk
          leaks one tar per task.
        * the phase strings come from the loop (`fix` for round 0, `reconcile`
          after), and both are in the sandbox hook's vocabulary and both freeze
          the gate artefacts. That is why `PATCH_PHASE` is `fix` and not a
          v3-specific name.
        """
        bug_id = bug['bug_id']
        # The paths recorded by the characterise step, which are None when the
        # artefact is not on disk. Passing a path that does not exist would run a
        # gate against a missing file and charge the failure to the fix; `verify`
        # skips a gate it is handed None for, which is the honest reading.
        ch = rec['measured']['characterisation']
        workflow_rel = ch['workflow_test_path']
        probe_rel = ch['exploit_probe_path']
        # The attested pre-fix verdict, and the only attested input left in the
        # fix phase. False makes V3 `skipped` rather than failed: a probe that
        # never demonstrated the defect cannot demonstrate its closure either.
        probe_expected = bool(attested_ch and attested_ch['probe_proven_pre_fix'])
        attestation_rel = f'{scratch_rel}/attestation.json'
        baseline = self._baseline(tree, related, workflow_rel, rec)

        # Per BUG, not per task_id: a reused characterisation gives two bugs the
        # same task_id, and one directory would mean the second bug's rounds
        # overwriting the first's logs.
        log_dir = os.path.join(self.run_dir, 'logs', f'{a.chunk_id}-{bug_id}')
        os.makedirs(log_dir, exist_ok=True)

        def build_prompt(round_no, vr, diff):
            return build_patch_prompt(
                a, bug, tree=tree, cfg=self.cfg, cmap=self.cmap,
                playbook=self.playbook, scratch_rel=scratch_rel,
                reused_from=reused_from, max_rounds=self.max_rounds,
                related_files=related, inherited=inherited,
                round_no=round_no, failures=(vr.failures if vr else ()), diff=diff)

        loop = task_loop.run_fix_loop(
            cfg=self.cfg, tree=tree, task_id=task_id, bug=bug, runner=self.runner,
            build_prompt=build_prompt,
            workflow_rel=workflow_rel, probe_rel=probe_rel,
            probe_expected=probe_expected, related=related,
            baseline_outcomes=baseline,
            # v3 has no anti-oracle detector wired in, and this is not the place
            # to invent a second excusal path: `verify` excuses a row from the
            # tests' own text or not at all. A net row a correct fix cannot
            # satisfy therefore goes red, the label says `vuln_only`, and the
            # agent's own claim about it sits beside that in `attested`.
            antioracles=None,
            max_rounds=self.max_rounds + 1,
            deadline=t0 + float(self.cfg.get('loop', {}).get('max_task_wall_s', 5400)),
            log_dir=log_dir, guard_log=guard,
            snap_path=snap, attestation_rel=attestation_rel)

        for inv in loop.invocations:
            self._note(rec, res, inv)

        # Keep the best round's tree, then let go of the snapshot on every path.
        try:
            if loop.best_snapshot:
                workspace.restore(tree, loop.best_snapshot)
        except workspace.WorkspaceError as ex:
            rec['violations'].append({'kind': 'scratch_missing',
                                      'detail': f'best-round restore failed: {ex}',
                                      'phase': PATCH_PHASE, 'auto_reverted': False})
        finally:
            if loop.best_snapshot:
                workspace.discard_snapshot(loop.best_snapshot)

        rec['attested'] = loop.attestation
        m = rec['measured']
        m['rounds'] = loop.rounds
        m['rounds_used'] = loop.rounds_used
        m['label'] = loop.label
        m['deadline_exceeded'] = loop.deadline_exceeded
        m['gates_run'] = len(loop.rounds)
        m['gates_not_run_reason'] = None
        if loop.green:
            m['rounds_to_green'] = loop.rounds[-1]['round']
        # The SELECTED round, not the last one: it is the tree that was just
        # restored and the tree that will be submitted, so a `final_gates` taken
        # from a later and worse round would describe a tree nobody kept.
        m['final_gates'] = {
            'typecheck': loop.gates.get('V1_typecheck', 'skipped'),
            'workflow': loop.gates.get('V2_workflow', 'skipped'),
            'probe_blocked': loop.gates.get('V3_probe_blocked', 'skipped'),
            'no_regression': loop.gates.get('V4_no_regression', 'skipped'),
        }
        if loop.deadline_exceeded:
            self.log(f'  [{a.chunk_id}] {bug_id}: task wall-clock budget exhausted '
                     f'after {loop.rounds_used} round(s)')
        return loop

    def _pre_fix_disposition(self, rec, ch, attested_ch, loc_key, remediated,
                             reused_from) -> bool:
        """Decide, before spending the fix phase, whether it is worth spending.

        Returns True when the task closes here. Both cases are ARCHITECTURE.md's:
        no workflow record at all is `blocked` before a fix is attempted, and a
        probe that will not fire at a location an earlier task already changed is
        `already_remediated` and closes with no fix phase.
        """
        if not (ch['workflow_test_written'] and ch['characterisation_parsed']) \
                and reused_from is None:
            return bool(_dispose(
                rec, 'blocked', MEASURED,
                f"no workflow record on disk after {ch['attempts']} attempt(s): "
                f"workflow_test_written={ch['workflow_test_written']}, "
                f"characterisation_parsed={ch['characterisation_parsed']}. Without one "
                'there is nothing to tell a fixed defect from a broken feature, so no '
                'fix was attempted.'))

        if (attested_ch and not attested_ch['probe_proven_pre_fix']
                and reused_from is None and loc_key in remediated):
            return bool(_dispose(
                rec, 'already_remediated', ATTESTED,
                f'the agent reported the probe never reached PROVEN, and '
                f'{remediated[loc_key]} already changed {loc_key} earlier in this '
                'chunk. Recorded as closed upstream rather than as a fix by this '
                'task. Attested: the probe verdict is the agent\'s, not a '
                'measurement.'))
        return False

    def _post_fix_disposition(self, rec, loop, attested_ch, changed,
                              reused_from) -> None:
        """The disposition, from the label the ORCHESTRATOR measured.

        Every branch here is MEASURED. It used to read `attestation.json →
        status` and label the result ATTESTED, which is the thing this change
        exists to end: `status` is the agent's opinion of its own patch, and an
        agent that stops after one round over a red gate and writes `fixed`
        produced exactly the same record as one that reconciled to green.

        `loop.label` is `task_loop._derive_label`'s reading of the gates the
        dispatcher ran on the round whose tree was kept:

            green          probe closed, build/workflow/net clean  -> fixed
            vuln_only      probe closed, something else red        -> fixed_workflow_red
            workflow_only  probe not closed, nothing else red      -> fixed_workflow_only
            neither        neither axis                            -> partial / abandoned
            agent_failed   no usable invocation, or no attestation -> agent_failed

        Two of those mappings are worth their own sentence.

        `vuln_only` -> `fixed_workflow_red`. The tag was added (43774ce) for a fix
        submitted over a workflow assertion the agent said it left red, on the
        agent's own list. It now means the same outcome MEASURED: the path is
        demonstrably closed and a gate the dispatcher ran is demonstrably red.
        The agent's `workflow_red` and `antioracle_claims` are still recorded, in
        `attested`, and are still adjudicated by nothing -- they are now a claim
        sitting beside a measurement that may or may not agree with it, which is
        strictly more information than the claim alone. It is still never summed
        with `fixed`: a correct fix over an attack-dependent assertion and a fix
        that broke the feature both land here, and the record still cannot tell
        them apart -- it can now at least say WHICH gate was red and in which
        round.

        `workflow_only` -> `fixed_workflow_only` carries the one attested input
        left: V3 is `skipped`, not passed, because the agent reported the probe
        never demonstrated the defect (or the oracle was another bug's). A
        skipped remediation gate is not a closed vulnerability.
        """
        att = rec['attested']
        label = loop.label
        wf_red_pre_fix = (rec['measured']['characterisation']['workflow_green_pre_fix']
                          is False)
        # Said out loud wherever a red gate drives the disposition. Without it, a
        # task whose oracle was already broken before the agent arrived reads
        # exactly like a task that broke it.
        pre_red = (' The workflow test was ALREADY RED against the unmodified tree, '
                   'measured before this fix, so a red workflow gate here is not '
                   'evidence that this change broke anything.' if wf_red_pre_fix else '')

        if label == 'agent_failed':
            # Deliberately not read as "revert whatever is there": a run can be
            # `agent_failed` for a missing attestation while its gates measured
            # green, so the reason records what was measured before the tree goes
            # back. What decides the revert is REVERT_DISPOSITIONS, below, and it
            # still reverts -- the attestation is the submission contract's only
            # durable output, and a change nobody can describe is not submittable.
            gates = _gate_summary(loop.gates)
            if not any(getattr(i, 'ok', False) for i in loop.invocations):
                why = ('no fix invocation returned successfully in '
                       f'{loop.rounds_used} round(s)')
            else:
                why = ('the fix invocation returned but wrote no parseable '
                       'attestation.json, which is the only durable output its '
                       'contract names')
            _dispose(rec, 'agent_failed', MEASURED,
                     f'{why}. Measured at the best round: {gates}. Its edits were '
                     'reverted rather than submitted undescribed.')
        elif not changed:
            # An unchanged tree cannot have fixed anything, whatever the gates
            # say about it, and a green sheet over no diff means a gate is
            # answering about something other than this task.
            _dispose(rec, 'abandoned', MEASURED,
                     ('the agent attested a fix and changed no source file. '
                      if att and att['status'] == 'fixed' else
                      'the fix phase ended with no source file changed. ')
                     + f'Measured label was `{label}` over an empty diff, so nothing '
                       'was patched.')
        elif label == 'green':
            _dispose(rec, 'fixed', MEASURED,
                     f'every gate passed at round {rec["measured"]["rounds_to_green"]}: '
                     'the probe stopped proving the defect, the workflow test still '
                     'passes and the regression net is clean. Measured by the '
                     'orchestrator, not attested.')
        elif label == 'vuln_only':
            red = [g for g in GATE_NAMES
                   if g != 'V3_probe_blocked'
                   and loop.gates.get(g) not in ('pass', 'skipped', None)]
            claims = len(((att or {}).get('antioracle_claims')) or [])
            _dispose(rec, 'fixed_workflow_red', MEASURED,
                     f'the probe stopped proving the defect, and {", ".join(sorted(red))} '
                     f'was still red after {loop.rounds_used} measured round(s). The '
                     f'agent claims {claims} of the failing assertion(s) assert the '
                     'vulnerable behaviour itself; that claim is recorded and '
                     'adjudicated by nothing. Never summed with `fixed` -- a correct '
                     'fix over an attack-dependent assertion and a fix that broke the '
                     'feature both land here.' + pre_red)
        elif label == 'workflow_only':
            why = ('the probe was reused from ' + str(reused_from) +
                   ' and does not exercise this defect' if reused_from
                   else 'the probe never demonstrated the defect before the fix')
            _dispose(rec, 'fixed_workflow_only', MEASURED,
                     f'the build, the workflow test and the regression net were '
                     f'measured clean, but {why}, so the remediation gate was skipped '
                     'rather than passed and the remediation axis is unverified. Never '
                     'summed with `fixed`.')
        else:                                                    # 'neither'
            gates = _gate_summary(loop.gates)
            _dispose(rec, 'partial', MEASURED,
                     f'gates still red after {loop.rounds_used} measured round(s) '
                     f'({gates}), and the work is retained: v3 submits a chunk whole, '
                     'so there is no per-task revert that would not also drop the tasks '
                     'around it. Read the round table before trusting this task.'
                     + pre_red)

        # The agent's claim against the orchestrator's own measurement. Recorded,
        # never used to alter the disposition.
        if att:
            # `fixed_workflow_red` counts as agreeing with a `fixed` claim: the
            # measurement agrees the path is closed, and the disagreement is
            # about a gate the disposition already names. Calling it an overclaim
            # would double-count one fact.
            green = rec['disposition'] in GREEN_DISPOSITIONS or \
                rec['disposition'] == 'fixed_workflow_red'
            if att['status'] == 'fixed' and not green:
                rec['attestation_delta'] = {'agent_said': 'fixed',
                                            'measurement_said': rec['disposition'],
                                            'kind': 'overclaim'}
            elif att['status'] == 'not_fixed' and green:
                rec['attestation_delta'] = {'agent_said': 'not_fixed',
                                            'measurement_said': rec['disposition'],
                                            'kind': 'underclaim'}

    def _close_out(self, rec, tree, snap, bug) -> None:
        """Revert if the disposition says so, then record what is actually left."""
        if rec['disposition'] in REVERT_DISPOSITIONS:
            try:
                workspace.restore(tree, snap)
            except workspace.WorkspaceError as ex:
                rec['violations'].append({'kind': 'scratch_missing',
                                          'detail': f'revert failed: {ex}',
                                          'phase': PATCH_PHASE,
                                          'auto_reverted': False})
        diff = workspace.diff_against_snapshot(tree, snap)
        rec['diff_stats'] = workspace.diff_stats(diff, bug['location']['file'])

    def _note(self, rec, res, inv) -> None:
        """Record an invocation. Liveness is exactly this: did it come back, and
        what did it cost. Nothing about WHAT it produced is looked at here."""
        rec['measured']['invocations'].append(
            {'phase': inv.phase, 'ok': inv.ok, 'reason': inv.reason,
             'wall_s': round(inv.wall_s, 1), 'cost_usd': inv.cost_usd})
        rec['measured']['cost_usd'] = round(
            rec['measured']['cost_usd'] + float(inv.cost_usd or 0.0), 4)
        res.invocations += 1
        res.cost_usd += float(inv.cost_usd or 0.0)
        self._charge(inv.cost_usd)

    def _changed(self, tree: str) -> list:
        snap = self._phase_base
        if not snap or not os.path.exists(snap):
            return []
        return workspace.changed_files_against(tree, workspace.base_hashes(snap))

    # -- one phase ---------------------------------------------------------

    _phase_base: str | None = None

    def run_phase(self, phase_no: int) -> dict:
        """Every chunk in the phase concurrently, then one serial merge queue.

        The barrier is per PHASE, not per bracket: two brackets in one phase are
        declared independent, so there is nothing to gain by separating their
        merges, and one queue means one deterministic order over the whole phase.
        """
        chunks = self.cmap.chunks_in_phase(phase_no)
        workers = max(1, min(self.cmap.concurrency_for_phase(phase_no), len(chunks) or 1))
        self.log(f'phase {phase_no}: {len(chunks)} chunk(s) across '
                 f'{len(self.cmap.brackets_in_phase(phase_no))} bracket(s), '
                 f'{workers} worker(s)')
        t0 = time.time()

        base_snap = workspace.snapshot(self.trunk, f'v3-phase-{phase_no}-base')
        self._phase_base = base_snap
        results: list = []
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {pool.submit(self.run_chunk, self.assignments[c.chunk_id]): c
                           for c in chunks}
                for fut in concurrent.futures.as_completed(futures):
                    c = futures[fut]
                    try:
                        results.append(fut.result())
                    except Exception as ex:                       # noqa: BLE001
                        # One poisoned chunk must not take the phase down, and it
                        # must not vanish from the denominator either.
                        self.log(f'  [{c.chunk_id}] !! crashed: '
                                 f'{type(ex).__name__}: {ex}')
                        why = f'crash: {type(ex).__name__}: {ex}'
                        unreached = [_unreached_record(c.chunk_id, b, why)
                                     for b in self.assignments[c.chunk_id].tasks]
                        crashed = ChunkResult(
                            chunk_id=c.chunk_id, bracket=c.bracket, phase=phase_no,
                            tree=self.chunk_tree(c.chunk_id),
                            tasks=unreached,
                            dispositions=disposition_counts(unreached),
                            stopped=why)
                        results.append(crashed)
                        # run_chunk raised, so it never recorded itself. A crashed
                        # chunk that leaves no trace on disk reads later as a chunk
                        # that was never planned.
                        if self.store is not None:
                            for rec in unreached:
                                self.store.record_task(rec)
                            self.store.record_chunk(crashed.as_record())
                            self.store.note_infrastructure_failure(
                                'chunk_crash', detail=why, chunk_id=c.chunk_id,
                                phase=phase_no)

            results.sort(key=lambda r: r.chunk_id)
            queue = mq.MergeQueue(trunk=self.trunk, base_snap=base_snap,
                                  build=self.build_gate, log=self.log)
            for r in results:
                if r.stopped and r.stopped.startswith('crash'):
                    continue
                queue.submit(mq.Submission(
                    chunk_id=r.chunk_id, tree=r.tree,
                    changed_files=r.changed_files,
                    declared=[d['file'] for d in r.declared],
                    merge_last=bool((r.boundary_review or {}).get('merge_last')),
                    bracket=r.bracket, phase=phase_no,
                    boundary_review=r.boundary_review,
                    attestation=None))
            merged = queue.drain()
            self._apply_merge_verdicts(results, merged)
            # Only now, and only for the chunks that actually landed. Before the
            # drain there is no trunk fact to advertise; after it, an accepted
            # chunk's declared writes ARE the trunk and the chunk that owns those
            # files needs to be told before it reads them as damage.
            self._land_declarations([r.as_record() for r in results], merged, phase_no)
        finally:
            workspace.discard_snapshot(base_snap)
            self._phase_base = None

        record = {
            'phase': phase_no,
            'brackets': [b.bracket for b in self.cmap.brackets_in_phase(phase_no)],
            'workers': workers,
            'chunks': [r.as_record() for r in results],
            'merge': merged,
            'dispositions': disposition_counts(
                [t for r in results for t in r.tasks]),
            'wall_s': round(time.time() - t0, 1),
            'spend_usd': round(sum(r.cost_usd for r in results), 4),
            'tree_digest': workspace.tree_digest(self.trunk),
        }
        # Checkpoint before the next phase starts. This record is authoritative:
        # the merge queue has drained and its verdicts are applied, so the task
        # dispositions in it are final where the streamed ones were not.
        if self.store is not None:
            self.store.record_phase(record, tree_digest=record['tree_digest'],
                                    spend_usd=self.spend_usd)
            self.log(f'phase {phase_no}: checkpointed to {self.store.run_dir}')
        return record

    def _land_declarations(self, chunk_records, merged, phase_no) -> None:
        """Record the declarations of ACCEPTED chunks, and only those.

        The filter is the whole of the correctness argument. A rejected
        submission was rolled back byte for byte, so its declared write is not in
        the trunk at all -- advertising it as landed would tell the owning chunk
        that a change it cannot see is deliberate, and send it looking for
        something that was never applied. That is a worse failure than the
        silence this replaces, so an unknown verdict is treated as not accepted.

        The same argument disqualifies a declaration the chunk wrote and then did
        not act on: `boundary.review` already separates the files a chunk declared
        AND changed from the ones it only intended to, and only the first kind is
        a fact about the trunk.
        """
        accepted = {e['chunk_id'] for e in (merged.get('accepted') or [])}
        landed = []
        for c in chunk_records or ():
            if c.get('chunk_id') not in accepted:
                continue
            review = c.get('boundary_review')
            written = {boundary.normalise(f) for f in
                       ((review.get('declared') if review else c.get('changed_files'))
                        or ())}
            for d in c.get('declared') or ():
                if boundary.normalise(d.get('file')) not in written:
                    continue
                landed.append({'chunk_id': c['chunk_id'], 'phase': phase_no,
                               'file': d.get('file'), 'bug_id': d.get('bug_id'),
                               'reason': d.get('reason') or ''})
        if landed:
            with self._lock:
                self.landed_declarations.extend(landed)

    @staticmethod
    def _apply_merge_verdicts(results, merged) -> None:
        """A rejected submission is rolled back byte for byte, so none of its
        tasks reached the trunk.

        Leaving them recorded as `fixed` would put work nobody shipped into the
        run's headline count -- the flattering direction, and the one the
        reporting rule exists to stop. `abandoned` is the disposition that already
        means "this task's change is not in the tree", and it is a MEASURED fact
        here: the queue observed the rollback. The pre-merge disposition is kept
        alongside so the agent's own outcome is not erased by an integration
        failure it did not cause.
        """
        rejected = {e['chunk_id'] for e in (merged.get('rejected') or [])}
        accepted = {e['chunk_id'] for e in (merged.get('accepted') or [])}
        for r in results:
            verdict = ('rejected' if r.chunk_id in rejected
                       else 'accepted' if r.chunk_id in accepted else None)
            for rec in r.tasks:
                rec['merge_verdict'] = verdict
                if verdict != 'rejected' or not rec.get('attempted'):
                    continue
                if rec['disposition'] in REVERT_DISPOSITIONS:
                    continue        # already reverted; the merge changes nothing
                rec['disposition_before_merge'] = rec['disposition']
                _dispose(rec, 'abandoned', MEASURED,
                         "this chunk's submission was rejected at the merge queue and "
                         'rolled back byte for byte, so no part of this task reached '
                         f"the trunk (pre-merge disposition: {rec['disposition']}).")

    # -- the run -----------------------------------------------------------

    def run(self, phases=None) -> dict:
        """Every phase, in order. The full suite runs once, after the last one."""
        t0 = time.time()
        order = [p for p in self.cmap.phase_order()
                 if phases is None or p in set(phases)]

        # Resume. A phase already in the store is not re-run: its agents were
        # paid for once and its merges already landed in the trunk, so running it
        # again would spend twice and merge an already-merged change.
        done: set = set()
        out: list = []
        if self.store is not None:
            out = [r for r in self.store.phase_records(order)
                   if r.get('phase') in set(order)]
            done = {r.get('phase') for r in out}
            for phase_no in sorted(done):
                self.log(f'phase {phase_no}: already complete, resumed from '
                         f'{self.store.run_dir}')
            # Landed declarations are a property of the TRUNK, not of the session
            # that produced them, and the trunk survives a lost session. Replayed
            # from every stored phase -- including one outside `order`, whose
            # merges are in the trunk just the same -- so a resumed run does not
            # hand a chunk the unexplained tree the first run took care to explain.
            for rec in self.store.phase_records():
                self._land_declarations(rec.get('chunks'), rec.get('merge') or {},
                                        rec.get('phase'))
            # The ceiling is a property of the RUN, not of the session. Seeding it
            # from the store stops a resumed run from getting a fresh budget every
            # time a session dies.
            if done and self.store.spend_usd:
                with self._lock:
                    self._spend = float(self.store.spend_usd)

        for phase_no in order:
            if phase_no in done:
                continue
            out.append(self.run_phase(phase_no))
        out.sort(key=lambda r: r.get('phase') if r.get('phase') is not None else -1)

        # The suite runs when every phase in the map has been executed, whether in
        # this session or an earlier one -- never on a partial tree.
        suite = None
        if {r.get('phase') for r in out} == set(self.cmap.phase_order()):
            suite = self._run_final_suite()

        records = [t for p in out for c in p['chunks'] for t in c['tasks']]
        return {
            'mode': 'v3-dispatch',
            'map_id': self.cmap.map_id,
            'phases': out,
            'phase_order': order,
            'tasks_total': len(records),
            # Counted, never summed. `fixed`, `fixed_workflow_only` and
            # `fixed_workflow_red` stay in separate buckets here for the same
            # reason report.py keeps them apart: the second means the remediation
            # axis was never demonstrated even in the agent's own sandbox, and the
            # third that the agent submitted over a workflow assertion it left
            # failing, which nothing here can adjudicate.
            'dispositions': disposition_counts(records),
            # Emitted still, and now mostly `measured`: the fix phase runs the
            # gates itself. What remains attested is `already_remediated`, whose
            # probe verdict is the agent's. A reader who wants to know whether a
            # green count is evidence or a self-report reads this split, and a
            # run whose ATTESTED share is large is a run whose fix phase mostly
            # did not happen.
            'disposition_basis': {
                MEASURED: sum(1 for r in records
                              if r.get('disposition_basis') == MEASURED),
                ATTESTED: sum(1 for r in records
                              if r.get('disposition_basis') == ATTESTED),
            },
            'rounds_to_green': _rounds_to_green(records),
            # Gate suites run by the orchestrator, one per measured round. Zero
            # here means no task reached its fix phase, not that gates are absent
            # from the architecture -- which is what it used to mean.
            'per_task_gates_run': sum((r.get('measured') or {}).get('gates_run') or 0
                                      for r in records),
            'tasks_merge_rejected': sum(1 for r in records
                                        if r.get('merge_verdict') == 'rejected'),
            'attestation_overclaims': sum(
                1 for r in records
                if (r.get('attestation_delta') or {}).get('kind') == 'overclaim'),
            'reuse_characterisation': self.reuse_characterisation,
            'characterisations_reused': sum(
                1 for p in out for c in p['chunks'] for t in c['tasks']
                if t.get('reused_from')),
            'characterisations_paid': sum(
                1 for p in out for c in p['chunks'] for t in c['tasks']
                if t.get('characterised')),
            'spend_usd': self.spend_usd,
            'cost_ceiling_usd': self.cost_ceiling_usd,
            # Which phases this session actually executed, and which were read
            # back from an earlier one. A resumed run's wall clock covers only
            # this session; its spend is cumulative because the ceiling is.
            'resumed_phases': sorted(done),
            'phases_run_this_session': sorted(p for p in order if p not in done),
            'wall_s': round(time.time() - t0, 1),
            'rejected_total': sum(len(p['merge']['rejected']) for p in out),
            'full_suite': suite,
            'tree_digest': workspace.tree_digest(self.trunk),
        }

    def _run_final_suite(self):
        """The whole-suite regression net, once, at the end.

        v1 and v2 ran a regression net per task and per wave. v3 does not, and
        that is a real loss: damage is discovered here, at the end, when
        attributing it to a chunk costs a bisect rather than a lookup. It is
        recorded as `null` when it did not run, never as an empty pass -- a suite
        that did not run is not a suite that passed.
        """
        if self.final_suite is not None:
            return self.final_suite(self.trunk)
        if (self.cfg.get('commands') or {}).get('full_suite'):
            return verify.run_full_suite(self.cfg, self.trunk)
        self.log('full suite: not configured, NOT RUN')
        return None


# ----------------------------------------------------------------------------
# Submission artefacts
# ----------------------------------------------------------------------------

def read_declarations(tree: str, chunk_id: str) -> list:
    """The chunk's declared out-of-boundary writes.

    Read from the agent's own artefact, normalised, and never inferred. An
    undeclared write is still detected -- `boundary.review` compares the
    declarations against what actually changed -- so a chunk cannot avoid the
    merge-last penalty by writing nothing here.

    Exactly three fields are kept, and the whitelist is deliberate rather than
    incidental: these entries are forwarded into another chunk's prompt once the
    submission is accepted, so anything else the agent chose to write into this
    file stops here.
    """
    path = os.path.join(tree, workspace.scratch_rel(chunk_id), 'declarations.json')
    doc = _read_json(path)
    if not doc:
        return []
    # Both spellings, because the prompt names the file but has never pinned the
    # key, and an agent that picks the other reasonable one must not lose its
    # declaration silently. Measured: on patch-run-subset-05 a chunk wrote
    # {"chunk": ..., "declarations": [...]}, this function read `files`, returned
    # [], and a correctly declared cross-boundary write was recorded as
    # UNDECLARED. Nothing failed; the entry simply was not there. Every test in
    # the suite built the artefact the parser's way, so none of them could see it.
    raw = None
    if isinstance(doc, dict):
        for key in ('files', 'declarations'):
            if isinstance(doc.get(key), list):
                raw = doc[key]
                break
    else:
        raw = doc
    out = []
    for item in raw or []:
        if isinstance(item, str):
            out.append({'file': item, 'bug_id': None, 'reason': ''})
        elif isinstance(item, dict) and item.get('file'):
            out.append({'file': item['file'],
                        'bug_id': item.get('bug_id') or None,
                        'reason': item.get('reason') or ''})
    return out


def _read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:                                            # noqa: BLE001
        return None
