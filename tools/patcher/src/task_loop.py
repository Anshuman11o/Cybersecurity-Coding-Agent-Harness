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

import dataclasses
import json
import os
import time

import antioracle
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
        # A parallel run gives every chain its own audit log: concurrent appends to
        # one file can interleave, and an audit trail that might be interleaved is
        # not an audit trail. Left unset, the whole run shares one.
        self.guard_log_path: str | None = None

    def guard_log(self) -> str:
        return self.guard_log_path or os.path.join(self.run_dir, 'guard.jsonl')

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
# Phases 2 + 3 + 4: the reconcile loop
# ----------------------------------------------------------------------------
# Extracted from `run_task` so that every track can be held to the same exit
# condition. A track that invokes the agent once and then reads the agent's own
# `attestation.json` to decide whether it was done has no measured exit condition
# at all: the agent can leave a gate red, declare in prose that the gate is
# illegitimate, and stop, and the record cannot afterwards distinguish that from
# a fix that reconciled. The number of rounds such a track reports is the agent's
# claim about itself, which is the one thing this architecture has already been
# burned by trusting.
#
# So the loop lives here, in the orchestrator, and both callers get the same
# three exit conditions and the same measured labelling. What each caller keeps
# for itself is only its prompt text, through `build_prompt`.

def _phase_for_round(round_no: int) -> str:
    """Round 0 is the fix; every round after it is a reconcile.

    The phase name is also the log filename stem (`{phase}-{round_no}.json`) and
    the value the sandbox hook is armed with, so it is derived in exactly one
    place rather than passed in.
    """
    return 'fix' if round_no == 0 else 'reconcile'


@dataclasses.dataclass
class FixLoopResult:
    """What the orchestrator measured, and nothing the agent said about itself.

    `gates`, `failures`, `excused` and `green` describe the SELECTED round -- the
    best one under `_score` -- because that is the round whose tree the caller
    will decide to keep or revert. `rounds` and `invocations` are the full,
    ordered history, so a caller that wants the last round rather than the best
    one can take it from there.
    """

    label: str
    rounds_used: int
    green: bool
    gates: dict
    failures: list
    excused: list
    attestation: dict | None
    rounds: list
    invocations: list
    # --- beyond the agreed interface -------------------------------------------
    # Additive, all defaulted, and needed by v1 to stay byte-identical: it selects
    # its disposition from the LAST round's verdict while restoring the BEST
    # round's tree, and it records the wall-clock break as a violation. None of it
    # changes the meaning of the fields above.
    best_round: int | None = None
    # The caller owns disposal of this snapshot (`workspace.discard_snapshot`).
    # The loop never restores it: whether an exhausted attempt is kept or reverted
    # is policy, and policy is the caller's.
    best_snapshot: str | None = None
    best_verify: object = None
    last_verify: object = None
    deadline_exceeded: bool = False


def _derive_label(selected, invocations, attestation) -> str:
    """The four outcome squares, read off the gates the orchestrator ran.

    Never off the attestation. An agent that says `status: fixed` over a red
    probe gets `neither` here, and an agent that says `not_fixed` over a clean
    sheet gets `green`.

    Two readings are deliberate:

      * a probe that was SKIPPED (never demonstrated the defect before the fix)
        or that ERRORED is not a measured `NOT_PROVEN`, so it does not count as
        the vulnerability having been closed. The honest square for "the feature
        still works and the remediation axis is unverified" is `workflow_only`.
      * a tree that does not compile short-circuits V2 and V4 to `skipped`, which
        must not be read as "workflow and net clean" -- so the build is folded
        into the clean test rather than left out of the table.
    """
    if not any(getattr(inv, 'ok', False) for inv in invocations) or attestation is None:
        return 'agent_failed'
    gates = (selected.gates if selected is not None else {}) or {}
    probe_closed = gates.get('V3_probe_blocked') == 'pass'
    clean = (gates.get('V1_typecheck') == 'pass'
             and gates.get('V2_workflow') in ('pass', 'skipped')
             and gates.get('V4_no_regression') in ('pass', 'skipped'))
    if probe_closed:
        return 'green' if clean else 'vuln_only'
    return 'workflow_only' if clean else 'neither'


