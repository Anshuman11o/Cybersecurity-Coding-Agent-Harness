#!/usr/bin/env python3
"""
Task records -> `patcher-report.json`, one of the run's two outputs.

Reporting rules this module encodes rather than leaves to whoever reads it:

- `fixed`, `fixed_workflow_only` and `fixed_workflow_red` are never summed.
  `fixed_workflow_only` means the agent could not demonstrate the defect in its
  own sandbox, so the remediation axis is unverified. `fixed_workflow_red` means
  it submitted over a workflow assertion it left failing, and nothing here can
  say whether that assertion encoded the vulnerable behaviour or the fix broke
  the feature. Folding either into `fixed` is the false-confidence failure the
  eval exists to catch.
- Every rate is emitted with its denominator. A percentage without one is not
  comparable across runs.
- A coverage number that was never measured is emitted as `null`, never as `0`,
  and carries the basis it was computed from. `0.0` is a finding — the oracle
  ran and came back red for every task. `null` is the absence of one. A reader
  of an archived row cannot tell those apart after the fact, and the row is
  append-only, so the distinction has to be made here or not at all.
- `rounds_to_green` is a distribution, not a mean. The mean hides the tail, and
  the tail is where the cost is.
- Cost and failure are reported even when the run went badly. A cost nobody can
  see is a cost paid twice.
- The in-sandbox calibration number is explicitly NOT the sighted False
  Confidence Rate, and says so in its own field description.
"""
from __future__ import annotations

import json
import os
import statistics
import time

DISPOSITIONS = ('fixed', 'fixed_workflow_only', 'fixed_workflow_red',
                'already_remediated', 'abandoned', 'partial', 'agent_failed',
                'blocked')

# The basis vocabulary for a coverage number. The first two strings are the same
# two `v3/dispatcher.py` writes into `disposition_basis`, deliberately: a reader
# should not have to learn two words for one distinction. `not_measured` is this
# module's own, and names the state neither of those can express -- nobody looked.
MEASURED, ATTESTED, NOT_MEASURED = 'measured', 'attested', 'not_measured'


def _pct(num, den):
    return round(num / den, 4) if den else None


def _flag(block, field):
    """One characterisation flag as a tri-state: True, False, or None.

    `None` means NOT MEASURED and must never collapse into `False`. v1 measures
    both flags itself and so always carries a real boolean; v3 does not re-run
    the exploit probe before the fix, so its `probe_proven_pre_fix` is null by
    design and its pre-fix evidence lives in `attested_characterisation`.
    """
    if not isinstance(block, dict):
        return None
    v = block.get(field)
    return None if v is None else bool(v)


def _coverage(records, field):
    """`(basis, count_of_true)` for one characterisation flag over all records.

    Measured values win outright: if ANY record carries a measured value, the
    number is computed from measured values alone and the attested ones are left
    out of it. A rate that blends what was run with what was claimed is not a
    rate of anything, and the blend cannot be undone by a later reader — so the
    number carries exactly one basis. A run that measured nothing falls back to
    the agent's own account, LABELLED as attested; a run with neither returns a
    null count, which the caller emits as a null rate rather than as zero.
    """
    if not records:
        # No tasks, so no claim in either direction: `_pct` already returns null
        # for a zero denominator and a zero count is honest. Left exactly as it
        # was rather than relabelled, because this is also the v1 shape.
        return MEASURED, 0
    measured, attested = [], []
    for r in records:
        v = _flag((r.get('measured') or {}).get('characterisation'), field)
        if v is not None:
            measured.append(v)
            continue
        # `disposition_basis` is consulted as well as the block itself, because a
        # record disposed on the agent's attestation is attested whether or not
        # it also carried a characterisation of its own.
        if r.get('attested_characterisation') or r.get('disposition_basis') == ATTESTED:
            av = _flag(r.get('attested_characterisation'), field)
            if av is not None:
                attested.append(av)
    if measured:
        return MEASURED, sum(measured)
    if attested:
        return ATTESTED, sum(attested)
    return NOT_MEASURED, None


