"""The subset-2 chunk map must agree with the subset-2 bug report, with the
generated map it is derived from, and with the v3 loader that will run it.

Three things this pins that the subset-4 test does not, because subset 2 is the
first map intended for v3 rather than for `run_patcher.py`'s wave mode:

  * `src/v3/chunk_map.py` is the code that actually reads this file before a run
    spends anything. A map that passes every assertion here and is then refused
    by the loader is a map nobody can run, so the loader is exercised directly.
  * The map is a mechanical subset form of `plan/chunk-map.json`, which
    `build_chunk_map.py` owns and `test_chunk_map.py` pins byte-for-byte to a
    fresh generation. Every id, file, line, class and reason here must still be
    that generator's -- a value that drifted would send an agent to a location
    the tool that owns the plan never chose.
  * Bracket B is dropped because this report puts no bug in it. The drop must be
    recorded rather than merely performed: an absent bracket and a bracket that
    was silently lost look identical in the artefact.

Every assertion is against the bug report, the generated map or the loader,
never against a value copied into this file.
"""
import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
MAP_PATH = os.path.join(REPO_ROOT, 'tools/patcher/plan/subsets/subset-02.chunk-map.json')
FULL_MAP_PATH = os.path.join(REPO_ROOT, 'tools/patcher/plan/chunk-map.json')
BUG_REPORT_PATH = os.path.join(REPO_ROOT, 'tools/patcher/inputs/bug-report.json')

sys.path.insert(0, os.path.join(REPO_ROOT, 'tools/patcher'))

EXPECTED_BRACKET_ORDER = ['A', 'C', 'D']


def _load(path):
    with open(path) as fh:
        return json.load(fh)


@pytest.fixture(scope='module')
def chunk_map():
    return _load(MAP_PATH)


@pytest.fixture(scope='module')
def full_map():
    return _load(FULL_MAP_PATH)


@pytest.fixture(scope='module')
def bug_report():
    return _load(BUG_REPORT_PATH)


@pytest.fixture(scope='module')
def tasks(chunk_map):
    """Every task in the map, with the chunk and bracket that owns it."""
    out = []
    for bracket in chunk_map['brackets']:
        for chunk in bracket['chunks']:
            for task in chunk['tasks']:
                out.append((bracket['bracket'], chunk['chunk_id'], task))
    return out


# --------------------------------------------------------------------------
# Coverage: exactly the bugs in the report, no more and no fewer
# --------------------------------------------------------------------------

def test_map_covers_exactly_the_reported_bugs(tasks, bug_report):
    planned = sorted(t['bug_id'] for _, _, t in tasks)
    reported = sorted(b['bug_id'] for b in bug_report['bugs'])
    assert planned == reported, (
        'the map and the bug report disagree about which bugs are being fixed:\n'
        f'  only in map:    {sorted(set(planned) - set(reported))}\n'
        f'  only in report: {sorted(set(reported) - set(planned))}')


def test_no_bug_is_planned_twice(tasks):
    planned = [t['bug_id'] for _, _, t in tasks]
    dupes = sorted({b for b in planned if planned.count(b) > 1})
    assert not dupes, f'bug(s) assigned to more than one task: {dupes}'


def test_declared_counts_match_the_content(chunk_map, tasks, bug_report):
    chunks = [c for b in chunk_map['brackets'] for c in b['chunks']]
    assert chunk_map['bug_count'] == len(tasks)
    assert chunk_map['bug_count'] == bug_report['bug_count']
    assert chunk_map['chunk_count'] == len(chunks)


def test_excluded_bugs_is_empty_because_every_bug_is_planned(chunk_map):
    # A bug absent from the report is simply not here; excluded_bugs is for a
    # reported bug that was deliberately left unplanned, and an unexplained
    # exclusion silently lowers the denominator.
    assert chunk_map['excluded_bugs'] == []


# --------------------------------------------------------------------------
# Fidelity: file, line and class come from the report
# --------------------------------------------------------------------------

def test_every_task_location_matches_the_bug_report(tasks, bug_report):
    by_id = {b['bug_id']: b for b in bug_report['bugs']}
    for _, chunk_id, task in tasks:
        bug = by_id[task['bug_id']]
        assert task['file'] == bug['location']['file'], (
            f"{chunk_id}/{task['bug_id']}: map says {task['file']}, "
            f"report says {bug['location']['file']}")
        assert task['line'] == bug['location']['line'], (
            f"{chunk_id}/{task['bug_id']}: map says line {task['line']}, "
            f"report says line {bug['location']['line']}")
        assert task['class'] == bug['class'], (
            f"{chunk_id}/{task['bug_id']}: map says class {task['class']!r}, "
            f"report says {bug['class']!r}")


def test_map_names_the_bug_report_it_was_generated_from(chunk_map, bug_report):
    src = chunk_map['generated_from']
    assert src['bug_report_id'] == bug_report['report_id']
    assert os.path.isfile(os.path.join(REPO_ROOT, src['bug_report']))
    assert src['tree'] == bug_report['target_dir']


