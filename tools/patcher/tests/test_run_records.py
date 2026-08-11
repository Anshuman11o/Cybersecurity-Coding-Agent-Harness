"""The run ledger — `tools/eval/run_records.py`.

`test_archive_run.py` defends the archive step. This module defends the two
steps on either side of it, which is where runs actually got lost:

  * a finished run sitting in the run store that nobody archived, and an archive
    that nobody wrote a history row for. Both are silent — the loss is only
    discovered when the container is gone.
  * a score that was produced and never written to a file. Two rows in
    `patcher.jsonl` are in that state, and no test could have caught it because
    a row with no score parses exactly like a row with one.

The checks below are the ones a machine can settle. Everything a machine cannot
settle — whether the caveats in `notes` are the true caveats, whether the oracle
set really is the same one as last time — stays in
`docs/protocols/run-record-keeping.md` as prose, and is flagged as such there.
"""
import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO_ROOT, 'tools', 'eval'))
import run_records as rr  # noqa: E402
import archive_run  # noqa: E402


NOW = '2026-08-12T00:00:00Z'          # after PROTOCOL_EFFECTIVE
BEFORE = '2026-07-25T00:00:00Z'       # before it


def _row(**over):
    row = {
        'run_id': 'patch-run-x', 'timestamp': NOW, 'component': 'patcher (x-v3)',
        'version': 'deadbee', 'ground_truth_set': 'subset-x (10 bugs)',
        'archived_to': '/home/user/harness-private/patcher-runs/stamp__x__deadbee',
        'scored': {'scoreable': 10, 'effective_fix': 6},
        'notes': 'ran clean',
    }
    row.update(over)
    return row


def _history(tmp_path, *rows, name='patcher.jsonl'):
    p = tmp_path / name
    p.write_text(''.join(json.dumps(r) + '\n' for r in rows))
    return str(p)


def _codes(findings):
    return sorted(f.code for f in findings)


def _check(path, **kw):
    rs = rr.RecordSet('t', history=path, report_name='patcher-report.json', **kw)
    return rr.check([rs], REPO_ROOT)


# --------------------------------------------------------------------------
# A complete record is silent
# --------------------------------------------------------------------------

def test_a_complete_record_produces_nothing(tmp_path):
    """The ordinary case must be quiet, or the noisy cases get ignored."""
    h = _history(tmp_path, _row(archived_to=str(tmp_path)))
    assert _check(h) == []


# --------------------------------------------------------------------------
# The record itself
# --------------------------------------------------------------------------

def test_a_row_that_does_not_parse_is_reported_not_raised(tmp_path):
    p = tmp_path / 'patcher.jsonl'
    p.write_text(json.dumps(_row()) + '\n{ not json }\n')
    assert 'history-unparseable' in _codes(_check(str(p)))


def test_a_missing_history_file_is_an_error(tmp_path):
    f = _check(str(tmp_path / 'nope.jsonl'))
    assert _codes(f) == ['history-missing']
    assert rr.exit_code(f) == 1


def test_identity_that_cannot_be_recovered_later_is_required(tmp_path):
    """`version` is the harness commit the run executed from. A dispatch prompt
    records what was asked for; only the commit records what ran."""
    h = _history(tmp_path, _row(version=None))
    f = [x for x in _check(h) if x.code == 'identity-missing']
    assert f and 'version' in f[0].message
    assert rr.exit_code(f) == 1


def test_a_second_row_for_the_same_run_must_declare_itself_a_rescore(tmp_path):
    h = _history(tmp_path, _row(), _row(scored={'effective_fix': 9}))
    assert 'duplicate-run-id' in _codes(_check(h))


def test_a_rescore_row_is_not_a_duplicate(tmp_path):
    h = _history(tmp_path, _row(), _row(rescore_of='patch-run-x',
                                        scored={'effective_fix': 9}))
    assert 'duplicate-run-id' not in _codes(_check(h))


