"""v3 chunk map: the offline plan, and every way it can lie.

Each rejection below corresponds to a failure that is otherwise SILENT -- it
does not crash the run, it changes the number the run reports. That is the whole
reason validation happens before the first agent is spawned rather than being
discovered in the merge queue.
"""
import copy
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
from v3 import chunk_map  # noqa: E402


def base_map() -> dict:
    """A small but complete map: 2 phases, 3 brackets, 4 chunks, 5 bugs."""
    return {
        'map_id': 'chunk-map/v1',
        'bug_count': 6,
        'chunk_count': 4,
        'excluded_bugs': [{'bug_id': 'BUG-099', 'file': 'models/challenge.ts',
                           'reason': 'read-denylisted file'}],
        'shared_extension_zone': ['views/**', 'config/**', 'swagger.yml'],
        'never_writable': ['test/**', '**/*.spec.ts'],
        'read_denylist': ['models/challenge.ts', 'lib/antiCheat.ts',
                          'data/datacreator.ts'],
        'phases': [{'phase': 0, 'brackets': ['A', 'B'], 'concurrency': 3},
                   {'phase': 1, 'brackets': ['C'], 'concurrency': 1}],
        'brackets': [
            {'bracket': 'A', 'name': 'core', 'phase': 0, 'depends_on': [],
             'concurrency': 2,
             'chunks': [
                 {'chunk_id': 'A01', 'reason': 'crypto helpers',
                  'files': ['lib/insecurity.ts'],
                  'tasks': [{'bug_id': 'BUG-001', 'file': 'lib/insecurity.ts',
                             'line': 10, 'class': 'Crypto'},
                            {'bug_id': 'BUG-002', 'file': 'lib/insecurity.ts',
                             'line': 40, 'class': 'Crypto'}]},
                 {'chunk_id': 'A02', 'reason': 'user model',
                  'files': ['models/user.ts'],
                  'tasks': [{'bug_id': 'BUG-003', 'file': 'models/user.ts',
                             'line': 7, 'class': 'AuthZ'}]}]},
            {'bracket': 'B', 'name': 'frontend', 'phase': 0, 'depends_on': [],
             'concurrency': 1,
             'chunks': [
                 {'chunk_id': 'B01', 'reason': 'search box',
                  'files': ['frontend/src/search.ts'],
                  'tasks': [{'bug_id': 'BUG-004', 'file': 'frontend/src/search.ts',
                             'line': 3, 'class': 'XSS'}]}]},
            {'bracket': 'C', 'name': 'handlers', 'phase': 1, 'depends_on': ['A'],
             'concurrency': 1,
             'chunks': [
                 {'chunk_id': 'C01', 'reason': 'login route',
                  'files': ['routes/login.ts'],
                  'tasks': [{'bug_id': 'BUG-005', 'file': 'routes/login.ts',
                             'line': 22, 'class': 'Injection'}]}]},
        ],
    }


def _bad(doc, fragment):
    with pytest.raises(chunk_map.ChunkMapError) as ex:
        chunk_map.parse(doc)
    assert fragment in str(ex.value), str(ex.value)
    return str(ex.value)


# ---- the happy path --------------------------------------------------------

def test_a_valid_map_parses_and_orders_deterministically():
    m = chunk_map.parse(base_map())
    assert [c.chunk_id for c in m.chunks] == ['A01', 'A02', 'B01', 'C01']
    assert m.phase_order() == [0, 1]
    assert [c.chunk_id for c in m.chunks_in_phase(0)] == ['A01', 'A02', 'B01']
    assert m.bug_ids() == ['BUG-001', 'BUG-002', 'BUG-003', 'BUG-004', 'BUG-005']
    assert m.chunk_of_bug('BUG-004').chunk_id == 'B01'


def test_phase_concurrency_prefers_the_phase_cap_over_the_bracket_cap():
    """The phase cap is the box's limit; the bracket's is the planner's view.
    When both exist the hardware wins."""
    m = chunk_map.parse(base_map())
    assert m.concurrency_for_phase(0) == 3
    doc = base_map()
    doc['phases'][0].pop('concurrency')
    assert chunk_map.parse(doc).concurrency_for_phase(0) == 2   # widest bracket


