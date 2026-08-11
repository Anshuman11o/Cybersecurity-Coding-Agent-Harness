"""The subset-5 chunk map must agree with the subset-5 bug report, with the
generated map it was filtered from, with the subset-5 playbook, and with the v3
loader that will run it.

Subset 5 is the A05 / Security Misconfiguration family: ten bugs across three
files. It is a *filter* of the 24-bug master report, so its map is a filter of
`plan/chunk-map.json` -- the artefact `build_chunk_map.py` owns and
`test_chunk_map.py` pins byte-for-byte to a fresh generation. Every chunk id,
file, line and class here is therefore the generator's; nothing was typed.

What this pins, and why each one is a silent failure if it drifts:

  * The map is what a run executes. A line number that moved, a bug that was
    added, a file that quietly appears in two chunks -- the run does the wrong
    work and the numbers are attributed to a plan that was never the plan.
  * Brackets A and B hold no subset-5 bug and are dropped. The drop must be
    *recorded*, not merely performed: an absent bracket and a bracket that was
    silently lost look identical in the artefact.
  * `src/v3/chunk_map.py` is the code that actually reads this file before a run
    spends anything. A map that passes every assertion here and is then refused
    by the loader is a map nobody can run, and the refusal would arrive after a
    tree had been seeded.
  * A bug whose class no entry of the playbook names would run on the general
    guidance alone. That is a quietly weaker treatment for that bug, and it
    would show up later as a reasoning result.

Every assertion is against the bug report, the generated map, the playbook or
the loader -- never against a value copied into this file.
"""
import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
MAP_PATH = os.path.join(REPO_ROOT, 'tools/patcher/plan/subsets/subset-05.chunk-map.json')
FULL_MAP_PATH = os.path.join(REPO_ROOT, 'tools/patcher/plan/chunk-map.json')
BUG_REPORT_PATH = os.path.join(REPO_ROOT, 'tools/patcher/inputs/subset5/bug-report.json')
PLAYBOOK_PATH = os.path.join(REPO_ROOT, 'tools/patcher/inputs/subset5/playbook.json')
MASTER_REPORT_PATH = os.path.join(REPO_ROOT, 'tools/patcher/inputs/bug-report.json')
MASTER_PLAYBOOK_PATH = os.path.join(REPO_ROOT, 'tools/patcher/inputs/playbook.json')
CONFIG_PATH = os.path.join(REPO_ROOT, 'tools/patcher/config/subset5.run-config.json')

sys.path.insert(0, os.path.join(REPO_ROOT, 'tools/patcher'))

EXPECTED_BRACKET_ORDER = ['C', 'D']
EXPECTED_CHUNK_IDS = {'C01', 'C02', 'D01'}
SUBSET_BUG_IDS = ['BUG-039', 'BUG-040', 'BUG-041', 'BUG-042', 'BUG-043',
                  'BUG-062', 'BUG-091', 'BUG-092', 'BUG-093', 'BUG-098']


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
def playbook():
    return _load(PLAYBOOK_PATH)


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
# Coverage: exactly the ten bugs of the subset, no more and no fewer
# --------------------------------------------------------------------------

def test_the_report_is_the_agreed_ten_bugs(bug_report):
    assert sorted(b['bug_id'] for b in bug_report['bugs']) == sorted(SUBSET_BUG_IDS)
    assert bug_report['bug_count'] == len(bug_report['bugs']) == 10


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
# Fidelity: the report is a verbatim filter of the master report
# --------------------------------------------------------------------------

def test_every_bug_is_the_master_reports_entry_unchanged(bug_report):
    """A hand-retyped entry is a location nobody verified.

    The entry shape was narrowed deliberately (bug_id, location, owasp, class,
    playbook_ref); a reintroduced prose field here would also be a field no
    scorer reads.
    """
    master = {b['bug_id']: b for b in _load(MASTER_REPORT_PATH)['bugs']}
    for bug in bug_report['bugs']:
        assert bug == master[bug['bug_id']], (
            f"{bug['bug_id']} differs from the master report entry")


def test_scoped_files_are_sorted_and_carry_a_bug(bug_report):
    with_bugs = {b['location']['file'] for b in bug_report['bugs']}
    assert bug_report['scoped_files'] == sorted(with_bugs)


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
# Derivation: the generator still owns every value here
# --------------------------------------------------------------------------

