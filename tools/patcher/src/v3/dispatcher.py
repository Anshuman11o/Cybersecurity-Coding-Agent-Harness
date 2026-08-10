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

WHY TWO INVOCATIONS PER TASK, NOT ONE AND NOT SEVEN

v1 spends one invocation per phase and gates between them: 2 to 7 per bug. v3
spends two:

    characterise   writes workflow.test.ts + exploit.probe.ts + characterisation.json,
                   source read-only. Kept as its own invocation for one reason:
                   it is the unit that CHARACTERISATION REUSE skips. Folded into
                   the fix call it could not be skipped, and reuse is the only
                   mitigation v3 has for the bug-wise cost regression (§6 of the
                   architecture doc).
    patch          fix, self-verify, reconcile until green or budget spent,
                   attest, submit. The agent runs its own loop here, which is
                   the actual v3 change; the orchestrator is not in it.

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
import verify
import workspace

from . import chunk_map as chunk_map_mod
from . import merge_queue as mq

SEED_EXCLUDES = ('.patcher-snapshots', workspace.SCRATCH_DIRNAME)

CHARACTERISE_PHASE = 'v3-characterise'
PATCH_PHASE = 'v3-patch'


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
  add the file and your reason to `{declarations}`. Several chunks legitimately
  extend the same view or config, so a chunk that writes here is merged last.
- Any other file: same rule -- declare it in `{declarations}` before you write it.
  Reaching outside your files is allowed and sometimes necessary; a correct CSRF
  fix in this codebase spans four files to plumb a token into a view. What is not
  allowed is doing it silently.
- `{never_writable}`: never, under any circumstances.

{house_rules}
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
  `PROVEN` now.
- `characterisation.json` — what correct behaviour is, what the defect is, which
  existing test files cover this path, what you expect to change.

Run them yourself and confirm before you finish:

    {workflow_cmd}
    {probe_cmd}
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

The orchestrator does not check your work between steps. You do:

1. fix the defect, inside your owned files where possible
2. self-verify: `{typecheck_cmd}`, then `{workflow_cmd}`, then `{probe_cmd}`,
   then the existing tests the characterisation named
3. if any of those is red, reconcile and go back to 2 — up to {max_rounds}
   rounds. The workflow test is the record of what correct behaviour looks like;
   use it to find a change that satisfies both axes. Do not edit the test to
   match the code, weaken the probe, or delete the feature.
4. when green, or when the budget is spent, write `{attestation_path}`:

```json
{{"bug_id": "{bug_id}", "status": "fixed" | "not_fixed", "confidence": 0.0,
  "what_changed": "one sentence", "why_it_closes_the_path": "one or two sentences",
  "why_the_workflow_still_works": "one or two sentences",
  "residual_risk": "what could not be closed, or null", "rounds_used": 0}}
```

Then move to your next bug. Do not stop to report; the whole chunk is submitted
to the merge queue once, at the end.
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
    map holds file and line so it can be validated offline; the prose the agent
    needs -- the vulnerability, the reproduction, the class -- only exists in the
    report, and duplicating it into a checked-in artefact would create two
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


def _header(a: Assignment, tree: str, cmap) -> str:
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
        house_rules=prompts.HOUSE_RULES)


def build_characterise_prompt(a: Assignment, bug: dict, *, tree, cfg, cmap,
                              scratch_rel: str) -> str:
    return _header(a, tree, cmap) + '\n' + CHARACTERISE_BODY.format(
        bug_id=bug['bug_id'], file=bug['location']['file'],
        line=bug['location']['line'], bug=prompts._fmt_bug(bug),
        scratch=scratch_rel,
        workflow_cmd=_cmd(cfg, 'run_test_file', f'{scratch_rel}/workflow.test.ts'),
        probe_cmd=_cmd(cfg, 'run_probe', f'{scratch_rel}/exploit.probe.ts'))