# --------------------------------------------------------------------------
# Derivation: the generator owns every value here
# --------------------------------------------------------------------------

def test_the_map_names_what_it_was_derived_from(chunk_map):
    src = chunk_map['derived_from']
    assert os.path.isfile(os.path.join(REPO_ROOT, src['full_map']))
    assert os.path.isfile(os.path.join(REPO_ROOT, src['generator']))
    assert src['transform'].strip()


def test_chunks_are_the_generated_maps_chunks_unchanged(chunk_map, full_map):
    """Ids, files, tasks and reasons are the generator's.

    A chunk id names a set of files and its place in the merge order, not a
    workload. Renumbering would make this read as its own plan and every later
    comparison would silently be against different chunks.
    """
    def by_id(doc):
        return {c['chunk_id']: c
                for b in doc['brackets'] for c in b['chunks']}

    subset, full = by_id(chunk_map), by_id(full_map)
    assert set(subset) == set(full), (
        'subset 2 and the generated map are built from the same bug report, so '
        'they hold the same chunks:\n'
        f'  only in subset map: {sorted(set(subset) - set(full))}\n'
        f'  only in full map:   {sorted(set(full) - set(subset))}')
    for cid, chunk in subset.items():
        assert chunk == full[cid], f'chunk {cid} differs from the generated map'


def test_dropped_brackets_are_recorded_and_really_are_empty(chunk_map, full_map):
    kept = {b['bracket'] for b in chunk_map['brackets']}
    recorded = {d['bracket'] for d in chunk_map['derived_from']['dropped_brackets']}
    empty = {b['bracket'] for b in full_map['brackets'] if not b['chunks']}
    assert kept | recorded == {b['bracket'] for b in full_map['brackets']}, (
        'every bracket of the generated map is either kept or recorded as dropped')
    assert recorded == empty, (
        f'only empty brackets may be dropped; recorded {sorted(recorded)}, '
        f'empty {sorted(empty)}')
    for d in chunk_map['derived_from']['dropped_brackets']:
        assert d.get('reason'), f'bracket {d["bracket"]} dropped without a reason'


# --------------------------------------------------------------------------
# File ownership: one chunk per file, and only files that carry a bug
# --------------------------------------------------------------------------

def test_no_file_is_owned_by_two_chunks(chunk_map):
    owner = {}
    for bracket in chunk_map['brackets']:
        for chunk in bracket['chunks']:
            for path in chunk['files']:
                assert path not in owner, (
                    f'{path} is owned by both {owner[path]} and '
                    f"{chunk['chunk_id']}; two agents would hold the same file")
                owner[path] = chunk['chunk_id']


def test_no_file_without_a_bug_appears_in_the_map(chunk_map, bug_report):
    with_bugs = {b['location']['file'] for b in bug_report['bugs']}
    listed = {p for br in chunk_map['brackets']
              for c in br['chunks'] for p in c['files']}
    assert listed == with_bugs, (
        'files[] must list exactly the files that carry a confirmed bug:\n'
        f'  listed without a bug: {sorted(listed - with_bugs)}\n'
        f'  carries a bug but unlisted: {sorted(with_bugs - listed)}')


def test_every_task_sits_in_a_chunk_that_owns_its_file(chunk_map):
    for bracket in chunk_map['brackets']:
        for chunk in bracket['chunks']:
            for task in chunk['tasks']:
                assert task['file'] in chunk['files'], (
                    f"{chunk['chunk_id']} holds {task['bug_id']} in "
                    f"{task['file']}, which it does not own")


# --------------------------------------------------------------------------
# Order and concurrency
# --------------------------------------------------------------------------

def test_bracket_order_is_core_then_handlers_then_wiring(chunk_map):
    assert [b['bracket'] for b in chunk_map['brackets']] == EXPECTED_BRACKET_ORDER


def test_phases_are_dense_and_ascending_in_bracket_order(chunk_map):
    phases = [b['phase'] for b in chunk_map['brackets']]
    assert phases == list(range(len(phases))), (
        f'phases must be dense and in bracket order, got {phases}')
    declared = [p['phase'] for p in chunk_map['phases']]
    assert declared == phases


def test_a_bracket_depends_only_on_earlier_brackets(chunk_map):
    seen = []
    for bracket in chunk_map['brackets']:
        for dep in bracket['depends_on']:
            assert dep in seen, (
                f"bracket {bracket['bracket']} depends on {dep}, which does not "
                'run before it')
        seen.append(bracket['bracket'])


def test_no_dependency_survives_on_a_dropped_bracket(chunk_map):
    """Dropping bracket B must drop the edges pointing at it.

    A depends_on naming a bracket that is not in the map is a claim the schedule
    cannot honour, and `chunk_map.validate()` refuses the map for it -- so this
    would be found at load time. It is asserted here because it is found for
    free, before anyone has built a tree.
    """
    known = {b['bracket'] for b in chunk_map['brackets']}
    for bracket in chunk_map['brackets']:
        unknown = [d for d in bracket['depends_on'] if d not in known]
        assert not unknown, (
            f"bracket {bracket['bracket']} depends on {unknown}, which this map "
            'does not contain')


