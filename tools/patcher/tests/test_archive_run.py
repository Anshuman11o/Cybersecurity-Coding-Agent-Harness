"""The patcher archival path.

Two things are being defended, and they fail in opposite directions:

  * a run that is not archived is gone. The run store lives outside the
    repository on ephemeral disk, which has already cost this project a
    completed run.
  * a run that is archived carelessly puts a bug id next to a file and a line
    in a committed artefact, which is the breach the root CLAUDE.md records
    four instances of.

So the tests below are mostly about the leak guard. A missing archive is loud —
the next session cannot find the run. A leaked row is silent, looks exactly like
a clean one, and is found by a reader months later.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'src'))
import archive_run  # noqa: E402


# --------------------------------------------------------------------------
# Fixtures — a minimal but structurally real report
# --------------------------------------------------------------------------

def _report(**over):
    rep = {
        'run': {
            'run_id': 'patch-run-subset-02', 'started_at': '2026-08-09T01:00:00Z',
            'finished_at': '2026-08-09T11:24:00Z', 'wall_s': 37440.0,
            'target_dir': 'target-apps/juice-shop-blind', 'target_sha': 'e654218',
            'bug_report_id': 'bug-report-subset2', 'playbook_id': 'playbook-subset2',
            'config_digest': 'sha256:abc', 'resumed_from': None,
            'agent': {'runner': 'claude-cli', 'model': 'opus', 'require_probe': False},
            'cost': {'total_usd': 190.12, 'invocations': 61},
        },
        'blind_audit': {'contaminated': False, 'denials': 0},
        'totals': {
            'tasks': 24,
            'dispositions': {'fixed': 19, 'abandoned': 5},
            'self_verification': {'probe_coverage': 41.7},
            'rounds_to_green': {'median': 2, 'max': 4},
            'blast_radius': {'files_touched_total': 8},
            'tasks_reverted': 5, 'violations_total': 0,
            'attestation_calibration': {'claimed_fixed': 19},
        },
        # The located half. Nothing in this module may ever read it.
        'tasks': [
            {'bug_id': 'BUG-039', 'file': 'routes/fileServer.ts', 'line': 27,
             'disposition': 'abandoned'},
            {'bug_id': 'BUG-091', 'file': 'server.ts', 'line': 234,
             'disposition': 'fixed'},
        ],
    }
    rep.update(over)
    return rep


@pytest.fixture
def row():
    return archive_run.build_row(_report(), label='subset-02-v2-waves',
                                 harness_sha='deadbee', archived_to='/private/x')


# --------------------------------------------------------------------------
# The split: aggregate is published, located material is not
# --------------------------------------------------------------------------

def test_the_row_carries_the_aggregate(row):
    assert row['run_id'] == 'patch-run-subset-02'
    assert row['in_sandbox']['tasks_total'] == 24
    assert row['in_sandbox']['dispositions'] == {'fixed': 19, 'abandoned': 5}
    assert row['cost']['total_usd'] == 190.12
    assert row['blind_audit']['contaminated'] is False


def test_the_row_never_contains_the_task_records(row):
    """`tasks[]` is the located half and is not read at all — not filtered,
    not summarised, not counted by walking it."""
    blob = json.dumps(row)
    assert 'BUG-039' not in blob
    assert 'fileServer' not in blob
    assert 'tasks' not in row


def test_a_bug_id_anywhere_in_the_row_is_refused():
    with pytest.raises(archive_run.ArchiveError, match='a bug id'):
        archive_run.assert_publishable({'run_id': 'r', 'notes': 'BUG-041 never closed'})


def test_a_challenge_key_anywhere_in_the_row_is_refused():
    with pytest.raises(archive_run.ArchiveError, match='a challenge key'):
        archive_run.assert_publishable(
            {'run_id': 'r', 'notes': 'unionSqlInjectionChallenge still solves'})


def test_a_file_line_reference_is_refused():
    with pytest.raises(archive_run.ArchiveError, match='a file:line reference'):
        archive_run.assert_publishable({'run_id': 'r', 'notes': 'fixed at insecurity.ts:55'})


def test_a_source_file_path_is_refused():
    with pytest.raises(archive_run.ArchiveError, match='a source file path'):
        archive_run.assert_publishable(
            {'run_id': 'r', 'notes': 'the agent reverted routes/fileServer.ts'})


def test_a_located_key_is_refused_even_with_a_harmless_value():
    """The key alone is disqualifying. A caller who adds `file` meaning
    something innocuous has still built a row whose shape invites the next
    person to put a path in it."""
    with pytest.raises(archive_run.ArchiveError, match='carries located material'):
        archive_run.assert_publishable({'run_id': 'r', 'detail': {'file': 'n/a'}})


def test_the_guard_looks_inside_nested_structures():
    with pytest.raises(archive_run.ArchiveError, match='a bug id'):
        archive_run.assert_publishable(
            {'run_id': 'r', 'scored': {'by_class': [{'note': 'BUG-010 only'}]}})


def test_the_target_dir_is_not_a_false_positive():
    """The path patterns must not fire on the target directory itself, or every
    honest row is refused and the guard gets switched off."""
    archive_run.assert_publishable(
        {'run_id': 'r', 'notes': 'ran against target-apps/juice-shop-blind at e654218'})


# --------------------------------------------------------------------------
# The sighted score: aggregate only
# --------------------------------------------------------------------------

def test_only_the_aggregate_block_of_a_score_is_carried():
    """`eval-result.schema.json` in the answer-key repo encodes that `aggregate`
    is publishable and `per_case[]` is not. This is where that is enforced on
    the harness side."""
    score = {
        'aggregate': {'scoreable': 23, 'effective_fix': 10, 'no_fix': 13,
                      'destructive_fix': 0, 'nefr_pct': 43.5},
        'per_case': [{'bug_id': 'BUG-010', 'file': 'lib/insecurity.ts',
                      'verdict': 'NO_FIX'}],
    }
    r = archive_run.build_row(_report(), label='x', harness_sha='abc',
                              archived_to='/p', score=score)
    assert r['scored']['effective_fix'] == 10
    assert 'per_case' not in json.dumps(r)
    assert 'BUG-010' not in json.dumps(r)


def test_a_score_whose_aggregate_leaks_is_still_refused():
    """A malformed aggregate must not ride through on the strength of its key."""
    score = {'aggregate': {'worst_case': 'BUG-043 null-byte bypass'}}
    with pytest.raises(archive_run.ArchiveError, match='a bug id'):
        archive_run.build_row(_report(), label='x', harness_sha='abc',
                              archived_to='/p', score=score)


# --------------------------------------------------------------------------
# Append-only
# --------------------------------------------------------------------------

def test_append_writes_exactly_one_line(tmp_path, row):
    h = str(tmp_path / 'patcher.jsonl')
    archive_run.append_row(h, row)
    archive_run.append_row(h, dict(row, run_id='other'))
    lines = open(h).read().strip().split('\n')
    assert len(lines) == 2
    assert [json.loads(x)['run_id'] for x in lines] == ['patch-run-subset-02', 'other']


def test_a_duplicate_run_id_is_refused(tmp_path, row):
    h = str(tmp_path / 'patcher.jsonl')
    archive_run.append_row(h, row)
    with pytest.raises(archive_run.ArchiveError, match='append-only'):
        archive_run.append_row(h, row)


def test_a_rescore_appends_rather_than_edits(tmp_path, row):
    """A run found invalid later is corrected by a new row that references it.
    Editing the original would make the history unable to show a regression."""
    h = str(tmp_path / 'patcher.jsonl')
    archive_run.append_row(h, row)
    resc = dict(row, rescore_of='patch-run-subset-02',
                notes='rescored against a larger oracle set')
    archive_run.append_row(h, resc, rescore_of='patch-run-subset-02')
    lines = open(h).read().strip().split('\n')
    assert len(lines) == 2
    assert json.loads(lines[0])['notes'] == row['notes']      # original untouched
    assert json.loads(lines[1])['rescore_of'] == 'patch-run-subset-02'


def test_a_corrupt_history_is_refused_rather_than_appended_to(tmp_path, row):
    h = str(tmp_path / 'patcher.jsonl')
    open(h, 'w').write('{not json}\n')
    with pytest.raises(archive_run.ArchiveError, match='not valid JSON'):
        archive_run.append_row(h, row)


# --------------------------------------------------------------------------
# Copying the run store
# --------------------------------------------------------------------------

def test_the_run_store_is_copied_verbatim(tmp_path):
    """Verbatim, not filtered: the private store is where located material is
    supposed to live, and a filtered archive loses the per-task records that
    are the only evidence of what the agent did."""
    run = tmp_path / 'run'
    (run / 'tasks').mkdir(parents=True)
    (run / 'patcher-report.json').write_text(json.dumps(_report()))
    (run / 'tasks' / 't1.json').write_text('{"bug_id": "BUG-039"}')
    dest = str(tmp_path / 'archive' / 'stamp')
    n = archive_run.copy_run(str(run), dest)
    assert n == 2
    assert json.loads(open(os.path.join(dest, 'tasks', 't1.json')).read())['bug_id'] \
        == 'BUG-039'


def test_copying_over_an_existing_archive_is_refused(tmp_path):
    run = tmp_path / 'run'
    run.mkdir()
    (run / 'x').write_text('1')
    dest = str(tmp_path / 'dest')
    archive_run.copy_run(str(run), dest)
    with pytest.raises(archive_run.ArchiveError, match='already exists'):
        archive_run.copy_run(str(run), dest)


def test_a_missing_run_directory_is_refused(tmp_path):
    with pytest.raises(archive_run.ArchiveError, match='run directory not found'):
        archive_run.copy_run(str(tmp_path / 'nope'), str(tmp_path / 'dest'))


# --------------------------------------------------------------------------
# The CLI
# --------------------------------------------------------------------------

def test_dry_run_copies_nothing_and_appends_nothing(tmp_path, capsys):
    run = tmp_path / 'run'
    run.mkdir()
    (run / 'patcher-report.json').write_text(json.dumps(_report()))
    repo = tmp_path / 'repo'
    (repo / 'results' / 'eval-history').mkdir(parents=True)

    rc = archive_run.main(['--run-dir', str(run), '--label', 'subset-02-v3',
                           '--private-store', str(tmp_path / 'private'),
                           '--repo', str(repo), '--dry-run'])
    assert rc == 0
    assert 'DRY RUN' in capsys.readouterr().out
    assert not (tmp_path / 'private').exists()
    assert not (repo / 'results' / 'eval-history' / 'patcher.jsonl').exists()


def test_a_private_store_inside_the_repository_is_refused(tmp_path):
    """The whole split collapses if the private store is committed."""
    run = tmp_path / 'run'
    run.mkdir()
    (run / 'patcher-report.json').write_text(json.dumps(_report()))
    repo = tmp_path / 'repo'
    repo.mkdir()
    with pytest.raises(archive_run.ArchiveError, match='inside the repository'):
        archive_run.main(['--run-dir', str(run), '--label', 'x',
                          '--private-store', str(repo / 'private'),
                          '--repo', str(repo)])


# --------------------------------------------------------------------------
# The committed history file
# --------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
HISTORY = os.path.join(REPO_ROOT, 'results/eval-history/patcher.jsonl')


def test_the_committed_history_exists_and_every_row_parses():
    assert os.path.isfile(HISTORY), (
        'results/eval-history/patcher.jsonl is the durable record of every patcher '
        'run. Without it a run archived to the private store has nothing in the '
        'repository pointing at it.')
    assert archive_run.existing_run_ids(HISTORY)


def test_every_committed_row_is_publishable():
    """The guard is re-run against what is actually on disk, not only against
    what the tool would produce. A row added by hand is exactly how the last
    breach got in."""
    with open(HISTORY) as fh:
        for n, line in enumerate(fh, 1):
            if line.strip():
                archive_run.assert_publishable(json.loads(line))


def test_the_committed_history_records_the_subset_two_run():
    """The one run this project has actually paid for and scored.

    Pinned because it is the only patcher datum in existence: if it vanishes
    from the history the repository is back to having no record of it at all,
    which is the state this tooling was written to end.
    """
    assert 'patcher-subset-02-waves-backfill' in archive_run.existing_run_ids(HISTORY)


def test_no_committed_row_id_appears_twice():
    ids = archive_run.existing_run_ids(HISTORY)
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    assert not dupes, f'append-only history has duplicate run_id(s): {dupes}'
