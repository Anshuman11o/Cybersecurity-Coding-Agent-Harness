#!/usr/bin/env python3
"""
Execute a wave plan: run each wave's units concurrently, then fold them back.

`wave_plan.py` decides WHAT may run together. This decides HOW, and the division
is deliberate -- the plan is a pure function of the inputs and is tested as one,
while everything here touches trees, threads and clocks.

    for each wave:
        snapshot the integrated tree            <- the wave base, and the merge ancestor
        seed one fresh tree per chain from it
        run the chains concurrently             <- the only parallel part
        fold every chain back in                <- serial, one place, integrator.py
        measure the merged tree                 <- post-wave gate

CHAINS, NOT UNITS

A wave's members are independent by construction, with one exception the planner
marks explicitly: a dependency cycle. Its members mutually depend, so they must
not run at the same time. They are grouped into a chain that runs serially in one
shared tree, and the chain is what gets integrated. Everything else is a chain of
one.

WHY THREADS

Each unit spends nearly all its wall clock blocked in `subprocess` -- waiting on
an agent CLI, a typecheck, a test file. Measured on the pilot: 50.4 of 53.4
minutes was agent time. Threads release the GIL for exactly that, and they keep
the run in one process, which is what lets state be flushed from a single writer
instead of merged from several.

WHAT IS NOT SHARED

Each chain gets its own tree and its own guard log. The tree is the obvious one.
The guard log matters because it is the run's contamination audit: a single file
appended to by concurrent processes can interleave, and an audit trail that might
be interleaved is not an audit trail. They are merged after the run, in order.
"""
from __future__ import annotations

import concurrent.futures
import os
import shutil
import threading
import time

import integrator
import task_loop
import workspace

SEED_EXCLUDES = ('.patcher-snapshots', workspace.SCRATCH_DIRNAME)


# ----------------------------------------------------------------------------
# Chains
# ----------------------------------------------------------------------------

def chains(wave_units: list) -> list:
    """Split one wave's plan entries into independently-runnable chains.

    Returns a list of lists, deterministically ordered. A cycle becomes one chain
    holding every member; every other unit becomes a chain of one.
    """
    by_id = {u['unit_id']: u for u in wave_units}
    seen: set = set()
    out: list = []
    for u in sorted(wave_units, key=lambda e: e['unit_id']):
        uid = u['unit_id']
        if uid in seen:
            continue
        members = [uid] + [c for c in (u.get('cycle_with') or []) if c in by_id]
        members = sorted(set(members))
        seen.update(members)
        out.append([by_id[m] for m in members])
    # Biggest chains first: a wave is only as fast as its longest chain, so
    # starting the long ones while workers are free costs nothing and can save a
    # whole unit of wall clock when chains outnumber workers.
    out.sort(key=lambda ch: (-sum(e.get('bug_count', 1) for e in ch), ch[0]['unit_id']))
    return out


def chain_id(chain: list) -> str:
    return '+'.join(e['unit_id'] for e in chain)


# ----------------------------------------------------------------------------
# One chain
# ----------------------------------------------------------------------------

def _run_chain(chain, *, seed, cfg, units_by_id, runner, playbook, run_dir,
               trees_root, wave_no, indices, log, on_record, lock,
               touched) -> integrator.Unit:
    """Seed a tree, run this chain's units serially in it, return it for merging."""
    cid = chain_id(chain)
    tree = os.path.join(trees_root, f'w{wave_no}-{cid.replace("+", "_")}')
    guard = os.path.join(run_dir, 'guard', f'w{wave_no}-{cid.replace("+", "_")}.jsonl')
    os.makedirs(os.path.dirname(guard), exist_ok=True)

    workspace.prepare(seed, tree, cfg['target'].get('node_modules'),
                      force=True, exclude=SEED_EXCLUDES)

    ctx = task_loop.TaskContext(cfg, tree, runner, playbook, run_dir, log=log)
    ctx.guard_log_path = guard
    # A copy taken before the wave started, not the live map. Units in one wave
    # run concurrently, so none of them may claim another closed its defect --
    # that credit only becomes visible once a wave has been integrated.
    ctx.touched_locations = dict(touched)

    files: list = []
    for entry in chain:
        unit = units_by_id[entry['unit_id']]
        files.append(unit['location']['file'])
        idx = indices[entry['unit_id']]
        n = len(unit.get('members') or [])
        log(f"  [w{wave_no}] start {unit['bug_id']}  {unit['location']['file']}"
            + (f'  ({n} bugs)' if n else ''))
        try:
            rec = task_loop.run_task(unit, idx, ctx)
        except Exception as ex:                                   # noqa: BLE001
            # One poisoned unit must not take down the wave, and it must not be
            # silently absent from the denominator either.
            log(f"  [w{wave_no}] !! {unit['bug_id']} crashed: {type(ex).__name__}: {ex}")
            rec = _crash_record(unit, idx, ex)
        rec['wave'] = wave_no
        rec['chain'] = cid
        with lock:
            on_record(rec)
        log(f"  [w{wave_no}] done  {unit['bug_id']} -> {rec['disposition']}")

    return integrator.Unit(cid, tree, files)