def test_boundary_for_carries_the_maps_zones_not_the_defaults():
    doc = base_map()
    doc['shared_extension_zone'] = ['views/**']
    b = chunk_map.parse(doc).boundary_for('A01')
    assert b.owned == frozenset({'lib/insecurity.ts'})
    assert b.shared_extension_zone == ('views/**',)
    assert not b.may_read('lib/antiCheat.ts')


def test_load_reads_a_file(tmp_path):
    p = tmp_path / 'map.json'
    p.write_text(json.dumps(base_map()))
    m = chunk_map.load(str(p))
    assert m.map_id == 'chunk-map/v1'
    assert 'phase 0' in m.describe()


# ---- the rejections --------------------------------------------------------

def test_a_bug_in_two_chunks_is_rejected():
    """Two agents fixing one defect in two trees is a conflict at best and a
    double fix at worst, and the denominator stops matching the report."""
    doc = base_map()
    doc['brackets'][2]['chunks'][0]['tasks'].append(
        {'bug_id': 'BUG-001', 'file': 'routes/login.ts', 'line': 30, 'class': 'x'})
    doc['bug_count'] = 7
    _bad(doc, "bug 'BUG-001' appears in both 'A01' and 'C01'")


def test_a_file_in_two_chunks_is_rejected():
    """Single ownership is the ONLY reason chunks may run concurrently without a
    merge protocol."""
    doc = base_map()
    doc['brackets'][2]['chunks'][0]['files'].append('lib/insecurity.ts')
    doc['brackets'][2]['chunks'][0]['tasks'].append(
        {'bug_id': 'BUG-006', 'file': 'lib/insecurity.ts', 'line': 60, 'class': 'x'})
    doc['bug_count'] = 7
    _bad(doc, "file 'lib/insecurity.ts' is owned by both")


def test_a_task_on_a_file_the_chunk_does_not_own_is_rejected():
    doc = base_map()
    doc['brackets'][0]['chunks'][1]['tasks'][0]['file'] = 'models/other.ts'
    _bad(doc, 'does not own that file')


def test_a_file_carrying_no_task_is_rejected():
    """One chunk per file means the whole file is read into a prompt. A file with
    no bug in it is pure prompt cost and pure read surface."""
    doc = base_map()
    doc['brackets'][0]['chunks'][1]['files'].append('models/quiet.ts')
    _bad(doc, 'no task targets it')


def test_a_read_denylisted_file_may_not_be_assigned():
    """The v2 per-file lane selector never applied the denylist and put a file
    that is 114 lines of literal challenge keys into a prompt. Two runs' worth
    of blindness. This is that guard, wired in."""
    doc = base_map()
    doc['brackets'][0]['chunks'][1]['files'].append('models/challenge.ts')
    doc['brackets'][0]['chunks'][1]['tasks'].append(
        {'bug_id': 'BUG-006', 'file': 'models/challenge.ts', 'line': 1, 'class': 'x'})
    doc['bug_count'] = 7
    _bad(doc, 'read-denylisted')


def test_a_never_writable_file_may_not_be_assigned():
    doc = base_map()
    doc['brackets'][1]['chunks'][0]['files'].append('frontend/src/a.spec.ts')
    doc['brackets'][1]['chunks'][0]['tasks'].append(
        {'bug_id': 'BUG-006', 'file': 'frontend/src/a.spec.ts', 'line': 1, 'class': 'x'})
    doc['bug_count'] = 7
    _bad(doc, 'never-writable')


def test_a_dependency_inside_the_same_phase_is_rejected():
    """Brackets in one phase run concurrently, so a depends_on edge between two
    of them is a claim the schedule does not honour."""
    doc = base_map()
    doc['brackets'][1]['depends_on'] = ['A']
    _bad(doc, 'STRICTLY')


