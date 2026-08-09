"""Integration: folding a wave's unit trees back into one tree.

The properties that matter are not "the merge succeeded" but that nothing is
applied silently and nothing is guessed:
  - a file only one unit changed lands exactly, byte for byte
  - a file two units changed is merged against the wave base, not overwritten
  - a conflict drops one side, names it, and never writes conflict markers
  - out-of-assignment writes are reported even though they are allowed
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import integrator  # noqa: E402
import workspace  # noqa: E402


def _tree(root, files: dict) -> str:
    for rel, src in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w') as fh:
            fh.write(src)
    return root


def _seed(tmp_path, files):
    """A seed tree plus its wave-base snapshot."""
    seed = _tree(str(tmp_path / 'seed'), files)
    snap = workspace.snapshot(seed, 'wave-0-base')
    return seed, snap


def _unit(tmp_path, seed, uid, assigned, edits: dict):
    """A unit tree seeded from `seed`, with `edits` applied."""
    tree = str(tmp_path / uid)
    workspace.prepare(seed, tree, None, force=True,
                      exclude=('.patcher-snapshots', workspace.SCRATCH_DIRNAME))
    for rel, src in edits.items():
        p = os.path.join(tree, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if src is None:
            os.remove(p)
        else:
            with open(p, 'w') as fh:
                fh.write(src)
    return integrator.Unit(uid, tree, assigned)


def _read(tree, rel):
    with open(os.path.join(tree, rel)) as fh:
        return fh.read()


NUMBERED = ''.join(f'line{i}\n' for i in range(1, 21))


# ---- claims ----------------------------------------------------------------

def test_claims_inverts_and_sorts():
    changed = {'B': ['b.ts', 'shared.ts'], 'A': ['a.ts', 'shared.ts']}
    assert integrator.claims(changed) == {
        'a.ts': ['A'], 'b.ts': ['B'], 'shared.ts': ['A', 'B']}


def test_out_of_assignment_lists_only_the_extras():
    u = integrator.Unit('A', '/nowhere', 'a.ts')
    assert integrator.out_of_assignment(
        [u], {'A': ['a.ts', 'lib/other.ts']}) == {'A': ['lib/other.ts']}


def test_a_cycle_unit_owns_every_member_file():
    """Its members ran serially in one tree, so their edits cannot be separated."""
    u = integrator.Unit('A+B', '/nowhere', ['a.ts', 'b.ts'])
    assert u.assigned_files == {'a.ts', 'b.ts'}
    assert u.assigned_file is None
    assert integrator.out_of_assignment([u], {'A+B': ['a.ts', 'b.ts', 'c.ts']}) == {
        'A+B': ['c.ts']}


# ---- sole claims -----------------------------------------------------------

def test_sole_claim_lands_exactly(tmp_path):
    seed, snap = _seed(tmp_path, {'a.ts': 'old\n', 'b.ts': 'keep\n'})
    ua = _unit(tmp_path, seed, 'A', 'a.ts', {'a.ts': 'new\n'})
    rep = integrator.integrate(seed=seed, base_snap=snap, units=[ua], log=lambda *_: None)
    assert _read(seed, 'a.ts') == 'new\n'
    assert _read(seed, 'b.ts') == 'keep\n'
    assert rep['clean'] is True
    assert rep['applied'] == [{'file': 'a.ts', 'unit': 'A', 'how': 'copied'}]


def test_two_units_touching_different_files_both_land(tmp_path):
    seed, snap = _seed(tmp_path, {'a.ts': 'a\n', 'b.ts': 'b\n'})
    units = [_unit(tmp_path, seed, 'A', 'a.ts', {'a.ts': 'A!\n'}),
             _unit(tmp_path, seed, 'B', 'b.ts', {'b.ts': 'B!\n'})]
    rep = integrator.integrate(seed=seed, base_snap=snap, units=units, log=lambda *_: None)
    assert (_read(seed, 'a.ts'), _read(seed, 'b.ts')) == ('A!\n', 'B!\n')
    assert rep['contested_files'] == []


def test_a_deletion_by_its_sole_owner_is_honoured(tmp_path):
    seed, snap = _seed(tmp_path, {'a.ts': 'a\n', 'gone.ts': 'x\n'})
    ua = _unit(tmp_path, seed, 'A', 'a.ts', {'gone.ts': None})
    integrator.integrate(seed=seed, base_snap=snap, units=[ua], log=lambda *_: None)
    assert not os.path.exists(os.path.join(seed, 'gone.ts'))


# ---- contested files -------------------------------------------------------

def test_contested_file_is_merged_not_overwritten(tmp_path):
    """Both edits must survive. Copying either whole file would lose the other."""
    seed, snap = _seed(tmp_path, {'shared.ts': NUMBERED, 'a.ts': '', 'b.ts': ''})
    top = NUMBERED.replace('line1\n', 'line1-A\n')
    bottom = NUMBERED.replace('line20\n', 'line20-B\n')
    units = [_unit(tmp_path, seed, 'A', 'a.ts', {'shared.ts': top}),
             _unit(tmp_path, seed, 'B', 'b.ts', {'shared.ts': bottom})]
    rep = integrator.integrate(seed=seed, base_snap=snap, units=units, log=lambda *_: None)

    merged = _read(seed, 'shared.ts')
    assert 'line1-A' in merged and 'line20-B' in merged
    assert '<<<<<<<' not in merged
    assert rep['clean'] is True
    assert rep['contested_files'] == [{'file': 'shared.ts', 'units': ['A', 'B']}]
    assert rep['out_of_assignment'] == {'A': ['shared.ts'], 'B': ['shared.ts']}


def test_overlapping_edits_conflict_and_one_side_is_dropped(tmp_path):
    seed, snap = _seed(tmp_path, {'shared.ts': NUMBERED, 'a.ts': '', 'b.ts': ''})
    units = [_unit(tmp_path, seed, 'A', 'a.ts',
                   {'shared.ts': NUMBERED.replace('line10\n', 'line10-A\n')}),
             _unit(tmp_path, seed, 'B', 'b.ts',
                   {'shared.ts': NUMBERED.replace('line10\n', 'line10-B\n')})]
    rep = integrator.integrate(seed=seed, base_snap=snap, units=units, log=lambda *_: None)

    assert rep['clean'] is False
    assert len(rep['conflicts']) == 1
    c = rep['conflicts'][0]
    assert c['file'] == 'shared.ts' and c['dropped'] == 'B' and c['kept'] == ['A']
    assert [d['unit'] for d in rep['dropped']] == ['B']
    # The tree must stay buildable: a conflict marker would fail the next wave's
    # typecheck and the failure would be attributed to nobody.
    assert '<<<<<<<' not in _read(seed, 'shared.ts')
    assert 'line10-A' in _read(seed, 'shared.ts')


def test_a_conflict_resolves_the_same_way_on_a_rerun(tmp_path):
    """Merge order is unit_id, not completion order, or a re-run would differ."""
    outcomes = []
    for attempt in ('one', 'two'):
        sub = tmp_path / attempt
        sub.mkdir()
        seed, snap = _seed(sub, {'shared.ts': NUMBERED, 'a.ts': '', 'b.ts': ''})
        units = [_unit(sub, seed, 'B', 'b.ts',
                       {'shared.ts': NUMBERED.replace('line10\n', 'B\n')}),
                 _unit(sub, seed, 'A', 'a.ts',
                       {'shared.ts': NUMBERED.replace('line10\n', 'A\n')})]
        if attempt == 'two':
            units.reverse()
        rep = integrator.integrate(seed=seed, base_snap=snap, units=units,
                                   log=lambda *_: None)
        outcomes.append((_read(seed, 'shared.ts'),
                         [c['dropped'] for c in rep['conflicts']]))
    assert outcomes[0] == outcomes[1]


def test_a_file_two_units_created_has_no_ancestor_and_is_not_applied(tmp_path):
    seed, snap = _seed(tmp_path, {'a.ts': '', 'b.ts': ''})
    units = [_unit(tmp_path, seed, 'A', 'a.ts', {'new.ts': 'from A\n'}),
             _unit(tmp_path, seed, 'B', 'b.ts', {'new.ts': 'from B\n'})]
    rep = integrator.integrate(seed=seed, base_snap=snap, units=units, log=lambda *_: None)
    assert rep['clean'] is False
    assert 'no common ancestor' in rep['conflicts'][0]['reason']
    assert not os.path.exists(os.path.join(seed, 'new.ts'))


# ---- scratch ---------------------------------------------------------------

def test_gate_artefacts_are_carried_into_the_seed(tmp_path):
    """The post-wave gate re-runs each unit's own test, which lives in its tree."""
    seed, snap = _seed(tmp_path, {'a.ts': 'a\n'})
    ua = _unit(tmp_path, seed, 'A', 'a.ts', {'a.ts': 'A\n'})
    scratch = workspace.ensure_scratch(ua.tree, 'A')
    with open(os.path.join(scratch, 'workflow.test.ts'), 'w') as fh:
        fh.write('// gate\n')
    integrator.integrate(seed=seed, base_snap=snap, units=[ua], log=lambda *_: None)
    assert os.path.isfile(os.path.join(workspace.scratch_abs(seed, 'A'),
                                       'workflow.test.ts'))


