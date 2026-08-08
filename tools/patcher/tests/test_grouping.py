"""Per-file task grouping.

The property that matters is not "fewer tasks" but that no bug is lost and no
bug is duplicated: a unit list that silently drops a finding would show up as a
lower denominator and read as a better score.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import blind_guard  # noqa: E402
import grouping  # noqa: E402


def _bug(bid, path, line, cls='Injection / SQL', code='A03'):
    return {'bug_id': bid, 'location': {'file': path, 'line': line},
            'owasp': [{'code': code}], 'class': cls}


BUGS = [
    _bug('BUG-001', 'routes/a.ts', 10),
    _bug('BUG-002', 'routes/a.ts', 3, cls='Broken Access Control / CSRF', code='A01'),
    _bug('BUG-003', 'routes/a.ts', 50),
    _bug('BUG-004', 'lib/solo.ts', 7, cls='Cryptographic Failures / Weak', code='A02'),
]


def test_bug_granularity_is_untouched():
    assert grouping.group(BUGS, 'bug') == BUGS


def test_unknown_granularity_is_loud():
    try:
        grouping.group(BUGS, 'per-class')
    except ValueError as ex:
        assert 'task_granularity' in str(ex)
    else:
        raise AssertionError('expected ValueError')


def test_every_bug_survives_exactly_once():
    units = grouping.group(BUGS, 'file')
    seen = []
    for u in units:
        seen += u.get('member_bug_ids') or [u['bug_id']]
    assert sorted(seen) == sorted(b['bug_id'] for b in BUGS)
    assert len(seen) == len(set(seen))


def test_one_file_becomes_one_unit():
    units = grouping.group(BUGS, 'file')
    assert len(units) == 2
    assert {u['location']['file'] for u in units} == {'routes/a.ts', 'lib/solo.ts'}


def test_single_bug_file_stays_the_bug_itself():
    """So the two modes remain comparable on every file holding one bug."""
    units = grouping.group(BUGS, 'file')
    solo = [u for u in units if u['location']['file'] == 'lib/solo.ts'][0]
    assert solo['bug_id'] == 'BUG-004'
    assert 'members' not in solo


def test_unit_anchors_on_the_lowest_line():
    units = grouping.group(BUGS, 'file')
    multi = [u for u in units if u.get('members')][0]
    assert multi['location']['line'] == 3
    assert [m['bug_id'] for m in multi['members']] == ['BUG-002', 'BUG-001', 'BUG-003']


def test_unit_id_is_a_safe_identifier():
    """It becomes a scratch directory name and a task record key."""
    import re
    units = grouping.group(BUGS, 'file')
    for u in units:
        assert re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]*$', u['bug_id'])


def test_unit_owasp_is_a_union_capped_at_three():
    many = [_bug(f'BUG-{i:03d}', 'routes/big.ts', i, code=c)
            for i, c in enumerate(['A01', 'A02', 'A03', 'A05', 'A07'], start=1)]
    unit = grouping.group(many, 'file')[0]
    assert len(unit['owasp']) == 3


def test_mixed_class_is_flagged_not_hidden():
    units = grouping.group(BUGS, 'file')
    multi = [u for u in units if u.get('members')][0]
    assert 'other class' in multi['class']


# ---- playbook merging ------------------------------------------------------

PLAYBOOK = {'entries': [
    {'entry_id': 'sqli', 'classes': ['Injection / SQL'], 'guidance': 'parameterise',
     'preserve': ['P1'], 'common_mistakes': ['M1'], 'content_retrieved': True},
    {'entry_id': 'csrf', 'classes': ['Broken Access Control / CSRF'], 'guidance': 'token',
     'preserve': ['P2'], 'common_mistakes': ['M2'], 'content_retrieved': True},
]}


def test_unit_gets_guidance_for_every_class_it_carries():
    """Picking the first member's entry would look complete while being silent
    on the rest -- worse than a thin section."""
    unit = [u for u in grouping.group(BUGS, 'file') if u.get('members')][0]
    entry, how = blind_guard.select_entry(PLAYBOOK, unit)
    assert 'parameterise' in entry['guidance'] and 'token' in entry['guidance']
    # Order follows member order, which is line order: the CSRF bug sits at
    # line 3 and leads. Asserted rather than sorted so a future change to member
    # ordering shows up here instead of silently reshuffling the prompt.
    assert entry['preserve'] == ['P2', 'P1']
    assert entry['common_mistakes'] == ['M2', 'M1']
    assert how.startswith('unit_merge')


def test_repeated_class_in_a_unit_is_not_repeated_guidance():
    same = [_bug('BUG-001', 'routes/a.ts', 1), _bug('BUG-002', 'routes/a.ts', 2)]
    unit = grouping.group(same, 'file')[0]
    entry, how = blind_guard.select_entry(PLAYBOOK, unit)
    assert entry['guidance'].count('parameterise') == 1
    assert how.endswith('+unit')


def test_unit_with_no_matching_entry_reports_no_match():
    unit = grouping.group(
        [_bug('BUG-001', 'routes/a.ts', 1, cls='Nothing Matches', code='A09'),
         _bug('BUG-002', 'routes/a.ts', 2, cls='Also Nothing', code='A09')], 'file')[0]
    entry, how = blind_guard.select_entry(PLAYBOOK, unit)
    assert entry is None and how == 'no_match'
