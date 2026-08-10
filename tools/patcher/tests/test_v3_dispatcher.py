"""v3 dispatcher: spawn, monitor, merge, advance -- and nothing else.

Driven end to end by `agent.FakeRunner`. No network, no model, no money. What is
under test is the orchestration, which is the whole of what v3 changed:

  - one agent per chunk, all with the same generic prompt
  - a chunk's tasks run strictly in order, in its own tree
  - phases advance only when the previous phase has merged
  - characterisation reuse fires within one chunk and one file, and nowhere else
  - a chunk that reached outside its boundary merges last
  - the orchestrator runs no patcher gate; the full suite runs once, at the end
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import agent  # noqa: E402
import workspace  # noqa: E402
from v3 import chunk_map, dispatcher  # noqa: E402
from v3 import merge_queue as mq  # noqa: E402

CFG = {'commands': {'typecheck': 'npx tsc --noEmit',
                    'run_test_file': 'npx tsx --test {file}',
                    'run_probe': 'npx tsx {file}'},
       'target': {}, 'loop': {'reconcile_rounds': 4}}

TRUNK_FILES = {
    'lib/a.ts': 'export const a = 1;\n',
    'lib/b.ts': 'export const b = 1;\n',
    'frontend/src/f.ts': 'export const f = 1;\n',
    'routes/c.ts': 'export const c = 1;\n',
    'views/v.pug': 'p hello\n',
}


def _map_doc() -> dict:
    return {
        'map_id': 'chunk-map/v1', 'bug_count': 5, 'chunk_count': 4,
        'excluded_bugs': [],
        'shared_extension_zone': ['views/**', 'config/**', 'swagger.yml'],
        'never_writable': ['test/**', '**/*.spec.ts'],
        'read_denylist': ['models/challenge.ts'],
        'phases': [{'phase': 0, 'brackets': ['A', 'B'], 'concurrency': 3},
                   {'phase': 1, 'brackets': ['C'], 'concurrency': 1}],
        'brackets': [
            {'bracket': 'A', 'name': 'core', 'phase': 0, 'depends_on': [],
             'concurrency': 2, 'chunks': [
                 {'chunk_id': 'A01', 'reason': 'one file, two defects',
                  'files': ['lib/a.ts'],
                  'tasks': [{'bug_id': 'BUG-001', 'file': 'lib/a.ts', 'line': 1,
                             'class': 'Crypto'},
                            {'bug_id': 'BUG-002', 'file': 'lib/a.ts', 'line': 1,
                             'class': 'Crypto'}]},
                 {'chunk_id': 'A02', 'reason': 'second core file',
                  'files': ['lib/b.ts'],
                  'tasks': [{'bug_id': 'BUG-003', 'file': 'lib/b.ts', 'line': 1,
                             'class': 'AuthZ'}]}]},
            {'bracket': 'B', 'name': 'frontend', 'phase': 0, 'depends_on': [],
             'concurrency': 1, 'chunks': [
                 {'chunk_id': 'B01', 'reason': 'frontend', 'files': ['frontend/src/f.ts'],
                  'tasks': [{'bug_id': 'BUG-004', 'file': 'frontend/src/f.ts',
                             'line': 1, 'class': 'XSS'}]}]},
            {'bracket': 'C', 'name': 'handlers', 'phase': 1, 'depends_on': ['A'],
             'concurrency': 1, 'chunks': [
                 {'chunk_id': 'C01', 'reason': 'handler', 'files': ['routes/c.ts'],
                  'tasks': [{'bug_id': 'BUG-005', 'file': 'routes/c.ts', 'line': 1,
                             'class': 'Injection'}]}]},
        ],
    }


BUGS = [
    {'bug_id': 'BUG-001', 'location': {'file': 'lib/a.ts', 'line': 1},
     'class': 'Crypto', 'playbook_ref': 'a02-crypto', 'vulnerability': 'weak hash'},
    {'bug_id': 'BUG-002', 'location': {'file': 'lib/a.ts', 'line': 1},
     'class': 'Crypto', 'playbook_ref': 'a02-crypto', 'vulnerability': 'weak salt'},
    {'bug_id': 'BUG-003', 'location': {'file': 'lib/b.ts', 'line': 1},
     'class': 'AuthZ', 'playbook_ref': 'a01-access', 'vulnerability': 'missing check'},
    {'bug_id': 'BUG-004', 'location': {'file': 'frontend/src/f.ts', 'line': 1},
     'class': 'XSS', 'playbook_ref': 'a03-xss', 'vulnerability': 'unescaped'},
    {'bug_id': 'BUG-005', 'location': {'file': 'routes/c.ts', 'line': 1},
     'class': 'Injection', 'playbook_ref': 'a03-injection', 'vulnerability': 'concat'},
]

STEP = re.compile(r'## This step: (\w+) bug (\S+) \(([^:]+):')


# ----------------------------------------------------------------------------
# Harness
# ----------------------------------------------------------------------------

class Runner(agent.FakeRunner):
    """FakeRunner with a price tag, so the cost ceiling can be exercised."""

    cost = 0.0

    def run(self, *a, **kw):
        inv = super().run(*a, **kw)
        inv.cost_usd = self.cost
        return inv


class Script:
    """Records every step, and performs the filesystem effects a real agent would."""

    def __init__(self, *, edit=True, extra=None, declare=None, prompts_seen=None):
        self.calls = []            # (step, bug_id, file, chunk_tree)
        self.prompts = []
        self.edit = edit
        self.extra = extra or {}   # bug_id -> {rel: text} written on the fix step
        self.declare = declare or {}   # chunk_id -> [rel, ...]

    def __call__(self, prompt, phase, task_id, cwd):
        m = STEP.search(prompt)
        assert m, prompt[:400]
        step, bug_id, rel = m.group(1), m.group(2), m.group(3)
        self.calls.append((step, bug_id, rel, cwd))
        self.prompts.append(prompt)
        scratch = os.path.join(cwd, workspace.scratch_rel(task_id))
        if step == 'characterise':
            os.makedirs(scratch, exist_ok=True)
            for name in ('workflow.test.ts', 'exploit.probe.ts'):
                _write(os.path.join(scratch, name), f'// {bug_id}\n')
            _write(os.path.join(scratch, 'characterisation.json'),
                   json.dumps({'bug_id': bug_id}))
            return True
        if self.edit:
            _append(os.path.join(cwd, rel), f'// fixed {bug_id}\n')
        for extra_rel, text in (self.extra.get(bug_id) or {}).items():
            _append(os.path.join(cwd, extra_rel), text)
        chunk_id = task_id.split('-')[0]
        if chunk_id in self.declare:
            _write(os.path.join(cwd, workspace.scratch_rel(chunk_id),
                                'declarations.json'),
                   json.dumps({'files': [{'file': f, 'reason': 'plumbing'}
                                         for f in self.declare[chunk_id]]}))
        _write(os.path.join(scratch, 'attestation.json'),
               json.dumps({'bug_id': bug_id, 'status': 'fixed', 'confidence': 0.8}))
        return True

    def steps(self, chunk_prefix=None):
        return [(s, b) for s, b, _r, cwd in self.calls
                if chunk_prefix is None or os.path.basename(cwd) == chunk_prefix]


def _write(path, text):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w') as fh:
        fh.write(text)


def _append(path, text):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'a') as fh:
        fh.write(text)


def _read(root, rel):
    with open(os.path.join(root, rel)) as fh:
        return fh.read()


def _build(tmp_path, script, *, doc=None, **kw):
    trunk = str(tmp_path / 'trunk')
    for rel, src in TRUNK_FILES.items():
        _write(os.path.join(trunk, rel), src)
    cmap = chunk_map.parse(doc or _map_doc())
    runner = Runner(behaviour=script)
    d = dispatcher.Dispatcher(
        cmap, bugs=BUGS, playbook=None, runner=runner, trunk=trunk,
        run_dir=str(tmp_path / 'run'), cfg=CFG,
        trees_root=str(tmp_path / 'trees'), log=lambda *a, **k: None,
        final_suite=lambda t: {'ran': True}, **kw)
    return d, trunk, runner


# ----------------------------------------------------------------------------
# Assignments and the generic prompt
# ----------------------------------------------------------------------------

def test_each_chunk_gets_its_slice_in_map_order():
    cmap = chunk_map.parse(_map_doc())
    a = {x.chunk_id: x for x in dispatcher.assignments(cmap, BUGS)}
    assert list(a) == ['A01', 'A02', 'B01', 'C01']
    assert [b['bug_id'] for b in a['A01'].tasks] == ['BUG-001', 'BUG-002']
    assert a['A01'].playbook_refs == ['a02-crypto']       # deduplicated
    assert a['A01'].boundary.owned == frozenset({'lib/a.ts'})
    assert a['A01'].as_record()['owned_files'] == ['lib/a.ts']


def test_a_task_naming_a_bug_the_report_does_not_have_is_refused():
    cmap = chunk_map.parse(_map_doc())
    try:
        dispatcher.assignments(cmap, BUGS[:2])
    except chunk_map.ChunkMapError as ex:
        assert 'not in the bug report' in str(ex)
    else:
        raise AssertionError('expected ChunkMapError')


def test_every_chunk_gets_the_same_generic_prompt_with_a_different_slice(tmp_path):
    script = Script()
    d, _trunk, _r = _build(tmp_path, script)
    d.run()
    a01 = [p for p in script.prompts if 'chunk **A01**' in p][0]
    b01 = [p for p in script.prompts if 'chunk **B01**' in p][0]
    for shared in ('## Write boundary', 'shared extension zone',
                   'Never search for, read, or reference any answer-key',
                   'test/**, **/*.spec.ts'):
        assert shared in a01 and shared in b01
    assert '`lib/a.ts`' in a01 and '`lib/a.ts`' not in b01


def test_the_prompt_names_the_declaration_file_rather_than_denying_the_write(tmp_path):
    """A measured correct CSRF fix spanned four files. The prompt has to make the
    out-of-boundary route reachable, not closed."""
    script = Script()
    d, _t, _r = _build(tmp_path, script)
    d.run()
    p = script.prompts[0]
    assert 'declarations.json' in p
    assert 'Reaching outside your files is allowed' in p


# ----------------------------------------------------------------------------
# Ordering
# ----------------------------------------------------------------------------

def test_a_chunks_tasks_run_strictly_in_order(tmp_path):
    script = Script()
    d, _t, _r = _build(tmp_path, script)
    d.run()
    assert script.steps('A01') == [('characterise', 'BUG-001'),
                                   ('fix', 'BUG-001'),
                                   ('fix', 'BUG-002')]


def test_phase_one_starts_only_after_phase_zero_has_merged(tmp_path):
    """C01 is seeded from the trunk, so if the phase barrier held it can see
    every phase-0 fix in its own tree before it starts work."""
    script = Script()
    d, trunk, _r = _build(tmp_path, script)
    rep = d.run()
    assert [p['phase'] for p in rep['phases']] == [0, 1]
    assert d.started_order[-1] == 'C01'
    assert set(d.started_order[:3]) == {'A01', 'A02', 'B01'}
    c_tree = d.chunk_tree('C01')
    assert 'fixed BUG-001' in _read(c_tree, 'lib/a.ts')
    assert 'fixed BUG-004' in _read(c_tree, 'frontend/src/f.ts')


def test_every_phase_zero_fix_is_on_the_trunk_before_phase_one_is_dispatched(tmp_path):
    seen = {}
    script = Script()
    real = script.__call__

    def spy(prompt, phase, task_id, cwd):
        if 'BUG-005' in prompt and 'characterise' in prompt:
            seen['a'] = _read(cwd, 'lib/a.ts')
        return real(prompt, phase, task_id, cwd)

    d, _t, _r = _build(tmp_path, spy)
    d.run()
    assert 'fixed BUG-001' in seen['a'] and 'fixed BUG-002' in seen['a']


# ----------------------------------------------------------------------------
# Characterisation reuse
# ----------------------------------------------------------------------------

def test_reuse_fires_for_a_second_bug_in_the_same_file_of_the_same_chunk(tmp_path):
    """Bug-wise tasks re-characterise the same file once per bug. That is what
    reuse exists to claw back -- and it is only sound because the artefacts are
    already on disk in this chunk's own tree."""
    script = Script()
    d, _t, _r = _build(tmp_path, script)
    rep = d.run()
    assert script.steps('A01') == [('characterise', 'BUG-001'),
                                   ('fix', 'BUG-001'),
                                   ('fix', 'BUG-002')]
    a01 = [c for c in rep['phases'][0]['chunks'] if c['chunk_id'] == 'A01'][0]
    assert a01['tasks'][1]['reused_from'] == 'BUG-001'
    assert a01['tasks'][1]['characterised'] is False
    assert rep['characterisations_reused'] == 1
    assert rep['characterisations_paid'] == 4


