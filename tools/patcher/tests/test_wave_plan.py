"""Wave planning.

The invariants that make a plan safe to execute:
  - every unit appears exactly once
  - a unit never shares a wave with something it depends on
  - a dependency cycle is never split across waves
  - the plan is a pure function of (bug report, tree)
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import wave_plan  # noqa: E402


def _bug(bid, path, line=1, code='A03'):
    return {'bug_id': bid, 'location': {'file': path, 'line': line},
            'owasp': [{'code': code}], 'class': 'Injection / SQL'}


def _tree(tmp_path, files: dict):
    """files: {relpath: source}. Returns the tree root."""
    root = tmp_path / 'app'
    for rel, src in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src)
    return str(root)


def _units_by_wave(p):
    return {w['wave']: {u['unit_id'] for u in w['units']} for w in p['waves']}


# ---- import resolution -----------------------------------------------------

def test_dependent_lands_after_its_dependency(tmp_path):
    tree = _tree(tmp_path, {
        'lib/shared.ts': 'export const x = 1\n',
        'routes/a.ts': "import { x } from '../lib/shared'\n",
    })
    p = wave_plan.plan([_bug('B1', 'lib/shared.ts'), _bug('B2', 'routes/a.ts')],
                       tree, isolate_hubs=False)
    waves = _units_by_wave(p)
    assert waves[0] == {'B1'}
    assert waves[1] == {'B2'}


def test_third_party_imports_are_not_edges(tmp_path):
    tree = _tree(tmp_path, {
        'routes/a.ts': "import express from 'express'\n",
        'routes/b.ts': "import lodash from 'lodash'\n",
    })
    p = wave_plan.plan([_bug('B1', 'routes/a.ts'), _bug('B2', 'routes/b.ts')],
                       tree, isolate_hubs=False)
    assert p['wave_count'] == 1
    assert _units_by_wave(p)[0] == {'B1', 'B2'}


def test_transitive_dependency_is_an_edge(tmp_path):
    """A -> mid -> B still means A should see B's change; a direct-only rule
    would schedule them in the same wave."""
    tree = _tree(tmp_path, {
        'lib/deep.ts': 'export const x = 1\n',
        'lib/mid.ts': "import { x } from './deep'\n",
        'routes/a.ts': "import './../lib/mid'\n",
    })
    p = wave_plan.plan([_bug('B1', 'lib/deep.ts'), _bug('B2', 'routes/a.ts')],
                       tree, isolate_hubs=False)
    waves = _units_by_wave(p)
    assert waves[0] == {'B1'} and waves[1] == {'B2'}


# ---- the invariants --------------------------------------------------------

def test_every_unit_appears_exactly_once(tmp_path):
    tree = _tree(tmp_path, {f'routes/f{i}.ts': '' for i in range(5)})
    bugs = [_bug(f'B{i}', f'routes/f{i}.ts') for i in range(5)]
    p = wave_plan.plan(bugs, tree)
    seen = [u['unit_id'] for w in p['waves'] for u in w['units']]
    assert sorted(seen) == sorted(b['bug_id'] for b in bugs)
    assert len(seen) == len(set(seen))


def test_no_unit_shares_a_wave_with_its_dependency(tmp_path):
    tree = _tree(tmp_path, {
        'lib/shared.ts': '',
        'routes/a.ts': "import '../lib/shared'\n",
        'routes/b.ts': "import '../lib/shared'\n",
        'routes/c.ts': '',
    })
    bugs = [_bug('B1', 'lib/shared.ts'), _bug('B2', 'routes/a.ts'),
            _bug('B3', 'routes/b.ts'), _bug('B4', 'routes/c.ts')]
    p = wave_plan.plan(bugs, tree, isolate_hubs=False)
    wave_of = {u['unit_id']: w['wave'] for w in p['waves'] for u in w['units']}
    for w in p['waves']:
        for u in w['units']:
            for dep in u['depends_on_units']:
                assert wave_of[dep] < wave_of[u['unit_id']], (
                    f"{u['unit_id']} shares or precedes its dependency {dep}")


def test_a_cycle_is_never_split_across_waves(tmp_path):
    """Circular imports are legal in TypeScript and do occur in the target.
    Splitting one would claim one member can land before the other, which is
    exactly what the cycle denies."""
    tree = _tree(tmp_path, {
        'lib/a.ts': "import './b'\n",
        'lib/b.ts': "import './a'\n",
        'routes/z.ts': '',
    })
    bugs = [_bug('B1', 'lib/a.ts'), _bug('B2', 'lib/b.ts'), _bug('B3', 'routes/z.ts')]
    for iso in (False, True):
        p = wave_plan.plan(bugs, tree, isolate_hubs=iso, hub_threshold=1)
        wave_of = {u['unit_id']: w['wave'] for w in p['waves'] for u in w['units']}
        assert wave_of['B1'] == wave_of['B2'], f'cycle split with isolate_hubs={iso}'
        cyc = [u for w in p['waves'] for u in w['units'] if u['unit_id'] == 'B1'][0]
        assert cyc['serial_within_wave'] is True
        assert cyc['cycle_with'] == ['B2']


def test_a_serial_wave_is_not_marked_parallel(tmp_path):
    tree = _tree(tmp_path, {'lib/a.ts': "import './b'\n", 'lib/b.ts': "import './a'\n"})
    p = wave_plan.plan([_bug('B1', 'lib/a.ts'), _bug('B2', 'lib/b.ts')],
                       tree, isolate_hubs=False)
    assert p['waves'][0]['parallel'] is False


def test_hub_isolation_gives_the_hub_its_own_wave(tmp_path):
    files = {'lib/hub.ts': ''}
    bugs = [_bug('HUB', 'lib/hub.ts')]
    for i in range(4):
        files[f'other/o{i}.ts'] = "import '../lib/hub'\n"
    files['routes/free.ts'] = ''
    bugs.append(_bug('FREE', 'routes/free.ts'))
    tree = _tree(tmp_path, files)

    together = wave_plan.plan(bugs, tree, isolate_hubs=False, hub_threshold=4)
    assert _units_by_wave(together)[0] == {'HUB', 'FREE'}

    apart = wave_plan.plan(bugs, tree, isolate_hubs=True, hub_threshold=4)
    assert _units_by_wave(apart)[0] == {'HUB'}
    assert 'HUB' in apart['hubs_isolated']


def test_plan_is_deterministic(tmp_path):
    tree = _tree(tmp_path, {
        'lib/shared.ts': '', 'routes/a.ts': "import '../lib/shared'\n",
        'routes/b.ts': "import '../lib/shared'\n", 'routes/c.ts': '',
    })
    bugs = [_bug('B1', 'lib/shared.ts'), _bug('B2', 'routes/a.ts'),
            _bug('B3', 'routes/b.ts'), _bug('B4', 'routes/c.ts')]
    a = json.dumps(wave_plan.plan(bugs, tree), sort_keys=True)
    b = json.dumps(wave_plan.plan(list(reversed(bugs)), tree), sort_keys=True)
    assert a == b, 'plan depends on input order'


def test_per_file_grouping_is_carried_through(tmp_path):
    tree = _tree(tmp_path, {'routes/a.ts': ''})
    bugs = [_bug('B1', 'routes/a.ts', 1), _bug('B2', 'routes/a.ts', 9)]
    p = wave_plan.plan(bugs, tree)
    assert p['unit_count'] == 1 and p['bug_count'] == 2
    u = p['waves'][0]['units'][0]
    assert u['bug_count'] == 2 and sorted(u['bug_ids']) == ['B1', 'B2']
