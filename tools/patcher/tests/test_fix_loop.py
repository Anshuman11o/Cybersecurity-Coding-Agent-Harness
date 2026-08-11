"""The reconcile loop, driven directly: who decides when the agent is finished.

The loop's exit condition is the whole point of it. An agent invoked once and
then asked whether it is done will say that it is, and the record it leaves --
`rounds_used`, a `residual_risk` paragraph, a list of assertions it has decided
are illegitimate -- is a claim about itself, not a measurement of the tree. This
project has already been burned by a self-report: a run reported clean while
twelve of sixteen modules did not exist.

So `run_fix_loop` is an orchestrator loop with three machine-checked exits --
measured green, the round budget, the wall clock -- and the tests below exist to
pin them:

  * the loop keeps going while gates are red and rounds remain, *including* when
    the agent has written down its reasons for the red being acceptable;
  * `rounds_used` counts the rounds this process actually ran, never the number
    in the attestation;
  * the label comes off the gates the orchestrator ran, so an agent that closes
    the vulnerability while breaking the feature is labelled as having done so,
    however confidently it attests otherwise.

Same fake application as `test_task_loop`: one source file with two markers,
VULN (the probe prints PROVEN) and FEATURE (the workflow test passes), which
gives every square of the 2x2 the labels are drawn from.
"""
import json
import os
import time

import pytest

import antioracle
import task_loop
import verify
import workspace
from agent import FakeRunner
from test_task_loop import (ATTACK_DEPENDENT_REL, ATTACK_DEPENDENT_TEST, BUG,
                            TYPECHECK_STUB, _attest, _set_markers, _src,
                            _write_scratch, env)                       # noqa: F401

RELATED_REL = 'test/api/search.test.ts'
TASK_ID = BUG['bug_id']


def _attest_claiming_antioracle(tree, task_id):
    """The attestation that used to be able to end a run: red, and explained.

    The agent reports the failing assertion, calls it attack-dependent, and says
    the residual risk is acceptable. Every field here is honest-looking and none
    of it is checked -- which is exactly why none of it may terminate the loop.
    """
    d = workspace.ensure_scratch(tree, task_id)
    json.dump({'bug_id': task_id, 'status': 'fixed', 'confidence': 0.95,
               'what_changed': 'x', 'why_it_closes_the_path': 'y',
               'why_the_workflow_still_works': 'the assertion is not a real oracle',
               'residual_risk': 'the workflow assertion cannot be satisfied by a '
                                'correct fix, so it is left red',
               'workflow_red': ['search returns matching products'],
               'antioracle_claims': [{'test': 'workflow.test.ts',
                                      'it_title': 'search returns matching products',
                                      'why': 'asserts the attack still lands'}],
               'rounds_used': 1},
              open(os.path.join(d, 'attestation.json'), 'w'))


def _kwargs(cfg, tree, run_dir, behaviour, *, max_rounds=4, deadline=None,
            related=(), probe_expected=True):
    """Everything phase 1 would have established, without running phase 1.

    Characterisation is a separate concern with its own tests; what matters here
    is that the loop is handed a real workflow test, a real probe and a real
    regression baseline, and measures against them.
    """
    related = list(related)
    _write_scratch(tree, TASK_ID)
    scratch = workspace.scratch_rel(TASK_ID)
    log_dir = os.path.join(run_dir, 'tasks', TASK_ID)
    os.makedirs(log_dir, exist_ok=True)

    calls = []

    def build_prompt(round_no, vr, diff):
        calls.append((round_no, vr, diff))
        return f'round {round_no}'

    runner = FakeRunner(behaviour=behaviour)
    kwargs = dict(
        cfg=cfg, tree=tree, task_id=TASK_ID, bug=BUG, runner=runner,
        build_prompt=build_prompt,
        workflow_rel=f'{scratch}/workflow.test.ts',
        probe_rel=f'{scratch}/exploit.probe.ts',
        probe_expected=probe_expected,
        related=related,
        baseline_outcomes=verify.collect_outcomes(cfg, tree, related) if related else {},
        antioracles=antioracle.detect(tree, related),
        max_rounds=max_rounds,
        deadline=time.time() + 600 if deadline is None else deadline,
        log_dir=log_dir, guard_log=os.path.join(run_dir, 'guard.jsonl'),
        snap_path=workspace.snapshot(tree, f'task-{TASK_ID}'),
        attestation_rel=f'{scratch}/attestation.json')
    return kwargs, runner, calls