def test_reuse_does_not_cross_a_chunk_boundary(tmp_path):
    """The map guarantees no file is in two chunks, so a cross-chunk reuse could
    only ever hand one chunk another chunk's oracle -- in another tree. Every
    chunk starts with an empty characterisation map."""
    script = Script()
    d, _t, _r = _build(tmp_path, script)
    rep = d.run()
    for phase in rep['phases']:
        for c in phase['chunks']:
            assert c['tasks'][0]['characterised'] is True
            assert c['tasks'][0]['reused_from'] is None
    reused = [(c['chunk_id'], t['bug_id'], t['reused_from'])
              for p in rep['phases'] for c in p['chunks'] for t in c['tasks']
              if t['reused_from']]
    assert reused == [('A01', 'BUG-002', 'BUG-001')]


def test_reuse_does_not_fire_for_a_different_file(tmp_path):
    doc = _map_doc()
    # A01 now owns two files, one bug each: same chunk, different files.
    doc['brackets'][0]['chunks'][0]['files'] = ['lib/a.ts', 'lib/b.ts']
    doc['brackets'][0]['chunks'][0]['tasks'] = [
        {'bug_id': 'BUG-001', 'file': 'lib/a.ts', 'line': 1, 'class': 'Crypto'},
        {'bug_id': 'BUG-003', 'file': 'lib/b.ts', 'line': 1, 'class': 'AuthZ'}]
    doc['brackets'][0]['chunks'].pop(1)
    doc['brackets'][0]['chunks'][0]['tasks'].append(
        {'bug_id': 'BUG-002', 'file': 'lib/a.ts', 'line': 1, 'class': 'Crypto'})
    doc['chunk_count'] = 3
    script = Script()
    d, _t, _r = _build(tmp_path, script, doc=doc)
    rep = d.run()
    a01 = [c for c in rep['phases'][0]['chunks'] if c['chunk_id'] == 'A01'][0]
    by_bug = {t['bug_id']: t for t in a01['tasks']}
    assert by_bug['BUG-003']['reused_from'] is None       # different file, paid
    assert by_bug['BUG-002']['reused_from'] == 'BUG-001'  # same file, reused


