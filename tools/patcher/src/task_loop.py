#!/usr/bin/env python3
"""
The inner loop: one bug, start to finish.

This is the `while` the architecture is named for. The agent is invoked once per
phase and never told to "iterate until it works" -- iteration is a Python loop
with a machine-checked exit condition, because an agent asked to decide when it
has iterated enough will decide that it has.

    (1) CHARACTERISE   record what correct behaviour is, while the code still works
    (2) FIX            patch the defect
    (3) VERIFY         the ORCHESTRATOR runs the gates; the agent is not present
    (4) RECONCILE      hand back the exact failure, go to (3)
    (5) close out      disposition, attestation, revert if the budget ran out

Context does not accumulate: every phase is a fresh process, and what crosses a
phase boundary is the small structured `carry` assembled here. Task 97's prompt
is the same size as task 1's.
"""
from __future__ import annotations

import json
import os
import time

import blind_guard
import prompts
import testmap
import verify
import workspace

REVERT_DISPOSITIONS = {'abandoned', 'agent_failed', 'blocked'}


class TaskContext:
    """Everything a task needs that is not the bug itself."""

    def __init__(self, cfg, tree, runner, playbook, run_dir, log=print):
        self.cfg = cfg
        self.tree = tree
        self.runner = runner
        self.playbook = playbook
        self.run_dir = run_dir
        self.log = log
        self.loop = cfg.get('loop', {})
        self.policy = cfg.get('policy', {})
        # file:line -> bug_id, for tasks whose defect an earlier task already closed
        self.touched_locations: dict = {}

    def guard_log(self) -> str:
        return os.path.join(self.run_dir, 'guard.jsonl')

    def task_dir(self, task_id: str) -> str:
        d = os.path.join(self.run_dir, 'tasks', task_id)
        os.makedirs(d, exist_ok=True)
        return d


def _cmd(cfg, key, rel):
    tmpl = cfg['commands'].get(key) or ''
    return tmpl.replace('{file}', rel)


def _read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:                                            # noqa: BLE001
        return None


def _record_skeleton(bug, index):
    return {
        'bug_id': bug['bug_id'],
        'task_index': index,
        'location': {'file': bug['location']['file'], 'line': bug['location']['line']},
        'owasp_codes': [o.get('code') for o in bug.get('owasp') or []],
        'class': bug.get('class'),
        'disposition': 'blocked',
        'disposition_reason': None,
        'measured': {
            'characterisation': {
                'workflow_green_pre_fix': False,
                'probe_proven_pre_fix': False,
                'attempts': 0,
                'workflow_test_path': None,
                'exploit_probe_path': None,
                'related_test_files': [],
                'baseline_failures': [],
            },
            'rounds': [],
            'final_gates': {},
            'rounds_to_green': None,
            'wall_s': 0.0,
            'cost_usd': 0.0,
        },
        'attested': None,
        'attestation_delta': None,
        'diff_stats': {'files_touched': [], 'lines_added': 0, 'lines_removed': 0,
                       'touched_outside_bug_file': False, 'net_deletion': False},
        'violations': [],
    }


# ----------------------------------------------------------------------------
# Phase 1
# ----------------------------------------------------------------------------