def test_phase_concurrency_equals_that_phases_chunk_count(chunk_map):
    by_bracket = {b['bracket']: b for b in chunk_map['brackets']}
    for phase in chunk_map['phases']:
        chunks = sum(len(by_bracket[name]['chunks']) for name in phase['brackets'])
        assert phase['concurrency'] == chunks, (
            f"phase {phase['phase']} declares concurrency "
            f"{phase['concurrency']} but holds {chunks} chunk(s)")
        for name in phase['brackets']:
            assert by_bracket[name]['concurrency'] == phase['concurrency']
            assert by_bracket[name]['phase'] == phase['phase']


def test_every_bracket_appears_in_exactly_one_phase(chunk_map):
    listed = [name for p in chunk_map['phases'] for name in p['brackets']]
    assert sorted(listed) == sorted(b['bracket'] for b in chunk_map['brackets'])


def test_tasks_are_ordered_by_file_then_line_then_bug_id(chunk_map):
    """The order a chunk agent works through its bugs is part of the plan.

    Two findings on one line are common in this subset, so without the bug_id
    tiebreak the order would be inherited from the order the input happened to
    list them in, which is not part of the input's meaning.
    """
    for bracket in chunk_map['brackets']:
        for chunk in bracket['chunks']:
            keys = [(t['file'], t['line'], t['bug_id']) for t in chunk['tasks']]
            assert keys == sorted(keys), (
                f"{chunk['chunk_id']} task order is not (file, line, bug_id)")


# --------------------------------------------------------------------------
# Boundary lists
# --------------------------------------------------------------------------

def test_the_denylisted_files_are_never_planned(chunk_map):
    """The three seed files leak challenge keys.

    v3 hands a chunk agent its owned files, so one of these in files[] is a
    blind-boundary breach -- the v2 per-file lane failure that cost two runs
    their blindness, in a new place.
    """
    denied = set(chunk_map['read_denylist'])
    assert denied == {'models/challenge.ts', 'lib/antiCheat.ts', 'data/datacreator.ts'}
    listed = {p for b in chunk_map['brackets'] for c in b['chunks'] for p in c['files']}
    assert not (listed & denied)


def test_boundary_lists_are_copied_verbatim_from_the_generated_map(chunk_map, full_map):
    """They are properties of the target tree and of the blind boundary, not of
    the slice, so they do not shrink because the subset is smaller."""
    for key in ('shared_extension_zone', 'never_writable', 'read_denylist'):
        assert chunk_map[key] == full_map[key], f'{key} drifted from the generated map'


def test_tests_are_never_writable(chunk_map):
    assert 'test/**' in chunk_map['never_writable']
    assert '**/*.spec.ts' in chunk_map['never_writable']


# --------------------------------------------------------------------------
# The v3 loader is the code that actually reads this before a run
# --------------------------------------------------------------------------

def test_the_v3_loader_accepts_the_map_and_pins_it_to_the_report(bug_report):
    from src.v3 import chunk_map as v3_chunk_map

    cmap = v3_chunk_map.load(MAP_PATH)
    v3_chunk_map.validate_against_report(cmap, bug_report['bugs'])
    assert cmap.map_id == 'chunk-map/v1'
    assert len(cmap.bug_ids()) == bug_report['bug_count']


def test_the_v3_loader_agrees_with_the_declared_schedule(chunk_map):
    from src.v3 import chunk_map as v3_chunk_map

    cmap = v3_chunk_map.load(MAP_PATH)
    assert cmap.phase_order() == [p['phase'] for p in chunk_map['phases']]
    for phase in chunk_map['phases']:
        n = phase['phase']
        assert cmap.concurrency_for_phase(n) == phase['concurrency']
        assert [c.chunk_id for c in cmap.chunks_in_phase(n)] == sorted(
            c['chunk_id'] for b in chunk_map['brackets']
            if b['bracket'] in phase['brackets'] for c in b['chunks'])


def test_every_chunks_write_boundary_resolves(chunk_map):
    """The boundary is what the agent is handed and the merge queue judges by.

    Resolving it here means a boundary that cannot be built is found now rather
    than after a tree has been seeded.
    """
    from src.v3 import boundary as v3_boundary
    from src.v3 import chunk_map as v3_chunk_map

    cmap = v3_chunk_map.load(MAP_PATH)
    for chunk in cmap.chunks:
        b = cmap.boundary_for(chunk.chunk_id)
        for path in chunk.files:
            assert b.classify(path) == v3_boundary.OWNED
        assert b.classify('test/api/login.spec.ts') == v3_boundary.NEVER_WRITABLE
        assert b.classify('views/login.pug') == v3_boundary.SHARED_EXTENSION
