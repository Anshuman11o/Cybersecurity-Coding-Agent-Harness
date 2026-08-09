#!/usr/bin/env python3
"""
Fold a wave's unit trees back into one tree, and then measure what that folding
did.

Each unit in a wave worked in its own copy, seeded from the same tree, so their
edits have to be combined before the next wave can start. That combination is
the only place in a parallel run where two agents' work meets, which makes it
the only place a collision can be caught -- and the only honest place to
attribute one.

WHY NOT APPLY task.patch

`workspace.diff_against_snapshot` exists for the reconcile prompt, and its
snapshot is source-only by design (SOURCE_EXTS). Anything outside that set --
`.md` files under `.ai/skills/`, for one -- is absent from the tar and therefore
shows up in the diff as a newly added file. Measured on the pilot: a real 2-file
change reported as 68 files and +6184 lines. Feeding that to `patch` would write
dozens of files no agent touched.

So integration does not use a diff at all. `workspace.changed_files` compares
content hashes against the same snapshot and returns exactly the source files
that actually differ. Those files are copied. There is no fuzz, no offset, and
no patch that can half-apply.

CONTESTED FILES

A unit is assigned one file, but it may legitimately edit others -- a correct
CSRF fix in this target spanned four files to plumb a token to a form, so
out-of-assignment writes cannot simply be denied. When two units in a wave both
changed the same file, the file is contested, and it is merged three-way with
the wave base as the common ancestor.

A conflict is recorded and the conflicting unit's version of that one file is
dropped. It is never guessed at, and conflict markers are never written into the
tree -- a tree containing `<<<<<<<` does not compile, and the next wave would
inherit a build failure attributed to nobody.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tarfile
import tempfile

import verify
import workspace


class Unit:
    """One integrable contribution: where it worked, and what it was asked to fix.

    `assigned_file` takes a list because a dependency cycle integrates as one
    contribution. Its members run serially in a shared tree, and since a cycle by
    definition cannot be ordered, their edits cannot be separated afterwards
    either -- so the unit owns the union of their files.
    """

    def __init__(self, unit_id: str, tree: str, assigned_file, record: dict | None = None):
        self.unit_id = unit_id
        self.tree = tree
        self.assigned_files = ({assigned_file} if isinstance(assigned_file, str)
                               else set(assigned_file or ()))
        self.record = record or {}

    @property
    def assigned_file(self):
        """The single assigned file, or None when this unit owns several."""
        return next(iter(self.assigned_files)) if len(self.assigned_files) == 1 else None

    def __repr__(self):                                          # pragma: no cover
        return f'Unit({self.unit_id!r}, {sorted(self.assigned_files)!r})'


# ----------------------------------------------------------------------------
# Base versions
# ----------------------------------------------------------------------------

def _extract_base(base_snap: str, rel: str, dest_dir: str) -> str | None:
    """The wave-base version of one file, or None if it did not exist then."""
    try:
        with tarfile.open(base_snap, 'r') as tf:
            try:
                member = tf.getmember(rel)
            except KeyError:
                return None
            if not member.isfile():
                return None
            fh = tf.extractfile(member)
            if fh is None:
                return None
            out = os.path.join(dest_dir, 'base')
            with open(out, 'wb') as dst:
                dst.write(fh.read())
            return out
    except (OSError, tarfile.TarError):
        return None


def _merge3(current: str, base: str, other: str) -> bool:
    """3-way merge `other` into `current` in place. False means conflict.

    git merge-file returns 0 on a clean merge, the conflict count when it had to
    leave markers, and negative on error. Only 0 is accepted: a merge that left
    markers has not merged.

    On failure `current` is rolled back byte for byte. git merge-file rewrites the
    file with conflict markers in it EVEN WHEN it reports a conflict, so without
    this rollback a rejected side still reaches the tree -- `<<<<<<<` in a .ts file
    fails the next wave's typecheck, and the build failure is attributed to nobody.
    A test pins this; it is how the bug was found.
    """
    with open(current, 'rb') as fh:
        before = fh.read()
    r = subprocess.run(['git', 'merge-file', '-q', current, base, other],
                       capture_output=True)
    if r.returncode == 0:
        return True
    with open(current, 'wb') as fh:
        fh.write(before)
    return False


def _copy_in(seed: str, src_tree: str, rel: str) -> str:
    """Copy one file from a unit tree into the seed, or delete it if the unit
    deleted it. Returns 'copied' or 'deleted'."""
    src = os.path.join(src_tree, rel)
    dst = os.path.join(seed, rel)
    if not os.path.exists(src):
        if os.path.exists(dst):
            os.remove(dst)
        return 'deleted'
    os.makedirs(os.path.dirname(dst) or seed, exist_ok=True)
    shutil.copyfile(src, dst)
    shutil.copymode(src, dst)
    return 'copied'


# ----------------------------------------------------------------------------
# Claims
# ----------------------------------------------------------------------------

def changed_by_unit(units, base_snap: str) -> dict:
    """unit_id -> the source files it changed against the wave base."""
    return {u.unit_id: workspace.changed_files(u.tree, base_snap) for u in units}


def claims(changed: dict) -> dict:
    """file -> the units that changed it, sorted. More than one is contested."""
    out: dict = {}
    for uid in sorted(changed):
        for rel in changed[uid]:
            out.setdefault(rel, []).append(uid)
    return {rel: sorted(uids) for rel, uids in sorted(out.items())}


def out_of_assignment(units, changed: dict) -> dict:
    """unit_id -> files it changed that are not the file it was assigned.

    Not a violation. It is the collision surface, and a run that does not name
    it cannot explain its own conflicts.
    """
    return {u.unit_id: [rel for rel in changed.get(u.unit_id, [])
                        if rel not in u.assigned_files]
            for u in units}


# ----------------------------------------------------------------------------
# Integration
# ----------------------------------------------------------------------------

def integrate(*, seed: str, base_snap: str, units, log=print) -> dict:
    """Fold every unit's changes into `seed`. Returns the integration report."""
    changed = changed_by_unit(units, base_snap)
    claim = claims(changed)
    tree_of = {u.unit_id: u.tree for u in units}

    applied: list = []
    contested: list = []
    conflicts: list = []
    dropped: list = []

    for rel, uids in claim.items():
        if len(uids) == 1:
            how = _copy_in(seed, tree_of[uids[0]], rel)
            applied.append({'file': rel, 'unit': uids[0], 'how': how})
            continue

        contested.append({'file': rel, 'units': uids})
        with tempfile.TemporaryDirectory() as td:
            base = _extract_base(base_snap, rel, td)
            if base is None:
                # No common ancestor: every unit created this file independently.
                # There is nothing to merge against, so nobody's version is
                # applied and the run says so.
                conflicts.append({
                    'file': rel, 'units': uids,
                    'reason': 'absent from the wave base, so two units created it '
                              'independently and there is no common ancestor to merge '
                              'against. No version was applied.'})
                dropped += [{'unit': u, 'file': rel, 'reason': 'no common ancestor'}
                            for u in uids]
                continue

            acc = os.path.join(td, 'acc')
            shutil.copyfile(base, acc)
            merged: list = []
            for uid in uids:
                side = os.path.join(tree_of[uid], rel)
                if not os.path.exists(side):
                    dropped.append({
                        'unit': uid, 'file': rel,
                        'reason': 'this unit deleted the file while another changed it; '
                                  'the deletion was not applied'})
                    continue
                if _merge3(acc, base, side):
                    merged.append(uid)
                else:
                    dropped.append({
                        'unit': uid, 'file': rel,
                        'reason': 'conflicts with '
                                  + (', '.join(merged) if merged else 'the wave base')})
                    conflicts.append({'file': rel, 'units': uids, 'dropped': uid,
                                      'kept': list(merged),
                                      'reason': 'three-way merge left conflict markers'})
            dst = os.path.join(seed, rel)
            os.makedirs(os.path.dirname(dst) or seed, exist_ok=True)
            shutil.copyfile(acc, dst)
            applied.append({'file': rel, 'unit': '+'.join(merged) or None,
                            'how': f'merged {len(merged)}/{len(uids)}'})

    for u in units:
        place_scratch(seed, u)

    report = {
        'units': [u.unit_id for u in units],
        'files_changed_by_unit': changed,
        'contested_files': contested,
        'conflicts': conflicts,
        'dropped': dropped,
        'applied': applied,
        'out_of_assignment': out_of_assignment(units, changed),
        'clean': not conflicts,
    }
    n_files = len(claim)
    log(f'  integrated {len(units)} unit(s): {n_files} file(s), '
        f'{len(contested)} contested, {len(conflicts)} conflict(s)')
    for c in conflicts:
        log(f"    CONFLICT {c['file']}: {c['reason']}")
    return report