def test_the_map_names_what_it_was_derived_from(chunk_map):
    src = chunk_map['derived_from']
    assert os.path.isfile(os.path.join(REPO_ROOT, src['full_map']))
    assert os.path.isfile(os.path.join(REPO_ROOT, src['generator']))
    assert src['transform'].strip()


def test_chunk_ids_are_the_full_maps_ids(chunk_map, full_map):
    """A chunk id names a set of files and its place in the merge order, not a
    workload. Renumbering would make this read as its own plan and every later
    comparison would silently be against different chunks."""
    ids = [c['chunk_id'] for b in chunk_map['brackets'] for c in b['chunks']]
    assert sorted(ids) == sorted(EXPECTED_CHUNK_IDS), (
        f'chunk ids are inherited from the full map; got {sorted(ids)}')
    full_ids = {c['chunk_id'] for b in full_map['brackets'] for c in b['chunks']}
    assert set(ids) <= full_ids, (
        f'chunk id(s) {sorted(set(ids) - full_ids)} exist in no full map')


def test_each_chunk_is_the_full_maps_chunk_filtered_to_this_subset(chunk_map, full_map,
                                                                  bug_report):
    """Task lists are filtered, not rebuilt, and files[] keeps only the files
    that still carry a bug (subsets/README rules 2 and 4)."""
    keep = {b['bug_id'] for b in bug_report['bugs']}
    full = {c['chunk_id']: c for b in full_map['brackets'] for c in b['chunks']}
    for bracket in chunk_map['brackets']:
        for chunk in bracket['chunks']:
            source = full[chunk['chunk_id']]
            expected_tasks = [t for t in source['tasks'] if t['bug_id'] in keep]
            assert chunk['tasks'] == expected_tasks, (
                f"{chunk['chunk_id']} tasks are not the full map's list filtered "
                'to this subset')
            assert chunk['files'] == sorted({t['file'] for t in expected_tasks}), (
                f"{chunk['chunk_id']} files[] is not exactly the surviving "
                "tasks' files")
            assert set(chunk['files']) <= set(source['files'])


def test_dropped_brackets_are_recorded_and_really_carry_no_subset_bug(
        chunk_map, full_map, bug_report):
    keep = {b['bug_id'] for b in bug_report['bugs']}
    kept = {b['bracket'] for b in chunk_map['brackets']}
    recorded = {d['bracket'] for d in chunk_map['derived_from']['dropped_brackets']}
    assert kept | recorded == {b['bracket'] for b in full_map['brackets']}, (
        'every bracket of the generated map is either kept or recorded as dropped')
    assert not (kept & recorded)
    for bracket in full_map['brackets']:
        planned = {t['bug_id'] for c in bracket['chunks'] for t in c['tasks']}
        if bracket['bracket'] in recorded:
            assert not (planned & keep), (
                f"bracket {bracket['bracket']} was dropped but carries subset-5 "
                f'bug(s) {sorted(planned & keep)}')
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

def test_bracket_order_is_handlers_then_wiring(chunk_map):
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
    """Dropping A and B must drop the edges pointing at them.

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

    Five of this subset's ten findings sit on one line of one file, so without
    the bug_id tiebreak the order would be inherited from the order the input
    happened to list them in, which is not part of the input's meaning.
    """
    for bracket in chunk_map['brackets']:
        for chunk in bracket['chunks']:
            keys = [(t['file'], t['line'], t['bug_id']) for t in chunk['tasks']]
            assert keys == sorted(keys), (
                f"{chunk['chunk_id']} task order is not (file, line, bug_id)")


# --------------------------------------------------------------------------
# Boundary lists and the blind-development boundary
# --------------------------------------------------------------------------

def test_the_denylisted_files_are_never_planned(chunk_map):
    """models/challenge.ts, lib/antiCheat.ts and data/datacreator.ts leak
    challenge keys. A chunk agent is handed its owned files, so one of these in
    files[] is a blind-boundary breach -- the v2 per-file lane failure that cost
    two runs their blindness, in a new place."""
    denied = set(chunk_map['read_denylist'])
    assert denied == {'models/challenge.ts', 'lib/antiCheat.ts', 'data/datacreator.ts'}
    listed = {p for b in chunk_map['brackets'] for c in b['chunks'] for p in c['files']}
    assert not (listed & denied)
    planned = {t['file'] for b in chunk_map['brackets']
               for c in b['chunks'] for t in c['tasks']}
    assert not (planned & denied)


