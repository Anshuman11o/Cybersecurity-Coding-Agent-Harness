"""The state machine, driven end to end with a fake agent and a fake app.

The gate commands are configurable, so the whole loop can be exercised with
Python scripts standing in for the Node toolchain. That is not a shortcut: it is
the same substitution the architecture claims to support, and running it here
proves the orchestrator has no hidden dependency on the target's runtime.

The fake application has two markers in one source file:

    VULN     present  -> the probe prints PROVEN      (vulnerability is live)
    FEATURE  present  -> the workflow test passes     (the feature works)

Which gives every square of the 2x2 the eval cares about, and lets each scripted
agent be one line of intent.
"""
import json
import os

import pytest

import task_loop
import workspace
from agent import FakeRunner

SRC = 'routes/search.ts'

WORKFLOW_TEST = '''\
import sys, pathlib
src = pathlib.Path("routes/search.ts").read_text()
if "FEATURE" in src:
    print("ok 1 - search returns matching products")
    sys.exit(0)
print("not ok 1 - search returns matching products")
sys.exit(1)
'''

EXPLOIT_PROBE = '''\
import pathlib
src = pathlib.Path("routes/search.ts").read_text()
print("PROVEN" if "VULN" in src else "NOT_PROVEN")
'''

RELATED_TEST = '''\
import sys, pathlib
src = pathlib.Path("routes/search.ts").read_text()
if "FEATURE" in src:
    print("ok 1 - product listing still works")
    sys.exit(0)
print("not ok 1 - product listing still works")
sys.exit(1)
'''

CHARACTERISATION = {
    'bug_id': 'BUG-001',
    'correct_behaviour': 'search returns matching products',
    'defect_mechanism': 'input concatenated into the query',
    'workflow_test_written': True,
    'workflow_test_passes_now': True,
    'probe_written': True,
    'probe_result_now': 'PROVEN',
    'related_test_files': ['test/api/search.test.ts'],
    'intended_change': 'parameterise the query',
    'risk_to_workflow': 'a too-strict filter could reject valid searches',
}

BUG = {
    'bug_id': 'BUG-001',
    'location': {'file': SRC, 'line': 19},
    'owasp': [{'code': 'A03', 'title': 'Injection'}],
    'class': 'Injection / SQL',
    'vulnerability': 'User input is concatenated into a SQL string.',
    'reproduction': 'Send a crafted q parameter.',
}

PLAYBOOK = {'playbook_id': 'pb', 'entries': [
    {'entry_id': 'a03', 'owasp_codes': ['A03'], 'guidance': 'Parameterise queries.'}]}


@pytest.fixture
def env(tmp_path):
    base = tmp_path / 'base'
    (base / 'routes').mkdir(parents=True)
    (base / 'test' / 'api').mkdir(parents=True)
    (base / SRC).write_text('// VULN FEATURE\nexport const search = () => {}\n')
    (base / 'test' / 'api' / 'search.test.ts').write_text(RELATED_TEST)
    (base / 'package.json').write_text('{"name":"fake"}')

    tree = str(tmp_path / 'tree')
    workspace.prepare(str(base), tree)

    run_dir = str(tmp_path / 'run')
    os.makedirs(run_dir, exist_ok=True)

    cfg = {
        'run_id': 't',
        'commands': {
            'typecheck': 'python3 -c "pass"',
            'run_test_file': 'python3 {file}',
            'run_server_test_file': 'python3 {file}',
            'run_probe': 'python3 {file}',
            'timeout_s': {'typecheck': 60, 'test_file': 60, 'probe': 60},
        },
        'loop': {'characterise_rounds': 2, 'reconcile_rounds': 3, 'max_task_wall_s': 600},
        'policy': {'on_exhausted': 'revert', 'require_probe': False,
                   'regression_net': 'related'},
    }
    return cfg, tree, run_dir


def _write_scratch(tree, task_id, *, workflow=WORKFLOW_TEST, probe=EXPLOIT_PROBE,
                   characterisation=CHARACTERISATION):
    d = workspace.ensure_scratch(tree, task_id)
    if workflow is not None:
        open(os.path.join(d, 'workflow.test.ts'), 'w').write(workflow)
    if probe is not None:
        open(os.path.join(d, 'exploit.probe.ts'), 'w').write(probe)
    if characterisation is not None:
        json.dump(characterisation, open(os.path.join(d, 'characterisation.json'), 'w'))


def _attest(tree, task_id, status='fixed', confidence=0.9, rounds=0):
    d = workspace.ensure_scratch(tree, task_id)
    json.dump({'bug_id': task_id, 'status': status, 'confidence': confidence,
               'what_changed': 'x', 'why_it_closes_the_path': 'y',
               'why_the_workflow_still_works': 'z', 'residual_risk': None,
               'rounds_used': rounds},
              open(os.path.join(d, 'attestation.json'), 'w'))


def _src(tree):
    return os.path.join(tree, SRC)