def _scripted(tree, plan):
    """One entry per round: (vuln, feature) markers, then a plain attestation."""
    state = {'n': 0}

    def behave(prompt, phase, task_id, cwd):
        vuln, feature = plan[min(state['n'], len(plan) - 1)]
        _set_markers(tree, vuln=vuln, feature=feature)
        _attest(tree, task_id)
        state['n'] += 1
        return True
    return behave


def _run(kwargs):
    res = task_loop.run_fix_loop(**kwargs)
    if res.best_snapshot:
        workspace.discard_snapshot(res.best_snapshot)
    return res


# ---------------------------------------------------------------------------
# Reaching green
# ---------------------------------------------------------------------------

def test_a_second_round_reaches_green_and_is_counted_as_two(env):
    cfg, tree, run_dir = env
    # Round 0 closes the defect by deleting the feature; round 1 does it properly.
    kwargs, runner, _ = _kwargs(cfg, tree, run_dir,
                                _scripted(tree, [(False, False), (False, True)]))

    res = _run(kwargs)

    assert res.label == 'green'
    assert res.rounds_used == 2
    assert res.green
    assert [p for p, _ in runner.invocations] == ['fix', 'reconcile']
    assert res.rounds[-1]['round'] == 1
    # Green means green on every axis, measured.
    assert res.gates == {'V1_typecheck': 'pass', 'V2_workflow': 'pass',
                         'V3_probe_blocked': 'pass', 'V4_no_regression': 'skipped'}


def test_the_loop_stops_the_moment_it_measures_green(env):
    cfg, tree, run_dir = env
    kwargs, runner, _ = _kwargs(cfg, tree, run_dir,
                                _scripted(tree, [(False, True)]), max_rounds=4)

    res = _run(kwargs)

    assert res.label == 'green' and res.rounds_used == 1
    assert len(runner.invocations) == 1


# ---------------------------------------------------------------------------
# The regression this whole change exists for
# ---------------------------------------------------------------------------

def test_an_antioracle_claim_never_ends_the_loop(env):
    """The defect being fixed: a self-declared excuse used to be a terminal state.

    The agent closes the vulnerability, leaves a workflow assertion red, and
    writes down that the assertion is attack-dependent and the residual risk is
    accepted. Every word of that may be true. None of it is measured, so it buys
    no early exit: the budget is spent, and the label is what the gates said.
    """
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        _set_markers(tree, vuln=False, feature=False)     # probe closed, workflow red
        _attest_claiming_antioracle(tree, task_id)
        return True

    kwargs, runner, _ = _kwargs(cfg, tree, run_dir, behave, max_rounds=3)

    res = _run(kwargs)

    assert res.rounds_used == 3                     # ran the whole budget
    assert len(runner.invocations) == 3
    assert res.label == 'vuln_only'
    assert not res.green
    # The claim is recorded, so a human can read it -- and acted on by nothing.
    assert res.attestation['antioracle_claims'] == [
        {'test': 'workflow.test.ts',
         'it_title': 'search returns matching products',
         'why': 'asserts the attack still lands'}]
    assert res.attestation['workflow_red'] == ['search returns matching products']
    assert res.gates['V2_workflow'] == 'fail'


def test_rounds_used_is_the_measurement_not_the_attestation(env):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        _set_markers(tree, vuln=False, feature=phase == 'reconcile')
        _attest(tree, task_id, rounds=4)              # the agent claims four
        return True

    kwargs, _, _ = _kwargs(cfg, tree, run_dir, behave, max_rounds=4)

    res = _run(kwargs)

    assert res.rounds_used == 2                       # two were run
    assert res.attestation['rounds_used'] == 4        # recorded, never believed


