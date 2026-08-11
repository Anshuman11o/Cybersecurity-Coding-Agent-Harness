#!/usr/bin/env python3
"""
Drive a v3 dispatch run: load, validate, dispatch, checkpoint, audit, report.

A separate entry point on purpose. `ARCHITECTURE-V3.md` §8 keeps v3 out of
`run_patcher.py` because wiring it in means editing the file that runs v1 and v2,
and both are load-bearing and unchanged. This script imports the same loaders,
the same runner, the same guard and the same reporter; only the orchestration
differs.

Usage
-----
    python3 src/run_patcher_v3.py --config config/subsetN.run-config.json --check
    python3 src/run_patcher_v3.py --config config/subsetN.run-config.json
    python3 src/run_patcher_v3.py --config ... --phases 0      # one phase, then stop
    python3 src/run_patcher_v3.py --config ... --resume        # continue where it died

What this does that the Dispatcher does not
-------------------------------------------
`Dispatcher` holds its results in memory and writes only guard logs and agent
transcripts. Three things have to happen around it or a paid run is unrecoverable
and unauditable:

1. **Checkpoint.** A `RunStore` is passed in, so every task is streamed as it
   ends and every phase is written before the next one starts. `--resume` picks
   up at the first phase that never completed.
2. **Concatenate the guard logs.** The dispatcher writes one per chunk;
   `blind_guard.audit_run` reads one path. Auditing a single chunk's log
   certifies the run blind on a fraction of its evidence.
3. **Write `patcher-report.json`.** It is what `archive_run.py` reads, and
   nothing on the v3 path produced it.

Long runs
---------
A v3 run outlives a session. Launch it detached and let the checkpoints do the
rest:

    setsid nohup python3 src/run_patcher_v3.py --config ... > run.log 2>&1 &

If it dies anyway, `--resume` costs one phase, not the run.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent as agent_mod                                        # noqa: E402
import blind_guard                                               # noqa: E402
import report as report_mod                                      # noqa: E402
import run_patcher                                               # noqa: E402
import workspace                                                 # noqa: E402
from v3 import chunk_map as chunk_map_mod                        # noqa: E402
from v3 import dispatcher as dispatcher_mod                      # noqa: E402
from v3 import merge_queue as mq                                 # noqa: E402
from v3 import run_store as run_store_mod                        # noqa: E402


def log(msg: str) -> None:
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def load_config(path: str) -> dict:
    """`run_patcher.load_config`, plus the one key v3 adds.

    `inputs.chunk_map` has no v1/v2 counterpart, so the shared loader does not
    normalise it and a relative path would resolve against the caller's cwd
    instead of the repository root -- the same path meaning two things depending
    on where the run was launched from. Resolved here rather than in
    `run_patcher.load_config`, because ARCHITECTURE-V3 §8 keeps v3 out of the file
    that runs v1 and v2.
    """
    cfg = run_patcher.load_config(path)
    cmap_path = (cfg.get('inputs') or {}).get('chunk_map')
    if cmap_path:
        cfg['inputs']['chunk_map'] = run_patcher._abs(cmap_path)
    return cfg


# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

def preflight(cfg: dict, runner_kind: str):
    """Everything that can be wrong before a token is spent.

    Reuses `run_patcher.preflight` for the inputs, the tree and the toolchain --
    including the built-artefacts check, which once cost a full run -- then
    replaces the v1/v2 execution checks with v3's, and adds the chunk map.
    """
    problems, notes, bug_report, playbook = run_patcher.preflight(cfg, runner_kind)

    # v2's execution rules do not apply here and their failures are not real.
    # v3 has no `execution` mode, and its tasks are bug-wise by construction, so
    # `task_granularity` is meaningless rather than wrong.
    problems = [p for p in problems
                if 'loop.execution' not in p and 'loop.task_granularity' not in p]
    notes = [n for n in notes if not n.startswith('execution:')
             and not n.startswith('post-wave gate:')]
    notes.append('execution: v3 dispatch -- tasks are bug-wise, '
                 'parallelism is across chunks only')

    path = (cfg.get('inputs') or {}).get('chunk_map')
    cmap = None
    if not path:
        problems.append('inputs.chunk_map is not configured; v3 runs an offline '
                        'plan and cannot compute one')
    else:
        try:
            cmap = chunk_map_mod.load(path)
            chunk_map_mod.validate(cmap)
            notes.append(f'chunk map: {cmap.describe().splitlines()[0]}')
        except Exception as ex:                                  # noqa: BLE001
            problems.append(f'chunk map: {ex}')

    if cmap is not None and bug_report is not None:
        try:
            chunk_map_mod.validate_against_report(cmap, bug_report['bugs'])
            notes.append(f'chunk map covers all {len(bug_report["bugs"])} bug(s) '
                         'in the report')
        except Exception as ex:                                  # noqa: BLE001
            problems.append(f'chunk map vs bug report: {ex}')

        denied = set(cmap.read_denylist)
        leaked = sorted({f for files in cmap.owned_files().values() for f in files}
                        & denied)
        if leaked:
            problems.append(
                'the chunk map assigns read-denylisted file(s) to a chunk: '
                f'{", ".join(leaked)}. A chunk agent is handed its owned files, so '
                'this would put challenge keys into a prompt.')

    if cmap is not None:
        for phase_no in cmap.phase_order():
            n = len(cmap.chunks_in_phase(phase_no))
            notes.append(f'phase {phase_no}: {n} chunk(s), up to '
                         f'{min(cmap.concurrency_for_phase(phase_no), n)} agent(s) '
                         'at a time')

    if not (cfg.get('commands') or {}).get('typecheck'):
        problems.append('commands.typecheck is not configured; the merge queue '
                        'build gate cannot run, and without it every chunk merges '
                        'without ever being compiled')

    if not (cfg.get('commands') or {}).get('full_suite'):
        notes.append('commands.full_suite is not configured; the end-of-run suite '
                     'will be recorded as NOT RUN rather than as passing')

    loop = cfg.get('loop') or {}
    if loop.get('cost_ceiling_usd') is None:
        notes.append('loop.cost_ceiling_usd is unset: this run has no budget ceiling')
    if loop.get('chunk_timeout_s') is None:
        notes.append('loop.chunk_timeout_s is unset: a wedged chunk will not be '
                     'timed out')
    if loop.get('reuse_characterisation') is None:
        notes.append('loop.reuse_characterisation is unset, defaulting to true: '
                     'the second and later bugs in a file reuse the first one\'s '
                     'oracle, which forces `fixed_workflow_only` and makes '
                     '`already_remediated` unreachable')

    return problems, notes, bug_report, playbook, cmap


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description='Run the v3 dispatcher.')
    ap.add_argument('--config', required=True)
    ap.add_argument('--check', action='store_true',
                    help='validate inputs, map, tree and toolchain, then exit')
    ap.add_argument('--agent', choices=['claude-cli', 'fake'], default=None)
    ap.add_argument('--resume', action='store_true',
                    help='continue an existing run in outputs.run_dir, skipping '
                         'phases that already completed')
    ap.add_argument('--force', action='store_true',
                    help='rebuild the trunk even if one exists')
    ap.add_argument('--phases', metavar='SPEC',
                    help='run only these phases, e.g. "0" or "0,1". Omitted means '
                         'every phase. The end-of-run suite is skipped unless the '
                         'run covers every phase in the map.')
    ap.add_argument('--no-reuse-characterisation', action='store_true',
                    help='override loop.reuse_characterisation to false: characterise '
                         'every bug separately instead of reusing the first '
                         'characterisation of each file. Costs one extra invocation '
                         'per additional bug in a file, and is what makes '
                         '`already_remediated` reachable: the reuse path forces '
                         '`fixed_workflow_only` instead. Prefer setting it in the '
                         'config, which is what config_digest records.')
    args = ap.parse_args()

    cfg = load_config(args.config)
    runner_kind = args.agent or cfg.get('agent', {}).get('runner', 'claude-cli')

    problems, notes, bug_report, playbook, cmap = preflight(cfg, runner_kind)
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
    trunk = cfg['target']['work_tree']
    phases = None
    if args.phases:
        phases = sorted({int(x) for x in args.phases.replace(' ', '').split(',') if x})

    # -- store and trunk ----------------------------------------------------
    if args.resume:
        if not run_store_mod.RunStore.exists_at(run_dir):
            log(f'no v3 run store at {run_dir}; nothing to resume')
            return 2
        store = run_store_mod.RunStore.load(run_dir)
        try:
            store.assert_tree_matches(workspace.tree_digest(trunk))
        except RuntimeError as ex:
            # A checkpointed run is resumed by hand, possibly days later. A
            # traceback here reads like a crash in the patcher; this is a refusal.
            log(str(ex))
            return 2
        log(f'resuming {store.meta.get("run_id")}: phase(s) '
            f'{sorted(store.completed_phases) or "none"} already complete, '
            f'${store.spend_usd} already spent')
    else:
        if run_store_mod.RunStore.exists_at(run_dir) and not args.force:
            log(f'a v3 run store already exists at {run_dir}. Use --resume to '
                'continue it, or --force to rebuild the trunk and start over. '
                'Refusing to overwrite a run that was paid for.')
            return 2
        workspace.prepare(cfg['target']['base_tree'], trunk,
                          cfg['target'].get('node_modules'), force=args.force)
        store = run_store_mod.RunStore(run_dir, meta={
            'run_id': cfg['run_id'],
            'engine': 'v3-dispatch',
            'target_dir': cfg['target']['base_tree'],
            'target_sha': bug_report.get('target_sha'),
            'bug_report_id': bug_report.get('report_id'),
            'playbook_id': playbook.get('playbook_id'),
            'map_id': cmap.map_id,
            'chunk_map': cfg['inputs']['chunk_map'],
            'config_digest': run_patcher.config_digest(cfg),
        })
        log(f'trunk built at {trunk}')
    store.begin()
    digest_start = store.meta.setdefault('tree_digest_start',
                                         workspace.tree_digest(trunk))
    store.flush()

    # -- dispatch -----------------------------------------------------------
    runner = agent_mod.build_runner(cfg, os.path.join(run_dir, 'sandbox'),
                                    runner_kind)
    # Config first, CLI as an override. The config is what `config_digest` hashes
    # into the run record, so a run configured here can say later how it ran; a
    # flag typed at the shell leaves no trace.
    reuse = bool((cfg.get('loop') or {}).get('reuse_characterisation', True))
    if args.no_reuse_characterisation:
        reuse = False
    log(f'reuse_characterisation={reuse}'
        + ('' if reuse else '  (already_remediated is reachable)')
        + ('  [--no-reuse-characterisation overrode the config]'
           if args.no_reuse_characterisation else ''))

    d = dispatcher_mod.Dispatcher(
        cmap,
        bugs=bug_report['bugs'],
        playbook=playbook,
        runner=runner,
        trunk=trunk,
        run_dir=run_dir,
        cfg=cfg,
        log=log,
        store=store,
        reuse_characterisation=reuse,
        # Not optional. The constructor's fallback is `always_ok`, which accepts
        # every merge without compiling anything.
        build_gate=mq.typecheck_gate(cfg),
    )

    try:
        result = d.run(phases=phases)
    except KeyboardInterrupt:
        store.note_infrastructure_failure('interrupted',
                                          detail='KeyboardInterrupt')
        log('interrupted. Completed phases are checkpointed; --resume continues.')
        return 130
    except Exception as ex:                                      # noqa: BLE001
        # The run died mid-phase. Everything up to the last completed phase is on
        # disk; say so rather than letting the traceback imply total loss.
        store.note_infrastructure_failure('dispatch_crash',
                                          detail=f'{type(ex).__name__}: {ex}')
        log(f'!! run crashed: {type(ex).__name__}: {ex}')
        log(f'   phase(s) {sorted(store.completed_phases) or "none"} are '
            f'checkpointed at {run_dir}; --resume continues from there.')
        raise

    # -- audit --------------------------------------------------------------
    combined = store.merge_guard_logs()
    parts = store.guard_log_parts()
    if combined:
        log(f'guard: {len(parts)} chunk log(s) concatenated for the audit')
    else:
        log('guard: no chunk logs found')
    # The inputs are re-loaded purely to recover their `ScrubReport`s. `preflight`
    # already loaded and scrubbed them, but it kept the documents and dropped the
    # reports, and `audit_run` defaults `scrub_reports=()` -- which makes its
    # `input_scrub` block assert `bug_report_clean: True, playbook_clean: True,
    # keys_stripped: []` whether or not anything was stripped. An assertion that
    # is unconditional is not evidence.
    #
    # The severity is bounded, and worth being exact about: a forbidden VALUE in
    # an input raises `BlindBoundaryError` out of `blind_guard.scrub`, so preflight
    # would already have refused the run and no run can reach this line with
    # withheld material embedded in it. What the empty default silently loses is
    # the record of the keys that WERE stripped -- the signal that the generator
    # producing these inputs is emitting material it should not -- and the
    # warnings, including the playbook's `content_status`, which is the
    # qualification that has to travel next to every number this run produces.
    scrub_reports = []
    try:
        _, br_rep = blind_guard.load_bug_report(cfg['inputs']['bug_report'])
        scrub_reports.append(br_rep)
        _, pb_rep = blind_guard.load_playbook(cfg['inputs']['playbook'])
        scrub_reports.append(pb_rep)
    except Exception:                                            # noqa: BLE001
        # Unreachable on a run that got this far -- preflight loaded both. If it
        # somehow fails here, the audit is weaker, not wrong, and losing the whole
        # report over it would throw away a paid run's records.
        pass

    audit = blind_guard.audit_run(
        combined or os.path.join(store.guard_dir, run_store_mod.COMBINED_GUARD),
        scrub_reports,
        extra_notes=[f'guard log is {len(parts)} per-chunk log(s) concatenated: '
                     f'{", ".join(parts)}'] if parts else (),
        runtime_enforced=(runner_kind != 'fake'))

    # -- report -------------------------------------------------------------
    records, provenance = store.task_records()
    log(f'records: {provenance}')
    rep = report_mod.aggregate(
        records,
        run_meta=dict(store.meta, resumed_phases=result.get('resumed_phases'),
                      phases_run_this_session=result.get(
                          'phases_run_this_session')),
        blind_audit=audit,
        # The runner, plus the knobs that decide how hard the run tried.
        # `runner.describe()` alone names the model and nothing about the loop, so
        # a v3 row could not state the reconcile budget it ran under -- which is
        # precisely the thing that changed when the fix phase became measured, and
        # precisely what a later comparison between two v3 rows turns on.
        #
        # The LOOP pair is quoted from the config because v3 reads both. The
        # POLICY triple is stated as v3's own fixed behaviour and is deliberately
        # NOT copied out of `cfg['policy']`: the dispatcher never opens that block
        # (subset5.run-config.json says so in its own comment), so a row reading
        # `require_probe: true` because a config said so would be a false claim
        # about how the run was measured. If v3 ever grows one of these branches,
        # it reads from the config here and this comment goes.
        agent_desc={**runner.describe(),
                    'reconcile_rounds': (cfg.get('loop') or {}).get('reconcile_rounds'),
                    'characterise_rounds': (cfg.get('loop') or {}).get(
                        'characterise_rounds'),
                    # A chunk is submitted whole, so there is no per-task revert on
                    # exhaustion: the best MEASURED round is kept.
                    'on_exhausted': 'keep_best',
                    # `testmap.select` over the bug's file, unconditionally.
                    'regression_net': 'related',
                    # There is no require_probe branch in the dispatcher; a probe
                    # that never proved the defect makes V3 `skipped` and the task
                    # `fixed_workflow_only`, never `blocked`.
                    'require_probe': False},
        tree_digest_start=digest_start,
        tree_digest_end=workspace.tree_digest(trunk),
        infrastructure_failures=store.infrastructure_failures,
        started_at=store.started_at,
        # `report._parallel_summary` reads a v2 wave shape and would not survive a
        # v3 phase record. The dispatch detail is attached below instead, whole.
        parallel=None)

    # v3's own numbers, kept out of the v1/v2 columns they would be misread in.
    # `disposition_basis` in particular is the only thing separating an attested
    # green from a measured one, and `report.aggregate` does not know the field.
    rep['v3_dispatch'] = {
        k: result.get(k) for k in (
            'mode', 'map_id', 'phase_order', 'resumed_phases',
            'phases_run_this_session', 'tasks_total', 'dispositions',
            'disposition_basis', 'rounds_to_green', 'per_task_gates_run',
            'tasks_merge_rejected', 'attestation_overclaims',
            'reuse_characterisation', 'characterisations_reused',
            'characterisations_paid', 'spend_usd', 'cost_ceiling_usd',
            'rejected_total', 'wall_s', 'tree_digest')
    }
    rep['v3_dispatch']['phases'] = [
        {k: p.get(k) for k in ('phase', 'brackets', 'workers', 'dispositions',
                               'wall_s', 'spend_usd', 'tree_digest')}
        | {'merge': {mk: p.get('merge', {}).get(mk)
                     for mk in ('accepted', 'rejected')}}
        for p in result.get('phases') or []
    ]
    rep['v3_dispatch']['full_suite'] = result.get('full_suite')
    rep['note_on_basis'] = (
        "v3's fix phase is measured: the orchestrator runs V1-V4 between the "
        'agent\'s rounds and the disposition comes from those gates, not from '
        'attestation.json. What is still ATTESTED is the pre-fix characterisation '
        '-- whether the probe demonstrated the defect before the change -- which '
        'is what separates `fixed` from `fixed_workflow_only`, and the '
        '`already_remediated` disposition that rests on it. See '
        'v3_dispatch.disposition_basis for the split.')

    path = store.write_report(rep)
    log(report_mod.render_summary(rep))
    log(f'report written to {path}')
    log(f'run store: {run_dir}')
    log('next: invoke the `archive-patch-run` skill -- aggregate to '
        'results/eval-history/patcher.jsonl, located detail to the private store.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
