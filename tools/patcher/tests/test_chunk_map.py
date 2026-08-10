"""The static chunk map.

The invariants that make a map safe to hand out as work:
  - every bug that was not excluded is in exactly one chunk
  - no file is in two chunks, so two agents can never be sent the same file
  - no file WITHOUT a bug appears anywhere; the map is a work plan, not an
    inventory, and a clean file listed here would be opened for nothing
  - a denylisted file's bugs are excluded, recorded, and not counted
  - an import cycle is never split across chunks
  - a bracket never runs before something it depends on
  - the map is a pure function of (bug report, tree)

The last one is why the shuffle test exists: if any ordering leaked in from the
input list, the map would be reproducible only by accident.
"""
import json
import os
import random
import sys

import pytest

_TESTS = os.path.dirname(os.path.abspath(__file__))
_PATCHER = os.path.dirname(_TESTS)
_REPO = os.path.dirname(os.path.dirname(_PATCHER))
sys.path.insert(0, os.path.join(_PATCHER, 'plan'))

import build_chunk_map as bcm            # noqa: E402
import wave_plan                         # noqa: E402

TREE = 'target-apps/juice-shop-blind'
ABS_TREE = os.path.join(_REPO, TREE)
SUBSET2 = os.path.join(_PATCHER, 'inputs', 'bug-report.json')
SUBSET4 = os.path.join(_PATCHER, 'inputs', 'subset4', 'bug-report.json')
CHECKED_IN = os.path.join(_PATCHER, 'plan', 'chunk-map.json')

pytestmark = pytest.mark.skipif(
    not os.path.isdir(ABS_TREE), reason='target tree not checked out')


def _bug(bid, path, line=1, cls='Injection / SQL'):
    return {'bug_id': bid, 'location': {'file': path, 'line': line},
            'owasp': [{'code': 'A03'}], 'class': cls}


def _report(bugs, report_id='synthetic'):
    return {'report_id': report_id, 'target_dir': TREE, 'bugs': bugs}


def _build(bugs_or_report, tree=ABS_TREE):
    br = bugs_or_report if isinstance(bugs_or_report, dict) else _report(bugs_or_report)
    return bcm.build(br, tree, repo_root=_REPO, bug_report_path='(test)')


