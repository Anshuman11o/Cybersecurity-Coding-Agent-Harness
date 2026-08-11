"""The v3 run store: a paid run that outlives its session.

Subset 2 was scored and then lost -- records, transcripts, cost and disposition
histogram gone, and its row in `results/eval-history/patcher.jsonl` still carries
nulls where those numbers should be. `Dispatcher` on its own holds everything in
the dict it returns, so that failure is one dropped session away from repeating.

What is under test:

  - every task is on disk the moment it ends, from whichever worker thread ran it
  - every phase is on disk before the next phase starts
  - a resumed run does not re-run, and does not re-pay for, a completed phase
  - the phase record wins over the crash-safety stream, and orphaned stream
    records are still counted rather than silently dropped
  - the per-chunk guard logs are concatenated before the blind audit reads them
  - a run with no store behaves exactly as it did before
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import workspace  # noqa: E402
from v3 import chunk_map, dispatcher  # noqa: E402
from v3 import run_store as rs  # noqa: E402

from test_v3_dispatcher import (  # noqa: E402
    BUGS, Runner, Script, _build, _write)


# ----------------------------------------------------------------------------
# The store on its own
# ----------------------------------------------------------------------------

def test_begin_lays_out_the_run_dir_and_writes_a_readable_cursor(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run'), meta={'run_id': 'r1'}).begin()
    for sub in ('phases', 'chunks', 'guard', 'logs'):
        assert os.path.isdir(os.path.join(store.run_dir, sub))
    with open(store.state_path) as fh:
        state = json.load(fh)
    assert state['store_id'] == 'v3-run-store/v1'
    assert state['meta']['run_id'] == 'r1'
    assert state['completed_phases'] == []


def test_a_task_is_on_disk_the_moment_it_ends(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    store.record_task({'bug_id': 'BUG-001', 'chunk_id': 'A01',
                       'disposition': 'fixed'})
    store.record_task({'bug_id': 'BUG-002', 'chunk_id': 'A01',
                       'disposition': 'partial'})
    streamed = store.streamed_tasks()
    assert [t['bug_id'] for t in streamed] == ['BUG-001', 'BUG-002']


def test_the_stream_survives_a_process_that_never_flushes_state(tmp_path):
    """The jsonl is appended and fsynced per record, not written at the end."""
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    store.record_task({'bug_id': 'BUG-001', 'chunk_id': 'A01'})
    # Nothing else called. A different process reading the file sees the record.
    reopened = rs.RunStore.load(store.run_dir)
    assert [t['bug_id'] for t in reopened.streamed_tasks()] == ['BUG-001']


def test_record_phase_marks_it_complete_and_persists_the_cursor(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    store.record_phase({'phase': 0, 'chunks': [], 'tree_digest': 'abc'},
                       spend_usd=1.25)
    reopened = rs.RunStore.load(store.run_dir)
    assert reopened.completed_phases == [0]
    assert reopened.tree_digest == 'abc'
    assert reopened.spend_usd == 1.25
    assert [p['phase'] for p in reopened.phase_records()] == [0]


def test_a_record_without_its_key_is_refused_rather_than_written_somewhere_odd(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    for bad, fn in ((({'tasks': []}), 'record_chunk'),
                    (({'chunks': []}), 'record_phase')):
        try:
            getattr(store, fn)(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f'{fn} accepted a record with no key')


# ----------------------------------------------------------------------------
# Which record wins
# ----------------------------------------------------------------------------

def test_the_phase_record_wins_over_the_stream(tmp_path):
    """A merge-rejected chunk is `abandoned` in the phase file and `fixed` in the
    stream, because the stream was written before the queue ran. The phase file
    is the one that is true."""
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    store.record_task({'bug_id': 'BUG-001', 'chunk_id': 'A01',
                       'disposition': 'fixed'})
    store.record_phase({'phase': 0, 'chunks': [
        {'chunk_id': 'A01', 'tasks': [
            {'bug_id': 'BUG-001', 'chunk_id': 'A01', 'disposition': 'abandoned',
             'disposition_before_merge': 'fixed'}]}]})
    records, note = store.task_records()
    assert [r['disposition'] for r in records] == ['abandoned']
    assert 'completed phase record' in note


def test_a_task_whose_phase_never_completed_is_still_counted(tmp_path):
    """Work that was really done and really lost its phase must not vanish from
    the denominator -- that is the flattering direction."""
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    store.record_task({'bug_id': 'BUG-001', 'chunk_id': 'A01',
                       'disposition': 'fixed'})
    store.record_task({'bug_id': 'BUG-009', 'chunk_id': 'C01',
                       'disposition': 'partial'})
    store.record_phase({'phase': 0, 'chunks': [
        {'chunk_id': 'A01', 'tasks': [
            {'bug_id': 'BUG-001', 'chunk_id': 'A01', 'disposition': 'fixed'}]}]})
    records, note = store.task_records()
    assert sorted(r['bug_id'] for r in records) == ['BUG-001', 'BUG-009']
    assert 'crash-safety stream' in note and 'pre-merge' in note


# ----------------------------------------------------------------------------
# Guard logs
# ----------------------------------------------------------------------------

def test_every_chunk_guard_log_reaches_the_audit(tmp_path):
    """One log per chunk, one path to the auditor. Auditing a single chunk's log
    certifies the run blind on a fraction of its evidence."""
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    for cid, n in (('A01', 2), ('C01', 3), ('D01', 1)):
        _write(os.path.join(store.guard_dir, f'{cid}.jsonl'),
               ''.join(json.dumps({'chunk': cid, 'i': i}) + '\n' for i in range(n)))
    combined = store.merge_guard_logs()
    with open(combined) as fh:
        lines = [json.loads(x) for x in fh if x.strip()]
    assert len(lines) == 6
    assert {x['chunk'] for x in lines} == {'A01', 'C01', 'D01'}
    assert store.guard_log_parts() == ['A01.jsonl', 'C01.jsonl', 'D01.jsonl']


def test_concatenating_twice_does_not_double_the_evidence(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    _write(os.path.join(store.guard_dir, 'A01.jsonl'), '{"a": 1}\n')
    store.merge_guard_logs()
    combined = store.merge_guard_logs()
    with open(combined) as fh:
        assert len([x for x in fh if x.strip()]) == 1


def test_no_guard_logs_is_reported_as_none_not_as_an_empty_clean_log(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    assert store.merge_guard_logs() is None


# ----------------------------------------------------------------------------
# Resume
# ----------------------------------------------------------------------------

def test_a_moved_trunk_refuses_the_resume(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    store.record_phase({'phase': 0, 'chunks': [], 'tree_digest': 'recorded'})
    try:
        store.assert_tree_matches('different')
    except RuntimeError as ex:
        assert 'refusing to resume' in str(ex)
    else:
        raise AssertionError('a moved trunk was accepted')


# ----------------------------------------------------------------------------
# End to end, through the dispatcher
# ----------------------------------------------------------------------------

def test_a_run_with_a_store_leaves_every_task_and_phase_on_disk(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    d, trunk, runner = _build(tmp_path, Script(), store=store)
    result = d.run()

    on_disk = rs.RunStore.load(store.run_dir)
    assert sorted(on_disk.completed_phases) == sorted(d.cmap.phase_order())
    assert len(on_disk.streamed_tasks()) == result['tasks_total'] == len(BUGS)
    records, _ = on_disk.task_records()
    assert len(records) == len(BUGS)
    for c in d.cmap.chunks:
        assert os.path.isfile(on_disk.chunk_path(c.chunk_id))
    for p in d.cmap.phase_order():
        assert os.path.isfile(on_disk.phase_path(p))


def test_a_phase_is_checkpointed_before_the_next_one_starts(tmp_path):
    """The guarantee that makes a session limit cost one phase, not the run."""
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    seen: list = []

    class Watchful(Script):
        def __call__(self, prompt, phase, task_id, cwd):
            # What is already durable at the moment this task starts.
            seen.append(sorted(rs.RunStore.load(store.run_dir).completed_phases))
            return super().__call__(prompt, phase, task_id, cwd)

    d, trunk, runner = _build(tmp_path, Watchful(), store=store)
    d.run()
    # Phase 1's tasks all began with phase 0 already durable.
    assert seen[0] == []
    assert seen[-1] == [0]


def test_resume_does_not_rerun_or_repay_for_a_completed_phase(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    s1 = Script()
    d1, trunk, _r1 = _build(tmp_path, s1, store=store)
    d1.run(phases=[0])
    assert s1.calls, 'phase 0 ran no agent at all'

    reopened = rs.RunStore.load(store.run_dir)
    assert reopened.completed_phases == [0]

    # A fresh dispatcher over the same store, as a resumed session would build.
    d2 = dispatcher.Dispatcher(
        d1.cmap, bugs=BUGS, playbook=None, runner=Runner(behaviour=(r2 := Script())), trunk=trunk,
        run_dir=str(tmp_path / 'run'), cfg=d1.cfg,
        trees_root=str(tmp_path / 'trees2'), log=lambda *a, **k: None,
        final_suite=lambda t: {'ran': True}, store=reopened)
    result = d2.run()

    assert result['resumed_phases'] == [0]
    assert 0 not in result['phases_run_this_session']
    # No agent was invoked for a phase-0 bug in the second session.
    phase0_bugs = {b.bug_id for c in d1.cmap.chunks_in_phase(0) for b in c.tasks}
    assert not [b for _s, b in r2.steps() if b in phase0_bugs]
    # And phase 0's records are still in the run, not dropped.
    assert {p['phase'] for p in result['phases']} == set(d1.cmap.phase_order())
    assert result['tasks_total'] == len(BUGS)


def test_a_resumed_run_keeps_the_earlier_sessions_spend_against_the_ceiling(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    d1, trunk, _r = _build(tmp_path, Script(), store=store)
    d1.run(phases=[0])
    store.spend_usd = 40.0
    store.flush()

    reopened = rs.RunStore.load(store.run_dir)
    d2 = dispatcher.Dispatcher(
        d1.cmap, bugs=BUGS, playbook=None, runner=Runner(behaviour=Script()), trunk=trunk,
        run_dir=str(tmp_path / 'run'), cfg=d1.cfg,
        trees_root=str(tmp_path / 'trees2'), log=lambda *a, **k: None,
        final_suite=lambda t: {'ran': True}, store=reopened,
        cost_ceiling_usd=10.0)
    result = d2.run()
    # The ceiling is a property of the run. A resumed session does not get a
    # fresh budget, so the already-spent $40 is over the $10 ceiling immediately.
    assert result['spend_usd'] >= 40.0
    assert any(t.get('disposition') == 'blocked'
               for p in result['phases'] for c in p['chunks'] for t in c['tasks'])


def test_the_final_suite_waits_for_every_phase_across_sessions(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    d1, trunk, _r = _build(tmp_path, Script(), store=store)
    first = d1.run(phases=[0])
    assert first['full_suite'] is None       # partial tree, no suite

    reopened = rs.RunStore.load(store.run_dir)
    d2 = dispatcher.Dispatcher(
        d1.cmap, bugs=BUGS, playbook=None, runner=Runner(behaviour=Script()), trunk=trunk,
        run_dir=str(tmp_path / 'run'), cfg=d1.cfg,
        trees_root=str(tmp_path / 'trees2'), log=lambda *a, **k: None,
        final_suite=lambda t: {'ran': True}, store=reopened)
    assert d2.run()['full_suite'] == {'ran': True}


def test_a_crashed_chunk_leaves_a_trace_rather_than_vanishing(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    d, trunk, _r = _build(tmp_path, Script(), store=store)
    target = d.cmap.chunks_in_phase(0)[0].chunk_id

    def boom(a):
        if a.chunk_id == target:
            raise RuntimeError('seeding failed')
        return real(a)

    real = d.run_chunk
    d.run_chunk = boom
    d.run()

    on_disk = rs.RunStore.load(store.run_dir)
    assert os.path.isfile(on_disk.chunk_path(target))
    assert any(f['kind'] == 'chunk_crash' and f['chunk_id'] == target
               for f in on_disk.infrastructure_failures)
    streamed = {t['bug_id'] for t in on_disk.streamed_tasks()}
    crashed_bugs = {b.bug_id for b in d.cmap.chunk(target).tasks}
    assert crashed_bugs <= streamed


def test_write_report_produces_the_file_the_archiver_reads(tmp_path):
    store = rs.RunStore(str(tmp_path / 'run')).begin()
    path = store.write_report({'run_id': 'r1', 'metrics': {}})
    assert os.path.basename(path) == 'patcher-report.json'
    with open(path) as fh:
        assert json.load(fh)['run_id'] == 'r1'


def test_without_a_store_a_run_behaves_exactly_as_before(tmp_path):
    d, trunk, _r = _build(tmp_path, Script())
    result = d.run()
    assert result['tasks_total'] == len(BUGS)
    assert result['resumed_phases'] == []
    assert not os.path.exists(os.path.join(str(tmp_path / 'run'), rs.STATE_NAME))