def test_a_bracket_in_no_phase_is_rejected():
    doc = base_map()
    doc['phases'][1]['brackets'] = []
    _bad(doc, 'lists no brackets')


def test_a_bracket_whose_phase_disagrees_with_the_phase_list_is_rejected():
    doc = base_map()
    doc['brackets'][2]['phase'] = 0
    _bad(doc, 'but the phase list puts it in phase')


def test_bug_count_that_does_not_add_up_is_rejected():
    """An unaccounted bug lowers the denominator and reads as a BETTER score."""
    doc = base_map()
    doc['bug_count'] = 40
    _bad(doc, 'bug_count says 40')


def test_an_excluded_bug_that_is_also_assigned_is_rejected():
    doc = base_map()
    doc['excluded_bugs'].append({'bug_id': 'BUG-003', 'file': 'models/user.ts',
                                 'reason': 'nope'})
    doc['bug_count'] = 7
    _bad(doc, 'both excluded and assigned')


def test_an_exclusion_without_a_reason_is_rejected():
    doc = base_map()
    doc['excluded_bugs'][0].pop('reason')
    _bad(doc, 'has no reason')


def test_an_empty_chunk_is_rejected():
    doc = base_map()
    doc['brackets'][1]['chunks'][0]['tasks'] = []
    doc['brackets'][1]['chunks'][0]['files'] = []
    doc['bug_count'] = 5
    _bad(doc, 'has no tasks')


def test_a_wrong_map_id_is_rejected():
    doc = base_map()
    doc['map_id'] = 'chunk-map/v2'
    _bad(doc, 'map_id must be')


def test_errors_are_reported_together_not_one_at_a_time():
    """A map is loaded once, before anything is spent. There is no reason to be
    economical about the error."""
    doc = base_map()
    doc['brackets'][2]['chunks'][0]['files'].append('lib/insecurity.ts')
    doc['brackets'][2]['chunks'][0]['tasks'].append(
        {'bug_id': 'BUG-001', 'file': 'lib/insecurity.ts', 'line': 60, 'class': 'x'})
    msg = _bad(doc, 'invalid chunk map')
    assert 'is owned by both' in msg and 'appears in both' in msg


# ---- against the report ----------------------------------------------------

REPORT = [{'bug_id': f'BUG-00{i}', 'location': {'file': f, 'line': 1}}
          for i, f in [(1, 'lib/insecurity.ts'), (2, 'lib/insecurity.ts'),
                       (3, 'models/user.ts'), (4, 'frontend/src/search.ts'),
                       (5, 'routes/login.ts')]]


def test_report_cross_check_accepts_a_matching_report():
    m = chunk_map.parse(base_map())
    report = copy.deepcopy(REPORT) + [
        {'bug_id': 'BUG-099', 'location': {'file': 'models/challenge.ts', 'line': 1}}]
    chunk_map.validate_against_report(m, report)


def test_report_cross_check_catches_a_bug_the_map_never_scheduled():
    m = chunk_map.parse(base_map())
    report = copy.deepcopy(REPORT) + [
        {'bug_id': 'BUG-099', 'location': {'file': 'models/challenge.ts', 'line': 1}},
        {'bug_id': 'BUG-500', 'location': {'file': 'routes/other.ts', 'line': 1}}]
    with pytest.raises(chunk_map.ChunkMapError) as ex:
        chunk_map.validate_against_report(m, report)
    assert 'neither assigned nor excluded' in str(ex.value)


def test_report_cross_check_catches_a_file_the_map_and_report_disagree_on():
    m = chunk_map.parse(base_map())
    report = copy.deepcopy(REPORT) + [
        {'bug_id': 'BUG-099', 'location': {'file': 'models/challenge.ts', 'line': 1}}]
    report[4]['location']['file'] = 'routes/elsewhere.ts'
    with pytest.raises(chunk_map.ChunkMapError) as ex:
        chunk_map.validate_against_report(m, report)
    assert 'but the report says' in str(ex.value)
