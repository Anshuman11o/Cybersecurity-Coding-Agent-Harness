"""v3 dispatcher: spawn, monitor, merge, advance -- and nothing else.

Driven end to end by `agent.FakeRunner`. No network, no model, no money. What is
under test is the orchestration, which is the whole of what v3 changed:

  - one agent per chunk, all with the same generic prompt
  - a chunk's tasks run strictly in order, in its own tree
  - phases advance only when the previous phase has merged
  - characterisation reuse fires within one chunk and one file, and nowhere else
  - a chunk that reached outside its boundary merges last
  - the orchestrator runs no patcher gate; the full suite runs once, at the end

And -- because v3 changed only the OUTSIDE of a task -- that the inner loop's
recorded facts survived the move: every bug still ends with one of
`ARCHITECTURE.md` §2's seven dispositions, `fixed` is still distinguished from
`fixed_workflow_only`, and every green outcome is labelled as the self-report it
now is.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import agent  # noqa: E402
import workspace  # noqa: E402
from v3 import chunk_map, dispatcher  # noqa: E402
from v3 import merge_queue as mq  # noqa: E402

HOOK = os.path.join(os.path.dirname(__file__), '..', 'hooks', 'sandbox_guard.py')

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
                            # A DIFFERENT line in the same file. Two bugs at one
                            # file:line is what `already_remediated` is for, and
                            # a fixture that trips it by accident would hide it.
                            {'bug_id': 'BUG-002', 'file': 'lib/a.ts', 'line': 7,
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
    {'bug_id': 'BUG-002', 'location': {'file': 'lib/a.ts', 'line': 7},
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
    """Records every step, and performs the filesystem effects a real agent would.

    The defaults describe the well-behaved agent: three artefacts written, the
    probe demonstrating the defect, a source edit, an attestation claiming a fix.
    Every knob below turns one of those off, because each of them is a way a real
    run goes wrong and the record has to say which.
    """

    def __init__(self, *, edit=True, extra=None, declare=None, probe=None,
                 status=None, no_attestation=(), no_artefacts=(), fail=()):
        self.calls = []            # (step, bug_id, file, chunk_tree)
        self.prompts = []
        self.edit = edit
        self.extra = extra or {}   # bug_id -> {rel: text} written on the fix step
        self.declare = declare or {}   # chunk_id -> [rel, ...]
        self.probe = probe or {}       # bug_id -> 'PROVEN' | 'NOT_PROVEN'
        self.status = status or {}     # bug_id -> 'fixed' | 'not_fixed'
        self.no_attestation = set(no_attestation)   # bug ids that write none
        self.no_artefacts = set(no_artefacts)       # bug ids that characterise nothing
        self.fail = set(fail)                       # (step, bug_id) that return not-ok

    def __call__(self, prompt, phase, task_id, cwd):
        m = STEP.search(prompt)
        assert m, prompt[:400]
        step, bug_id, rel = m.group(1), m.group(2), m.group(3)
        self.calls.append((step, bug_id, rel, cwd))
        self.prompts.append(prompt)
        scratch = os.path.join(cwd, workspace.scratch_rel(task_id))
        if step == 'characterise':
            if bug_id in self.no_artefacts:
                return (step, bug_id) not in self.fail
            os.makedirs(scratch, exist_ok=True)
            for name in ('workflow.test.ts', 'exploit.probe.ts'):
                _write(os.path.join(scratch, name), f'// {bug_id}\n')
            _write(os.path.join(scratch, 'characterisation.json'),
                   json.dumps({'bug_id': bug_id,
                               'workflow_test_written': True,
                               'workflow_test_passes_now': True,
                               'probe_written': True,
                               'probe_result_now': self.probe.get(bug_id, 'PROVEN'),
                               'related_test_files': []}))
            return (step, bug_id) not in self.fail
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
        if bug_id not in self.no_attestation:
            _write(os.path.join(scratch, 'attestation.json'),
                   json.dumps({'bug_id': bug_id,
                               'status': self.status.get(bug_id, 'fixed'),
                               'confidence': 0.8, 'rounds_used': 1}))
        return (step, bug_id) not in self.fail

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


def _build(tmp_path, script, *, doc=None, bugs=None, **kw):
    trunk = str(tmp_path / 'trunk')
    for rel, src in TRUNK_FILES.items():
        _write(os.path.join(trunk, rel), src)
    cmap = chunk_map.parse(doc or _map_doc())
    runner = Runner(behaviour=script)
    d = dispatcher.Dispatcher(
        cmap, bugs=bugs or BUGS, playbook=None, runner=runner, trunk=trunk,
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


# ----------------------------------------------------------------------------
# The inner loop survived the move: the sandbox phases
# ----------------------------------------------------------------------------

def test_the_phase_names_are_the_ones_the_sandbox_hook_actually_accepts():
    """The phase string is not a label -- it is the hook's argument.

    `sandbox_guard.py` declares `--phase` with a closed choice list, and its two
    phase-dependent rules key off these exact strings: source is read-only in
    `characterise`, and the gate artefacts are frozen in `fix`. A v3-specific
    name parsed as nothing, so the guard exited on argparse having written no
    decision at all -- the whole of the loop's hook enforcement, silently absent
    from the fork. Same shape as the v2 denylist incident.
    """
    for phase in (dispatcher.CHARACTERISE_PHASE, dispatcher.PATCH_PHASE):
        p = subprocess.run(
            [sys.executable, HOOK, '--tree', '/tmp', '--log', '/tmp/v3-guard.jsonl',
             '--phase', phase, '--task', 'A01-BUG-001'],
            input='{}', capture_output=True, text=True)
        assert p.returncode == 0, f'{phase}: rc={p.returncode} {p.stderr[:200]}'
        assert json.loads(p.stdout)['hookSpecificOutput']


def test_characterisation_is_source_read_only_and_the_fix_phase_cannot_edit_its_oracle():
    """The two properties those phase names buy, asserted through the guard."""
    import sandbox_guard
    src = sandbox_guard.check_path(
        'lib/a.ts', '/tmp/tree', '/tmp/tree', writing=True,
        phase=dispatcher.CHARACTERISE_PHASE, task='A01-BUG-001',
        extra_path_patterns=())
    assert not src.allow and src.kind == 'source_edited_in_characterise'

    oracle = sandbox_guard.check_path(
        f'{workspace.SCRATCH_DIRNAME}/A01-BUG-001/workflow.test.ts',
        '/tmp/tree', '/tmp/tree', writing=True, phase=dispatcher.PATCH_PHASE,
        task='A01-BUG-001', extra_path_patterns=())
    assert not oracle.allow and oracle.kind == 'gate_artefact_edit'


def test_a_source_edit_that_slips_through_characterisation_is_reverted_and_recorded(
        tmp_path):
    class Sneaky(Script):
        def __call__(self, prompt, phase, task_id, cwd):
            if 'characterise bug BUG-003' in prompt:
                _append(os.path.join(cwd, 'lib/b.ts'), '// early edit\n')
            return super().__call__(prompt, phase, task_id, cwd)

    d, _t, _r = _build(tmp_path, Sneaky())
    rep = d.run()
    rec = _by_bug(rep)['BUG-003']
    assert [v['kind'] for v in rec['violations']] == ['source_edited_in_characterise']
    assert 'early edit' not in _read(d.chunk_tree('A02'), 'lib/b.ts')


# ----------------------------------------------------------------------------
# The inner loop survived the move: dispositions
# ----------------------------------------------------------------------------

def _tasks(rep):
    return [t for p in rep['phases'] for c in p['chunks'] for t in c['tasks']]


def _by_bug(rep):
    return {t['bug_id']: t for t in _tasks(rep)}


def test_every_bug_ends_with_one_of_the_seven_dispositions_and_says_what_it_rests_on(
        tmp_path):
    """v3 changed who runs the gates. It did not change that a task terminates."""
    d, _t, _r = _build(tmp_path, Script())
    rep = d.run()
    recs = _tasks(rep)
    assert len(recs) == 5 == rep['tasks_total']
    for r in recs:
        assert r['disposition'] in dispatcher.DISPOSITIONS
        assert r['disposition_basis'] in ('measured', 'attested')
        assert r['location']['file'] and r['location']['line']
    assert rep['dispositions']['fixed'] == 4
    assert rep['dispositions']['fixed_workflow_only'] == 1     # BUG-002, reused probe
    assert rep['disposition_basis'] == {'measured': 0, 'attested': 5}


def test_a_green_v3_disposition_is_labelled_a_self_report_not_a_measurement(tmp_path):
    """v1's `fixed` was measured by the orchestrator. v3's is the agent's word.

    Emitting them under one unqualified name would let a v3 row be pooled with a
    v1 row in `docs/benchmarking-results.md`, where each row cost a paid run.
    """
    d, _t, _r = _build(tmp_path, Script())
    rep = d.run()
    rec = _by_bug(rep)['BUG-001']
    assert rec['disposition'] == 'fixed'
    assert rec['disposition_basis'] == 'attested'
    assert rec['measured']['rounds'] == []
    assert rec['measured']['rounds_to_green'] is None
    assert rec['measured']['gates_run'] == 0
    assert rec['measured']['characterisation']['probe_proven_pre_fix'] is None
    assert rec['attested_characterisation']['probe_proven_pre_fix'] is True
    assert rep['per_task_gates_run'] == 0


def test_a_probe_that_never_proved_the_defect_is_never_reported_as_fixed(tmp_path):
    """`fixed` and `fixed_workflow_only` are not summed. Folding them is the
    false-confidence failure EVAL-METRICS.md exists to catch, and in v3 the
    probe verdict is the only thing that separates them."""
    d, _t, _r = _build(tmp_path, Script(probe={'BUG-003': 'NOT_PROVEN'}))
    rep = d.run()
    rec = _by_bug(rep)['BUG-003']
    assert rec['disposition'] == 'fixed_workflow_only'
    assert 'never demonstrated the defect' in rec['disposition_reason']
    assert rep['dispositions']['fixed'] == 3
    assert rep['dispositions']['fixed_workflow_only'] == 2


def test_a_reused_oracle_cannot_produce_a_bare_fixed(tmp_path):
    """The reuse trade, made a consequence rather than a sentence in a prompt.

    BUG-002's probe was written while characterising BUG-001. It printed PROVEN
    for that defect, which is not evidence about this one, so the remediation
    axis stays unverified.
    """
    d, _t, _r = _build(tmp_path, Script())
    rep = d.run()
    rec = _by_bug(rep)['BUG-002']
    assert rec['reused_from'] == 'BUG-001'
    assert rec['disposition'] == 'fixed_workflow_only'
    assert rec['attested_characterisation']['probe_proven_pre_fix'] is False
    assert rec['attested_characterisation']['reused_from'] == 'BUG-001'
    # The oracle is another task's, but it is on disk and is what this task was
    # measured against; recording it as absent would read as a blocked task.
    assert rec['measured']['characterisation']['workflow_test_written'] is True
    assert rec['measured']['characterisation']['attempts'] == 0      # nothing paid


def test_a_probe_that_will_not_fire_where_an_earlier_fix_landed_is_already_remediated(
        tmp_path):
    """ARCHITECTURE.md §③ G2, and bug-wise tasks make it the common case: a chunk
    IS a file and its bugs, so the second bug at a location the first one already
    changed is ordinary rather than exotic. The task closes with no fix phase."""
    doc = _map_doc()
    doc['brackets'][0]['chunks'][0]['tasks'][1]['line'] = 1      # same file:line
    bugs = [dict(b) for b in BUGS]
    bugs[1] = dict(bugs[1], location={'file': 'lib/a.ts', 'line': 1})
    script = Script(probe={'BUG-002': 'NOT_PROVEN'})
    d, _t, _r = _build(tmp_path, script, doc=doc, bugs=bugs,
                       reuse_characterisation=False)
    rep = d.run()
    rec = _by_bug(rep)['BUG-002']
    assert rec['disposition'] == 'already_remediated'
    assert rec['disposition_basis'] == 'attested'
    assert ('fix', 'BUG-002') not in script.steps('A01')        # no fix phase paid for


def test_a_characterisation_that_writes_nothing_blocks_before_any_fix_is_attempted(
        tmp_path):
    """G3 is a file-system fact, so the dispatcher can still evaluate it, retry it
    and block on it. A fix dispatched against no recorded ground truth would
    produce a change nothing could ever judge."""
    script = Script(no_artefacts={'BUG-004'})
    d, _t, _r = _build(tmp_path, script)
    rep = d.run()
    rec = _by_bug(rep)['BUG-004']
    assert rec['disposition'] == 'blocked'
    assert rec['disposition_basis'] == 'measured'
    assert rec['measured']['characterisation']['attempts'] == 2      # retried once
    assert script.steps('B01') == [('characterise', 'BUG-004'),
                                   ('characterise', 'BUG-004')]


def test_a_fix_invocation_that_did_not_return_is_agent_failed_and_its_edits_go_back(
        tmp_path):
    """Liveness is measured, and it is one of the few things v3 measures. A
    half-finished edit with no attestation must not ride along in a submission
    the merge queue accepts whole."""
    d, trunk, _r = _build(tmp_path, Script(fail={('fix', 'BUG-005')}))
    rep = d.run()
    rec = _by_bug(rep)['BUG-005']
    assert rec['disposition'] == 'agent_failed'
    assert rec['disposition_basis'] == 'measured'
    assert rec['diff_stats']['files_touched'] == []
    assert 'fixed BUG-005' not in _read(trunk, 'routes/c.ts')


def test_a_fix_that_wrote_no_attestation_is_agent_failed(tmp_path):
    d, _t, _r = _build(tmp_path, Script(no_attestation={'BUG-003'}))
    rep = d.run()
    rec = _by_bug(rep)['BUG-003']
    assert rec['disposition'] == 'agent_failed'
    assert 'attestation.json' in rec['disposition_reason']


def test_an_attested_fix_that_changed_no_source_file_is_not_a_fix(tmp_path):
    """Where the agent's claim and the measurement disagree, the measurement wins
    in the record and the disagreement is itself recorded."""
    d, _t, _r = _build(tmp_path, Script(edit=False))
    rep = d.run()
    rec = _by_bug(rep)['BUG-001']
    assert rec['disposition'] == 'abandoned'
    assert rec['disposition_basis'] == 'measured'
    assert rec['attestation_delta']['kind'] == 'overclaim'
    assert rep['dispositions']['fixed'] == 0
    assert rep['attestation_overclaims'] == 5


def test_not_fixed_with_work_retained_is_partial_not_abandoned(tmp_path):
    d, _t, _r = _build(tmp_path, Script(status={'BUG-003': 'not_fixed'}))
    rep = d.run()
    rec = _by_bug(rep)['BUG-003']
    assert rec['disposition'] == 'partial'
    assert rec['attested']['status'] == 'not_fixed'
    assert rec['diff_stats']['files_touched']


def test_diff_stats_are_per_task_not_per_chunk(tmp_path):
    """A chunk is an ordered run of many fixes in one tree. Without a per-task
    baseline, BUG-002's record would claim BUG-001's lines as well."""
    d, _t, _r = _build(tmp_path, Script())
    rep = d.run()
    by_bug = _by_bug(rep)
    assert by_bug['BUG-001']['diff_stats']['lines_added'] == 1
    assert by_bug['BUG-002']['diff_stats']['lines_added'] == 1


# ----------------------------------------------------------------------------
# The denominator
# ----------------------------------------------------------------------------

def test_a_bug_the_chunk_never_reached_is_still_in_the_denominator(tmp_path):
    """A cost ceiling that silently dropped the remaining bugs would make the run
    read as a BETTER result than it was -- the same failure `chunk_map` refuses a
    map for."""
    d, _t, runner = _build(tmp_path, Script(), cost_ceiling_usd=0.05)
    runner.cost = 0.10
    rep = d.run()
    assert rep['tasks_total'] == 5
    unreached = [t for t in _tasks(rep) if not t['attempted']]
    assert unreached
    for t in unreached:
        assert t['disposition'] == 'blocked'
        assert 'cost_ceiling' in t['disposition_reason']


def test_a_crashed_chunk_keeps_its_bugs_in_the_denominator(tmp_path):
    def seed(trunk, dest):
        if dest.endswith('A02'):
            raise RuntimeError('disk full')
        workspace.prepare(trunk, dest, None, force=True,
                          exclude=dispatcher.SEED_EXCLUDES)

    d, _t, _r = _build(tmp_path, Script(), seed_tree=seed)
    rep = d.run()
    assert rep['tasks_total'] == 5
    rec = _by_bug(rep)['BUG-003']
    assert rec['disposition'] == 'blocked'
    assert 'crash' in rec['disposition_reason']


def test_a_rejected_merge_leaves_no_task_recorded_as_fixed(tmp_path):
    """The submission was rolled back byte for byte, so nothing in it shipped.
    Counting its tasks as fixed would put work nobody has into the headline."""
    def build(tree):
        return 'fixed BUG-003' not in _read(tree, 'lib/b.ts'), 'tsc: nope'

    d, _t, _r = _build(tmp_path, Script(), build_gate=build)
    rep = d.run()
    rec = _by_bug(rep)['BUG-003']
    assert rec['merge_verdict'] == 'rejected'
    assert rec['disposition'] == 'abandoned'
    assert rec['disposition_basis'] == 'measured'
    assert rec['disposition_before_merge'] == 'fixed'
    assert rep['tasks_merge_rejected'] == 1
    assert _by_bug(rep)['BUG-001']['merge_verdict'] == 'accepted'