def test_reuse_can_be_turned_off_so_the_saving_can_be_measured(tmp_path):
    script = Script()
    d, _t, _r = _build(tmp_path, script, reuse_characterisation=False)
    rep = d.run()
    assert rep['characterisations_reused'] == 0
    assert rep['characterisations_paid'] == 5
    assert script.steps('A01') == [('characterise', 'BUG-001'),
                                   ('fix', 'BUG-001'),
                                   ('characterise', 'BUG-002'),
                                   ('fix', 'BUG-002')]


def test_a_reused_prompt_says_so_and_says_why_that_is_weaker(tmp_path):
    script = Script()
    d, _t, _r = _build(tmp_path, script)
    d.run()
    reused = [p for p in script.prompts if 'fix bug BUG-002' in p][0]
    assert 'reused rather than rewritten' in reused
    assert 'BUG-001' in reused


# ----------------------------------------------------------------------------
# Monitoring
# ----------------------------------------------------------------------------

def test_the_cost_ceiling_stops_a_chunk_between_tasks(tmp_path):
    """Between tasks, not mid-invocation: the orchestrator cannot reach into a
    running agent, and pretending otherwise would report a stop it did not make."""
    script = Script()
    d, _t, runner = _build(tmp_path, script, cost_ceiling_usd=0.05)
    runner.cost = 0.10
    rep = d.run()
    stopped = [c for p in rep['phases'] for c in p['chunks'] if c['stopped']]
    assert stopped and all(c['stopped'] == 'cost_ceiling' for c in stopped)
    assert rep['spend_usd'] >= 0.05