def _set_markers(tree, *, vuln, feature):
    marks = ' '.join(m for m, on in (('VULN', vuln), ('FEATURE', feature)) if on)
    open(_src(tree), 'w').write(f'// {marks}\nexport const search = () => {{}}\n')


def ctx_for(cfg, tree, run_dir, behaviour):
    return task_loop.TaskContext(cfg, tree, FakeRunner(behaviour=behaviour),
                                 PLAYBOOK, run_dir, log=lambda *_: None)


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------

def test_clean_fix_goes_green_in_round_zero(env):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=False, feature=True)     # the correct fix
            _attest(tree, task_id)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'fixed'
    assert rec['measured']['rounds_to_green'] == 0
    assert rec['measured']['characterisation']['workflow_green_pre_fix']
    assert rec['measured']['characterisation']['probe_proven_pre_fix']
    assert rec['measured']['final_gates'] == {
        'typecheck': 'pass', 'workflow': 'pass',
        'probe_blocked': 'pass', 'no_regression': 'pass'}
    assert 'VULN' not in open(_src(tree)).read()


def test_related_tests_are_discovered_and_baselined(env):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=False, feature=True)
            _attest(tree, task_id)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert 'test/api/search.test.ts' in rec['measured']['characterisation'][
        'related_test_files']


# ---------------------------------------------------------------------------
# Fixing by deleting the feature -- the failure mode the loop exists to catch
# ---------------------------------------------------------------------------

def test_destructive_fix_is_caught_and_reconciled(env):
    cfg, tree, run_dir = env
    state = {'round': 0}

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
            return True
        if state['round'] == 0:
            _set_markers(tree, vuln=False, feature=False)     # deleted the feature
        else:
            _set_markers(tree, vuln=False, feature=True)      # reconciled properly
        _attest(tree, task_id, rounds=state['round'])
        state['round'] += 1
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'fixed'
    assert rec['measured']['rounds_to_green'] == 1
    r0 = rec['measured']['rounds'][0]
    assert not r0['green']
    kinds = {f['kind'] for f in r0['failures']}
    # Both the agent's own workflow test and the related existing test noticed.
    assert 'workflow_broken' in kinds and 'regression' in kinds


def test_reconcile_prompt_carries_the_real_failure(env):
    cfg, tree, run_dir = env
    seen = {}

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
            return True
        if phase == 'reconcile':
            seen['prompt'] = prompt
            _set_markers(tree, vuln=False, feature=True)
        else:
            _set_markers(tree, vuln=False, feature=False)
        _attest(tree, task_id)
        return True

    task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    p = seen['prompt']
    assert 'search returns matching products' in p      # the actual failing assertion
    assert 'diff' in p and 'correct_behaviour' in p     # diff + the recorded baseline
    assert 'frozen' in p or 'Forbidden' in p            # the gates cannot be edited


# ---------------------------------------------------------------------------
# Running out of budget
# ---------------------------------------------------------------------------

def test_exhausted_budget_reverts_by_default(env):
    cfg, tree, run_dir = env
    before = open(_src(tree)).read()

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=False, feature=False)   # never reconciles
            _attest(tree, task_id, status='fixed', confidence=0.95)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'abandoned'
    assert len(rec['measured']['rounds']) == cfg['loop']['reconcile_rounds'] + 1
    # The tree is exactly as the task found it: damage must not reach later tasks.
    assert open(_src(tree)).read() == before
    assert rec['diff_stats']['lines_added'] == 0


def test_keep_if_workflow_intact_banks_a_harmless_attempt(env):
    cfg, tree, run_dir = env
    cfg['policy']['on_exhausted'] = 'keep_if_workflow_intact'

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            # Feature intact, vulnerability untouched: uncertain, but harmless.
            _set_markers(tree, vuln=True, feature=True)
            open(_src(tree), 'a').write('// attempted hardening\n')
            _attest(tree, task_id, status='not_fixed', confidence=0.2)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'partial'
    assert 'attempted hardening' in open(_src(tree)).read()


def test_keep_if_workflow_intact_reverts_real_damage(env):
    cfg, tree, run_dir = env
    cfg['policy']['on_exhausted'] = 'keep_if_workflow_intact'
    before = open(_src(tree)).read()

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=False, feature=False)
            _attest(tree, task_id)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'abandoned'
    assert open(_src(tree)).read() == before


def test_keep_best_prefers_preservation_over_remediation(env):
    """A change that closes the attack by breaking the feature must never win."""
    cfg, tree, run_dir = env
    cfg['policy']['on_exhausted'] = 'keep_best'
    state = {'n': 0}

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
            return True
        # round 0: vuln closed but feature destroyed
        # rounds 1+: feature intact, vuln still live
        _set_markers(tree, vuln=state['n'] > 0, feature=state['n'] > 0)
        _attest(tree, task_id)
        state['n'] += 1
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'partial'
    assert 'FEATURE' in open(_src(tree)).read()


# ---------------------------------------------------------------------------
# Characterisation gates
# ---------------------------------------------------------------------------