def _load(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def _chunks(m):
    return [c for b in m['brackets'] for c in b['chunks']]


def _tasks(m):
    return [t for c in _chunks(m) for t in c['tasks']]


@pytest.fixture(scope='module')
def subset2():
    return _build(_load(SUBSET2))


@pytest.fixture(scope='module')
def subset4():
    return _build(_load(SUBSET4))


# ---- the partition ---------------------------------------------------------

@pytest.mark.parametrize('path', [SUBSET2, SUBSET4])
def test_every_bug_lands_in_exactly_one_chunk(path):
    br = _load(path)
    m = _build(br)
    placed = [t['bug_id'] for t in _tasks(m)]
    excluded = {e['bug_id'] for e in m['excluded_bugs']}
    expected = [b['bug_id'] for b in br['bugs'] if b['bug_id'] not in excluded]
    assert sorted(placed) == sorted(expected)
    assert len(placed) == len(set(placed)), 'a bug was placed twice'
    assert m['bug_count'] == len(placed)


def test_no_file_appears_in_two_chunks(subset2):
    seen = []
    for c in _chunks(subset2):
        seen += c['files']
    assert len(seen) == len(set(seen))


def test_a_task_never_names_a_file_outside_its_own_chunk(subset2):
    for c in _chunks(subset2):
        assert {t['file'] for t in c['tasks']} <= set(c['files'])


def test_no_file_without_a_bug_appears_in_the_map(subset2):
    with_bugs = {b['location']['file'] for b in _load(SUBSET2)['bugs']}
    listed = {f for c in _chunks(subset2) for f in c['files']}
    assert listed <= with_bugs
    # and the map does not quietly enumerate the tree either
    assert len(listed) < len(list(wave_plan.iter_source(ABS_TREE)))


def test_a_clean_neighbour_of_a_bug_file_is_not_pulled_in():
    """server.ts imports most of the app. Only the bug-bearing files are listed."""
    m = _build([_bug('B1', 'server.ts'), _bug('B2', 'lib/insecurity.ts')])
    assert {f for c in _chunks(m) for f in c['files']} == {
        'server.ts', 'lib/insecurity.ts'}


# ---- exclusion -------------------------------------------------------------

def test_denylisted_bug_is_excluded_recorded_and_uncounted():
    m = _build([_bug('B1', 'data/datacreator.ts'), _bug('B2', 'routes/metrics.ts')])
    assert [e['bug_id'] for e in m['excluded_bugs']] == ['B1']
    e = m['excluded_bugs'][0]
    assert e['file'] == 'data/datacreator.ts'
    assert 'read-guard' in e['reason'] and 'challenge keys' in e['reason']

    assert 'data/datacreator.ts' not in {f for c in _chunks(m) for f in c['files']}
    assert [t['bug_id'] for t in _tasks(m)] == ['B2']
    assert m['bug_count'] == 1, 'an excluded bug must not inflate the denominator'


def test_a_file_that_is_only_denylisted_produces_no_chunk():
    m = _build([_bug('B1', 'data/datacreator.ts')])
    assert m['chunk_count'] == 0
    assert m['bug_count'] == 0
    assert len(m['excluded_bugs']) == 1


def test_denylist_is_read_from_the_guard_not_hardcoded(tmp_path):
    """The one copy of the list lives in read-guard.ts. Assert we parse it."""
    real = bcm.read_denylist(_REPO, TREE)
    assert real == ['models/challenge.ts', 'lib/antiCheat.ts', 'data/datacreator.ts']

    # A guard whose array we can no longer find must fail loudly. An empty
    # denylist reads as 'nothing to exclude', which is the exact failure this
    # function exists to prevent.
    fake = tmp_path / 'tools' / 'scanner' / 'shared'
    fake.mkdir(parents=True)
    (fake / 'read-guard.ts').write_text('export const RENAMED = [1]\n')
    with pytest.raises(bcm.MapError):
        bcm.read_denylist(str(tmp_path), TREE)


# ---- cycles ----------------------------------------------------------------

def test_the_core_cycle_is_real():
    """Pinned separately from the map: it is the fact the map depends on."""
    imports, _ = wave_plan.import_graph(ABS_TREE)
    trio = ['lib/insecurity.ts', 'models/user.ts', 'models/feedback.ts']
    for a in trio:
        reach = wave_plan._reachable(a, imports)
        for b in trio:
            if a != b:
                assert b in reach, f'{a} no longer reaches {b}'


def test_cycle_members_share_a_chunk():
    """insecurity + user + feedback are one component; xml.ts is not in it.

    Note what this does NOT assert: that xml.ts gets a different chunk. A
    component below the cap is packable, so if the cycle were small enough
    xml.ts would legitimately be first-fit beside it -- one agent, one chunk,
    no concurrency between them. The cycle is given 5 bugs here so the chunk is
    oversized and the separation is the packing rule's doing, not luck.
    """
    bugs = ([_bug(f'I{i}', 'lib/insecurity.ts', i) for i in range(1, 4)]
            + [_bug('U1', 'models/user.ts'), _bug('F1', 'models/feedback.ts'),
               _bug('X1', 'lib/xml.ts')])
    m = _build(bugs)
    holder = {f: c['chunk_id'] for c in _chunks(m) for f in c['files']}
    assert holder['lib/insecurity.ts'] == holder['models/user.ts'] \
        == holder['models/feedback.ts']
    assert holder['lib/xml.ts'] != holder['lib/insecurity.ts'], \
        'lib/xml.ts is not in the cycle and must not be merged into it'
    cyc = [c for c in _chunks(m) if len(c['files']) == 3][0]
    assert 'import cycle' in cyc['reason']


def test_a_small_cycle_is_packed_with_a_stranger_and_still_stays_whole():
    """The complement of the test above: packing may join, never split."""
    m = _build([_bug('I1', 'lib/insecurity.ts'), _bug('U1', 'models/user.ts'),
                _bug('F1', 'models/feedback.ts'), _bug('X1', 'lib/xml.ts')])
    assert m['chunk_count'] == 1
    assert len(_chunks(m)[0]['files']) == 4
    assert 'import cycle' in _chunks(m)[0]['reason']


def test_a_cycle_is_never_split_even_when_it_exceeds_the_cap():
    """Six bugs across a 3-file cycle is over the cap of 4 and still one chunk.

    Splitting would assert one member can land before another, which is exactly
    what a cycle denies -- the same defect an earlier wave_plan hub pass had.
    """
    bugs = ([_bug(f'I{i}', 'lib/insecurity.ts', i) for i in range(1, 3)]
            + [_bug(f'U{i}', 'models/user.ts', i) for i in range(1, 3)]
            + [_bug(f'F{i}', 'models/feedback.ts', i) for i in range(1, 3)])
    m = _build(bugs)
    core = [c for c in m['brackets'][0]['chunks']]
    assert len(core) == 1 and len(core[0]['tasks']) == 6


def test_route_to_route_import_edges_are_pinned():
    """MEASURED, and it is not zero.

    The design note this map was built from says 'no route file imports another
    route file (0 edges)'. Against the real tree there is exactly one such edge.
    It is directed and not part of a cycle, so it does not change any component
    and therefore does not change any chunk -- but it does mean bracket C is not
    quite the edgeless set it was described as, and a chunk map does not encode
    intra-bracket ordering. Pinned rather than asserted away: a SECOND edge, or
    a mutual one, would change the answer and must fail this test.
    """
    imports, _ = wave_plan.import_graph(ABS_TREE)
    edges = sorted((f, g) for f, deps in imports.items() if f.startswith('routes/')
                   for g in deps if g.startswith('routes/'))
    assert edges == [('routes/metrics.ts', 'routes/vulnCodeSnippet.ts')]


def test_the_one_mutually_reachable_route_pair_is_pinned():
    """Bracket C is NOT cycle-free either, transitively.

    routes/vulnCodeFixes.ts and routes/vulnCodeSnippet.ts each reach the other
    through lib/challengeUtils.ts -> lib/antiCheat.ts. Neither direct edge is a
    route->route edge, which is why a direct-edge check reported the bracket
    clean. The planner uses transitive mutual reachability, so if both files
    ever carry a bug they become one component and one chunk -- which is the
    correct answer and is asserted below.
    """
    imports, _ = wave_plan.import_graph(ABS_TREE)
    routes = sorted(f for f in imports if f.startswith('routes/'))
    reach = {f: wave_plan._reachable(f, imports) for f in routes}
    mutual = sorted((f, g) for f in routes for g in routes
                    if f < g and g in reach[f] and f in reach[g])
    assert mutual == [('routes/vulnCodeFixes.ts', 'routes/vulnCodeSnippet.ts')]

    m = _build([_bug('B1', 'routes/vulnCodeFixes.ts'),
                _bug('B2', 'routes/vulnCodeSnippet.ts')])
    assert m['chunk_count'] == 1
    assert 'import cycle' in _chunks(m)[0]['reason']


def test_a_cycle_that_spans_two_brackets_is_split_by_the_bracket_boundary():
    """A KNOWN LIMIT, pinned so it cannot be discovered by surprise.

    The tree holds one 14-file strongly-connected component that straddles
    lib/ + models/ (bracket A) and routes/ + data/ (bracket C). Components are
    computed WITHIN a bracket, so that cycle is cut at the boundary and the two
    halves are scheduled in different phases -- an ordering the cycle itself
    does not support. The brackets are a fixed architectural partition and take
    precedence; the cost is recorded here rather than hidden.
    """
    m = _build([_bug('B1', 'lib/insecurity.ts'), _bug('B2', 'data/datacache.ts')])
    holder = {f: c['chunk_id'] for c in _chunks(m) for f in c['files']}
    assert holder['lib/insecurity.ts'].startswith('A')
    assert holder['data/datacache.ts'].startswith('C')

    imports, _ = wave_plan.import_graph(ABS_TREE)
    assert 'data/datacache.ts' in wave_plan._reachable('lib/insecurity.ts', imports)
    assert 'lib/insecurity.ts' in wave_plan._reachable('data/datacache.ts', imports)


def test_frontend_and_contract_files_have_no_edge_to_server_side_files():
    """Why brackets A and B can share phase 0."""
    imports, _ = wave_plan.import_graph(ABS_TREE)
    for f, deps in imports.items():
        if f.startswith('frontend/') or f.endswith('.sol'):
            assert not deps
        assert not any(d.startswith('frontend/') or d.endswith('.sol')
                       for d in deps), f'{f} now reaches the frontend'


# ---- packing ---------------------------------------------------------------

def test_capped_brackets_respect_the_cap_unless_one_component_exceeds_it(subset2):
    for b in subset2['brackets']:
        cap = bcm.CAP[b['bracket']]
        if cap is None:
            continue
        for c in b['chunks']:
            if len(c['tasks']) > cap:
                assert len(c['files']) >= 1 and 'on its own' in c['reason']


def test_an_oversized_chunk_is_never_topped_up():
    """5 bugs in one file plus a 1-bug file: the big chunk stays at 5."""
    bugs = ([_bug(f'A{i}', 'routes/fileServer.ts', i) for i in range(1, 6)]
            + [_bug('B1', 'routes/metrics.ts')])
    m = _build(bugs)
    sizes = sorted(len(c['tasks']) for c in _chunks(m))
    assert sizes == [1, 5]


def test_first_fit_packs_small_components_together():
    bugs = [_bug(f'B{i}', f, 1) for i, f in enumerate(
        ['routes/metrics.ts', 'routes/easterEgg.ts', 'routes/premiumReward.ts',
         'routes/updateUserProfile.ts'])]
    m = _build(bugs)
    assert m['chunk_count'] == 1
    assert len(_chunks(m)[0]['tasks']) == 4


def test_the_wiring_bracket_is_uncapped():
    bugs = [_bug(f'S{i}', 'server.ts', i) for i in range(1, 9)]
    m = _build(bugs)
    assert m['chunk_count'] == 1
    assert len(_chunks(m)[0]['tasks']) == 8


def test_chunk_ids_are_bracket_prefixed_and_numbered_from_one(subset2):
    for b in subset2['brackets']:
        ids = [c['chunk_id'] for c in b['chunks']]
        assert ids == [f"{b['bracket']}{i:02d}" for i in range(1, len(ids) + 1)]


def test_tasks_are_ordered_by_file_then_line_then_bug_id(subset2):
    for c in _chunks(subset2):
        keys = [(t['file'], t['line'], t['bug_id']) for t in c['tasks']]
        assert keys == sorted(keys)


# ---- brackets and phases ---------------------------------------------------

def test_files_land_in_the_bracket_their_path_says():
    cases = {
        'lib/insecurity.ts': 'A', 'models/user.ts': 'A',
        'frontend/src/app/app.routing.ts': 'B',
        'data/static/web3-snippets/ETHWalletBank.sol': 'B',
        'routes/metrics.ts': 'C', 'data/static/codefixes/x.ts': 'C',
        'server.ts': 'D', 'app.ts': 'D',
    }
    for path, bracket in cases.items():
        assert bcm.bracket_of(path) == bracket, path


def test_web3_snippets_beat_the_data_rule():
    """Rule order is load-bearing: data/** would otherwise swallow the contracts."""
    assert bcm.bracket_of('data/static/web3-snippets/HoneyPotNFT.sol') == 'B'
    assert bcm.bracket_of('data/static/i18n/en.json') == 'C'


def test_an_unbracketed_bug_file_is_an_error_not_a_default_bucket():
    with pytest.raises(bcm.MapError) as exc:
        _build([_bug('B1', 'ftp/legal.md')])
    assert 'ftp/legal.md' in str(exc.value)


def test_every_bracket_runs_after_its_dependencies(subset2):
    phase = {b['bracket']: b['phase'] for b in subset2['brackets']}
    for b in subset2['brackets']:
        for dep in b['depends_on']:
            assert phase[dep] < b['phase'], f"{b['bracket']} not after {dep}"


def test_phase_concurrency_is_the_sum_of_its_brackets(subset2):
    by_bracket = {b['bracket']: b for b in subset2['brackets']}
    for ph in subset2['phases']:
        assert ph['concurrency'] == sum(
            by_bracket[n]['concurrency'] for n in ph['brackets'])
        for n in ph['brackets']:
            assert by_bracket[n]['phase'] == ph['phase']
    assert [p['phase'] for p in subset2['phases']] == [0, 1, 2]


def test_bracket_concurrency_is_its_chunk_count(subset2):
    for b in subset2['brackets']:
        assert b['concurrency'] == len(b['chunks'])


def test_phase_zero_holds_a_and_b(subset2):
    assert subset2['phases'][0]['brackets'] == ['A', 'B']


# ---- determinism -----------------------------------------------------------

def test_map_is_byte_identical_under_a_shuffled_bug_list():
    br = _load(SUBSET2)
    first = json.dumps(_build(br), indent=1, sort_keys=False)
    rng = random.Random(20260810)
    for _ in range(5):
        shuffled = dict(br)
        shuffled['bugs'] = list(br['bugs'])
        rng.shuffle(shuffled['bugs'])
        assert json.dumps(_build(shuffled), indent=1, sort_keys=False) == first


def test_map_is_byte_identical_when_rebuilt(subset2):
    assert json.dumps(_build(_load(SUBSET2))) == json.dumps(subset2)


def test_checked_in_map_matches_a_fresh_generation():
    """The committed artifact is the generator's output, not a hand edit."""
    on_disk = _load(CHECKED_IN)
    fresh = bcm.build(_load(SUBSET2), ABS_TREE, repo_root=_REPO,
                      bug_report_path=on_disk['generated_from']['bug_report'])
    assert json.dumps(fresh, indent=1) == json.dumps(on_disk, indent=1)


# ---- schema ----------------------------------------------------------------

def test_map_carries_the_agreed_top_level_contract(subset2):
    assert subset2['map_id'] == 'chunk-map/v1'
    for key in ('generated_from', 'deterministic', 'bug_count', 'chunk_count',
                'excluded_bugs', 'shared_extension_zone', 'never_writable',
                'read_denylist', 'phases', 'brackets'):
        assert key in subset2, key
    assert subset2['generated_from']['bug_report_id'] == 'bug-report-subset2'
    assert subset2['generated_from']['tree'] == TREE
    assert subset2['shared_extension_zone'] == ['views/**', 'config/**', 'swagger.yml']
    assert subset2['never_writable'] == ['test/**', '**/*.spec.ts']


def test_every_bracket_is_present_even_when_it_has_no_bugs(subset2):
    assert [b['bracket'] for b in subset2['brackets']] == ['A', 'B', 'C', 'D']
    empty = [b for b in subset2['brackets'] if not b['chunks']]
    assert all(b['concurrency'] == 0 for b in empty)


def test_chunk_count_matches_the_chunks_present(subset2):
    assert subset2['chunk_count'] == len(_chunks(subset2))


def test_every_chunk_states_a_reason(subset2):
    for c in _chunks(subset2):
        assert c['reason'] and len(c['reason']) > 20
        assert c['files'] and c['tasks']