def test_a_crashed_chunk_does_not_take_the_phase_down(tmp_path):
    script = Script()

    def seed(trunk, dest):
        if dest.endswith('A02'):
            raise RuntimeError('disk full')
        workspace.prepare(trunk, dest, None, force=True,
                          exclude=dispatcher.SEED_EXCLUDES)

    d, trunk, _r = _build(tmp_path, script, seed_tree=seed)
    rep = d.run()
    chunks = {c['chunk_id']: c for c in rep['phases'][0]['chunks']}
    assert chunks['A02']['stopped'].startswith('crash')
    assert 'fixed BUG-001' in _read(trunk, 'lib/a.ts')     # siblings unaffected
    # It is not silently absent from the denominator, and it is not submitted.
    assert 'A02' not in rep['phases'][0]['merge']['merge_order']


# ----------------------------------------------------------------------------
# Merging and the boundary
# ----------------------------------------------------------------------------

def test_a_declared_out_of_boundary_write_merges_last(tmp_path):
    """A01 sorts first. It reaches into the shared extension zone, declares it,
    and therefore goes to the back of its phase's queue."""
    script = Script(extra={'BUG-001': {'views/v.pug': 'p csrf token\n'}},
                    declare={'A01': ['views/v.pug']})
    d, trunk, _r = _build(tmp_path, script)
    rep = d.run()
    merge = rep['phases'][0]['merge']
    assert merge['merge_order'] == ['A02', 'B01', 'A01']
    assert merge['declared_out_of_boundary'] == {'A01': ['views/v.pug']}
    a01 = [c for c in rep['phases'][0]['chunks'] if c['chunk_id'] == 'A01'][0]
    assert a01['boundary_review']['declared'] == ['views/v.pug']
    assert a01['boundary_review']['clean'] is True
    assert 'csrf token' in _read(trunk, 'views/v.pug')