def test_a_rescore_of_a_run_that_is_not_in_the_file_is_an_error(tmp_path):
    h = _history(tmp_path, _row(run_id='other', rescore_of='never-recorded'))
    assert 'dangling-rescore' in _codes(_check(h))


def test_an_archive_pointer_into_the_repository_is_an_error(tmp_path):
    """The split collapses if located detail is committed. `archive_run.py`
    refuses this at write time; this catches a row that got in another way."""
    h = _history(tmp_path, _row(archived_to=os.path.join(REPO_ROOT, 'results', 'x')))
    assert 'archive-inside-repo' in _codes(_check(h))


def test_the_publishability_guard_is_the_archiver_s_and_not_a_second_copy(tmp_path):
    """Imported, not restated. Two copies of that pattern list would drift, and
    the drifted copy would be the permissive one."""
    h = _history(tmp_path, _row(notes='BUG-999 was never closed'))
    f = [x for x in _check(h) if x.severity == rr.LEAK]
    assert f and 'a bug id' in f[0].message
    assert rr.exit_code(f) == 1


# --------------------------------------------------------------------------
# The step that had no home: scoring
# --------------------------------------------------------------------------

def test_a_run_with_no_score_on_file_is_reported(tmp_path):
    h = _history(tmp_path, _row(scored=None))
    f = [x for x in _check(h) if x.code == 'unscored']
    assert f and f[0].run_id == 'patch-run-x'


def test_the_older_metrics_shape_counts_as_a_score(tmp_path):
    """Every scanner row records its score under `metrics`, not `scored`. A
    checker that only understood the newer shape would report the entire
    scanner history as unscored and be switched off within a day."""
    h = _history(tmp_path, _row(scored=None, metrics={'recall_pct': 66.0}))
    assert 'unscored' not in _codes(_check(h))


def test_a_score_arriving_in_a_later_row_settles_the_run(tmp_path):
    """Append-only means a score cannot be edited into the original row. It
    arrives as a rescore, and the run is then scored — the question is asked of
    the run, not of a row."""
    h = _history(tmp_path, _row(scored=None),
                 _row(rescore_of='patch-run-x', scored={'effective_fix': 6}))
    assert 'unscored' not in _codes(_check(h))


def test_unscored_is_reported_even_when_the_row_says_so(tmp_path):
    """A row declaring itself unscored is not thereby settled. The standing list
    of unscored runs IS the deliverable: someone reading it is the only way a
    score that lives in a conversation gets noticed before the session ends."""
    h = _history(tmp_path, _row(scored=None, notes='not yet scored'))
    f = [x for x in _check(h) if x.code == 'unscored']
    assert f and 'dies with it' in f[0].message


def test_an_unscored_run_does_not_fail_the_check_unless_strict(tmp_path):
    h = _history(tmp_path, _row(scored=None))
    f = _check(h)
    assert rr.exit_code(f) == 0
    assert rr.exit_code(f, strict=True) == 1


# --------------------------------------------------------------------------
# Qualifications travel in the row
# --------------------------------------------------------------------------

def test_a_run_that_does_not_name_its_oracle_set_is_reported(tmp_path):
    h = _history(tmp_path, _row(ground_truth_set=None))
    assert 'oracle-set-unnamed' in _codes(_check(h))


def test_rows_predating_the_protocol_are_not_held_to_its_conventions(tmp_path):
    """18 scanner rows predate `archived_to`. Reporting each of them every run
    would bury the one finding that matters."""
    h = _history(tmp_path, _row(timestamp=BEFORE, ground_truth_set=None,
                                archived_to=None))
    assert _codes(_check(h)) == []


def test_a_leak_in_a_pre_protocol_row_is_still_a_leak(tmp_path):
    """Conventions are retroactively forgiven; a live disclosure is not."""
    h = _history(tmp_path, _row(timestamp=BEFORE, notes='see routes/placeholderRoute.ts'))
    assert rr.LEAK in {x.severity for x in _check(h)}