# ---------------------------------------------------------------------------
# The four squares, off the gates
# ---------------------------------------------------------------------------

def test_exhaustion_with_the_vulnerability_closed_keeps_the_tree(env):
    """A closed defect over a red net is a terminal outcome, not a failure.

    The net is a damage detector, not an oracle: a row that asserts the payload
    was acted upon goes red by construction when the path is closed. The loop
    reports it and changes nothing on disk -- keeping or reverting is the
    caller's policy, and there is no path here that quietly weakens the tree.
    """
    cfg, tree, run_dir = env
    open(os.path.join(tree, ATTACK_DEPENDENT_REL), 'w').write(ATTACK_DEPENDENT_TEST)

    def behave(prompt, phase, task_id, cwd):
        _set_markers(tree, vuln=False, feature=True)
        open(_src(tree), 'a').write('// parameterised\n')
        _attest(tree, task_id)
        return True

    kwargs, _, _ = _kwargs(cfg, tree, run_dir, behave, max_rounds=2,
                           related=[RELATED_REL, ATTACK_DEPENDENT_REL])

    res = _run(kwargs)

    assert res.rounds_used == 2
    assert res.label == 'vuln_only'
    assert res.gates['V3_probe_blocked'] == 'pass'
    assert res.gates['V2_workflow'] == 'pass'
    assert res.gates['V4_no_regression'] == 'fail'
    # The work survives the loop untouched.
    src = open(_src(tree)).read()
    assert '// parameterised' in src and 'VULN' not in src and 'FEATURE' in src


def test_an_excused_row_is_not_red_and_the_loop_invents_no_second_excusal(env):
    """Excusal is `verify.verify`'s decision, made from the tests' own text.

    The loop asks no separate question about which failures count. When the gate
    itself declines to charge a row, the round is green, the loop stops, and the
    excusal is on the record rather than dropped -- an exclusion nobody can see is
    indistinguishable from a gate that was never run.
    """
    cfg, tree, run_dir = env
    open(os.path.join(tree, ATTACK_DEPENDENT_REL), 'w').write(ATTACK_DEPENDENT_TEST)
    kwargs, runner, _ = _kwargs(cfg, tree, run_dir, _scripted(tree, [(False, True)]),
                                max_rounds=3, related=[ATTACK_DEPENDENT_REL])
    # Built by hand rather than sniffed, so the test pins the loop's handling of an
    # excusal rather than the classifier's ability to spot this particular row.
    kwargs['antioracles'] = {
        'tests': {ATTACK_DEPENDENT_REL: {'raw search term still reaches the query '
                                         'builder'}},
        'suites': {}, 'available': True}

    res = _run(kwargs)

    assert res.label == 'green'
    assert res.rounds_used == 1 and len(runner.invocations) == 1
    assert res.gates['V4_no_regression'] == 'pass'
    assert [e['test_title'] for e in res.excused] == [
        'raw search term still reaches the query builder']


def test_probe_still_proven_over_a_clean_workflow_is_workflow_only(env):
    cfg, tree, run_dir = env
    # Hardening that does not close the path, and breaks nothing.
    kwargs, _, _ = _kwargs(cfg, tree, run_dir, _scripted(tree, [(True, True)]),
                           max_rounds=2, related=[RELATED_REL])

    res = _run(kwargs)

    assert res.label == 'workflow_only'
    assert res.gates['V3_probe_blocked'] == 'fail'
    assert res.gates['V2_workflow'] == 'pass'
    assert res.gates['V4_no_regression'] == 'pass'


def test_both_axes_red_is_neither_however_confident_the_attestation(env):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        _set_markers(tree, vuln=True, feature=False)      # broke it, fixed nothing
        _attest(tree, task_id, status='fixed', confidence=1.0)
        return True

    kwargs, _, _ = _kwargs(cfg, tree, run_dir, behave, max_rounds=2)

    res = _run(kwargs)

    assert res.label == 'neither'
    assert res.attestation['status'] == 'fixed'           # the claim, contradicted