def test_an_undeclared_out_of_boundary_write_is_recorded_not_dropped(tmp_path):
    script = Script(extra={'BUG-001': {'views/v.pug': 'p sneaky\n'}})
    d, trunk, _r = _build(tmp_path, script)
    rep = d.run()
    a01 = [c for c in rep['phases'][0]['chunks'] if c['chunk_id'] == 'A01'][0]
    assert a01['boundary_review']['undeclared'] == ['views/v.pug']
    assert a01['boundary_review']['clean'] is False
    assert rep['phases'][0]['merge']['merge_order'][-1] == 'A01'
    assert 'sneaky' in _read(trunk, 'views/v.pug')        # applied, and named


def test_declarations_are_read_from_the_agents_own_artefact(tmp_path):
    tree = str(tmp_path / 't')
    _write(os.path.join(tree, workspace.scratch_rel('A01'), 'declarations.json'),
           json.dumps({'files': [{'file': 'views/v.pug', 'reason': 'token'},
                                 'config/x.yml']}))
    assert dispatcher.read_declarations(tree, 'A01') == [
        {'file': 'views/v.pug', 'reason': 'token'},
        {'file': 'config/x.yml', 'reason': ''}]
    assert dispatcher.read_declarations(tree, 'B01') == []


def test_every_chunks_work_reaches_the_trunk(tmp_path):
    script = Script()
    d, trunk, _r = _build(tmp_path, script)
    rep = d.run()
    assert rep['rejected_total'] == 0
    assert 'fixed BUG-001' in _read(trunk, 'lib/a.ts')
    assert 'fixed BUG-002' in _read(trunk, 'lib/a.ts')
    assert 'fixed BUG-003' in _read(trunk, 'lib/b.ts')
    assert 'fixed BUG-004' in _read(trunk, 'frontend/src/f.ts')
    assert 'fixed BUG-005' in _read(trunk, 'routes/c.ts')