def build_patch_prompt(a: Assignment, bug: dict, *, tree, cfg, cmap, playbook,
                       scratch_rel: str, reused_from: str | None,
                       max_rounds: int) -> str:
    entry, how = (blind_guard.select_entry(playbook, bug) if playbook else (None, 'none'))
    return _header(a, tree, cmap) + '\n' + PATCH_BODY.format(
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
        attestation_path=f'{scratch_rel}/attestation.json')


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
                 seed_tree=None):
        self.cmap = cmap
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
        characterised: dict = {}        # file -> the bug whose artefacts are on disk
        guard = os.path.join(self.run_dir, 'guard', f'{a.chunk_id}.jsonl')
        os.makedirs(os.path.dirname(guard), exist_ok=True)

        for bug in a.tasks:
            if self._over_ceiling():
                res.stopped = 'cost_ceiling'
                self.log(f'  [{a.chunk_id}] stopping: cost ceiling '
                         f'${self.cost_ceiling_usd} reached at ${self.spend_usd}')
                break
            if self.chunk_timeout_s and (time.time() - t0) > self.chunk_timeout_s:
                res.stopped = 'timeout'
                self.log(f'  [{a.chunk_id}] stopping: chunk timeout '
                         f'{self.chunk_timeout_s}s exceeded')
                break

            rec = self._run_task(a, bug, tree, characterised, guard, res)
            res.tasks.append(rec)

        res.declared = read_declarations(tree, a.chunk_id)
        res.changed_files = self._changed(tree)
        res.boundary_review = a.boundary.review(
            res.changed_files, [d['file'] for d in res.declared]).as_record()
        res.wall_s = time.time() - t0
        return res

    def _run_task(self, a, bug, tree, characterised, guard, res) -> dict:
        bug_id = bug['bug_id']
        rel_file = bug['location']['file']
        reused_from = characterised.get(rel_file) if self.reuse_characterisation else None
        task_id = task_id_for(a.chunk_id, reused_from or bug_id)
        scratch_rel = workspace.scratch_rel(task_id)
        rec = {'bug_id': bug_id, 'file': rel_file, 'task_id': task_id,
               'characterised': False, 'reused_from': reused_from,
               'invocations': [], 'cost_usd': 0.0}

        if reused_from is None:
            workspace.ensure_scratch(tree, task_id)
            inv = self.runner.run(
                build_characterise_prompt(a, bug, tree=tree, cfg=self.cfg,
                                          cmap=self.cmap, scratch_rel=scratch_rel),
                cwd=tree, phase=CHARACTERISE_PHASE, task_id=task_id,
                log_path=os.path.join(self.run_dir, 'logs',
                                      f'{task_id}-characterise.json'),
                guard_log=guard)
            self._note(rec, res, inv)
            rec['characterised'] = True
            characterised[rel_file] = bug_id
        else:
            self.log(f'  [{a.chunk_id}] {bug_id}: reusing characterisation from '
                     f'{reused_from} ({rel_file})')

        inv = self.runner.run(
            build_patch_prompt(a, bug, tree=tree, cfg=self.cfg, cmap=self.cmap,
                               playbook=self.playbook, scratch_rel=scratch_rel,
                               reused_from=reused_from, max_rounds=self.max_rounds),
            cwd=tree, phase=PATCH_PHASE, task_id=task_id,
            log_path=os.path.join(self.run_dir, 'logs', f'{task_id}-patch.json'),
            guard_log=guard)
        self._note(rec, res, inv)
        rec['attestation'] = _read_json(
            os.path.join(tree, scratch_rel, 'attestation.json'))
        return rec

    def _note(self, rec, res, inv) -> None:
        """Record an invocation. Liveness is exactly this: did it come back, and
        what did it cost. Nothing about WHAT it produced is looked at here."""
        rec['invocations'].append({'phase': inv.phase, 'ok': inv.ok,
                                   'reason': inv.reason,
                                   'wall_s': round(inv.wall_s, 1),
                                   'cost_usd': inv.cost_usd})
        rec['cost_usd'] += float(inv.cost_usd or 0.0)
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
                        results.append(ChunkResult(
                            chunk_id=c.chunk_id, bracket=c.bracket, phase=phase_no,
                            tree=self.chunk_tree(c.chunk_id),
                            stopped=f'crash: {type(ex).__name__}: {ex}'))

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
        finally:
            workspace.discard_snapshot(base_snap)
            self._phase_base = None

        return {
            'phase': phase_no,
            'brackets': [b.bracket for b in self.cmap.brackets_in_phase(phase_no)],
            'workers': workers,
            'chunks': [r.as_record() for r in results],
            'merge': merged,
            'wall_s': round(time.time() - t0, 1),
            'spend_usd': round(sum(r.cost_usd for r in results), 4),
            'tree_digest': workspace.tree_digest(self.trunk),
        }

    # -- the run -----------------------------------------------------------

    def run(self, phases=None) -> dict:
        """Every phase, in order. The full suite runs once, after the last one."""
        t0 = time.time()
        order = [p for p in self.cmap.phase_order()
                 if phases is None or p in set(phases)]
        out: list = []
        for phase_no in order:
            out.append(self.run_phase(phase_no))

        suite = None
        if phases is None or set(order) == set(self.cmap.phase_order()):
            suite = self._run_final_suite()

        return {
            'mode': 'v3-dispatch',
            'map_id': self.cmap.map_id,
            'phases': out,
            'phase_order': order,
            'reuse_characterisation': self.reuse_characterisation,
            'characterisations_reused': sum(
                1 for p in out for c in p['chunks'] for t in c['tasks']
                if t.get('reused_from')),
            'characterisations_paid': sum(
                1 for p in out for c in p['chunks'] for t in c['tasks']
                if t.get('characterised')),
            'spend_usd': self.spend_usd,
            'cost_ceiling_usd': self.cost_ceiling_usd,
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
    """
    path = os.path.join(tree, workspace.scratch_rel(chunk_id), 'declarations.json')
    doc = _read_json(path)
    if not doc:
        return []
    raw = doc.get('files') if isinstance(doc, dict) else doc
    out = []
    for item in raw or []:
        if isinstance(item, str):
            out.append({'file': item, 'reason': ''})
        elif isinstance(item, dict) and item.get('file'):
            out.append({'file': item['file'], 'reason': item.get('reason') or ''})
    return out


def _read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:                                            # noqa: BLE001
        return None