def test_seeding_leaves_the_seeds_own_scratch_and_snapshots_behind(tmp_path):
    """Otherwise a unit inherits another unit's frozen oracle inside its sandbox."""
    seed, snap = _seed(tmp_path, {'a.ts': 'a\n'})
    other = workspace.ensure_scratch(seed, 'SOMEONE-ELSE')
    with open(os.path.join(other, 'exploit.probe.ts'), 'w') as fh:
        fh.write('// not yours\n')
    ua = _unit(tmp_path, seed, 'A', 'a.ts', {})
    assert not os.path.exists(workspace.scratch_abs(ua.tree, 'SOMEONE-ELSE'))
    assert not os.path.exists(os.path.join(ua.tree, '.patcher-snapshots'))
    assert os.path.exists(snap)


# ---- the post-wave gate ----------------------------------------------------

class _R:
    """Stand-in for verify.CommandResult."""

    def __init__(self, ok=True, out='', tail=''):
        self.ok, self.stdout, self.stderr, self.tail = ok, out, '', tail
        self.timed_out = False


def _gate_tree(tmp_path, uids, *, probe=True):
    seed = str(tmp_path / 'seed')
    os.makedirs(seed, exist_ok=True)
    units = []
    for uid in uids:
        s = workspace.ensure_scratch(seed, uid)
        with open(os.path.join(s, 'workflow.test.ts'), 'w') as fh:
            fh.write('// gate\n')
        if probe:
            with open(os.path.join(s, 'exploit.probe.ts'), 'w') as fh:
                fh.write('// probe\n')
        units.append(integrator.Unit(uid, seed, f'{uid}.ts'))
    return seed, units


