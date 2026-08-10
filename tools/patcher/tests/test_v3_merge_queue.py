"""v3 merge queue: the one serial point, and the only test the orchestrator runs.

The properties under test are not "the merge worked". They are:
  - a submission is accepted or rejected WHOLE, never half-applied
  - a rejected submission leaves the trunk exactly as it found it, so the
    submissions behind it start from a clean base
  - a chunk that reached outside its files merges last, deterministically
  - a contest is merged three-way against the phase base, never overwritten
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import workspace  # noqa: E402
from v3 import merge_queue as mq  # noqa: E402

NUMBERED = ''.join(f'line{i}\n' for i in range(1, 21))
TRUNK_FILES = {'lib/a.ts': NUMBERED, 'routes/b.ts': 'b0\n', 'views/v.pug': 'v0\n'}


def _write(root, rel, src):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p) or root, exist_ok=True)
    with open(p, 'w') as fh:
        fh.write(src)


def _read(root, rel):
    with open(os.path.join(root, rel)) as fh:
        return fh.read()


def _trunk(tmp_path, files=None):
    root = str(tmp_path / 'trunk')
    for rel, src in (files or TRUNK_FILES).items():
        _write(root, rel, src)
    snap = workspace.snapshot(root, 'v3-phase-0-base')
    return root, snap


def _chunk(tmp_path, trunk, cid, edits, **kw):
    tree = str(tmp_path / cid)
    workspace.prepare(trunk, tree, None, force=True,
                      exclude=('.patcher-snapshots', workspace.SCRATCH_DIRNAME))
    for rel, src in edits.items():
        if src is None:
            os.remove(os.path.join(tree, rel))
        else:
            _write(tree, rel, src)
    return mq.Submission(chunk_id=cid, tree=tree, **kw)


# ---- ordering --------------------------------------------------------------

def test_a_declaring_chunk_merges_last_even_when_its_id_sorts_first(tmp_path):
    """The file it reached for belongs to somebody else, so that somebody's
    version has to be on the trunk before the declared write lands on top."""
    trunk, snap = _trunk(tmp_path)
    q = mq.MergeQueue(trunk=trunk, base_snap=snap)
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/a.ts': NUMBERED + 'a\n',
                                             'views/v.pug': 'v1\n'},
                    declared=['views/v.pug'], merge_last=True))
    q.submit(_chunk(tmp_path, trunk, 'B01', {'routes/b.ts': 'b1\n'}))
    rep = q.drain()
    assert rep['merge_order'] == ['B01', 'A01']
    assert rep['declared_out_of_boundary'] == {'A01': ['views/v.pug']}


def test_order_is_stable_and_does_not_depend_on_submission_order(tmp_path):
    trunk, snap = _trunk(tmp_path)
    subs = [_chunk(tmp_path, trunk, 'C01', {'routes/b.ts': 'b1\n'}),
            _chunk(tmp_path, trunk, 'A01', {'lib/a.ts': NUMBERED + 'a\n'})]
    q = mq.MergeQueue(trunk=trunk, base_snap=snap)
    for s in reversed(subs):
        q.submit(s)
    assert q.order()[0].chunk_id == 'A01'


# ---- clean merges ----------------------------------------------------------

def test_disjoint_submissions_all_land(tmp_path):
    trunk, snap = _trunk(tmp_path)
    q = mq.MergeQueue(trunk=trunk, base_snap=snap)
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/a.ts': NUMBERED + 'a\n'}))
    q.submit(_chunk(tmp_path, trunk, 'B01', {'routes/b.ts': 'b1\n'}))
    rep = q.drain()
    assert rep['clean'] and len(rep['accepted']) == 2
    assert _read(trunk, 'lib/a.ts').endswith('a\n')
    assert _read(trunk, 'routes/b.ts') == 'b1\n'
    assert rep['file_owner'] == {'lib/a.ts': 'A01', 'routes/b.ts': 'B01'}


def test_a_submission_that_changed_nothing_is_recorded_not_dropped(tmp_path):
    trunk, snap = _trunk(tmp_path)
    q = mq.MergeQueue(trunk=trunk, base_snap=snap)
    q.submit(_chunk(tmp_path, trunk, 'A01', {}))
    rep = q.drain()
    assert rep['accepted'][0]['reason'] == 'no change to merge'
    assert q.builds_run == 0


def test_a_contested_file_is_merged_three_way_not_overwritten(tmp_path):
    """Both chunks touched the same file in different places. Overwriting would
    silently discard one of the two fixes."""
    trunk, snap = _trunk(tmp_path)
    top = 'TOP\n' + NUMBERED
    bottom = NUMBERED + 'BOTTOM\n'
    q = mq.MergeQueue(trunk=trunk, base_snap=snap)
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/a.ts': top}))
    q.submit(_chunk(tmp_path, trunk, 'B01', {'lib/a.ts': bottom}))
    rep = q.drain()
    assert rep['clean'], rep['rejected']
    merged = _read(trunk, 'lib/a.ts')
    assert merged.startswith('TOP\n') and merged.endswith('BOTTOM\n')
    assert rep['contested_files'] == [{'file': 'lib/a.ts', 'chunks': ['A01', 'B01']}]


# ---- rejection and containment --------------------------------------------

def test_a_real_conflict_rejects_the_whole_submission_and_writes_no_markers(tmp_path):
    trunk, snap = _trunk(tmp_path)
    q = mq.MergeQueue(trunk=trunk, base_snap=snap)
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/a.ts': 'A rewrote everything\n'}))
    q.submit(_chunk(tmp_path, trunk, 'B01', {'lib/a.ts': 'B rewrote everything\n',
                                             'routes/b.ts': 'b1\n'}))
    rep = q.drain()
    assert [e['chunk_id'] for e in rep['accepted']] == ['A01']
    assert rep['rejected'][0]['chunk_id'] == 'B01'
    assert rep['rejected'][0]['kind'] == 'conflict'
    body = _read(trunk, 'lib/a.ts')
    assert body == 'A rewrote everything\n'
    assert '<<<<<<<' not in body
    # B is rejected WHOLE: its unrelated, uncontested file does not sneak in.
    assert _read(trunk, 'routes/b.ts') == 'b0\n'


def test_a_rejected_build_does_not_poison_the_chunks_behind_it(tmp_path):
    """The trunk is rolled back from bytes captured immediately before the
    submission was applied, so the next chunk in the queue starts from a trunk
    that has never seen the rejected change."""
    trunk, snap = _trunk(tmp_path)
    seen = []

    def build(tree):
        body = _read(tree, 'lib/a.ts')
        seen.append('POISON' in body)
        return ('POISON' not in body), 'tsc said no'

    q = mq.MergeQueue(trunk=trunk, base_snap=snap, build=build)
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/a.ts': NUMBERED + 'POISON\n'}))
    q.submit(_chunk(tmp_path, trunk, 'B01', {'routes/b.ts': 'b1\n'}))
    rep = q.drain()

    assert rep['rejected'][0]['chunk_id'] == 'A01'
    assert rep['rejected'][0]['kind'] == 'build'
    assert [e['chunk_id'] for e in rep['accepted']] == ['B01']
    assert _read(trunk, 'lib/a.ts') == NUMBERED          # rolled back exactly
    assert _read(trunk, 'routes/b.ts') == 'b1\n'
    assert seen == [True, False]                          # B built on a clean trunk


def test_a_rejected_submission_does_not_claim_ownership(tmp_path):
    """If it did, the next chunk touching that file would be told it was
    contested and merged against a version nobody shipped."""
    trunk, snap = _trunk(tmp_path)
    q = mq.MergeQueue(trunk=trunk, base_snap=snap,
                      build=lambda t: (False, 'no'))
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/a.ts': NUMBERED + 'a\n'}))
    q.drain()
    assert q.report()['file_owner'] == {}


def test_a_deletion_over_another_chunks_edit_is_a_conflict(tmp_path):
    trunk, snap = _trunk(tmp_path)
    q = mq.MergeQueue(trunk=trunk, base_snap=snap)
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/a.ts': NUMBERED + 'a\n'}))
    q.submit(_chunk(tmp_path, trunk, 'B01', {'lib/a.ts': None}))
    rep = q.drain()
    assert rep['rejected'][0]['chunk_id'] == 'B01'
    assert os.path.exists(os.path.join(trunk, 'lib/a.ts'))


def test_two_chunks_creating_the_same_new_file_have_no_common_ancestor(tmp_path):
    trunk, snap = _trunk(tmp_path)
    q = mq.MergeQueue(trunk=trunk, base_snap=snap)
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/new.ts': 'from A\n'}))
    q.submit(_chunk(tmp_path, trunk, 'B01', {'lib/new.ts': 'from B\n'}))
    rep = q.drain()
    assert [e['chunk_id'] for e in rep['accepted']] == ['A01']
    assert 'no common ancestor' in rep['rejected'][0]['conflicts'][0]['reason']


# ---- the build gate --------------------------------------------------------

def test_the_gate_runs_once_per_submission_not_once_per_file(tmp_path):
    trunk, snap = _trunk(tmp_path)
    q = mq.MergeQueue(trunk=trunk, base_snap=snap, build=mq.always_ok)
    q.submit(_chunk(tmp_path, trunk, 'A01', {'lib/a.ts': NUMBERED + 'a\n',
                                             'routes/b.ts': 'b1\n'}))
    q.drain()
    assert q.builds_run == 1