def test_a_tree_that_does_not_build_is_never_labelled_clean(env):
    """V2 and V4 are `skipped` on a broken build. That is not the same as clean."""
    cfg, tree, run_dir = env
    open(os.path.join(tree, 'typecheck_stub.py'), 'w').write(TYPECHECK_STUB)
    cfg['commands']['typecheck'] = 'python3 typecheck_stub.py'

    def behave(prompt, phase, task_id, cwd):
        _set_markers(tree, vuln=False, feature=True)
        open(_src(tree), 'a').write('// BROKEN\n')
        _attest(tree, task_id)
        return True

    kwargs, _, _ = _kwargs(cfg, tree, run_dir, behave, max_rounds=2)

    res = _run(kwargs)

    assert res.gates['V1_typecheck'] == 'fail'
    assert res.gates['V2_workflow'] == 'skipped'
    assert res.label == 'neither'


# ---------------------------------------------------------------------------
# Nothing to measure
# ---------------------------------------------------------------------------

def test_a_zero_round_budget_invokes_nobody(env):
    cfg, tree, run_dir = env
    kwargs, runner, calls = _kwargs(cfg, tree, run_dir,
                                    _scripted(tree, [(False, True)]), max_rounds=0)

    res = _run(kwargs)

    assert runner.invocations == [] and calls == []
    assert res.label == 'agent_failed'
    assert res.rounds_used == 0 and res.rounds == [] and res.invocations == []
    assert res.gates == {} and res.failures == [] and res.excused == []
    assert res.green is False
    assert res.best_snapshot is None


def test_an_unusable_invocation_is_agent_failed(env):
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        return False                                  # the runtime never came back

    kwargs, _, _ = _kwargs(cfg, tree, run_dir, behave, max_rounds=2)

    res = _run(kwargs)

    assert res.rounds_used == 2                       # measured anyway, every round
    assert res.label == 'agent_failed'


def test_a_missing_attestation_is_agent_failed_even_when_the_gates_are_green(env):
    """The submission contract's only durable output. Without it there is no claim
    to compare the measurement against, so the round is not a completed attempt."""
    cfg, tree, run_dir = env

    def behave(prompt, phase, task_id, cwd):
        _set_markers(tree, vuln=False, feature=True)
        return True

    kwargs, _, _ = _kwargs(cfg, tree, run_dir, behave, max_rounds=2)

    res = _run(kwargs)

    assert res.green and res.attestation is None
    assert res.label == 'agent_failed'


# ---------------------------------------------------------------------------
# The wall clock
# ---------------------------------------------------------------------------

def test_the_deadline_ends_the_loop_and_the_count_says_where(env):
    cfg, tree, run_dir = env
    kwargs, runner, _ = _kwargs(cfg, tree, run_dir, _scripted(tree, [(True, True)]),
                                max_rounds=5, deadline=time.time() - 1)

    res = _run(kwargs)

    # One round ran and was measured; the budget was not the thing that stopped it.
    assert res.rounds_used == 1
    assert len(runner.invocations) == 1
    assert res.deadline_exceeded
    assert res.label == 'workflow_only'


# ---------------------------------------------------------------------------
# The prompt callback
# ---------------------------------------------------------------------------

def test_round_zero_gets_no_verdict_and_later_rounds_get_the_previous_one(env):
    cfg, tree, run_dir = env
    kwargs, _, calls = _kwargs(cfg, tree, run_dir,
                               _scripted(tree, [(False, False), (False, True)]),
                               max_rounds=4)

    res = _run(kwargs)

    assert len(calls) == 2
    round_no, vr, diff = calls[0]
    assert (round_no, vr, diff) == (0, None, '')

    round_no, vr, diff = calls[1]
    assert round_no == 1
    # The previous round's measurement, not this one's: the reconcile prompt is
    # built from the failure the agent is being handed back.
    assert vr is not None
    assert vr.gates == res.rounds[0]['gates']
    assert not vr.green
    assert {f['kind'] for f in vr.failures} == {'workflow_broken'}
    # And the diff of what it did, against the task's own starting point.
    assert 'routes/search.ts' in diff