def run_fix_loop(*, cfg, tree, task_id, bug, runner, build_prompt,
                 workflow_rel, probe_rel, probe_expected,
                 related, baseline_outcomes, antioracles,
                 max_rounds, deadline, log_dir, guard_log,
                 snap_path, attestation_rel) -> FixLoopResult:
    """Invoke, measure, hand back the failure, repeat. The orchestrator decides.

    `max_rounds` is the TOTAL number of rounds, round 0 (the fix) included -- so
    `max_rounds=0` invokes the agent zero times and `max_rounds=1` is a single
    fix attempt with no reconcile. A caller whose budget is expressed as a number
    of reconciles passes that number plus one.

    `build_prompt(round_no, vr, diff) -> str` is the only thing a caller keeps to
    itself. Round 0 is called with `vr=None` and `diff=''`; every later round is
    called with the previous round's `VerifyResult` and the diff of the tree
    against `snap_path`.

    The loop mutates the tree only through the agent. It takes a snapshot of the
    best round and returns its path; it never restores one. Whether an exhausted
    attempt is kept or reverted belongs to the caller's policy.

    `bug` is accepted and deliberately unread: everything bug-specific reaches the
    agent through `build_prompt`, and a loop that could reach into the bug record
    would be a loop that could start making decisions per defect.
    """
    rounds: list = []
    invocations: list = []
    best = None                      # (round_no, VerifyResult, snapshot path)
    vr = None
    deadline_exceeded = False
    round_no = 0

    while round_no < max_rounds:
        phase = _phase_for_round(round_no)
        # Only computed for a reconcile: the diff is against the task's own
        # starting snapshot, and on round 0 there is nothing in it.
        diff = '' if round_no == 0 else workspace.diff_against_snapshot(tree, snap_path)

        inv = runner.run(build_prompt(round_no, vr, diff), cwd=tree, phase=phase,
                         task_id=task_id,
                         log_path=os.path.join(log_dir, f'{phase}-{round_no}.json'),
                         guard_log=guard_log)
        invocations.append(inv)

        vr = verify.verify(cfg, tree, workflow_rel=workflow_rel, probe_rel=probe_rel,
                           probe_expected=probe_expected, related_files=related,
                           baseline_outcomes=baseline_outcomes,
                           antioracles=antioracles)

        rounds.append({
            'round': round_no, 'green': vr.green, 'gates': dict(vr.gates),
            'gate_seconds': dict(vr.durations),
            'excused': list(vr.excused),
            'failures': vr.failures, 'agent': inv.as_record(),
        })

        if best is None or _score(vr) > _score(best[1]):
            best = (round_no, vr, workspace.snapshot(tree, f'best-{task_id}'))

        # THE THREE EXIT CONDITIONS, AND THERE ARE ONLY THREE: measured green,
        # the round budget, the wall clock.
        #
        # An anti-oracle claim in the attestation is NOT one of them, and must
        # never become one. If the agent writes `workflow_red`, `antioracle_claims`
        # or a `residual_risk` explanation while a gate is still red and rounds
        # remain, the loop runs another round: the claim may well be correct --
        # some tests in the net assert the attack succeeds and no correct fix can
        # satisfy them -- but "this failure does not count" decided by the party
        # being measured is the exact self-report this design exists to refuse.
        # The claim is recorded, in `attestation`, and acted on by nothing here.
        # Excusal is `verify.verify`'s job, from the tests' own text, and there is
        # deliberately no second excusal path.
        if vr.green:
            break
        if round_no + 1 >= max_rounds:
            break
        if time.time() > deadline:
            deadline_exceeded = True
            break
        round_no += 1

    # Read once, at the end, for the record. Never consulted by the loop above.
    attestation = _normalise_attestation(
        _read_json(os.path.join(tree, attestation_rel)))
    selected = best[1] if best else None

    return FixLoopResult(
        label=_derive_label(selected, invocations, attestation),
        # The rounds this loop ran and measured. A `rounds_used` in the
        # attestation is the agent's claim about itself and is not read here.
        rounds_used=len(rounds),
        green=bool(selected.green) if selected is not None else False,
        gates=dict(selected.gates) if selected is not None else {},
        failures=list(selected.failures) if selected is not None else [],
        excused=list(selected.excused) if selected is not None else [],
        attestation=attestation,
        rounds=rounds,
        invocations=invocations,
        best_round=best[0] if best else None,
        best_snapshot=best[2] if best else None,
        best_verify=selected,
        last_verify=vr,
        deadline_exceeded=deadline_exceeded,
    )


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
    # Derived from the net's own files, before any fix. A test that requires the
    # attack to succeed cannot be satisfied by a correct change, and charging it
    # reverts correct work -- measured on wave 1, one unit, 5 rounds, $10.79.
    net_cmds = [_cmd(cfg, 'run_server_test_file' if rel.replace(chr(92), '/').startswith(
        'test/server') else 'run_test_file', rel) for rel in related]
    antioracles = antioracle.detect(tree, related)
    ch['antioracle_tests'] = sorted(
        t for titles in (antioracles.get('tests') or {}).values() for t in titles)
    ch['antioracle_detector_available'] = antioracles.get('available', False)
    if ch['antioracle_tests']:
        ctx.log(f"  {len(ch['antioracle_tests'])} attack-dependent test(s) in the net "
                'will not be charged as regressions')
    baseline_outcomes = verify.collect_outcomes(cfg, tree, related) if related else {}
    ch['baseline_failures'] = sorted(
        f'{rel}: {title}'
        for rel, r in baseline_outcomes.items()
        for title, status in r['outcomes'].items() if status == 'fail')

    # ---- phase 2 + 3 + 4: the reconcile loop -----------------------------
    entry, how = blind_guard.select_entry(ctx.playbook, bug)
    attestation_rel = f'{workspace.scratch_rel(task_id)}/attestation.json'

    max_rounds = max(0, int(ctx.loop.get('reconcile_rounds', 4)))
    deadline = t0 + float(ctx.loop.get('max_task_wall_s', 5400))

    def build_prompt(round_no, vr, diff):
        """v1's own prompts. The loop supplies the round, the verdict and the diff."""
        if round_no == 0:
            return prompts.build_fix(
                tree=tree, bug=bug, characterisation=characterisation or {},
                playbook_entry=entry, playbook_how=how,
                general_guidance=ctx.playbook.get('general_guidance'),
                workflow_rel=workflow_rel, probe_rel=probe_rel,
                probe_proven=probe_expected,
                workflow_cmd=_cmd(cfg, 'run_test_file', workflow_rel),
                probe_cmd=_cmd(cfg, 'run_probe', probe_rel),
                typecheck_cmd=cfg['commands']['typecheck'],
                attestation_path=attestation_rel, round_no=0,
                net_cmds=net_cmds)
        return prompts.build_reconcile(
            tree=tree, bug=bug, characterisation=characterisation or {},
            diff=diff,
            failures=vr.failures if vr else [], round_no=round_no,
            # The agent is told the RECONCILE budget, which is what it has always
            # been told: `loop.max_rounds` below counts round 0 as well.
            max_rounds=max_rounds,
            workflow_cmd=_cmd(cfg, 'run_test_file', workflow_rel),
            probe_cmd=_cmd(cfg, 'run_probe', probe_rel),
            typecheck_cmd=cfg['commands']['typecheck'],
            attestation_path=attestation_rel)

    loop = run_fix_loop(
        cfg=cfg, tree=tree, task_id=task_id, bug=bug, runner=ctx.runner,
        build_prompt=build_prompt,
        workflow_rel=workflow_rel, probe_rel=probe_rel,
        probe_expected=probe_expected, related=related,
        baseline_outcomes=baseline_outcomes, antioracles=antioracles,
        # `reconcile_rounds` counts RECONCILES; the loop counts total rounds and
        # round 0 is the fix. The +1 is what keeps a budget of n reconciles worth
        # n+1 measured rounds, as it always has been.
        max_rounds=max_rounds + 1, deadline=deadline,
        log_dir=task_dir, guard_log=ctx.guard_log(),
        snap_path=snap_path, attestation_rel=attestation_rel)

    rec['measured']['rounds'] = loop.rounds
    rec.setdefault('_invocations', []).extend(loop.invocations)
    vr = loop.last_verify
    best = ((loop.best_round, loop.best_verify, loop.best_snapshot)
            if loop.best_snapshot else None)
    if loop.green:
        rec['measured']['rounds_to_green'] = loop.rounds[-1]['round']
    if loop.deadline_exceeded:
        rec['violations'].append({'kind': 'scratch_missing',
                                  'detail': 'task wall-clock budget exhausted mid-loop',
                                  'phase': _phase_for_round(loop.rounds[-1]['round']),
                                  'auto_reverted': False})

    rec['measured']['final_gates'] = {
        'typecheck': vr.gates.get('V1_typecheck', 'skipped'),
        'workflow': vr.gates.get('V2_workflow', 'skipped'),
        'probe_blocked': vr.gates.get('V3_probe_blocked', 'skipped'),
        'no_regression': vr.gates.get('V4_no_regression', 'skipped'),
    }
    rec['attested'] = loop.attestation

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

    # V4 is deliberately not a clause here. A test that requires the attack to
    # succeed cannot be satisfied by a correct fix, so charging the regression net
    # with the revert decision deletes correct work: three of the ten failures on
    # the subset 4 run were one unit that had its probe blocked and its own workflow
    # test green on every round of its budget, discarded only because the net
    # objected. `antioracle.py` narrows that class but cannot close it -- it
    # recognises a test carrying an attack payload in its own text, and the rows
    # that killed that unit carried none. So the net is reported, never obeyed.
    #
    # The two clauses that remain are what keeps this from being `keep_best` with
    # its sharp edge: a tree that does not compile poisons every task after it, and
    # a change that closes the attack by breaking the feature is the exact damage
    # this whole procedure exists to prevent. Never ship known damage; do ship a fix
    # that an existing test merely objects to.
    if policy == 'keep_if_workflow_intact':
        workflow_ok = vr.gates.get('V2_workflow') in ('pass', 'skipped')
        build_ok = vr.gates.get('V1_typecheck') == 'pass'
        if workflow_ok and build_ok:
            kept = (f'{why}. Workflow intact and the tree builds, so the attempt was '
                    'kept under keep_if_workflow_intact.')
            if vr.gates.get('V4_no_regression') not in ('pass', 'skipped'):
                # Said out loud, in the record, every time. A task kept over a red
                # net is not the same object as one kept over a clean net, and if
                # the two are indistinguishable afterwards then dropping the clause
                # has quietly converted real collateral damage into silence.
                kept += (' The regression net was RED and the attempt was kept anyway:'
                         ' the failing rows may be tests a correct fix cannot satisfy,'
                         ' or they may be real collateral damage, and this record does'
                         ' not tell them apart. Read the V4 failures before trusting'
                         ' this task.')
            return 'partial', kept
        # Which clause failed, in the record: a reverted task has no tree left to
        # inspect, so its reason is the only account of why it went.
        broke = ('the tree does not build' if not build_ok
                 else 'the workflow test was not intact')
        workspace.restore(ctx.tree, snap_path)
        return 'abandoned', f'{why}. Reverted because {broke}.'

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
        # The two structured fields behind `residual_risk`. An agent that ships a
        # correct fix over a red workflow assertion used to be able to say so only
        # in prose, which nothing parses, so the record was a plain `fixed` and the
        # red assertion was invisible until a human read the transcript. These are
        # lists so the record can be counted; they are the agent's claim and are
        # never checked here.
        'workflow_red': _str_list(raw.get('workflow_red')),
        'antioracle_claims': _claim_list(raw.get('antioracle_claims')),
        'rounds_used': raw.get('rounds_used') if isinstance(raw.get('rounds_used'), int)
        else None,
    }


# A missing, null or malformed field means "the agent said nothing", which is the
# same record as an empty list -- an absent claim, not a claim of red. Anything
# that is not a list at all becomes `[]` rather than being wrapped, because a
# string here is as likely to be prose as a single entry and guessing which would
# invent a claim the agent did not make.
def _str_list(raw) -> list:
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
    return out


# Three keys, whitelisted for the same reason `dispatcher.read_declarations`
# whitelists its own: these entries are forwarded into the run record and read
# downstream, so whatever else the agent chose to write into the file stops here.
_CLAIM_KEYS = ('test', 'it_title', 'why')


def _claim_list(raw) -> list:
    if not isinstance(raw, list):
        return []
    return [{k: item.get(k) for k in _CLAIM_KEYS}
            for item in raw if isinstance(item, dict)]


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

    # EVERY invocation, characterise included. The per-task cost above always
    # counted them, but the run-level roll-up in report.py aggregated
    # `measured.rounds`, and characterise has no round entry -- so the run
    # under-reported its own spend by the whole characterise phase. Measured on
    # the pilot: a true $16.03 over 6 invocations was reported as $11.18 over 4.
    # The number that sizes the next dataset must not be the one that is short.
    rec['measured']['invocations'] = [i.as_record() for i in invs]

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