def _parallel_summary(p) -> dict | None:
    """The publishable shape of a wave run.

    Conflicts, out-of-assignment writes and red post-wave gates are the three
    things a parallel run can do that a sequential one cannot, so they are
    surfaced as totals rather than left in the per-wave detail. A parallel run
    reporting the same fields as a sequential one would hide its own failure mode.
    """
    if not p:
        return None
    waves = p.get('waves') or []
    outside = {uid: rels
               for w in waves
               for uid, rels in (w['integration'].get('out_of_assignment') or {}).items()
               if rels}
    return {
        'mode': p.get('mode'),
        'plan_id': p.get('plan_id'),
        'wave_count': p.get('wave_count'),
        'max_parallelism': p.get('max_parallelism'),
        'concurrency_cap': p.get('concurrency_cap'),
        'wall_s': p.get('wall_s'),
        'per_wave_wall_s': [w.get('wall_s') for w in waves],
        'conflicts_total': p.get('conflicts_total'),
        'contested_files_total': sum(len(w['integration'].get('contested_files') or [])
                                     for w in waves),
        'units_writing_outside_assignment': len(outside),
        'waves_gate_red': p.get('waves_gate_red') or [],
        'units_workflow_red_after_merge': sorted(
            {u for w in waves for u in (w['gate'].get('workflow_red') or [])}),
        'units_reopened_after_merge': sorted(
            {u for w in waves for u in (w['gate'].get('reopened') or [])}),
    }


