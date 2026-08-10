"""The subset-4 chunk map must agree with the subset-4 bug report.

The map is what a run executes: it decides which agent owns which file, in what
order, and how many run at once. If it drifts from the bug report -- a line
number that moved, a bug that was added, a file that quietly appears in two
chunks -- the run does the wrong work and the numbers it produces are attributed
to a plan that was never the plan. Every assertion here is against the bug
report, never against a value copied into this file.
"""
import json
import os

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
MAP_PATH = os.path.join(REPO_ROOT, 'tools/patcher/plan/subsets/subset-04.chunk-map.json')
BUG_REPORT_PATH = os.path.join(REPO_ROOT, 'tools/patcher/inputs/subset4/bug-report.json')
CONFIG_PATH = os.path.join(REPO_ROOT, 'tools/patcher/config/subset4.run-config.json')

EXPECTED_BRACKET_ORDER = ['A', 'C', 'D']
EXPECTED_CHUNK_IDS = {'A01', 'C09', 'C11', 'D01'}


def _load(path):
    with open(path) as fh:
        return json.load(fh)


@pytest.fixture(scope='module')
def chunk_map():
    return _load(MAP_PATH)


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


def test_declared_counts_match_the_content(chunk_map, tasks):
    chunks = [c for b in chunk_map['brackets'] for c in b['chunks']]
    assert chunk_map['bug_count'] == len(tasks)
    assert chunk_map['chunk_count'] == len(chunks)


def test_excluded_bugs_is_empty_because_every_bug_is_planned(chunk_map):
    # A bug absent from the report is simply not here; excluded_bugs is for a
    # reported bug that was deliberately left unplanned.
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


def test_chunk_ids_are_the_full_maps_ids(chunk_map):
    ids = [c['chunk_id'] for b in chunk_map['brackets'] for c in b['chunks']]
    assert sorted(ids) == sorted(EXPECTED_CHUNK_IDS), (
        'chunk ids are inherited from the full map so a subset run and a full '
        f'run stay comparable; got {sorted(ids)}')


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


# --------------------------------------------------------------------------
# Boundary lists and the run config
# --------------------------------------------------------------------------

def test_the_denylisted_files_are_never_planned(chunk_map):
    """models/challenge.ts, lib/antiCheat.ts and data/datacreator.ts leak
    challenge keys. A per-file plan hands an owned file's whole content to an
    agent, so one of these appearing in files[] is a blind-boundary breach."""
    denied = set(chunk_map['read_denylist'])
    assert denied == {'models/challenge.ts', 'lib/antiCheat.ts', 'data/datacreator.ts'}
    listed = {p for b in chunk_map['brackets'] for c in b['chunks'] for p in c['files']}
    assert not (listed & denied)


def test_tests_are_never_writable(chunk_map):
    assert 'test/**' in chunk_map['never_writable']
    assert '**/*.spec.ts' in chunk_map['never_writable']


def test_run_config_matches_the_map(chunk_map):
    cfg = _load(CONFIG_PATH)
    peak = max(p['concurrency'] for p in chunk_map['phases'])
    assert cfg['loop']['task_concurrency'] == peak, (
        f'the config asks for {cfg["loop"]["task_concurrency"]} concurrent '
        f'agents; the map peaks at {peak}')
    # waves + file granularity is the only combination run_patcher's preflight
    # accepts for task_concurrency > 1; anything else is silently serialised.
    assert cfg['loop']['execution'] == 'waves'
    assert cfg['loop']['task_granularity'] == 'file'
    assert cfg['loop']['gate_concurrency'] is None
    assert cfg['inputs']['bug_report'] == chunk_map['generated_from']['bug_report']
    assert cfg['target']['base_tree'] == chunk_map['generated_from']['tree']
