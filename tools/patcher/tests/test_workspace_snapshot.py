"""Reading a snapshot once, and comparing many trees against it.

`changed_files` used to read and hash the whole snapshot archive on every call.
The merge path calls it once per unit against ONE immutable wave base, so on the
full-set plan's widest wave that is 31 identical reads on the serial path. The
split has to be exactly equivalent to the old single-call form, or the merge
starts deciding differently -- which is why the property tested here is equality
with `changed_files`, not the new function's behaviour in isolation.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import workspace  # noqa: E402


def _write(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p) or root, exist_ok=True)
    with open(p, 'w') as fh:
        fh.write(text)


def _base(tmp_path):
    tree = str(tmp_path / 'base')
    _write(tree, 'a.ts', 'const a = 1\n')
    _write(tree, 'lib/b.ts', 'const b = 2\n')
    _write(tree, 'models/c.ts', 'const c = 3\n')
    return tree, workspace.snapshot(tree, 'wave-0-base')


def test_reading_the_base_once_gives_the_same_answer_as_reading_it_per_tree(tmp_path):
    tree, snap = _base(tmp_path)
    _write(tree, 'lib/b.ts', 'const b = 22\n')
    _write(tree, 'new.ts', 'const n = 4\n')

    recorded = workspace.base_hashes(snap)
    assert (workspace.changed_files_against(tree, recorded)
            == workspace.changed_files(tree, snap)
            == ['lib/b.ts', 'new.ts'])


def test_one_read_serves_several_trees(tmp_path):
    """The case the split exists for: N unit trees, one wave base."""
    base, snap = _base(tmp_path)
    recorded = workspace.base_hashes(snap)

    for uid, rel, text in (('A', 'a.ts', 'const a = 11\n'),
                           ('B', 'lib/b.ts', 'const b = 22\n')):
        tree = str(tmp_path / uid)
        workspace.prepare(base, tree, None, force=True,
                          exclude=('.patcher-snapshots', workspace.SCRATCH_DIRNAME))
        _write(tree, rel, text)
        assert workspace.changed_files_against(tree, recorded) == [rel]


def test_a_deleted_file_is_still_reported_as_changed(tmp_path):
    """A unit that removes a file has changed it. Dropping that would merge nothing."""
    tree, snap = _base(tmp_path)
    os.remove(os.path.join(tree, 'models/c.ts'))
    assert workspace.changed_files_against(tree, workspace.base_hashes(snap)) \
        == ['models/c.ts']


def test_an_untouched_tree_reports_nothing(tmp_path):
    tree, snap = _base(tmp_path)
    assert workspace.changed_files_against(tree, workspace.base_hashes(snap)) == []


def test_a_missing_snapshot_is_empty_rather_than_an_error(tmp_path):
    """Unchanged from the pre-split behaviour; the wrapper still owns this check."""
    tree, _snap = _base(tmp_path)
    assert workspace.changed_files(tree, str(tmp_path / 'nope.tar')) == []