def aggregate(records, *, run_meta, blind_audit, agent_desc,
              tree_digest_start=None, tree_digest_end=None,
              infrastructure_failures=(), started_at=None, parallel=None) -> dict:
    n = len(records)
    counts = {d: 0 for d in DISPOSITIONS}
    for r in records:
        counts[r.get('disposition', 'blocked')] = counts.get(
            r.get('disposition', 'blocked'), 0) + 1

    probe_basis, probe_ok = _coverage(records, 'probe_proven_pre_fix')
    wf_basis, wf_ok = _coverage(records, 'workflow_green_pre_fix')
    self_verification = {
        'probe_coverage': None if probe_ok is None else _pct(probe_ok, n),
        'workflow_characterised': None if wf_ok is None else _pct(wf_ok, n),
        # Null, not `n`. "Every task is unproven" is a finding; "no task was
        # checked" is not, and reading the second as the first is exactly the
        # over-report the tri-state exists to prevent.
        'probe_unproven_tasks': None if probe_ok is None else n - probe_ok,
        'characterisation_blocked_tasks': None if wf_ok is None else n - wf_ok,
    }
    # The basis is emitted only when the number is NOT the plain measured one,
    # so a v1 report is unchanged to the byte and an absent basis reads as
    # `measured`. A consumer should default it to `measured` for that reason.
    if probe_basis != MEASURED:
        self_verification['probe_coverage_basis'] = probe_basis
    if wf_basis != MEASURED:
        self_verification['workflow_characterised_basis'] = wf_basis

    greens = [r['measured'].get('rounds_to_green') for r in records
              if r.get('measured') and r['measured'].get('rounds_to_green') is not None]
    hist = {}
    for g in greens:
        hist[str(g)] = hist.get(str(g), 0) + 1
    never = n - len(greens)
    if never:
        hist['never'] = never

    files, added, removed, outside, deleters = set(), 0, 0, 0, 0
    for r in records:
        ds = r.get('diff_stats') or {}
        files.update(ds.get('files_touched') or [])
        added += ds.get('lines_added', 0)
        removed += ds.get('lines_removed', 0)
        outside += 1 if ds.get('touched_outside_bug_file') else 0
        deleters += 1 if ds.get('net_deletion') else 0

    claimed = [r for r in records if (r.get('attested') or {}).get('status') == 'fixed']
    # Calibration only -- this set answers "did the disposition AGREE with the
    # claim", not "how many succeeded". `fixed_workflow_red` is here for the same
    # reason the dispatcher records no `attestation_delta` for it: that disposition
    # is derived from the agent's own report, so nothing contradicted the claim and
    # counting it as `claimed_fixed_but_gates_red` would put a disagreement in the
    # record where there was none. It is still absent from every success total
    # below -- `dispositions` keeps it as its own key and nothing sums it.
    green_set = {'fixed', 'fixed_workflow_only', 'fixed_workflow_red'}
    claimed_green = sum(1 for r in claimed if r.get('disposition') in green_set)
    claimed_red = len(claimed) - claimed_green
    underclaim = sum(1 for r in records
                     if (r.get('attested') or {}).get('status') == 'not_fixed'
                     and r.get('disposition') in green_set)

    # Aggregate over `measured.invocations` -- every agent call, characterise
    # included. Falling back to `rounds` keeps older reports readable, but a run
    # recorded that way is SHORT by its characterise phases and is flagged as a
    # floor rather than presented as a total.
    total_cost, invocations, by_model = 0.0, 0, {}
    saw_cost = False
    partial_cost = False
    for r in records:
        m = r.get('measured') or {}
        invs = m.get('invocations')
        if invs is None:
            invs = [rd.get('agent') or {} for rd in (m.get('rounds') or [])]
            if invs:
                partial_cost = True
        for a in invs:
            invocations += 1
            if a.get('cost_usd') is not None:
                total_cost += a['cost_usd']
                saw_cost = True
            for model, u in (a.get('model_usage') or {}).items():
                slot = by_model.setdefault(model, {})
                for k, v in (u or {}).items():
                    if isinstance(v, (int, float)):
                        slot[k] = slot.get(k, 0) + v

    now = time.time()
    return {
        'run': {
            'run_id': run_meta.get('run_id'),
            'started_at': _iso(started_at or now),
            'finished_at': _iso(now),
            'wall_s': round(now - (started_at or now), 1),
            'target_dir': run_meta.get('target_dir'),
            'target_sha': run_meta.get('target_sha'),
            'tree_digest_start': tree_digest_start,
            'tree_digest_end': tree_digest_end,
            'bug_report_id': run_meta.get('bug_report_id'),
            'playbook_id': run_meta.get('playbook_id'),
            'config_digest': run_meta.get('config_digest'),
            'resumed_from': run_meta.get('resumed_from'),
            'agent': agent_desc,
            'cost': {
                'total_usd': round(total_cost, 4) if saw_cost else None,
                'invocations': invocations,
                'by_model': by_model,
                # True means the records predate per-invocation accounting, so this
                # total omits the characterise phases and is a floor, not a total.
                # Named in the report rather than left to be discovered.
                'excludes_characterise_phases': partial_cost,
            },
            'infrastructure_failures': list(infrastructure_failures),
        },
        'blind_audit': blind_audit,
        # Present only for a parallel run. Absent means the run was sequential --
        # never that it was parallel and clean.
        'parallel': _parallel_summary(parallel),
        'totals': {
            'tasks': n,
            'dispositions': counts,
            'self_verification': self_verification,
            'rounds_to_green': {
                'histogram': hist,
                'median': statistics.median(greens) if greens else None,
                'max': max(greens) if greens else None,
            },
            'blast_radius': {
                'files_touched_total': len(files),
                'lines_added_total': added,
                'lines_removed_total': removed,
                'tasks_touching_outside_bug_file': outside,
                'tasks_net_deletion': deleters,
            },
            'tasks_reverted': counts['abandoned'] + counts['agent_failed'] + counts['blocked'],
            'violations_total': sum(len(r.get('violations') or []) for r in records),
            'attestation_calibration': {
                'claimed_fixed': len(claimed),
                'claimed_fixed_and_gates_green': claimed_green,
                'claimed_fixed_but_gates_red': claimed_red,
                'claimed_not_fixed_but_gates_green': underclaim,
                'in_sandbox_overclaim_rate': _pct(claimed_red, len(claimed)),
            },
        },
        'tasks': records,
    }


def _coverage_line(sv: dict, key: str, n: int) -> str:
    """The right-hand side of one SELF-VERIFICATION line.

    A number that was never measured prints as words, never as a rate. Someone
    skimming a column of rates will not stop to ask whether `0.0` means the
    oracle failed or that there was no oracle, so the two never look alike here.
    An attested number prints its provenance beside it for the same reason: it
    is the agent's account of its own work and is not evidence of the same kind.
    """
    basis = sv.get(f'{key}_basis', MEASURED)
    if basis == NOT_MEASURED:
        return f'not measured  ({n} tasks — no pre-fix result was recorded)'
    if basis == ATTESTED:
        return f'{sv[key]}  ({n} tasks — ATTESTED by the agent, not measured here)'
    return f'{sv[key]}  ({n} tasks)'


def _iso(ts: float) -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts))


