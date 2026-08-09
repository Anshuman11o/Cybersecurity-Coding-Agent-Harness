"""Wave execution: chaining, concurrency, and what must not be shared.

These tests stub out `task_loop.run_task` so the whole wave path can be driven
without an agent or a real toolchain. What is being checked is the orchestration:
that cycle members never overlap in time, that independent units do, that a
crash costs one unit rather than the wave, and that units never see each other's
credit or each other's audit log.
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import task_loop  # noqa: E402
import wave_runner  # noqa: E402
import workspace  # noqa: E402


def _file_for(uid: str) -> str:
    """Unit 'A' owns 'a.ts'. Lowercased so the name matches what _seed() creates --
    a mismatch here makes the harness create a new file instead of editing one, and
    the test then reads a path integration never claimed."""
    return f'{uid.lower()}.ts'


def _entry(uid, bugs=1, cycle=()):
    return {'unit_id': uid, 'bug_count': bugs, 'cycle_with': list(cycle),
            'serial_within_wave': bool(cycle), 'file': _file_for(uid)}


def _unit(uid, path=None):
    return {'bug_id': uid, 'location': {'file': path or _file_for(uid), 'line': 1},
            'owasp': [{'code': 'A03'}], 'class': 'Injection / SQL'}


def _plan(waves):
    return {'plan_id': 'wave-plan/v1', 'wave_count': len(waves),
            'max_parallelism': max((len(w) for w in waves), default=0),
            'waves': [{'wave': i, 'parallel': len(w) > 1, 'units': w}
                      for i, w in enumerate(waves)]}


def _cfg(tmp_path):
    return {'target': {'node_modules': None},
            'loop': {}, 'policy': {}, 'commands': {}}


def _seed(tmp_path, files=('a.ts', 'b.ts', 'c.ts', 'd.ts')):
    seed = str(tmp_path / 'seed')
    os.makedirs(seed, exist_ok=True)
    for rel in files:
        with open(os.path.join(seed, rel), 'w') as fh:
            fh.write('orig\n')
    return seed


class Harness:
    """Replaces run_task. Records when each unit ran, in which tree."""

    def __init__(self, edit=True, crash_on=(), hold_s=0.0):
        self.spans = {}
        self.trees = {}
        self.guards = {}
        self.seen_touched = {}
        self.edit = edit
        self.crash_on = set(crash_on)
        self.hold_s = hold_s
        self._lock = threading.Lock()

    def __call__(self, unit, index, ctx):
        uid = unit['bug_id']
        t0 = time.time()
        with self._lock:
            self.trees[uid] = ctx.tree
            self.guards[uid] = ctx.guard_log()
            self.seen_touched[uid] = dict(ctx.touched_locations)
        if uid in self.crash_on:
            raise RuntimeError('boom')
        if self.hold_s:
            time.sleep(self.hold_s)
        if self.edit:
            with open(os.path.join(ctx.tree, unit['location']['file']), 'w') as fh:
                fh.write(f'patched by {uid}\n')
        with self._lock:
            self.spans[uid] = (t0, time.time())
        return {'bug_id': uid, 'task_index': index, 'disposition': 'fixed',
                'location': unit['location'],
                'measured': {'characterisation': {}, 'rounds': [],
                             'rounds_to_green': 0, 'cost_usd': 0.0},
                'diff_stats': {'files_touched': [], 'lines_added': 1,
                               'lines_removed': 1},
                'violations': []}


def _run(tmp_path, monkeypatch, plan, units, harness, concurrency=4, gate=None):
    monkeypatch.setattr(task_loop, 'run_task', harness)
    monkeypatch.setattr(wave_runner.integrator, 'post_wave_gate',
                        gate or (lambda *a, **k: {'green': True}))
    seed = _seed(tmp_path)
    recs = []
    out = wave_runner.run_waves(
        plan, cfg=_cfg(tmp_path), units=units, runner=None, playbook={},
        run_dir=str(tmp_path / 'run'), seed=seed, concurrency=concurrency,
        log=lambda *_: None, on_record=recs.append)
    return out, recs, seed


def _overlap(a, b) -> bool:
    return a[0] < b[1] and b[0] < a[1]


# ---- chains ----------------------------------------------------------------

def test_a_lone_unit_is_a_chain_of_one():
    chs = wave_runner.chains([_entry('A'), _entry('B')])
    assert [[e['unit_id'] for e in ch] for ch in chs] == [['A'], ['B']]


def test_a_cycle_becomes_one_chain():
    chs = wave_runner.chains([_entry('A', cycle=['B']), _entry('B', cycle=['A'])])
    assert len(chs) == 1
    assert [e['unit_id'] for e in chs[0]] == ['A', 'B']
    assert wave_runner.chain_id(chs[0]) == 'A+B'


def test_a_cycle_member_named_outside_this_wave_is_ignored():
    """cycle_with can only be honoured for units actually present here."""
    chs = wave_runner.chains([_entry('A', cycle=['ELSEWHERE'])])
    assert [e['unit_id'] for e in chs[0]] == ['A']


def test_longest_chain_is_scheduled_first():
    """A wave is only as fast as its longest chain."""
    chs = wave_runner.chains([_entry('small', bugs=1), _entry('big', bugs=9)])
    assert chs[0][0]['unit_id'] == 'big'


# ---- concurrency -----------------------------------------------------------

def test_independent_units_actually_overlap(tmp_path, monkeypatch):
    h = Harness(hold_s=0.25)
    _run(tmp_path, monkeypatch, _plan([[_entry('A'), _entry('B')]]),
         [_unit('A'), _unit('B')], h)
    assert _overlap(h.spans['A'], h.spans['B']), 'a wave did not run in parallel'


def test_cycle_members_never_overlap(tmp_path, monkeypatch):
    h = Harness(hold_s=0.25)
    _run(tmp_path, monkeypatch,
         _plan([[_entry('A', cycle=['B']), _entry('B', cycle=['A'])]]),
         [_unit('A'), _unit('B')], h)
    assert not _overlap(h.spans['A'], h.spans['B']), 'a cycle ran concurrently'


def test_cycle_members_share_a_tree_so_the_second_sees_the_first(tmp_path, monkeypatch):
    h = Harness(hold_s=0.05)
    _run(tmp_path, monkeypatch,
         _plan([[_entry('A', cycle=['B']), _entry('B', cycle=['A'])]]),
         [_unit('A'), _unit('B')], h)
    assert h.trees['A'] == h.trees['B']


def test_the_concurrency_cap_is_respected(tmp_path, monkeypatch):
    h = Harness(hold_s=0.3)
    out, _, _ = _run(tmp_path, monkeypatch,
                     _plan([[_entry(u) for u in 'ABCD']]),
                     [_unit(u) for u in 'ABCD'], h, concurrency=2)
    assert out['waves'][0]['workers'] == 2
    running = max(sum(1 for other in h.spans.values() if _overlap(span, other))
                  for span in h.spans.values())
    assert running <= 2, f'{running} units overlapped with a cap of 2'


def test_later_waves_start_after_earlier_ones_finish(tmp_path, monkeypatch):
    h = Harness(hold_s=0.15)
    _run(tmp_path, monkeypatch, _plan([[_entry('A')], [_entry('B')]]),
         [_unit('A'), _unit('B')], h)
    assert h.spans['A'][1] <= h.spans['B'][0]


# ---- isolation -------------------------------------------------------------

def test_each_chain_gets_its_own_tree_and_guard_log(tmp_path, monkeypatch):
    h = Harness()
    _run(tmp_path, monkeypatch, _plan([[_entry('A'), _entry('B')]]),
         [_unit('A'), _unit('B')], h)
    assert h.trees['A'] != h.trees['B']
    assert h.guards['A'] != h.guards['B']


def test_units_in_one_wave_cannot_claim_each_others_credit(tmp_path, monkeypatch):
    """`already_remediated` may only ever refer to work already integrated."""
    h = Harness()
    _run(tmp_path, monkeypatch, _plan([[_entry('A'), _entry('B')]]),
         [_unit('A'), _unit('B')], h)
    assert h.seen_touched['A'] == {} and h.seen_touched['B'] == {}


def test_a_later_wave_does_see_an_earlier_wave(tmp_path, monkeypatch):
    h = Harness()
    _run(tmp_path, monkeypatch, _plan([[_entry('A')], [_entry('B')]]),
         [_unit('A'), _unit('B')], h)
    assert h.seen_touched['B'] == {'a.ts:1': 'A'}


# ---- results ---------------------------------------------------------------

def test_every_unit_lands_in_the_seed(tmp_path, monkeypatch):
    h = Harness()
    _, recs, seed = _run(tmp_path, monkeypatch,
                         _plan([[_entry('A'), _entry('B')], [_entry('C')]]),
                         [_unit('A'), _unit('B'), _unit('C')], h)
    for uid, rel in (('A', 'a.ts'), ('B', 'b.ts'), ('C', 'c.ts')):
        with open(os.path.join(seed, rel)) as fh:
            assert fh.read() == f'patched by {uid}\n'
    assert sorted(r['bug_id'] for r in recs) == ['A', 'B', 'C']


def test_task_indices_do_not_depend_on_who_finished_first(tmp_path, monkeypatch):
    h = Harness(hold_s=0.1)
    _, recs, _ = _run(tmp_path, monkeypatch, _plan([[_entry('B'), _entry('A')]]),
                      [_unit('A'), _unit('B')], h)
    by_id = {r['bug_id']: r['task_index'] for r in recs}
    assert by_id == {'A': 0, 'B': 1}


def test_a_crashing_unit_costs_one_unit_not_the_wave(tmp_path, monkeypatch):
    h = Harness(crash_on={'A'})
    _, recs, seed = _run(tmp_path, monkeypatch, _plan([[_entry('A'), _entry('B')]]),
                         [_unit('A'), _unit('B')], h)
    by_id = {r['bug_id']: r for r in recs}
    assert by_id['A']['disposition'] == 'blocked'
    assert 'orchestrator crash' in by_id['A']['disposition_reason']
    assert by_id['B']['disposition'] == 'fixed'
    with open(os.path.join(seed, 'b.ts')) as fh:
        assert fh.read() == 'patched by B\n'


def test_records_carry_their_wave_and_chain(tmp_path, monkeypatch):
    h = Harness()
    _, recs, _ = _run(tmp_path, monkeypatch,
                      _plan([[_entry('A', cycle=['B']), _entry('B', cycle=['A'])]]),
                      [_unit('A'), _unit('B')], h)
    assert {r['wave'] for r in recs} == {0}
    assert {r['chain'] for r in recs} == {'A+B'}


def test_clean_trees_are_reclaimed_and_suspect_ones_kept(tmp_path, monkeypatch):
    """A unit tree is ~67MB. Forensics on a clean merge has nothing to find."""
    h = Harness()
    gate = lambda *a, **k: {'green': False, 'workflow_red': ['B'], 'reopened': []}  # noqa: E731
    _run(tmp_path, monkeypatch, _plan([[_entry('A'), _entry('B')]]),
         [_unit('A'), _unit('B')], h, gate=gate)
    assert not os.path.exists(h.trees['A'])
    assert os.path.isdir(h.trees['B'])


def test_the_wave_base_snapshot_is_not_left_behind(tmp_path, monkeypatch):
    h = Harness()
    _, _, seed = _run(tmp_path, monkeypatch, _plan([[_entry('A')]]), [_unit('A')], h)
    snaps = os.path.join(seed, '.patcher-snapshots')
    assert not os.path.isdir(snaps) or not os.listdir(snaps)


def test_the_report_names_conflicts_and_red_gates(tmp_path, monkeypatch):
    h = Harness()
    gate = lambda *a, **k: {'green': False, 'workflow_red': ['A'], 'reopened': []}  # noqa: E731
    out, _, _ = _run(tmp_path, monkeypatch, _plan([[_entry('A')]]), [_unit('A')], h,
                     gate=gate)
    assert out['waves_gate_red'] == [0]
    assert out['conflicts_total'] == 0
    assert out['mode'] == 'waves' and out['concurrency_cap'] == 4
    assert out['waves'][0]['tree_digest']