def _characterise(bug, ctx, rec, snap_path):
    """Establish the recorded baseline. Returns (characterisation|None, paths)."""
    task_id = bug['bug_id']
    tree, cfg = ctx.tree, ctx.cfg
    scratch_rel = workspace.scratch_rel(task_id)
    workspace.ensure_scratch(tree, task_id)

    workflow_rel = f'{scratch_rel}/workflow.test.ts'
    probe_rel = f'{scratch_rel}/exploit.probe.ts'
    char_path = os.path.join(tree, scratch_rel, 'characterisation.json')

    workflow_cmd = _cmd(cfg, 'run_test_file', workflow_rel)
    probe_cmd = _cmd(cfg, 'run_probe', probe_rel)

    base_prompt = prompts.build_characterise(
        tree=tree, bug=bug, scratch_rel=scratch_rel,
        workflow_cmd=workflow_cmd, probe_cmd=probe_cmd)

    max_attempts = max(1, int(ctx.loop.get('characterise_rounds', 2)))
    feedback = ''
    characterisation = None

    for attempt in range(1, max_attempts + 1):
        rec['measured']['characterisation']['attempts'] = attempt
        inv = ctx.runner.run(base_prompt + feedback, cwd=tree, phase='characterise',
                             task_id=task_id,
                             log_path=os.path.join(ctx.task_dir(task_id),
                                                   f'characterise-{attempt}.json'),
                             guard_log=ctx.guard_log())
        rec.setdefault('_invocations', []).append(inv)

        # Characterisation is read-only on source. Anything that slipped past
        # the hook is reverted here, because a baseline captured from code the
        # agent had already edited is not a baseline.
        stray = workspace.changed_files(tree, snap_path)
        if stray:
            workspace.restore(tree, snap_path)
            rec['violations'].append({
                'kind': 'source_edited_in_characterise',
                'detail': f'{len(stray)} source file(s) modified during '
                          f'characterisation: {", ".join(stray[:6])}',
                'phase': 'characterise', 'auto_reverted': True})

        characterisation = _read_json(char_path)
        problems = []
        if characterisation is None:
            problems.append(f'{scratch_rel}/characterisation.json is missing or is not '
                            'valid JSON.')

        wf_abs = os.path.join(tree, workflow_rel)
        if not os.path.isfile(wf_abs):
            problems.append(f'{workflow_rel} was not written.')
            wf_green = False
        else:
            wr = verify.run_test_file(cfg, tree, workflow_rel)
            wf_green = wr.ok
            if not wr.ok:
                problems.append(
                    'The workflow test does not pass against the UNMODIFIED code. It has '
                    'to, or it cannot detect damage later. Output:\n\n```\n'
                    + wr.tail[-3000:] + '\n```')

        probe_verdict = 'MISSING'
        if os.path.isfile(os.path.join(tree, probe_rel)):
            probe_verdict, _pr = verify.run_probe(cfg, tree, probe_rel)

        rec['measured']['characterisation'].update({
            'workflow_green_pre_fix': bool(wf_green),
            'probe_proven_pre_fix': probe_verdict == verify.PROVEN,
            'workflow_test_path': workflow_rel if os.path.isfile(wf_abs) else None,
            'exploit_probe_path': probe_rel if os.path.isfile(
                os.path.join(tree, probe_rel)) else None,
        })

        if not problems:
            return characterisation, workflow_rel, probe_rel

        if attempt < max_attempts:
            feedback = ('\n\n---\n\n## Your previous attempt did not satisfy this step\n\n'
                        + '\n\n'.join(f'- {p}' for p in problems)
                        + '\n\nFix these and finish the step. Do not modify application '
                          'source.\n')
            ctx.log(f'    [{task_id}] characterisation attempt {attempt} incomplete; '
                    f'retrying ({len(problems)} problem(s))')

    return characterisation, workflow_rel, probe_rel


# ----------------------------------------------------------------------------
# The task
# ----------------------------------------------------------------------------