def test_a_broken_build_stops_the_gate_rather_than_inventing_per_unit_results(
        tmp_path, monkeypatch):
    seed, units = _gate_tree(tmp_path, ['A', 'B'])
    monkeypatch.setattr(integrator.verify, 'typecheck',
                        lambda *a, **k: _R(ok=False, tail='TS2345'))
    called = []
    monkeypatch.setattr(integrator.verify, 'run_test_file',
                        lambda *a, **k: called.append(1) or _R())
    out = integrator.post_wave_gate({}, seed, units, log=lambda *_: None)
    assert out['green'] is False
    assert out['workflow'] == {} and not called
    assert 'typecheck failed' in out['skipped']


def test_a_red_workflow_test_names_the_unit(tmp_path, monkeypatch):
    seed, units = _gate_tree(tmp_path, ['A', 'B'])
    monkeypatch.setattr(integrator.verify, 'typecheck', lambda *a, **k: _R())
    monkeypatch.setattr(
        integrator.verify, 'run_test_file',
        lambda cfg, tree, rel, *a, **k: _R(ok='/B/' not in rel, out='x'))
    monkeypatch.setattr(integrator.verify, 'parse_test_output',
                        lambda text: {'t': 'fail'} if text.strip() == 'x' else {})
    monkeypatch.setattr(integrator.verify, 'run_probe',
                        lambda *a, **k: (integrator.verify.NOT_PROVEN, _R()))
    out = integrator.post_wave_gate({}, seed, units, log=lambda *_: None)
    assert out['workflow_red'] == ['A', 'B'] and out['green'] is False


def test_a_probe_that_goes_proven_again_after_merging_is_reopened(tmp_path, monkeypatch):
    """A sibling's change defeated this unit's fix. Nothing else detects it."""
    seed, units = _gate_tree(tmp_path, ['A', 'B'])
    monkeypatch.setattr(integrator.verify, 'typecheck', lambda *a, **k: _R())
    monkeypatch.setattr(integrator.verify, 'run_test_file', lambda *a, **k: _R())
    monkeypatch.setattr(integrator.verify, 'parse_test_output', lambda text: {'t': 'pass'})
    monkeypatch.setattr(
        integrator.verify, 'run_probe',
        lambda cfg, tree, rel: ((integrator.verify.PROVEN, _R()) if '/B/' in rel
                                else (integrator.verify.NOT_PROVEN, _R())))
    out = integrator.post_wave_gate({}, seed, units, log=lambda *_: None)
    assert out['reopened'] == ['B'] and out['workflow_red'] == [] and out['green'] is False


def test_a_missing_gate_artefact_is_recorded_not_treated_as_a_pass(tmp_path, monkeypatch):
    seed, units = _gate_tree(tmp_path, ['A'], probe=False)
    monkeypatch.setattr(integrator.verify, 'typecheck', lambda *a, **k: _R())
    monkeypatch.setattr(integrator.verify, 'run_test_file', lambda *a, **k: _R())
    monkeypatch.setattr(integrator.verify, 'parse_test_output', lambda text: {'t': 'pass'})
    out = integrator.post_wave_gate({}, seed, units, log=lambda *_: None)
    assert out['probe']['A'] == 'MISSING'
    assert out['workflow']['A']['ok'] is True