def place_scratch(seed: str, unit: Unit) -> bool:
    """Copy a unit's frozen gate artefacts into the seed.

    The post-wave gate re-runs each unit's own workflow test and probe, and both
    live in that unit's scratch directory rather than in the tree it patched.
    Scratch is excluded from the digest and from every diff, so this cannot
    change what the run is measured on.
    """
    src = workspace.scratch_abs(unit.tree, unit.unit_id)
    if not os.path.isdir(src):
        return False
    dst = workspace.scratch_abs(seed, unit.unit_id)
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copytree(src, dst)
    return True


# ----------------------------------------------------------------------------
# The post-wave gate
# ----------------------------------------------------------------------------

def post_wave_gate(cfg: dict, seed: str, units, *, log=print) -> dict:
    """Measure the merged tree.

    Every unit characterised its workflow test against THIS wave's base and
    confirmed it green there, so a red test here cannot be blamed on upstream
    drift -- within a wave there is no upstream. It is either that unit's own
    fix or a sibling in the same wave, and the report says which units were
    siblings so the shortlist is explicit.

    (The pre-merge baseline re-run needed to separate "this unit broke it" from
    "the contract moved underneath it" belongs to the optimistic scheme, where
    units are seeded from a tree that later moves. Waves make it unnecessary by
    construction, so it is deliberately not run here.)
    """
    out: dict = {'typecheck': None, 'workflow': {}, 'probe': {}, 'green': True}

    tc = verify.typecheck(cfg, seed)
    out['typecheck'] = {'ok': tc.ok, 'timed_out': tc.timed_out,
                        'tail': '' if tc.ok else tc.tail}
    if not tc.ok:
        # Nothing downstream can be measured against a tree that does not build,
        # and reporting per-unit gates from a broken build would invent results.
        out['green'] = False
        out['skipped'] = 'typecheck failed; per-unit gates not run'
        log('  post-wave gate: BUILD FAILED')
        return out

    for u in units:
        rel = workspace.scratch_rel(u.unit_id)
        wf = f'{rel}/workflow.test.ts'
        pr = f'{rel}/exploit.probe.ts'

        if os.path.isfile(os.path.join(seed, wf)):
            r = verify.run_test_file(cfg, seed, wf)
            outcomes = verify.parse_test_output(r.stdout + '\n' + r.stderr)
            failed = sorted(t for t, s in outcomes.items() if s == 'fail')
            ok = r.ok and not failed
            out['workflow'][u.unit_id] = {
                'ok': ok, 'failed': failed,
                'harness_error': (not outcomes) and not r.ok,
                'tail': '' if ok else r.tail}
            if not ok:
                out['green'] = False
        else:
            out['workflow'][u.unit_id] = {'ok': None, 'missing': True}

        if os.path.isfile(os.path.join(seed, pr)):
            verdict, _ = verify.run_probe(cfg, seed, pr)
            out['probe'][u.unit_id] = verdict
            if verdict == verify.PROVEN:
                # The unit's fix survived its own task and stopped working once a
                # sibling's change landed. Nothing else in the run detects this.
                out['green'] = False
        else:
            out['probe'][u.unit_id] = 'MISSING'

    bad_wf = [u for u, v in out['workflow'].items() if v.get('ok') is False]
    reopened = [u for u, v in out['probe'].items() if v == verify.PROVEN]
    log(f"  post-wave gate: typecheck ok, "
        f"{len(out['workflow']) - len(bad_wf)}/{len(out['workflow'])} workflow green"
        + (f", workflow red: {', '.join(bad_wf)}" if bad_wf else '')
        + (f", REOPENED: {', '.join(reopened)}" if reopened else ''))
    out['workflow_red'] = bad_wf
    out['reopened'] = reopened
    return out