def test_boundary_lists_are_copied_verbatim_from_the_generated_map(chunk_map, full_map):
    """They are properties of the target tree and of the blind boundary, not of
    the slice, so they do not shrink because the subset is smaller."""
    for key in ('shared_extension_zone', 'never_writable', 'read_denylist'):
        assert chunk_map[key] == full_map[key], f'{key} drifted from the generated map'


def test_tests_are_never_writable(chunk_map):
    assert 'test/**' in chunk_map['never_writable']
    assert '**/*.spec.ts' in chunk_map['never_writable']


# --------------------------------------------------------------------------
# The playbook: no bug runs on general guidance alone
# --------------------------------------------------------------------------

def test_playbook_is_a_verbatim_filter_of_the_master(playbook):
    master = _load(MASTER_PLAYBOOK_PATH)
    by_id = {e['entry_id']: e for e in master['entries']}
    assert playbook['playbook_id'] == 'playbook-subset-05'
    assert playbook['general_guidance'] == master['general_guidance']
    assert playbook['source'] == master['source']
    for entry in playbook['entries']:
        assert entry == by_id[entry['entry_id']], (
            f"playbook entry {entry['entry_id']} differs from the master entry")


def test_every_bugs_playbook_ref_resolves(bug_report, playbook):
    have = {e['entry_id'] for e in playbook['entries']}
    for bug in bug_report['bugs']:
        assert bug['playbook_ref'] in have, (
            f"{bug['bug_id']} references playbook entry "
            f"{bug['playbook_ref']!r}, which this playbook does not carry")


def test_every_bug_class_is_named_by_some_entry(bug_report, playbook):
    """A class no entry names falls back to the general guidance, which is a
    quietly weaker treatment for that bug."""
    covered = {c for e in playbook['entries'] for c in e['classes']}
    missing = sorted({b['class'] for b in bug_report['bugs']} - covered)
    assert not missing, f'no playbook entry names class(es): {missing}'


def test_the_entry_a_bug_points_at_also_names_its_class(bug_report, playbook):
    by_id = {e['entry_id']: e for e in playbook['entries']}
    for bug in bug_report['bugs']:
        entry = by_id[bug['playbook_ref']]
        assert bug['class'] in entry['classes'], (
            f"{bug['bug_id']} points at {entry['entry_id']!r} but that entry "
            f"does not name its class {bug['class']!r}")


def test_no_playbook_entry_is_unreferenced(bug_report, playbook):
    """An entry no bug reaches is prompt cost and nothing else."""
    used = {b['playbook_ref'] for b in bug_report['bugs']}
    carried = {e['entry_id'] for e in playbook['entries']}
    assert carried == used, f'unreferenced playbook entries: {sorted(carried - used)}'


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


# --------------------------------------------------------------------------
# The run config, once it exists
# --------------------------------------------------------------------------

@pytest.mark.skipif(not os.path.isfile(CONFIG_PATH),
                    reason='subset-5 run config is authored separately')
def test_run_config_matches_the_map(chunk_map):
    cfg = _load(CONFIG_PATH)
    peak = max(p['concurrency'] for p in chunk_map['phases'])
    assert cfg['loop']['task_concurrency'] == peak, (
        f'the config asks for {cfg["loop"]["task_concurrency"]} concurrent '
        f'agents; the map peaks at {peak}')
    assert cfg['inputs']['bug_report'] == chunk_map['generated_from']['bug_report']
    # Same target app, not necessarily the same path: the map is generated from
    # the in-repo checkout, a run needs a BUILT tree outside it.
    assert (os.path.basename(cfg['target']['base_tree'].rstrip('/'))
            == os.path.basename(chunk_map['generated_from']['tree'].rstrip('/'))), (
        f"config base_tree {cfg['target']['base_tree']!r} and map tree "
        f"{chunk_map['generated_from']['tree']!r} are different applications")
