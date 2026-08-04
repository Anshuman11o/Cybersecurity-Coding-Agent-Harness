#!/usr/bin/env python3
"""
Entrypoint. The outer loop: one task per bug, until the report is empty.

    python3 run_patcher.py --config <cfg> --check        validate, spend nothing
    python3 run_patcher.py --config <cfg>                run
    python3 run_patcher.py --config <cfg> --agent fake   drive the loop for free
    python3 run_patcher.py --config <cfg> --resume <id>  continue after an interruption

A run takes hours and will outlive the session that started it. Launch it
detached (`setsid nohup ... &`) and let the per-task checkpoint do its job: an
interruption should cost one task, not a run. One run has already been lost in
this project for want of that.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent as agent_mod          # noqa: E402
import blind_guard                 # noqa: E402
import report as report_mod        # noqa: E402
import state as state_mod          # noqa: E402
import task_loop                   # noqa: E402
import verify                      # noqa: E402
import workspace                   # noqa: E402

# .../<repo>/tools/patcher/src/run_patcher.py  ->  <repo>
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         '..', '..', '..'))


def log(msg: str) -> None:
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def _abs(path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(REPO_ROOT, path)


def load_config(path: str) -> dict:
    with open(path) as fh:
        cfg = json.load(fh)
    run_id = cfg.get('run_id') or 'patch-run'
    cfg['run_id'] = run_id
    out = cfg.setdefault('outputs', {})
    out['run_dir'] = _abs((out.get('run_dir') or f'./runs/{run_id}').replace(
        '{run_id}', run_id))
    for key in ('bug_report', 'playbook'):
        cfg['inputs'][key] = _abs(cfg['inputs'][key])
    tgt = cfg['target']
    tgt['base_tree'] = _abs(tgt['base_tree'])
    tgt['work_tree'] = _abs(tgt['work_tree'])
    if tgt.get('node_modules'):
        tgt['node_modules'] = _abs(tgt['node_modules'])
    return cfg


def config_digest(cfg: dict) -> str:
    scrubbed = {k: v for k, v in cfg.items() if not k.startswith('_')}
    return hashlib.sha256(json.dumps(scrubbed, sort_keys=True,
                                     default=str).encode()).hexdigest()[:16]


# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

def preflight(cfg: dict, runner_kind: str) -> list:
    """Everything that can be wrong before a token is spent. Run this every time."""
    problems, notes = [], []

    try:
        bug_report, br_rep = blind_guard.load_bug_report(cfg['inputs']['bug_report'])
        notes.append(f"bug report: {len(bug_report['bugs'])} task(s), "
                     f"{len({b['location']['file'] for b in bug_report['bugs']})} file(s)")
        if br_rep.keys_stripped:
            notes.append(f'bug report: {len(br_rep.keys_stripped)} withheld key(s) '
                         'stripped before dispatch')
        for w in br_rep.warnings:
            notes.append(f'bug report: {w}')
    except Exception as ex:                                      # noqa: BLE001
        problems.append(f'bug report: {ex}')
        bug_report = None

    try:
        playbook, pb_rep = blind_guard.load_playbook(cfg['inputs']['playbook'])
        notes.append(f"playbook: {len(playbook['entries'])} entry/entries")
        for w in pb_rep.warnings:
            notes.append(f'playbook: {w}')
    except Exception as ex:                                      # noqa: BLE001
        problems.append(f'playbook: {ex}')
        playbook = None

    if bug_report and playbook:
        unmatched = [b['bug_id'] for b in bug_report['bugs']
                     if blind_guard.select_entry(playbook, b)[0] is None]
        if unmatched:
            notes.append(f'{len(unmatched)} bug(s) have no playbook entry and will run on '
                         f'class guidance alone: {", ".join(unmatched[:8])}'
                         + (' ...' if len(unmatched) > 8 else ''))

    base = cfg['target']['base_tree']
    if not os.path.isdir(base):
        problems.append(f'base tree does not exist: {base}')
    elif not os.path.isfile(os.path.join(base, 'package.json')):
        problems.append(f'{base} has no package.json; that is not the application tree')

    nm = cfg['target'].get('node_modules')
    if nm and not os.path.isdir(nm):
        problems.append(
            f'node_modules {nm} does not exist. Install it once, outside the tree '
            '(`npm ci` against a committed lockfile), and point the config at it. The '
            'patcher may not run installs, and an unpinned tree makes every differential '
            'metric unattributable.')

    hook = agent_mod.HOOK
    if not os.path.isfile(hook):
        problems.append(f'sandbox hook missing: {hook}. Refusing to run unguarded.')
    else:
        probe = subprocess.run(
            ['python3', hook, '--tree', base, '--log', os.devnull, '--phase', 'fix'],
            input=json.dumps({'tool_name': 'Read', 'cwd': base,
                              'tool_input': {'file_path': '/etc/passwd'}}),
            capture_output=True, text=True)
        try:
            decision = json.loads(probe.stdout)['hookSpecificOutput']['permissionDecision']
        except Exception:                                        # noqa: BLE001
            decision = None
        if decision != 'deny':
            problems.append(
                'sandbox hook did not deny an out-of-tree read during preflight '
                f'(returned {decision!r}). The boundary is not enforced; refusing to run.')
        else:
            notes.append('sandbox hook: verified — denies out-of-tree access')

    if runner_kind != 'fake' and not shutil.which('claude'):
        problems.append('`claude` is not on PATH; the configured runtime cannot start')

    for key in ('typecheck', 'run_test_file', 'run_probe'):
        if not cfg.get('commands', {}).get(key):
            problems.append(f'commands.{key} is not configured; gate {key} cannot run')

    if cfg.get('policy', {}).get('on_exhausted') not in (
            'revert', 'keep_best', 'keep_if_workflow_intact'):
        problems.append("policy.on_exhausted must be revert | keep_best | "
                        "keep_if_workflow_intact")

    return problems, notes, bug_report, playbook


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description='Run the patcher agent loop.')
    ap.add_argument('--config', required=True)
    ap.add_argument('--check', action='store_true',
                    help='validate inputs, tree, toolchain and sandbox, then exit')
    ap.add_argument('--agent', choices=['claude-cli', 'fake'], default=None)
    ap.add_argument('--resume', metavar='RUN_ID')
    ap.add_argument('--force', action='store_true',
                    help='rebuild the work tree even if one exists')
    ap.add_argument('--limit', type=int, default=0,
                    help='stop after N tasks (smoke-testing a real run)')
    args = ap.parse_args()

    cfg = load_config(args.config)
    runner_kind = args.agent or cfg.get('agent', {}).get('runner', 'claude-cli')

    problems, notes, bug_report, playbook = preflight(cfg, runner_kind)
    for n in notes:
        log(f'  ok   {n}')
    for p in problems:
        log(f'  FAIL {p}')
    if problems:
        log(f'{len(problems)} problem(s). Nothing was run and nothing was spent.')
        return 2
    if args.check:
        log('preflight clean.')
        return 0

    run_dir = cfg['outputs']['run_dir']
    os.makedirs(run_dir, exist_ok=True)
    tree = cfg['target']['work_tree']
    state_path = os.path.join(run_dir, 'state.json')

    # -- tree ---------------------------------------------------------------
    if args.resume:
        if not os.path.exists(state_path):
            log(f'no state at {state_path}; cannot resume {args.resume}')
            return 2
        st = state_mod.RunState.load(state_path)
        st.assert_tree_matches(workspace.tree_digest(tree))
        log(f'resuming {args.resume}: {len(st.records)} task(s) already complete')
    else:
        workspace.prepare(cfg['target']['base_tree'], tree,
                          cfg['target'].get('node_modules'), force=args.force)
        st = state_mod.RunState(state_path, meta={
            'run_id': cfg['run_id'],
            'target_dir': cfg['target']['base_tree'],
            'target_sha': bug_report.get('target_sha'),
            'bug_report_id': bug_report.get('report_id'),
            'playbook_id': playbook.get('playbook_id'),
            'config_digest': config_digest(cfg),
            'resumed_from': None,
        })
        st.flush()
        log(f'work tree built at {tree}')

    if args.resume:
        st.meta['resumed_from'] = args.resume
    digest_start = st.meta.setdefault('tree_digest_start', workspace.tree_digest(tree))

    # -- runner -------------------------------------------------------------
    runner = agent_mod.build_runner(cfg, os.path.join(run_dir, 'sandbox'), runner_kind)
    ctx = task_loop.TaskContext(cfg, tree, runner, playbook, run_dir, log=log)
    for r in st.records:
        if r.get('disposition') in ('fixed', 'fixed_workflow_only', 'partial'):
            loc = r.get('location') or {}
            ctx.touched_locations[f"{loc.get('file')}:{loc.get('line')}"] = r['bug_id']

    pending = st.pending(bug_report['bugs'])
    if args.limit:
        pending = pending[:args.limit]
    log(f'{len(pending)} task(s) to run  '
        f"(net={cfg['policy'].get('regression_net')}, "
        f"rounds={cfg['loop'].get('reconcile_rounds')}, "
        f"on_exhausted={cfg['policy'].get('on_exhausted')})")

    # -- THE OUTER LOOP -----------------------------------------------------
    index = len(st.records)
    for bug in pending:
        log(f"task {index + 1}/{len(bug_report['bugs'])}  {bug['bug_id']}  "
            f"{bug['location']['file']}:{bug['location']['line']}  [{bug.get('class')}]")
        try:
            rec = task_loop.run_task(bug, index, ctx)
        except KeyboardInterrupt:
            st.flush()
            log('interrupted; state flushed. Resume with --resume '
                f"{cfg['run_id']}")
            return 130
        except Exception as ex:                                  # noqa: BLE001
            # One poisoned task must not end the run.
            log(f"  !! {bug['bug_id']} crashed the orchestrator: "
                f'{type(ex).__name__}: {ex}')
            st.note_infrastructure_failure('crash', bug['bug_id'], detail=str(ex)[:400])
            rec = {'bug_id': bug['bug_id'], 'task_index': index,
                   'location': bug['location'], 'disposition': 'blocked',
                   'disposition_reason': f'orchestrator crash: {type(ex).__name__}: {ex}',
                   'measured': {'characterisation': {'workflow_green_pre_fix': False,
                                                     'probe_proven_pre_fix': False},
                                'rounds': [], 'final_gates': {}, 'rounds_to_green': None,
                                'wall_s': 0.0, 'cost_usd': None},
                   'attested': None, 'diff_stats': {'files_touched': [], 'lines_added': 0,
                                                    'lines_removed': 0},
                   'violations': []}

        for rd in (rec.get('measured') or {}).get('rounds') or []:
            a = rd.get('agent') or {}
            if not a.get('ok') and a.get('reason'):
                kind = ('timeout' if 'timeout' in a['reason'] else
                        'rate_limit' if 'rate limit' in a['reason'] else
                        'unparseable' if 'unparseable' in a['reason'] else 'crash')
                st.note_infrastructure_failure(kind, bug['bug_id'], a.get('phase'),
                                               a['reason'][:300])

        st.append(rec, workspace.tree_digest(tree))
        st.flush()
        ds = rec.get('diff_stats') or {}
        log(f"  -> {rec['disposition']}  "
            f"rounds_to_green={(rec.get('measured') or {}).get('rounds_to_green')}  "
            f"+{ds.get('lines_added', 0)}/-{ds.get('lines_removed', 0)}  "
            f"${(rec.get('measured') or {}).get('cost_usd') or 0:.2f}")
        index += 1

    # -- end-of-run global net ---------------------------------------------
    full_suite = None
    if cfg['policy'].get('final_full_suite') and runner_kind != 'fake':
        log('running the full suite once, as the global net')
        full_suite = verify.run_full_suite(cfg, tree)
        for s in full_suite:
            log(f"  {'ok  ' if s['ok'] else 'FAIL'} {s['command']}  "
                f"({s['duration_s']}s, {len(s['outcomes'])} test(s))")
        with open(os.path.join(run_dir, 'full-suite.json'), 'w') as fh:
            json.dump(full_suite, fh, indent=1)

    # -- outputs ------------------------------------------------------------
    workspace.cleanup(tree)
    digest_end = workspace.tree_digest(tree)

    _, _, br_rep = None, None, None
    scrub_reports = []
    try:
        _, br_rep = blind_guard.load_bug_report(cfg['inputs']['bug_report'])
        scrub_reports.append(br_rep)
        _, pb_rep = blind_guard.load_playbook(cfg['inputs']['playbook'])
        scrub_reports.append(pb_rep)
    except Exception:                                            # noqa: BLE001
        pass

    audit = blind_guard.audit_run(ctx.guard_log(), scrub_reports,
                                  runtime_enforced=(runner_kind != 'fake'))
    rep = report_mod.aggregate(
        st.records, run_meta=st.meta, blind_audit=audit,
        agent_desc={**runner.describe(),
                    'reconcile_rounds': cfg['loop'].get('reconcile_rounds'),
                    'characterise_rounds': cfg['loop'].get('characterise_rounds'),
                    'on_exhausted': cfg['policy'].get('on_exhausted'),
                    'regression_net': cfg['policy'].get('regression_net'),
                    'require_probe': cfg['policy'].get('require_probe')},
        tree_digest_start=digest_start, tree_digest_end=digest_end,
        infrastructure_failures=st.infrastructure_failures,
        started_at=st.started_at)

    path = report_mod.write(rep, run_dir)
    st.flush()

    print()
    print(report_mod.render_summary(rep))
    print()
    log(f'report      : {path}')
    log(f'patched tree: {tree}   (digest {digest_end[:16]})')
    if audit['contaminated']:
        log('BLIND BOUNDARY VIOLATED — this run\'s numbers are void. See blind_audit.')
        return 3
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
