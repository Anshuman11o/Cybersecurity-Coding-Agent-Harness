#!/usr/bin/env python3
"""
Task records -> `patcher-report.json`, one of the run's two outputs.

Reporting rules this module encodes rather than leaves to whoever reads it:

- `fixed` and `fixed_workflow_only` are never summed. The second means the agent
  could not demonstrate the defect in its own sandbox, so the remediation axis
  is unverified; folding it in is the false-confidence failure the eval exists
  to catch.
- Every rate is emitted with its denominator. A percentage without one is not
  comparable across runs.
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

DISPOSITIONS = ('fixed', 'fixed_workflow_only', 'already_remediated', 'abandoned',
                'partial', 'agent_failed', 'blocked')


def _pct(num, den):
    return round(num / den, 4) if den else None


def aggregate(records, *, run_meta, blind_audit, agent_desc,
              tree_digest_start=None, tree_digest_end=None,
              infrastructure_failures=(), started_at=None) -> dict:
    n = len(records)
    counts = {d: 0 for d in DISPOSITIONS}
    for r in records:
        counts[r.get('disposition', 'blocked')] = counts.get(
            r.get('disposition', 'blocked'), 0) + 1

    ch = [r['measured']['characterisation'] for r in records if r.get('measured')]
    probe_ok = sum(1 for c in ch if c.get('probe_proven_pre_fix'))
    wf_ok = sum(1 for c in ch if c.get('workflow_green_pre_fix'))

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
    green_set = {'fixed', 'fixed_workflow_only'}
    claimed_green = sum(1 for r in claimed if r.get('disposition') in green_set)
    claimed_red = len(claimed) - claimed_green
    underclaim = sum(1 for r in records
                     if (r.get('attested') or {}).get('status') == 'not_fixed'
                     and r.get('disposition') in green_set)

    total_cost, invocations, by_model = 0.0, 0, {}
    saw_cost = False
    for r in records:
        for rd in (r.get('measured') or {}).get('rounds') or []:
            a = rd.get('agent') or {}
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
            },
            'infrastructure_failures': list(infrastructure_failures),
        },
        'blind_audit': blind_audit,
        'totals': {
            'tasks': n,
            'dispositions': counts,
            'self_verification': {
                'probe_coverage': _pct(probe_ok, n),
                'workflow_characterised': _pct(wf_ok, n),
                'probe_unproven_tasks': n - probe_ok,
                'characterisation_blocked_tasks': n - wf_ok,
            },
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
        f"  already closed by an earlier task     : {d['already_remediated']}",
        f"  kept but gates red (partial)          : {d['partial']}",
        f"  abandoned, reverted                   : {d['abandoned']}",
        f"  agent failed                          : {d['agent_failed']}",
        f"  blocked before a fix was attempted    : {d['blocked']}",
        '',
        'SELF-VERIFICATION COVERAGE  (the ceiling on what the sandbox could check)',
        f"  workflow baseline established : {sv['workflow_characterised']}  ({n} tasks)",
        f"  exploit probe reached PROVEN  : {sv['probe_coverage']}  ({n} tasks)",
        '',
        'COST OF THE LOOP',
        f"  rounds to green (median / max): {rg['median']} / {rg['max']}",
        f"  histogram                     : {rg['histogram']}",
        f"  measured spend                : "
        + (f"${run['cost']['total_usd']:.2f}" if run['cost']['total_usd'] is not None
           else 'not reported by the runtime')
        + f" over {run['cost']['invocations']} invocation(s)",
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
