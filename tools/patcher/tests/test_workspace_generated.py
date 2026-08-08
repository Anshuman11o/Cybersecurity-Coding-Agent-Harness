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
