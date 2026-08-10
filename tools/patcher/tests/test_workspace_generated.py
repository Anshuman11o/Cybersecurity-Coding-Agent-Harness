"""Generated-artifact filtering in the deliverable diff.

The target application writes i18n/*.json and ftp/legal.md when it runs; its own
.gitignore declares them build output. Before this filter, one task's diff was
4,000,043 bytes of generated locale JSON, hit the truncation cap, and contained
none of the actual patch -- and that diff is fed back into the reconcile prompt.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import workspace  # noqa: E402


def test_root_generated_paths_are_filtered():
    assert workspace._is_generated('i18n/ar_SA.json')
    assert workspace._is_generated('ftp/legal.md')


def test_tracked_source_sharing_those_names_is_kept():
    # Same basenames, different path. Excluding by basename would hide a real
    # frontend change, which is why the filter is path-anchored.
    assert not workspace._is_generated('frontend/src/assets/i18n/ar_SA.json')
    assert not workspace._is_generated('data/static/i18n/en.json')
    assert not workspace._is_generated('models/feedback.ts')


def test_generated_section_dropped_real_section_kept():
    a, b = '/tmp/base', '/tmp/work'
    text = (
        f'diff -ruN {a}/i18n/ar_SA.json {b}/i18n/ar_SA.json\n'
        f'--- {a}/i18n/ar_SA.json\n'
        f'+++ {b}/i18n/ar_SA.json\n'
        '+{"noise": true}\n'
        f'diff -ruN {a}/models/feedback.ts {b}/models/feedback.ts\n'
        f'--- {a}/models/feedback.ts\n'
        f'+++ {b}/models/feedback.ts\n'
        '+const real = 1\n'
    )
    out = workspace._drop_generated(text, (a, b))
    assert 'ar_SA' not in out
    assert 'const real = 1' in out


def test_only_in_lines_for_generated_paths_are_dropped():
    a, b = '/tmp/base', '/tmp/work'
    text = (f'Only in {b}/i18n: bg_BG.json\n'
            f'Only in {b}/routes: newFile.ts\n')
    out = workspace._drop_generated(text, (a, b))
    assert 'bg_BG' not in out
    assert 'newFile.ts' in out


# ---- snapshot diff symmetry -------------------------------------------------

def test_non_source_files_are_not_reported_as_added(tmp_path):
    """A snapshot holds source only, so diffing it against the whole tree reports
    every other file as new. Measured on a real run: a 2-file change reported as
    76 files and +3092 lines, in the blast-radius number itself."""
    tree = str(tmp_path / 'app')
    os.makedirs(os.path.join(tree, '.ai/skills'), exist_ok=True)
    os.makedirs(os.path.join(tree, '.well-known'), exist_ok=True)
    with open(os.path.join(tree, 'lib.ts'), 'w') as fh:
        fh.write('export const a = 1\n')
    for rel in ('.ai/skills/SKILL.md', '.well-known/security.txt', 'README.md',
                'contract.sol', '.gitattributes'):
        with open(os.path.join(tree, rel), 'w') as fh:
            fh.write('not source, not in the snapshot\n')

    snap = workspace.snapshot(tree, 'base')
    with open(os.path.join(tree, 'lib.ts'), 'w') as fh:
        fh.write('export const a = 2\n')

    diff = workspace.diff_against_snapshot(tree, snap)
    stats = workspace.diff_stats(diff)
    assert stats['files_touched'] == ['lib.ts'], stats['files_touched']
    assert (stats['lines_added'], stats['lines_removed']) == (1, 1)
    for name in ('SKILL.md', 'security.txt', 'README.md', 'contract.sol'):
        assert name not in diff


def test_a_new_source_file_still_shows_as_added(tmp_path):
    """Reducing both sides must not hide real work."""
    tree = str(tmp_path / 'app')
    os.makedirs(tree, exist_ok=True)
    with open(os.path.join(tree, 'a.ts'), 'w') as fh:
        fh.write('x\n')
    snap = workspace.snapshot(tree, 'base')
    with open(os.path.join(tree, 'helper.ts'), 'w') as fh:
        fh.write('export const h = 1\n')
    stats = workspace.diff_stats(workspace.diff_against_snapshot(tree, snap))
    assert 'helper.ts' in stats['files_touched']


def test_diff_paths_are_tree_relative(tmp_path):
    """They are read by a human and counted by diff_stats; temp-dir absolutes are
    neither."""
    tree = str(tmp_path / 'app')
    os.makedirs(os.path.join(tree, 'lib'), exist_ok=True)
    with open(os.path.join(tree, 'lib/x.ts'), 'w') as fh:
        fh.write('1\n')
    snap = workspace.snapshot(tree, 'base')
    with open(os.path.join(tree, 'lib/x.ts'), 'w') as fh:
        fh.write('2\n')
    diff = workspace.diff_against_snapshot(tree, snap)
    assert '/tmp/' not in diff
    assert workspace.diff_stats(diff)['files_touched'] == ['lib/x.ts']