def write(report: dict, run_dir: str) -> str:
    path = os.path.join(run_dir, 'patcher-report.json')
    with open(path, 'w') as fh:
        json.dump(report, fh, indent=1)
    return path


def render_summary(report: dict) -> str:
    """Human-readable digest. Aggregate only -- publishable under the project's rule.

    `tasks[]` pairs a bug id with a file and a line and is deliberately absent.
    """
    t, run = report['totals'], report['run']
    d, sv, rg, br = (t['dispositions'], t['self_verification'],
                     t['rounds_to_green'], t['blast_radius'])
    cal = t['attestation_calibration']
    n = t['tasks']
    lines = []

    if report['blind_audit'].get('contaminated'):
        lines += ['', '!! BLIND BOUNDARY VIOLATED — every number below is void !!', '']
        for note in report['blind_audit'].get('notes', [])[:10]:
            lines.append(f'   {note}')
        lines.append('')
    elif report['blind_audit'].get('runtime_enforced') is False:
        lines += ['', '.. UNENFORCED RUNTIME — this is a mechanism test, not a '
                      'measurement ..', '']

    lines += [
        f"run {run['run_id']}  —  {n} task(s) in {run['wall_s'] / 3600:.1f}h",
        '',
        'DISPOSITIONS',
        f"  fixed (both axes verified in-sandbox) : {d['fixed']}",
        f"  fixed, remediation axis unverified    : {d['fixed_workflow_only']}",
        f"  fixed, workflow left red (attested)   : {d.get('fixed_workflow_red', 0)}",
        f"  already closed by an earlier task     : {d['already_remediated']}",
        f"  kept but gates red (partial)          : {d['partial']}",
        f"  abandoned, reverted                   : {d['abandoned']}",
        f"  agent failed                          : {d['agent_failed']}",
        f"  blocked before a fix was attempted    : {d['blocked']}",
        '',
        'SELF-VERIFICATION COVERAGE  (the ceiling on what the sandbox could check)',
        '  workflow baseline established : '
        + _coverage_line(sv, 'workflow_characterised', n),
        '  exploit probe reached PROVEN  : '
        + _coverage_line(sv, 'probe_coverage', n),
        '',
        'COST OF THE LOOP',
        f"  rounds to green (median / max): {rg['median']} / {rg['max']}",
        f"  histogram                     : {rg['histogram']}",
        f"  measured spend                : "
        + (f"${run['cost']['total_usd']:.2f}" if run['cost']['total_usd'] is not None
           else 'not reported by the runtime')
        + f" over {run['cost']['invocations']} invocation(s)"
        + ('  [FLOOR - excludes characterise phases]'
           if run['cost'].get('excludes_characterise_phases') else ''),
        '',
        'BLAST RADIUS',
        f"  files touched                 : {br['files_touched_total']}",
        f"  lines +{br['lines_added_total']} / -{br['lines_removed_total']}",
        f"  tasks reaching outside the bug file : {br['tasks_touching_outside_bug_file']}",
        f"  tasks that look like fix-by-deletion: {br['tasks_net_deletion']}"
        + ('   <- read every one of these by hand' if br['tasks_net_deletion'] else ''),
        '',
        'IN-SANDBOX CALIBRATION  (NOT the scorer\'s False Confidence Rate — no oracle here)',
        f"  claimed fixed                 : {cal['claimed_fixed']}",
        f"  ... and gates agreed          : {cal['claimed_fixed_and_gates_green']}",
        f"  ... but gates were red        : {cal['claimed_fixed_but_gates_red']}",
        f"  claimed not fixed, gates green: {cal['claimed_not_fixed_but_gates_green']}",
        f"  in-sandbox overclaim rate     : {cal['in_sandbox_overclaim_rate']}",
    ]
    if run['infrastructure_failures']:
        lines += ['', 'INFRASTRUCTURE FAILURES  (not reasoning results)']
        for f in run['infrastructure_failures'][:20]:
            lines.append(f"  {f['kind']}: {f.get('bug_id') or '-'} "
                         f"{f.get('phase') or ''} {(f.get('detail') or '')[:120]}")
    if t['violations_total']:
        lines += ['', f"RULES THE RUNNER HAD TO ENFORCE: {t['violations_total']} "
                      '(see tasks[].violations)']
    return '\n'.join(lines)