def _crash_record(unit, index, ex) -> dict:
    return {
        'bug_id': unit['bug_id'], 'task_index': index,
        'location': unit['location'], 'disposition': 'blocked',
        'disposition_reason': f'orchestrator crash: {type(ex).__name__}: {ex}',
        'measured': {'characterisation': {'workflow_green_pre_fix': False,
                                          'probe_proven_pre_fix': False},
                     'rounds': [], 'final_gates': {}, 'rounds_to_green': None,
                     'wall_s': 0.0, 'cost_usd': None},
        'attested': None,
        'diff_stats': {'files_touched': [], 'lines_added': 0, 'lines_removed': 0},
        'violations': [],
    }


# ----------------------------------------------------------------------------
# The waves
# ----------------------------------------------------------------------------

def run_waves(plan: dict, *, cfg, units, runner, playbook, run_dir, seed,
              concurrency: int, log=print, on_record=lambda r: None,
              keep_trees: bool = False) -> dict:
    """Run every wave in order. Returns the parallel-run report."""
    units_by_id = {u['bug_id']: u for u in units}
    trees_root = os.path.join(os.path.dirname(os.path.abspath(seed)), 'wave-trees')
    os.makedirs(trees_root, exist_ok=True)
    lock = threading.Lock()

    # Fixed up front so a task index never depends on which thread finished first.
    indices = {}
    for w in plan['waves']:
        for u in sorted(w['units'], key=lambda e: e['unit_id']):
            indices[u['unit_id']] = len(indices)

    waves_out: list = []
    touched: dict = {}
    t_run = time.time()

    for w in plan['waves']:
        wave_no = w['wave']
        wave_records: list = []

        def collect(rec, _sink=wave_records):
            _sink.append(rec)
            on_record(rec)

        chs = chains(w['units'])
        workers = max(1, min(concurrency, len(chs)))
        t0 = time.time()
        log(f"wave {wave_no}: {len(w['units'])} unit(s) in {len(chs)} chain(s), "
            f'{workers} worker(s)')

        base_snap = workspace.snapshot(seed, f'wave-{wave_no}-base')
        done: list = []
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {pool.submit(
                    _run_chain, ch, seed=seed, cfg=cfg, units_by_id=units_by_id,
                    runner=runner, playbook=playbook, run_dir=run_dir,
                    trees_root=trees_root, wave_no=wave_no, indices=indices,
                    log=log, on_record=collect, lock=lock,
                    touched=touched): ch for ch in chs}
                for fut in concurrent.futures.as_completed(futures):
                    try:
                        done.append(fut.result())
                    except Exception as ex:                       # noqa: BLE001
                        ch = futures[fut]
                        log(f'  [w{wave_no}] !! chain {chain_id(ch)} failed to run: '
                            f'{type(ex).__name__}: {ex}')

            # Deterministic merge order. Two units contesting a file must resolve
            # the same way on a re-run, and as_completed() ordering is a race.
            done.sort(key=lambda u: u.unit_id)
            integ = integrator.integrate(seed=seed, base_snap=base_snap,
                                         units=done, log=log)
            gate = integrator.post_wave_gate(cfg, seed, done, log=log)
        finally:
            workspace.discard_snapshot(base_snap)

        if not keep_trees:
            # Keep the trees whose work is in question; reclaim the rest. A unit
            # tree is ~67MB, and forensics on a clean merge has nothing to find.
            suspect = set(integ.get('conflicts') and
                          [c.get('dropped') for c in integ['conflicts']] or [])
            suspect |= set(gate.get('workflow_red') or [])
            suspect |= set(gate.get('reopened') or [])
            for u in done:
                if u.unit_id not in suspect:
                    shutil.rmtree(u.tree, ignore_errors=True)

        # Only now, with the wave merged, may a later wave say a defect was closed
        # upstream. Sorted so the map does not depend on completion order.
        for rec in sorted(wave_records, key=lambda r: r.get('bug_id') or ''):
            if rec.get('disposition') in ('fixed', 'fixed_workflow_only', 'partial'):
                loc = rec.get('location') or {}
                touched[f"{loc.get('file')}:{loc.get('line')}"] = rec['bug_id']

        waves_out.append({
            'wave': wave_no,
            'chains': [chain_id(ch) for ch in chs],
            'unit_count': len(w['units']),
            'workers': workers,
            'wall_s': round(time.time() - t0, 1),
            'integration': integ,
            'gate': gate,
            'tree_digest': workspace.tree_digest(seed),
        })
        log(f'wave {wave_no} complete in {(time.time() - t0) / 60:.1f} min')

    return {
        'mode': 'waves',
        'plan_id': plan.get('plan_id'),
        'wave_count': plan.get('wave_count'),
        'max_parallelism': plan.get('max_parallelism'),
        'concurrency_cap': concurrency,
        'wall_s': round(time.time() - t_run, 1),
        'waves': waves_out,
        'conflicts_total': sum(len(w['integration']['conflicts']) for w in waves_out),
        'waves_gate_red': [w['wave'] for w in waves_out if not w['gate'].get('green')],
    }