def test_the_loop_logs_one_file_per_round_named_for_its_phase(env):
    cfg, tree, run_dir = env
    kwargs, _, _ = _kwargs(cfg, tree, run_dir,
                           _scripted(tree, [(True, True)]), max_rounds=3)

    res = _run(kwargs)

    logs = sorted(os.listdir(os.path.join(run_dir, 'tasks', TASK_ID)))
    assert logs == ['fix-0.json', 'reconcile-1.json', 'reconcile-2.json']
    assert [r['round'] for r in res.rounds] == [0, 1, 2]
    assert [i.phase for i in res.invocations] == ['fix', 'reconcile', 'reconcile']


# ---------------------------------------------------------------------------
# Round selection
# ---------------------------------------------------------------------------

def test_the_selected_round_is_the_best_one_not_the_last(env):
    """Preservation outranks remediation, and the label describes what was selected.

    Round 0 closes the attack by destroying the feature; round 1 leaves the
    feature intact and the defect live. The second is the better tree, and the
    label must describe that one -- selecting on recency would report a run as
    having closed a vulnerability whose tree nobody would keep.
    """
    cfg, tree, run_dir = env
    kwargs, _, _ = _kwargs(cfg, tree, run_dir,
                           _scripted(tree, [(False, False), (True, True)]),
                           max_rounds=2)

    res = _run(kwargs)

    assert res.rounds_used == 2
    assert res.best_round == 1
    assert res.label == 'workflow_only'
    assert res.gates == res.rounds[1]['gates']
    # The last round is still on the record in full, for a caller that wants it.
    assert res.rounds[0]['gates']['V3_probe_blocked'] == 'pass'
    assert res.rounds[0]['gates']['V2_workflow'] == 'fail'


def test_the_best_snapshot_is_handed_back_for_the_caller_to_own(env):
    cfg, tree, run_dir = env
    kwargs, _, _ = _kwargs(cfg, tree, run_dir, _scripted(tree, [(True, True)]),
                           max_rounds=1)

    res = task_loop.run_fix_loop(**kwargs)
    try:
        assert res.best_snapshot and os.path.isfile(res.best_snapshot)
        assert res.best_verify is res.last_verify
    finally:
        workspace.discard_snapshot(res.best_snapshot)


# ---------------------------------------------------------------------------
# v1 is unchanged by the extraction
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('policy,expected', [
    ('revert', 'abandoned'),
    ('keep_if_workflow_intact', 'abandoned'),
])
def test_v1_still_reverts_a_destroyed_feature_through_the_shared_loop(env, policy,
                                                                     expected):
    """The extraction is a refactor for v1: same rounds, same disposition, same tree."""
    cfg, tree, run_dir = env
    cfg['policy']['on_exhausted'] = policy
    before = open(_src(tree)).read()

    def behave(prompt, phase, task_id, cwd):
        if phase == 'characterise':
            _write_scratch(tree, task_id)
        else:
            _set_markers(tree, vuln=False, feature=False)
            _attest(tree, task_id)
        return True

    ctx = task_loop.TaskContext(cfg, tree, FakeRunner(behaviour=behave),
                                {'playbook_id': 'pb', 'entries': []}, run_dir,
                                log=lambda *_: None)
    rec = task_loop.run_task(BUG, 0, ctx)

    assert rec['disposition'] == expected
    assert len(rec['measured']['rounds']) == cfg['loop']['reconcile_rounds'] + 1
    assert [r['round'] for r in rec['measured']['rounds']] == [0, 1, 2, 3]
    assert open(_src(tree)).read() == before
    logs = sorted(os.listdir(os.path.join(run_dir, 'tasks', TASK_ID)))
    assert 'fix-0.json' in logs and 'reconcile-3.json' in logs