def test_no_workflow_test_blocks_the_task_before_any_fix(env):
    """Without a damage detector, a fix cannot be distinguished from a demolition."""
    cfg, tree, run_dir = env
    before = open(_src(tree)).read()
    runner = FakeRunner(behaviour=lambda p, ph, t, c: _write_scratch(
        tree, t, workflow=None) or True)
    ctx = task_loop.TaskContext(cfg, tree, runner, PLAYBOOK, run_dir, log=lambda *_: None)

    rec = task_loop.run_task(BUG, 0, ctx)
    assert rec['disposition'] == 'blocked'
    assert 'workflow test' in rec['disposition_reason']
    assert open(_src(tree)).read() == before
    assert not any(p == 'fix' for p, _ in runner.invocations)


def test_red_workflow_test_is_retried_then_blocks(env):
    cfg, tree, run_dir = env
    runner = FakeRunner(behaviour=lambda p, ph, t, c: _write_scratch(
        tree, t, workflow='import sys; print("not ok 1 - x"); sys.exit(1)') or True)
    ctx = task_loop.TaskContext(cfg, tree, runner, PLAYBOOK, run_dir, log=lambda *_: None)

    rec = task_loop.run_task(BUG, 0, ctx)
    assert rec['disposition'] == 'blocked'
    assert rec['measured']['characterisation']['attempts'] == 2


def test_source_edited_during_characterisation_is_reverted(env):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
            _set_markers(tree, vuln=False, feature=True)   # jumped the gun
        else:
            _set_markers(tree, vuln=False, feature=True)
            _attest(tree, task_id)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    kinds = {v['kind'] for v in rec['violations']}
    assert 'source_edited_in_characterise' in kinds
    assert all(v['auto_reverted'] for v in rec['violations']
               if v['kind'] == 'source_edited_in_characterise')


def test_unprovable_probe_still_attempts_the_fix(env):
    """The report is stipulated accurate: an unprovable probe is the agent's
    limit, not evidence of a non-bug."""
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id, probe='print("NOT_PROVEN")')
        else:
            _set_markers(tree, vuln=False, feature=True)
            _attest(tree, task_id)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'fixed_workflow_only'
    assert rec['measured']['final_gates']['probe_blocked'] == 'skipped'
    assert not rec['measured']['characterisation']['probe_proven_pre_fix']


def test_require_probe_blocks_when_set(env):
    cfg, tree, run_dir = env
    cfg['policy']['require_probe'] = True

    def behave(prompt, phase, task_id, cwd):
        _write_scratch(tree, task_id, probe='print("NOT_PROVEN")')
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'blocked'


def test_probe_with_unreadable_output_is_an_error_not_a_pass(env):
    """Treating an unreadable probe as a pass is exactly the false confidence
    the eval is built to detect."""
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=False, feature=True)
            # probe now crashes rather than answering
            open(os.path.join(workspace.scratch_abs(tree, task_id),
                              'exploit.probe.ts'), 'w').write('raise SystemExit(3)')
            _attest(tree, task_id)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'abandoned'
    assert rec['measured']['final_gates']['probe_blocked'] == 'error'


def test_shared_location_already_closed_by_an_earlier_task(env):
    cfg, tree, run_dir = env
    ctx = ctx_for(cfg, tree, run_dir,
                  lambda p, ph, t, c: _write_scratch(
                      tree, t, probe='print("NOT_PROVEN")') or True)
    ctx.touched_locations[f'{SRC}:19'] = 'BUG-000'

    rec = task_loop.run_task(BUG, 0, ctx)
    assert rec['disposition'] == 'already_remediated'
    assert 'BUG-000' in rec['disposition_reason']


# ---------------------------------------------------------------------------
# Attestation vs measurement
# ---------------------------------------------------------------------------

def test_overclaim_is_recorded_but_never_changes_the_verdict(env):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=True, feature=True)      # did nothing
            _attest(tree, task_id, status='fixed', confidence=1.0)
        return True

    rec = task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert rec['disposition'] == 'abandoned'
    assert rec['attested']['status'] == 'fixed'
    assert rec['attestation_delta']['kind'] == 'overclaim'


def test_scratch_is_harvested_and_removed_from_the_tree(env):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=False, feature=True)
            _attest(tree, task_id)
        return True

    task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    assert not os.path.exists(workspace.scratch_abs(tree, 'BUG-001'))
    harvested = os.path.join(run_dir, 'tasks', 'BUG-001', 'artefacts')
    assert os.path.isfile(os.path.join(harvested, 'workflow.test.ts'))
    assert os.path.isfile(os.path.join(harvested, 'characterisation.json'))


def test_agent_artefacts_never_reach_the_deliverable_diff(env, tmp_path):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=False, feature=True)
            _attest(tree, task_id)
        return True

    task_loop.run_task(BUG, 0, ctx_for(cfg, tree, run_dir, behave))
    diff = workspace.diff_against_base(tree, str(tmp_path / 'base'))
    assert 'workflow.test.ts' not in diff
    assert 'exploit.probe.ts' not in diff
    assert SRC in diff