# --------------------------------------------------------------------------
# Reconciling the history against the disk — the actual loss
# --------------------------------------------------------------------------

def _archive(root, name, run_id):
    d = root / name
    d.mkdir(parents=True)
    (d / 'MANIFEST.md').write_text(f'# Patcher run archive\n\n| Run id | {run_id} |\n')
    return d


def test_an_archived_run_with_no_history_row_is_an_error(tmp_path):
    store = tmp_path / 'private'
    _archive(store, '2026-08-12T00-00Z__x__deadbee', 'patch-run-ghost')
    h = _history(tmp_path, _row())
    f = _check(h, archive_root=str(store))
    assert 'archive-without-row' in _codes(f)
    assert rr.exit_code(f) == 1


def test_an_archived_run_that_has_a_row_is_silent(tmp_path):
    store = tmp_path / 'private'
    _archive(store, '2026-08-12T00-00Z__x__deadbee', 'patch-run-x')
    h = _history(tmp_path, _row(archived_to=str(store / '2026-08-12T00-00Z__x__deadbee')))
    assert _check(h, archive_root=str(store)) == []


def test_an_archive_with_no_manifest_cannot_be_tied_to_a_row(tmp_path):
    store = tmp_path / 'private'
    (store / 'orphan').mkdir(parents=True)
    h = _history(tmp_path, _row())
    assert 'archive-unidentifiable' in _codes(_check(h, archive_root=str(store)))


def test_the_run_id_can_be_recovered_from_the_report_when_the_manifest_is_absent(tmp_path):
    """Only `run.run_id` is read out of the report. `tasks[]` is located material
    and nothing in this module may touch it."""
    d = tmp_path / 'store' / 'patch-run-y'
    d.mkdir(parents=True)
    (d / 'patcher-report.json').write_text(json.dumps({
        'run': {'run_id': 'patch-run-y'},
        'tasks': [{'bug_id': 'BUG-996', 'file': 'routes/placeholderRoute.ts'}]}))
    assert rr.archive_run_id(str(d)) == 'patch-run-y'


def test_a_finished_run_never_recorded_is_an_error(tmp_path):
    """The subset 2 loss, in the shape a check can see it: the run store still
    exists, the history does not know about it, and the disk is ephemeral."""
    store = tmp_path / 'work' / 'runs' / 'patch-run-z'
    store.mkdir(parents=True)
    (store / 'patcher-report.json').write_text(json.dumps({'run': {'run_id': 'patch-run-z'}}))
    h = _history(tmp_path, _row())
    f = _check(h, run_store_root=str(tmp_path / 'work' / 'runs'))
    assert 'run-never-recorded' in _codes(f)
    assert rr.exit_code(f) == 1


def test_a_run_still_in_progress_is_not_an_error(tmp_path):
    """A run without a finished report has nothing to record yet. Failing on it
    would make the check red for the whole hour a scan takes, which is the
    hour it most needs to be readable."""
    store = tmp_path / 'work' / 'runs' / 'patch-run-live'
    store.mkdir(parents=True)
    f = _check(_history(tmp_path, _row(archived_to=str(tmp_path))),
               run_store_root=str(tmp_path / 'work' / 'runs'))
    assert _codes(f) == ['run-store-unfinished']
    assert rr.exit_code(f) == 0


def test_an_archive_missing_from_this_machine_is_a_note_not_a_failure(tmp_path):
    """The private store is not version controlled. An archive that is not on
    this disk is the durability gap showing itself — a fact to surface, not a
    mistake to fail on."""
    h = _history(tmp_path, _row(archived_to='/home/user/harness-private/gone'))
    f = _check(h)
    assert _codes(f) == ['archive-not-on-this-disk']
    assert rr.exit_code(f, strict=True) == 0


# --------------------------------------------------------------------------
# record-score: writing a score back into an archived run
# --------------------------------------------------------------------------