def run_task(bug: dict, index: int, ctx: TaskContext) -> dict:
    task_id = bug['bug_id']
    tree, cfg = ctx.tree, ctx.cfg
    t0 = time.time()
    rec = _record_skeleton(bug, index)
    task_dir = ctx.task_dir(task_id)
    bug_file = bug['location']['file']
    loc_key = f"{bug_file}:{bug['location']['line']}"

    snap_path = workspace.snapshot(tree, f'task-{task_id}')

    # ---- phase 1 ---------------------------------------------------------
    characterisation, workflow_rel, probe_rel = _characterise(bug, ctx, rec, snap_path)
    ch = rec['measured']['characterisation']

    if not ch['workflow_green_pre_fix']:
        rec['disposition'] = 'blocked'
        rec['disposition_reason'] = (
            'no workflow test that passes against the unmodified code, after '
            f"{ch['attempts']} attempt(s). Without one there is no way to tell a fixed "
            'defect from a broken feature, so no fix was attempted.')
        return _finish(rec, ctx, bug, snap_path, t0, task_dir)

    if not ch['probe_proven_pre_fix'] and loc_key in ctx.touched_locations:
        rec['disposition'] = 'already_remediated'
        rec['disposition_reason'] = (
            f'the probe could not demonstrate the defect, and {ctx.touched_locations[loc_key]} '
            f'already changed {loc_key} earlier in this run. Recorded as closed upstream '
            'rather than as a fix by this task.')
        return _finish(rec, ctx, bug, snap_path, t0, task_dir)

    probe_expected = ch['probe_proven_pre_fix']
    if not probe_expected and ctx.policy.get('require_probe'):
        rec['disposition'] = 'blocked'
        rec['disposition_reason'] = ('the exploit probe never reached PROVEN and '
                                     'policy.require_probe is set.')
        return _finish(rec, ctx, bug, snap_path, t0, task_dir)

    # ---- regression baseline, captured at TASK start ---------------------
    net = ctx.policy.get('regression_net', 'related')
    related = []
    if net != 'own_only':
        related = testmap.select(tree, [bug_file],
                                 (characterisation or {}).get('related_test_files') or [])
    ch['related_test_files'] = related
    baseline_outcomes = verify.collect_outcomes(cfg, tree, related) if related else {}
    ch['baseline_failures'] = sorted(
        f'{rel}: {title}'
        for rel, r in baseline_outcomes.items()
        for title, status in r['outcomes'].items() if status == 'fail')

    # ---- phase 2 + 3 + 4: the reconcile loop -----------------------------
    entry, how = blind_guard.select_entry(ctx.playbook, bug)
    attestation_rel = f'{workspace.scratch_rel(task_id)}/attestation.json'
    attestation_abs = os.path.join(tree, attestation_rel)

    max_rounds = max(0, int(ctx.loop.get('reconcile_rounds', 4)))
    deadline = t0 + float(ctx.loop.get('max_task_wall_s', 5400))
    best = None
    vr = None
    round_no = 0

    while True:
        if round_no == 0:
            prompt = prompts.build_fix(
                tree=tree, bug=bug, characterisation=characterisation or {},
                playbook_entry=entry, playbook_how=how,
                general_guidance=ctx.playbook.get('general_guidance'),
                workflow_rel=workflow_rel, probe_rel=probe_rel,
                probe_proven=probe_expected,
                workflow_cmd=_cmd(cfg, 'run_test_file', workflow_rel),
                probe_cmd=_cmd(cfg, 'run_probe', probe_rel),
                typecheck_cmd=cfg['commands']['typecheck'],
                attestation_path=attestation_rel, round_no=0)
            phase = 'fix'
        else:
            prompt = prompts.build_reconcile(
                tree=tree, bug=bug, characterisation=characterisation or {},
                diff=workspace.diff_against_snapshot(tree, snap_path),
                failures=vr.failures if vr else [], round_no=round_no,
                max_rounds=max_rounds,
                workflow_cmd=_cmd(cfg, 'run_test_file', workflow_rel),
                probe_cmd=_cmd(cfg, 'run_probe', probe_rel),
                typecheck_cmd=cfg['commands']['typecheck'],
                attestation_path=attestation_rel)
            phase = 'reconcile'

        inv = ctx.runner.run(prompt, cwd=tree, phase=phase, task_id=task_id,
                             log_path=os.path.join(task_dir, f'{phase}-{round_no}.json'),
                             guard_log=ctx.guard_log())
        rec.setdefault('_invocations', []).append(inv)

        vr = verify.verify(cfg, tree, workflow_rel=workflow_rel, probe_rel=probe_rel,
                           probe_expected=probe_expected, related_files=related,
                           baseline_outcomes=baseline_outcomes)

        rec['measured']['rounds'].append({
            'round': round_no, 'green': vr.green, 'gates': dict(vr.gates),
            'failures': vr.failures, 'agent': inv.as_record(),
        })

        if best is None or _score(vr) > _score(best[1]):
            best = (round_no, vr, workspace.snapshot(tree, f'best-{task_id}'))

        if vr.green:
            rec['measured']['rounds_to_green'] = round_no
            break
        if round_no >= max_rounds:
            break
        if time.time() > deadline:
            rec['violations'].append({'kind': 'scratch_missing',
                                      'detail': 'task wall-clock budget exhausted mid-loop',
                                      'phase': phase, 'auto_reverted': False})
            break
        round_no += 1

    rec['measured']['final_gates'] = {
        'typecheck': vr.gates.get('V1_typecheck', 'skipped'),
        'workflow': vr.gates.get('V2_workflow', 'skipped'),
        'probe_blocked': vr.gates.get('V3_probe_blocked', 'skipped'),
        'no_regression': vr.gates.get('V4_no_regression', 'skipped'),
    }
    rec['attested'] = _normalise_attestation(_read_json(attestation_abs))

    # ---- disposition ------------------------------------------------------
    if vr.green:
        rec['disposition'] = 'fixed' if probe_expected else 'fixed_workflow_only'
        rec['disposition_reason'] = None if probe_expected else (
            'every gate passed, but the exploit probe never demonstrated the defect '
            'before the fix, so the remediation axis is unverified in-sandbox.')
        ctx.touched_locations[loc_key] = task_id
    else:
        rec['disposition'], rec['disposition_reason'] = _apply_exhausted_policy(
            ctx, rec, vr, best, snap_path)
        if rec['disposition'] == 'partial':
            ctx.touched_locations[loc_key] = task_id

    if best:
        workspace.discard_snapshot(best[2])
    return _finish(rec, ctx, bug, snap_path, t0, task_dir)


