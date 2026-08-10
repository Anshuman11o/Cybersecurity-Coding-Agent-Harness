#!/usr/bin/env python3
"""
The merge queue: the one serial point in a v3 run, and the only test the
orchestrator is allowed to run.

v2's integrator folded a whole wave in at a barrier and then measured it with
the patcher's own gates. v3 does not do that. The chunk agent has already
characterised, fixed, self-verified and reconciled its own work; asking the
orchestrator to re-judge it would put the verifier back in the loop and undo the
point of the change. So the queue asks exactly the three questions that MERGING
raises and nothing else:

    does it apply?          -- can these files land on the trunk as it stands now
    does it build?          -- is the trunk still compilable afterwards
    does it conflict?       -- did another chunk already change these files

Anything else -- does the workflow still pass, is the vulnerability closed, did
a sibling reopen it -- is deferred to the single whole-suite run after the last
bracket. That deferral is the honest cost of v3 and it is stated as such in
`docs/patcher/ARCHITECTURE-V3.md` §7, not hidden here.

SUBMISSION GRANULARITY, NOT FILE GRANULARITY

`integrator.integrate()` resolves contests file by file and drops the losing
side of one file while keeping the rest of that unit. That is right for a wave,
where a unit is one file's worth of work. It is wrong for a chunk: a chunk is an
ordered run of many bug fixes in one tree, and dropping one file out of the
middle of it produces a partial fix -- the plumbing without the check, or the
check without the plumbing. So the queue accepts or rejects a WHOLE submission,
and a rejected submission is rolled back byte for byte.

The trunk is rolled back from an in-memory copy of exactly the files the
submission touched, taken immediately before it was applied. That is what makes
"a rejected merge does not poison the chunks behind it" a property rather than a
hope: the next submission in the queue starts from a trunk that has never seen
the rejected bytes.

WHAT IS REUSED

`integrator._copy_in`, `_merge3` and `_extract_base` are imported, not copied.
`_merge3` in particular carries a bug fix worth keeping: `git merge-file`
rewrites the file with conflict markers EVEN WHEN it reports a conflict, and
that function rolls the file back. A second implementation here would have had
the same bug, and the tests that pin it live next to the original.
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field

import integrator
import verify
import workspace


@dataclass
class Submission:
    """One chunk's finished work, offered to the trunk.

    `declared` is what the agent said it would write outside its boundary, read
    from the artefact it wrote -- the queue does not infer it. `merge_last` comes
    from `boundary.BoundaryReview.merge_last`, so a chunk that reached outside
    its files goes to the back whether or not it remembered to declare.
    """

    chunk_id: str
    tree: str
    changed_files: list = field(default_factory=list)
    declared: list = field(default_factory=list)
    merge_last: bool = False
    bracket: str | None = None
    phase: int | None = None
    attestation: dict | None = None
    boundary_review: dict | None = None
    note: str | None = None


# ----------------------------------------------------------------------------
# Build gates
# ----------------------------------------------------------------------------

def typecheck_gate(cfg: dict):
    """The real build gate: the target's own typecheck, nothing more.

    Deliberately not the test suite. A queue that ran tests would be running a
    patcher gate, and it would run it once per chunk on the serial path -- the
    exact cost shape v2 had to fix at its barrier.
    """
    def _gate(trunk: str):
        r = verify.typecheck(cfg, trunk)
        return bool(r.ok), ('' if r.ok else r.tail)
    return _gate


def always_ok(_trunk: str):
    """No build gate. For a dry run, and for tests that are measuring ordering."""
    return True, ''


# ----------------------------------------------------------------------------
# The queue
# ----------------------------------------------------------------------------

class MergeQueue:
    """Serial. One submission at a time, applied to one trunk.

    A queue instance covers one phase: `base_snap` is the snapshot the phase's
    chunk trees were all seeded from, and it is the common ancestor every
    three-way merge uses. Reusing a queue across phases would merge against an
    ancestor that has moved.
    """

    def __init__(self, *, trunk: str, base_snap: str, build=always_ok, log=print):
        self.trunk = os.path.abspath(trunk)
        self.base_snap = base_snap
        self.build = build
        self.log = log
        self._pending: list = []
        self._owner: dict = {}          # rel -> the chunk whose version is on the trunk
        self.accepted: list = []
        self.rejected: list = []
        self.contested: list = []
        self.builds_run = 0
        self._base_hashes = None

    # -- input -------------------------------------------------------------

    def submit(self, sub: Submission) -> None:
        self._pending.append(sub)

    def order(self) -> list:
        """Undeclared-clean chunks first, out-of-boundary writers last.

        The reason a declaring chunk merges last is not politeness: the file it
        reached for is owned or extended by somebody else, and applying that
        somebody's version first means the declared write merges against the
        final content rather than against a version that is about to be replaced.
        Ties break on chunk id so the order is reproducible, never a race.
        """
        return sorted(self._pending,
                      key=lambda s: (bool(s.merge_last or s.declared), s.chunk_id))

    # -- trunk state -------------------------------------------------------

    def base_hashes(self) -> dict:
        """Read the phase base once. Every submission compares against the same
        immutable archive, and re-reading it per chunk re-derives an identical
        answer -- v2 measured 31 identical reads on its widest wave."""
        if self._base_hashes is None:
            self._base_hashes = (workspace.base_hashes(self.base_snap)
                                 if os.path.exists(self.base_snap) else {})
        return self._base_hashes

    def changed_by(self, sub: Submission) -> list:
        if sub.changed_files:
            return sorted({boundary_norm(f) for f in sub.changed_files})
        return workspace.changed_files_against(sub.tree, self.base_hashes())

    def _capture(self, rels) -> dict:
        """The trunk's current bytes for these paths. None means 'did not exist'."""
        out: dict = {}
        for rel in rels:
            p = os.path.join(self.trunk, rel)
            try:
                with open(p, 'rb') as fh:
                    out[rel] = fh.read()
            except OSError:
                out[rel] = None
        return out

    def _restore(self, captured: dict) -> None:
        for rel, blob in captured.items():
            p = os.path.join(self.trunk, rel)
            if blob is None:
                if os.path.exists(p):
                    os.remove(p)
                continue
            os.makedirs(os.path.dirname(p) or self.trunk, exist_ok=True)
            with open(p, 'wb') as fh:
                fh.write(blob)

    # -- one submission ----------------------------------------------------

    def _apply(self, sub: Submission, rels: list) -> list:
        """Land every file, or report the conflicts. Caller rolls back on failure."""
        conflicts: list = []
        for rel in rels:
            prior = self._owner.get(rel)
            if prior is None:
                integrator._copy_in(self.trunk, sub.tree, rel)
                continue

            self.contested.append({'file': rel, 'chunks': [prior, sub.chunk_id]})
            side = os.path.join(sub.tree, rel)
            current = os.path.join(self.trunk, rel)
            if not os.path.exists(side):
                conflicts.append({
                    'file': rel, 'with': prior,
                    'reason': 'this chunk deleted a file another chunk changed; a '
                              'deletion is never merged over somebody else\'s edit'})
                continue
            if not os.path.exists(current):
                conflicts.append({'file': rel, 'with': prior,
                                  'reason': 'the trunk no longer has this file'})
                continue
            with tempfile.TemporaryDirectory() as td:
                base = integrator._extract_base(self.base_snap, rel, td)
                if base is None:
                    conflicts.append({
                        'file': rel, 'with': prior,
                        'reason': 'absent from the phase base, so two chunks created it '
                                  'independently and there is no common ancestor to '
                                  'merge against'})
                    continue
                if not integrator._merge3(current, base, side):
                    conflicts.append({'file': rel, 'with': prior,
                                      'reason': 'three-way merge left conflict markers'})
        return conflicts

    def _process(self, sub: Submission) -> dict:
        rels = self.changed_by(sub)
        if not rels:
            entry = {'chunk_id': sub.chunk_id, 'files': [], 'contested': [],
                     'declared': sorted(sub.declared), 'reason': 'no change to merge'}
            self.accepted.append(entry)
            self.log(f'  merge {sub.chunk_id}: nothing changed')
            return entry

        captured = self._capture(rels)
        contested_here = [r for r in rels if r in self._owner]
        conflicts = self._apply(sub, rels)

        if conflicts:
            self._restore(captured)
            entry = {'chunk_id': sub.chunk_id, 'files': rels,
                     'contested': contested_here, 'declared': sorted(sub.declared),
                     'verdict': 'rejected', 'kind': 'conflict', 'conflicts': conflicts}
            self.rejected.append(entry)
            self.log(f'  merge {sub.chunk_id}: REJECTED, '
                     f'{len(conflicts)} conflict(s): '
                     + '; '.join(f"{c['file']} ({c['reason']})" for c in conflicts[:3]))
            return entry

        ok, tail = self.build(self.trunk)
        self.builds_run += 1
        if not ok:
            self._restore(captured)
            entry = {'chunk_id': sub.chunk_id, 'files': rels,
                     'contested': contested_here, 'declared': sorted(sub.declared),
                     'verdict': 'rejected', 'kind': 'build', 'tail': tail[-1500:]}
            self.rejected.append(entry)
            self.log(f'  merge {sub.chunk_id}: REJECTED, trunk would not build')
            return entry

        for rel in rels:
            self._owner[rel] = sub.chunk_id
        entry = {'chunk_id': sub.chunk_id, 'files': rels,
                 'contested': contested_here, 'declared': sorted(sub.declared),
                 'verdict': 'accepted'}
        self.accepted.append(entry)
        self.log(f'  merge {sub.chunk_id}: accepted, {len(rels)} file(s)'
                 + (f', {len(contested_here)} contested' if contested_here else ''))
        return entry

    # -- output ------------------------------------------------------------

    def drain(self) -> dict:
        """Process every pending submission, in `order()`, one at a time."""
        order = self.order()
        for sub in order:
            self._process(sub)
        self._pending = []
        return self.report(order)

    def report(self, order=None) -> dict:
        return {
            'merge_order': [s.chunk_id for s in (order or [])],
            'accepted': self.accepted,
            'rejected': self.rejected,
            'contested_files': self.contested,
            'declared_out_of_boundary': {
                e['chunk_id']: e['declared'] for e in (self.accepted + self.rejected)
                if e.get('declared')},
            'file_owner': dict(sorted(self._owner.items())),
            'builds_run': self.builds_run,
            'clean': not self.rejected,
        }


def boundary_norm(rel: str) -> str:
    return (rel or '').replace('\\', '/').lstrip('./')