def test_a_rejected_merge_does_not_poison_the_chunks_behind_it(tmp_path):
    """The build gate is the merge queue's only test, and a chunk it rejects is
    rolled back before the next one is applied."""
    script = Script()

    def build(tree):
        ok = 'fixed BUG-003' not in _read(tree, 'lib/b.ts')
        return ok, 'tsc: nope'

    d, trunk, _r = _build(tmp_path, script, build_gate=build)
    rep = d.run()
    merge = rep['phases'][0]['merge']
    assert [e['chunk_id'] for e in merge['rejected']] == ['A02']
    assert 'fixed BUG-003' not in _read(trunk, 'lib/b.ts')
    assert 'fixed BUG-001' in _read(trunk, 'lib/a.ts')
    assert 'fixed BUG-004' in _read(trunk, 'frontend/src/f.ts')


# ----------------------------------------------------------------------------
# What the orchestrator does NOT do
# ----------------------------------------------------------------------------

def test_the_orchestrator_runs_no_patcher_gate_only_the_build(tmp_path):
    """One build per accepted submission, and nothing else. No workflow test, no
    probe, no per-chunk regression net -- that judgement moved into the agent."""
    builds = []
    script = Script()
    d, _t, _r = _build(tmp_path, script,
                       build_gate=lambda tree: (builds.append(tree), (True, ''))[1])
    d.run()
    assert len(builds) == 4          # A01, A02, B01 in phase 0; C01 in phase 1


def test_the_full_suite_runs_once_after_the_last_phase(tmp_path):
    runs = []
    script = Script()
    d, _t, _r = _build(tmp_path, script)
    d.final_suite = lambda tree: runs.append(tree) or {'ran': True}
    rep = d.run()
    assert len(runs) == 1
    assert rep['full_suite'] == {'ran': True}


def test_a_partial_run_does_not_claim_the_suite_passed(tmp_path):
    """A suite that did not run is recorded as null, never as an empty pass."""
    script = Script()
    d, _t, _r = _build(tmp_path, script)
    rep = d.run(phases=[0])
    assert rep['full_suite'] is None
    assert rep['phase_order'] == [0]


def test_an_unconfigured_suite_is_null_rather_than_invented(tmp_path):
    script = Script()
    d, _t, _r = _build(tmp_path, script)
    d.final_suite = None                       # and CFG has no commands.full_suite
    assert d.run()['full_suite'] is None


def test_the_default_build_gate_is_a_typecheck_not_a_test_run():
    gate = mq.typecheck_gate({'commands': {'typecheck': 'false'}, 'timeouts': {}})
    assert callable(gate)