def _score_file(tmp_path, aggregate, per_case=True):
    p = tmp_path / 'eval-result.json'
    doc = {'aggregate': aggregate}
    if per_case:
        doc['per_case'] = [{'bug_id': 'BUG-997', 'file': 'lib/placeholderModule.ts',
                            'verdict': 'NO_FIX'}]
    p.write_text(json.dumps(doc))
    return str(p)


def _record(h, sp, **kw):
    args = dict(ground_truth_set='subset-x (10 bugs, driver-backed)',
                defects='node_modules unpinned', notes='scored sighted',
                located_detail_at='answer-key repo, commit abc')
    args.update(kw)
    return rr.record_score(h, 'patch-run-x', sp, **args)


def test_a_score_becomes_a_new_row_rather_than_an_edit(tmp_path):
    h = _history(tmp_path, _row(scored=None, archived_to=str(tmp_path)))
    row = _record(h, _score_file(tmp_path, {'effective_fix': 6, 'scoreable': 10}))
    lines = open(h).read().strip().split('\n')
    assert len(lines) == 2
    assert json.loads(lines[0])['scored'] is None          # original untouched
    assert row['rescore_of'] == 'patch-run-x'
    assert row['scored']['effective_fix'] == 6
    assert _codes(_check(h)) == []                          # and the run is settled


def test_the_score_row_carries_the_run_s_identity_forward(tmp_path):
    """A score row that does not name the same commit, config digest and archive
    is not evidence about the same run."""
    h = _history(tmp_path, _row(scored=None, target_sha='f01512b',
                                inputs={'config_digest': 'fed51f58'}))
    row = _record(h, _score_file(tmp_path, {'effective_fix': 6}))
    assert row['version'] == 'deadbee'
    assert row['target_sha'] == 'f01512b'
    assert row['inputs']['config_digest'] == 'fed51f58'
    assert row['archived_to'].endswith('stamp__x__deadbee')


def test_only_the_aggregate_block_is_carried(tmp_path):
    h = _history(tmp_path, _row(scored=None))
    row = _record(h, _score_file(tmp_path, {'effective_fix': 6}))
    blob = json.dumps(row)
    assert 'per_case' not in blob and 'BUG-997' not in blob
    assert 'placeholderModule' not in blob


def test_the_qualification_travels_in_the_row(tmp_path):
    """Not in a footnote, not in a commit message, not in the conversation the
    score came from."""
    h = _history(tmp_path, _row(scored=None))
    row = _record(h, _score_file(tmp_path, {'effective_fix': 6}),
                  defects='no frozen pre-patch baseline')
    assert row['defects_in_force'] == 'no frozen pre-patch baseline'
    assert 'subset-x (10 bugs, driver-backed)' in row['ground_truth_set']
    assert 'invalidates comparison' in row['notes']


def test_a_score_for_a_run_with_no_row_is_refused(tmp_path):
    """A score with no run behind it records a number nobody can trace to a
    commit, a config digest or an archive."""
    h = _history(tmp_path, _row(run_id='someone-else'))
    with pytest.raises(archive_run.ArchiveError, match='has no row'):
        _record(h, _score_file(tmp_path, {'effective_fix': 6}))


def test_a_score_file_with_no_aggregate_is_refused(tmp_path):
    h = _history(tmp_path, _row(scored=None))
    with pytest.raises(archive_run.ArchiveError, match='aggregate'):
        _record(h, _score_file(tmp_path, {}))


def test_a_leaky_aggregate_is_refused_by_the_archiver_s_guard(tmp_path):
    h = _history(tmp_path, _row(scored=None))
    with pytest.raises(archive_run.ArchiveError, match='a bug id'):
        _record(h, _score_file(tmp_path, {'worst_case': 'BUG-998 synthetic example'}))


def test_dry_run_appends_nothing(tmp_path):
    h = _history(tmp_path, _row(scored=None))
    _record(h, _score_file(tmp_path, {'effective_fix': 6}), dry_run=True)
    assert len(open(h).read().strip().split('\n')) == 1