def _score(vr) -> int:
    """Rank rounds for `keep_best`. Preservation outranks remediation.

    Deliberate: a change that closes the attack by breaking the feature is the
    failure mode this whole procedure exists to prevent, so it must never win a
    tie-break against one that keeps the feature.
    """
    g = vr.gates
    return ((4 if g.get('V1_typecheck') == 'pass' else 0)
            + (3 if g.get('V2_workflow') == 'pass' else 0)
            + (2 if g.get('V4_no_regression') in ('pass', 'skipped') else 0)
            + (1 if g.get('V3_probe_blocked') == 'pass' else 0))


def _apply_exhausted_policy(ctx, rec, vr, best, snap_path):
    policy = ctx.policy.get('on_exhausted', 'revert')
    kinds = sorted({f.get('kind') for f in vr.failures if f.get('kind')})
    why = f"gates still red after the reconcile budget: {', '.join(kinds) or 'unknown'}"

    if policy == 'keep_best' and best:
        workspace.restore(ctx.tree, best[2])
        return 'partial', f'{why}. Best round ({best[0]}) retained under keep_best.'

    if policy == 'keep_if_workflow_intact':
        workflow_ok = vr.gates.get('V2_workflow') in ('pass', 'skipped')
        regress_ok = vr.gates.get('V4_no_regression') in ('pass', 'skipped')
        build_ok = vr.gates.get('V1_typecheck') == 'pass'
        if workflow_ok and regress_ok and build_ok:
            return 'partial', (f'{why}. Workflow intact and the tree builds, so the '
                               'attempt was kept under keep_if_workflow_intact.')
        workspace.restore(ctx.tree, snap_path)
        return 'abandoned', f'{why}. Workflow was not intact, so the task was reverted.'

    workspace.restore(ctx.tree, snap_path)
    return 'abandoned', (f'{why}. Reverted: shipping a change that fails its own gates '
                         'would put the damage into every task that follows.')


def _normalise_attestation(raw):
    if not isinstance(raw, dict):
        return None
    status = raw.get('status')
    if status not in ('fixed', 'not_fixed'):
        status = 'fixed' if str(status).lower().startswith('fix') else 'not_fixed'
    conf = raw.get('confidence')
    try:
        conf = min(1.0, max(0.0, float(conf)))
    except (TypeError, ValueError):
        conf = None
    return {
        'status': status,
        'confidence': conf,
        'what_changed': raw.get('what_changed'),
        'why_it_closes_the_path': raw.get('why_it_closes_the_path'),
        'why_the_workflow_still_works': raw.get('why_the_workflow_still_works'),
        'residual_risk': raw.get('residual_risk'),
        'rounds_used': raw.get('rounds_used') if isinstance(raw.get('rounds_used'), int)
        else None,
    }


def _finish(rec, ctx, bug, snap_path, t0, task_dir):
    task_id = bug['bug_id']

    if rec['disposition'] in REVERT_DISPOSITIONS:
        try:
            workspace.restore(ctx.tree, snap_path)
        except workspace.WorkspaceError as ex:
            rec['violations'].append({'kind': 'scratch_missing',
                                      'detail': f'revert failed: {ex}',
                                      'phase': 'finish', 'auto_reverted': False})

    diff = workspace.diff_against_snapshot(ctx.tree, snap_path)
    with open(os.path.join(task_dir, 'task.patch'), 'w') as fh:
        fh.write(diff)
    rec['diff_stats'] = workspace.diff_stats(diff, bug['location']['file'])

    invs = rec.pop('_invocations', [])
    rec['measured']['rounds'] = rec['measured']['rounds']
    rec['measured']['wall_s'] = round(time.time() - t0, 1)
    costs = [i.cost_usd for i in invs if i.cost_usd is not None]
    rec['measured']['cost_usd'] = round(sum(costs), 4) if costs else None

    # The agent's claim against the orchestrator's own measurement. Recorded,
    # never used to alter the disposition.
    att = rec.get('attested')
    if att:
        gates_green = rec['disposition'] in ('fixed', 'fixed_workflow_only')
        if att['status'] == 'fixed' and not gates_green:
            rec['attestation_delta'] = {
                'agent_said': 'fixed', 'measurement_said': rec['disposition'],
                'kind': 'overclaim'}
        elif att['status'] == 'not_fixed' and gates_green:
            rec['attestation_delta'] = {
                'agent_said': 'not_fixed', 'measurement_said': rec['disposition'],
                'kind': 'underclaim'}

    if not workspace.harvest_scratch(ctx.tree, task_id, task_dir):
        rec['violations'].append({'kind': 'scratch_missing',
                                  'detail': f'no scratch directory for {task_id}',
                                  'phase': 'finish', 'auto_reverted': False})

    workspace.discard_snapshot(snap_path)
    with open(os.path.join(task_dir, 'task-record.json'), 'w') as fh:
        json.dump(rec, fh, indent=1)
    return rec
