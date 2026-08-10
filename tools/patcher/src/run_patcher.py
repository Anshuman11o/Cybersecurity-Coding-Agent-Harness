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
import glob
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
import grouping                    # noqa: E402
import integrator                  # noqa: E402
import task_loop                   # noqa: E402
import verify                      # noqa: E402
import wave_plan                   # noqa: E402
import wave_runner                 # noqa: E402
import workspace                   # noqa: E402

EXECUTION_MODES = ('sequential', 'waves')


def _parse_waves(spec, every: list) -> set:
    """"0" | "0,2" | "0-1" -> a set of wave numbers. None means all of them."""
    if not spec:
        return set(every)
    out = set()
    for part in str(spec).split(','):
        part = part.strip()
        if not part:
            continue
        try:
            if '-' in part:
                lo, hi = (int(x) for x in part.split('-', 1))
                out.update(range(lo, hi + 1))
            else:
                out.add(int(part))
        except ValueError:
            raise ValueError(f'--waves {spec!r}: {part!r} is not a wave number or range')
    unknown = sorted(out - set(every))
    if unknown:
        raise ValueError(f'--waves {spec!r}: this plan has no wave(s) {unknown}. '
                         f'It has {every}.')
    return out


def _merge_wave_runs(path: str, fresh: dict) -> dict:
    """Fold this checkpoint's waves into whatever earlier checkpoints recorded.

    Overwriting instead would leave the final report describing only the last
    wave -- a 24-bug run reading as an 8-bug one, with the earlier waves' conflicts
    and red gates silently gone.
    """
    if not os.path.exists(path):
        return fresh
    try:
        with open(path) as fh:
            prior = json.load(fh)
    except (OSError, ValueError):
        return fresh
    by_wave = {w['wave']: w for w in (prior.get('waves') or [])}
    by_wave.update({w['wave']: w for w in (fresh.get('waves') or [])})
    waves = [by_wave[n] for n in sorted(by_wave)]
    merged = {**prior, **fresh, 'waves': waves}
    merged['wall_s'] = round((prior.get('wall_s') or 0) + (fresh.get('wall_s') or 0), 1)
    merged['checkpoints'] = (prior.get('checkpoints') or 1) + 1
    merged['conflicts_total'] = sum(len(w['integration']['conflicts']) for w in waves)
    merged['waves_gate_red'] = [w['wave'] for w in waves if not w['gate'].get('green')]
    # Summed from the per-wave figures, never carried over from either side: a plain
    # dict merge would take the LAST checkpoint's totals and report one wave's spend
    # as the whole run's.
    merged['spend_usd'] = round(sum((w.get('usage') or {}).get('spend_usd') or 0
                                    for w in waves), 4)
    merged['invocations'] = sum((w.get('usage') or {}).get('invocations') or 0
                                for w in waves)
    merged['gate_seconds'] = round(sum((w.get('usage') or {}).get('gate_seconds') or 0
                                       for w in waves), 1)
    return merged

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

    # The application refuses to start unless its build output is present, and the
    # API suite boots the application. Point base_tree at an unbuilt checkout and
    # every API test aborts at load with "unsatisfied precondition" -- before a
    # single assertion runs. Nothing downstream distinguishes that from a patch
    # that broke the app: the agent's workflow gate goes red for a reason that has
    # nothing to do with its work, and the run reads as damage.
    #
    # This cost a full 2-task run. Checked here because it is free here.
    if os.path.isdir(base):
        required = ['build/server.js',
                    'frontend/dist/frontend/index.html',
                    'frontend/dist/frontend/styles.css',
                    'frontend/dist/frontend/main.js',
                    'frontend/dist/frontend/polyfills.js']
        missing = [r for r in required if not os.path.isfile(os.path.join(base, r))]
        if not glob.glob(os.path.join(base, 'frontend/dist/frontend/hacking-instructor-*.js')):
            missing.append('frontend/dist/frontend/hacking-instructor-*.js')
        if missing:
            problems.append(
                f'{base} is not built: {len(missing)} file(s) the application requires at '
                f'startup are missing ({", ".join(missing[:3])}'
                + (' ...' if len(missing) > 3 else '')
                + '). The API suite boots the app, so every API gate would fail at load '
                  'regardless of any patch. Point base_tree at a built tree, or build it.')

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

    gran = cfg.get('loop', {}).get('task_granularity', 'bug')
    if gran not in grouping.GRANULARITIES:
        problems.append(f'loop.task_granularity must be one of '
                        f'{", ".join(grouping.GRANULARITIES)} (got {gran!r})')

    # Execution mode and concurrency. These are checked together and loudly on
    # purpose: task_concurrency shipped in the example config for a release while
    # nothing read it, so a run asking for five agents got one and reported
    # success. A knob that silently does nothing is worse than a missing knob.
    loop = cfg.get('loop', {})
    mode = loop.get('execution', 'sequential')
    conc = loop.get('task_concurrency', 1)
    if mode not in EXECUTION_MODES:
        problems.append(f'loop.execution must be one of {" | ".join(EXECUTION_MODES)} '
                        f'(got {mode!r})')
    if not isinstance(conc, int) or conc < 1:
        problems.append(f'loop.task_concurrency must be an integer >= 1 (got {conc!r})')
    elif mode == 'sequential' and conc > 1:
        problems.append(
            f'loop.task_concurrency is {conc} but loop.execution is "sequential", which '
            'runs one task at a time. Set execution to "waves" to actually run in '
            'parallel. Refusing to accept a setting that would be ignored.')
    elif mode == 'waves':
        if gran != 'file':
            problems.append(
                'loop.execution "waves" requires loop.task_granularity "file". Waves '
                'guarantee that no two agents hold the same file, and that guarantee '
                'comes from grouping by file; per-bug units would put two agents in one '
                'file inside a single wave.')
        notes.append(f'execution: waves, up to {conc} chain(s) at a time')
        notes.append(f'post-wave gate: up to {integrator.gate_concurrency(cfg)} '
                     'unit gate(s) at a time')

    gconc = loop.get('gate_concurrency')
    if gconc is not None and (not isinstance(gconc, int) or gconc < 1):
        problems.append(f'loop.gate_concurrency must be an integer >= 1 (got {gconc!r})')

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
    ap.add_argument('--waves', metavar='SPEC',
                    help='waves mode only: run just these waves and stop, e.g. "0", '
                         '"0,1" or "0-1". Omitted means every wave. Use with --resume '
                         'to spend one session per wave instead of one per run.')
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
        try:
            st.assert_tree_matches(workspace.tree_digest(tree))
        except RuntimeError as ex:
            # A checkpointed run is resumed by hand, possibly days later. A
            # traceback here reads like a crash in the patcher; this is a refusal.
            log(str(ex))
            return 2
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

    granularity = cfg['loop'].get('task_granularity', 'bug')
    units = grouping.group(bug_report['bugs'], granularity)
    log(f'granularity={granularity}: {grouping.describe(units)}')
    pending = st.pending(units)
    if args.limit:
        pending = pending[:args.limit]
    log(f'{len(pending)} task(s) to run  '
        f"(net={cfg['policy'].get('regression_net')}, "
        f"rounds={cfg['loop'].get('reconcile_rounds')}, "
        f"on_exhausted={cfg['policy'].get('on_exhausted')})")

    # -- THE OUTER LOOP -----------------------------------------------------
    execution = cfg['loop'].get('execution', 'sequential')
    wave_run = None
    all_waves_done = True
    if execution == 'waves':
        plan_path = os.path.join(run_dir, 'wave-plan.json')

        # The plan is computed ONCE, from the tree as it was before any wave ran,
        # then reused. Recomputing it per checkpoint would read the import graph of
        # an already-patched tree, so a fix that added or removed an import could
        # silently reshape the remaining waves -- and the run would have executed
        # two different plans while reporting one.
        if os.path.exists(plan_path):
            with open(plan_path) as fh:
                plan = json.load(fh)
            if plan.get('bug_report_id') not in (None, bug_report.get('report_id')):
                log(f'{plan_path} was built for bug report {plan["bug_report_id"]!r}, '
                    f'but this config supplies {bug_report.get("report_id")!r}. '
                    'Refusing to continue a plan that describes different bugs.')
                return 2
            log(f'reusing the plan recorded at wave 0 '
                f'({plan["wave_count"]} wave(s), {plan["unit_count"]} unit(s))')
        else:
            plan = wave_plan.plan(
                bug_report['bugs'], tree,
                isolate_hubs=cfg['loop'].get('isolate_hubs', True),
                hub_threshold=int(cfg['loop'].get('hub_threshold', 8)))
            plan['bug_report_id'] = bug_report.get('report_id')
            with open(plan_path, 'w') as fh:
                json.dump(plan, fh, indent=1)
        log(wave_plan.render(plan))

        every = [w['wave'] for w in plan['waves']]
        done = list(st.meta.get('waves_done') or [])
        try:
            selected = _parse_waves(args.waves, every)
        except ValueError as ex:
            log(str(ex))
            return 2

        todo = [w for w in plan['waves']
                if w['wave'] in selected and w['wave'] not in done]

        # Waves are an ordering. Running one before the wave it depends on would
        # characterise against a base that has not been established yet, which is
        # the whole thing the plan exists to prevent.
        for w in todo:
            missing = [n for n in every
                       if n < w['wave'] and n not in done and n not in selected]
            if missing:
                log(f'refusing to run wave {w["wave"]}: wave(s) {missing} have not run. '
                    'A later wave patches on top of an earlier one; running it first '
                    'would characterise against a base that does not exist yet.')
                return 2

        if done:
            log(f'resuming: wave(s) {done} already complete, '
                f'{len(st.records)} unit record(s) on file')
        if not todo:
            log(f'nothing to do: wave(s) {sorted(selected)} already complete')

        def _append(rec):
            st.append(rec, st.tree_digest or digest_start)
            st.flush()

        def _wave_done(wave_no, digest):
            """Checkpoint. Written before the next wave starts, so an interruption
            costs the wave that was running and never one already paid for."""
            st.meta.setdefault('waves_done', []).append(wave_no)
            st.tree_digest = digest
            st.flush()

        wave_run = wave_runner.run_waves(
            {**plan, 'waves': todo}, cfg=cfg, units=units, runner=runner,
            playbook=playbook, run_dir=run_dir, seed=tree,
            concurrency=int(cfg['loop'].get('task_concurrency', 1)),
            log=log, on_record=_append, on_wave_done=_wave_done)

        st.tree_digest = workspace.tree_digest(tree)
        st.flush()
        wave_run = _merge_wave_runs(os.path.join(run_dir, 'wave-run.json'), wave_run)
        with open(os.path.join(run_dir, 'wave-run.json'), 'w') as fh:
            json.dump(wave_run, fh, indent=1)
        remaining = [n for n in every if n not in (st.meta.get('waves_done') or [])]
        all_waves_done = not remaining
        if remaining:
            log(f'CHECKPOINT: wave(s) {remaining} still to run. Continue with '
                f'--resume {cfg["run_id"]} --waves {remaining[0]}')

        # Fold the per-chain audit logs into the one path the blind audit reads.
        # Without this the audit would open an untouched guard.jsonl, find nothing,
        # and report a clean boundary for a run it never actually looked at.
        merged = sorted(glob.glob(os.path.join(run_dir, 'guard', '*.jsonl')))
        with open(ctx.guard_log(), 'a') as out:
            for src in merged:
                with open(src) as fh:
                    shutil.copyfileobj(fh, out)
        log(f'merged {len(merged)} per-chain guard log(s) into {ctx.guard_log()}')
        if not merged:
            st.note_infrastructure_failure(
                'guard_log_missing', detail='no per-chain guard logs were written; '
                'the contamination audit for this run has no input')
        log(f"waves complete in {wave_run['wall_s'] / 60:.1f} min  "
            f"conflicts={wave_run['conflicts_total']}  "
            f"gate_red_waves={wave_run['waves_gate_red'] or 'none'}")
        pending = []

    index = len(st.records)
    for bug in pending:
        n_in_unit = len(bug.get('members') or [])
        log(f"task {index + 1}/{len(units)}  {bug['bug_id']}  "
            f"{bug['location']['file']}:{bug['location']['line']}  [{bug.get('class')}]"
            + (f'  ({n_in_unit} bugs)' if n_in_unit else ''))
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
    if not all_waves_done:
        log('skipping the full suite: waves remain, so this is not the final tree. '
            'Running it now would publish a partial run as a finished one.')
    elif cfg['policy'].get('final_full_suite') and runner_kind != 'fake':
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
        started_at=st.started_at, parallel=wave_run)

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