def test_a_history_that_does_not_read_cleanly_is_not_appended_to(tmp_path):
    p = tmp_path / 'patcher.jsonl'
    p.write_text(json.dumps(_row(scored=None)) + '\n{ broken }\n')
    with pytest.raises(archive_run.ArchiveError, match='does not read cleanly'):
        _record(str(p), _score_file(tmp_path, {'effective_fix': 6}))


def test_a_scanner_row_keeps_the_metrics_shape_it_already_uses(tmp_path):
    """Every scanner row carries its score under `metrics`, and
    `generate_eval_report.py` indexes that key directly — a scanner rescore row
    that put the score under `scored` instead would crash the report."""
    h = _history(tmp_path, _row(run_id='scanner-x', component='scanner',
                                scored=None, metrics={'recall': {'pct': 60.0}},
                                archived_to=str(tmp_path)))
    row = rr.record_score(h, 'scanner-x', _score_file(tmp_path, {'recall': {'pct': 66.0}},
                                                      per_case=False),
                          ground_truth_set='juice-shop 97 reachable',
                          defects='none known', notes='', located_detail_at=None)
    assert row['metrics'] == {'recall': {'pct': 66.0}}
    assert 'scored' not in row


def test_a_flat_score_document_needs_its_block_named(tmp_path):
    """`score_scanner.py --json-out` writes a flat metrics document with no
    `aggregate` wrapper. Naming the block with `--aggregate-key .` is the point
    at which someone decides the whole document is publishable; the guard is the
    backstop, not the decision."""
    p = tmp_path / 'metrics.json'
    p.write_text(json.dumps({'recall': {'pct': 66.0}, 'findings_total': 247}))
    h = _history(tmp_path, _row(scored=None, archived_to=str(tmp_path)))
    with pytest.raises(archive_run.ArchiveError, match='aggregate'):
        _record(h, str(p))
    row = _record(h, str(p), aggregate_key='.')
    assert row['scored']['findings_total'] == 247


# --------------------------------------------------------------------------
# The committed record, as it actually stands
# --------------------------------------------------------------------------

STRUCTURAL = {'history-missing', 'history-unparseable', 'identity-missing',
              'duplicate-run-id', 'dangling-rescore', 'archive-inside-repo',
              'archive-without-row', 'run-never-recorded'}


def test_the_committed_history_is_structurally_sound():
    """Every row identifiable, no duplicate ids, no dangling rescore, no archive
    pointer into the repository — and, when the private store and the live run
    store are on this machine, no run in either of them without a history row.

    Deliberately not asserted here: that every committed row passes the
    publishability guard. Seven do not — six scanner rows name a denylisted
    file in prose and one patcher row carries a `bugs` key — and the history is
    append-only, so those cannot be fixed by editing. `test_archive_run.py`
    already fails on the patcher one; the scanner ones are reported by
    `run_records.py check` and need an architect's decision, not a test.
    """
    findings = rr.check(rr.default_record_sets(REPO_ROOT), REPO_ROOT)
    bad = [f.line() for f in findings if f.code in STRUCTURAL]
    assert not bad, 'run records are structurally broken:\n' + '\n'.join(bad)


def test_every_run_on_disk_has_a_row_or_is_reported():
    """The invariant the subset 2 loss violated, asserted against whatever is
    actually on this machine. It passes vacuously on a fresh container — which
    is itself the durability gap, and is why this cannot be the only defence."""
    sets = rr.default_record_sets(REPO_ROOT)
    for rs in sets:
        rows, _ = rr.read_history(rs.history)
        ids = {r.get('run_id') for _, r in rows if r.get('run_id')}
        orphans = [f.run_id for f in rr.reconcile(rs, ids)
                   if f.code in ('archive-without-row', 'run-never-recorded')]
        assert not orphans, (
            f'{rs.name}: run(s) on disk with no row in {rs.history}: {orphans}. '
            'That disk is not version controlled; when it is reclaimed the run is gone.')
