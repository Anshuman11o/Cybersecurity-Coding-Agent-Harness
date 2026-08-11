#!/usr/bin/env python3
"""
The run ledger: check that every paid run left a durable, complete record, and
write a score back into one that did not.

    python3 tools/eval/run_records.py check
    python3 tools/eval/run_records.py check --run patch-run-subset-05
    python3 tools/eval/run_records.py record-score --run <run_id> --score <eval-result.json> ...

WHY THIS EXISTS

`archive-run` and `archive-patch-run` cover the *archive* step and cover it well.
Runs kept getting partially lost anyway, because the losses happen on either side
of that step:

  * before it — a run whose config digest, target sha and harness commit were
    never captured cannot be reconstructed even when its outputs survive;
  * after it — **scoring has no home**. A score produced in a conversation, after
    the archive has already been written, has nowhere to go: `archive_run.py`
    takes `--score` at archive time and there is no second door. So the number
    gets reported to a human, the session ends, and the row keeps its null. Two
    rows in `results/eval-history/patcher.jsonl` are in exactly that state.

Neither failure is visible. A half-recorded run looks like a recorded one: the
history file has a line in it. This module makes the difference into something a
command prints.

WHAT IT DOES NOT DO

It does not re-implement the publishability rule. `tools/patcher/src/archive_run.py`
is the authority for what may be committed, and this module imports
`assert_publishable` from it rather than restating the patterns — a second copy
of that list would drift, and the drifted copy would be the permissive one.

It also cannot make the private store durable. `/home/user/harness-private/` is
not a git repository: no remote, no version control, nothing off this machine.
The checker reports which archives are missing from this container's disk, which
is the most it can honestly do. See `docs/protocols/run-record-keeping.md` §5.

SEVERITIES

    ERROR  a record is broken or a run has no record at all. Exit code 1.
    LEAK   a committed row trips the publishability guard. Exit code 1.
    GAP    a record exists but is incomplete — most importantly, unscored.
           Reported always, exits 1 only under --strict, because the standing
           list of unscored runs is the point rather than a failure.
    NOTE   a fact worth surfacing that is nobody's mistake, e.g. an archive
           directory that is not on this machine.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
from dataclasses import dataclass, field

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

sys.path.insert(0, os.path.join(REPO_ROOT, 'tools', 'patcher', 'src'))
import archive_run  # noqa: E402  the authority on what may be published

ERROR, LEAK, GAP, NOTE = 'ERROR', 'LEAK', 'GAP', 'NOTE'
SEVERITY_ORDER = (ERROR, LEAK, GAP, NOTE)

# Rows recorded before this protocol existed are not held to the conventions it
# introduced — `archived_to` and an explicitly named oracle set. They are held to
# everything else, because a leaked row and a run whose score was never written
# down are facts about the repository today, not stylistic drift.
#
# A checker that prints twenty findings nobody can act on is a checker that gets
# ignored, and an ignored check is worse than no check: it looks like coverage.
PROTOCOL_EFFECTIVE = '2026-08-11'
CONVENTION_CODES = ('no-archive-pointer', 'oracle-set-unnamed')


@dataclass
class Finding:
    severity: str
    code: str
    where: str          # history file and line, or a directory
    run_id: str | None
    message: str
    pre_protocol: bool = False

    def line(self) -> str:
        rid = f' [{self.run_id}]' if self.run_id else ''
        tag = ' (pre-protocol)' if self.pre_protocol else ''
        return (f'{self.severity:5} {self.code:24} {self.where}{rid}{tag}'
                f'\n        {self.message}')


# ---------------------------------------------------------------------------
# What a record set is
# ---------------------------------------------------------------------------

@dataclass
class RecordSet:
    """One component's history file plus the two places its runs live on disk.

    `archive_root` is the private store the archive skills copy into.
    `run_store_root` is where a run writes while it is still running — a
    directory there with a finished report and no history row is a run that
    completed and was never recorded, which is the loss this whole protocol is
    about.
    """
    name: str
    history: str
    archive_root: str | None = None
    run_store_root: str | None = None
    report_name: str | None = None      # marks a run store dir as *finished*
    extra: dict = field(default_factory=dict)


def default_record_sets(repo: str) -> list:
    hist = os.path.join(repo, 'results', 'eval-history')
    return [
        RecordSet('patcher',
                  history=os.path.join(hist, 'patcher.jsonl'),
                  archive_root='/home/user/harness-private/patcher-runs',
                  run_store_root='/home/user/patcher-work/runs',
                  report_name='patcher-report.json'),
        RecordSet('scanner',
                  history=os.path.join(hist, 'scanner.jsonl'),
                  archive_root='/home/user/harness-private/runs'),
        RecordSet('external-baseline',
                  history=os.path.join(hist, 'external-baseline.jsonl')),
    ]


# ---------------------------------------------------------------------------
# Reading a history file
# ---------------------------------------------------------------------------

def read_history(path: str) -> tuple:
    """Return (rows, findings). A row is (lineno, dict).

    A history file that does not parse is an ERROR rather than an exception:
    the checker's job is to report every problem in one pass, and a corrupt
    file is exactly when a full report is wanted.
    """
    rows, findings = [], []
    if not os.path.isfile(path):
        return rows, [Finding(ERROR, 'history-missing', path, None,
                              'no history file. A run archived to the private store has '
                              'nothing in the repository pointing at it.')]
    with open(path) as fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                rows.append((n, json.loads(line)))
            except json.JSONDecodeError as ex:
                findings.append(Finding(
                    ERROR, 'history-unparseable', f'{path}:{n}', None,
                    f'line does not parse ({ex}). The history is append-only and every '
                    'line must parse before anything can be appended.'))
    return rows, findings


# ---------------------------------------------------------------------------
# Row-level checks
# ---------------------------------------------------------------------------

# Identity that must be captured *before* a run, because it cannot be recovered
# afterwards. `version` is the harness commit the run executed from — a dispatch
# prompt records what was asked for, only the commit records what ran.
REQUIRED_IDENTITY = ('run_id', 'timestamp', 'component', 'version')

# One of these must say what the run was measured against. Without it a number
# cannot be compared to anything: a ground-truth change invalidates comparison
# across it, and a row that does not name its oracle set hides that.
ORACLE_FIELDS = ('ground_truth_set', 'baseline', 'inputs')

UNSCORED_DECLARATIONS = re.compile(
    r'not (yet )?scored|unscored|pending a sighted|awaiting scoring', re.I)


def _is_scored(row: dict) -> bool:
    """A score is recorded when it is *in the row*, in either shape.

    `scored` is what `archive_run.build_row` writes from a sighted
    `eval-result.json`. `metrics` is the older shape, still used by every
    scanner row. Either counts; a number that lives only in a conversation
    does not.
    """
    for key in ('scored', 'metrics'):
        val = row.get(key)
        if isinstance(val, dict) and val:
            return True
    return False


def _declares_unscored(row: dict) -> bool:
    for key in ('notes', 'located_detail_at', 'scored_status'):
        val = row.get(key)
        if isinstance(val, str) and UNSCORED_DECLARATIONS.search(val):
            return True
    return False


def _is_pre_protocol(row: dict) -> bool:
    ts = row.get('timestamp')
    return isinstance(ts, str) and ts[:10] < PROTOCOL_EFFECTIVE


def check_rows(rows: list, path: str, repo: str) -> list:
    findings = []
    seen: dict = {}

    for n, row in rows:
        where = f'{path}:{n}'
        rid = row.get('run_id')
        rf: list = []

        missing = [k for k in REQUIRED_IDENTITY if not row.get(k)]
        if missing:
            rf.append(Finding(
                ERROR, 'identity-missing', where, rid,
                f'row is missing {", ".join(missing)}. This is the pre-run half of the '
                'record and cannot be reconstructed after the fact.'))

        if rid:
            if rid in seen and not row.get('rescore_of'):
                rf.append(Finding(
                    ERROR, 'duplicate-run-id', where, rid,
                    f'run_id already appears at line {seen[rid]} and this row is not a '
                    'rescore. A correction is a new row carrying rescore_of, never an '
                    'edit — and never a silent second row either.'))
            seen.setdefault(rid, n)

        resc = row.get('rescore_of')
        if resc and resc not in seen:
            rf.append(Finding(
                ERROR, 'dangling-rescore', where, rid,
                f'rescore_of names {resc!r}, which does not appear earlier in this file. '
                'A rescore that does not point at the row it supersedes cannot be read '
                'as a correction.'))

        archived_to = row.get('archived_to')
        if archived_to:
            ap = os.path.abspath(archived_to)
            if ap == repo or ap.startswith(repo + os.sep):
                rf.append(Finding(
                    ERROR, 'archive-inside-repo', where, rid,
                    f'archived_to {archived_to} is inside the repository. Located detail '
                    'pairs a bug id with a file and a line and may not be committed.'))
            elif not os.path.exists(ap):
                rf.append(Finding(
                    NOTE, 'archive-not-on-this-disk', where, rid,
                    f'{archived_to} is not present. The private store is not version '
                    'controlled, so this is expected on a fresh container and means the '
                    'located half of this run is gone. Only the aggregate in this row '
                    'survives.'))

        try:
            archive_run.assert_publishable(row)
        except archive_run.ArchiveError as ex:
            detail = '; '.join(x.strip()[2:] for x in str(ex).splitlines()
                               if x.strip().startswith('- '))
            rf.append(Finding(
                LEAK, 'row-not-publishable', where, rid,
                f'{detail}. Rephrase in a new row — never loosen the guard, and never '
                'edit a committed row.'))

        pre = _is_pre_protocol(row)
        for f in rf:
            f.pre_protocol = pre
        findings += [f for f in rf
                     if not (pre and f.code in CONVENTION_CODES)]

    findings += check_runs(rows, path)
    return findings


def check_runs(rows: list, path: str) -> list:
    """Completeness is a property of a *run*, not of a row.

    A run's record is spread across its original row and any rescore rows that
    follow it — that is what append-only means. So "is this run scored" asks
    whether *any* of its rows carries a score, and the finding is reported once,
    against the run's most recent row.
    """
    findings = []
    runs: dict = {}
    for n, row in rows:
        rid = row.get('run_id')
        if not rid:
            continue
        st = runs.setdefault(rid, {'line': n, 'scored': False, 'archived': False,
                                   'oracle': False, 'pre': True, 'declared': False})
        st['line'] = n
        st['scored'] |= _is_scored(row)
        st['archived'] |= bool(row.get('archived_to'))
        st['oracle'] |= any(bool(row.get(k)) for k in ORACLE_FIELDS)
        st['declared'] |= _declares_unscored(row)
        st['pre'] &= _is_pre_protocol(row)

    for rid, st in runs.items():
        where = f'{path}:{st["line"]}'
        if not st['scored']:
            findings.append(Finding(
                GAP, 'unscored', where, rid,
                ('the record says this run is not yet scored. If it was in fact scored, '
                 'that number exists only in a conversation and dies with it — write it '
                 'back with `run_records.py record-score`.') if st['declared'] else
                ('no row for this run carries a score, and none says it is unscored. '
                 'Either the run was never scored, or the score was never written down.'),
                pre_protocol=st['pre']))
        if not st['oracle'] and not st['pre']:
            findings.append(Finding(
                GAP, 'oracle-set-unnamed', where, rid,
                'no row for this run names what it was measured against '
                '(ground_truth_set / baseline / inputs). Two oracle sets read as one '
                'trend is how subset 2 appeared to improve without a patch changing.'))
        if not st['archived'] and not st['pre']:
            findings.append(Finding(
                GAP, 'no-archive-pointer', where, rid,
                'no row for this run carries archived_to. Nothing in the repository '
                'points at its artefacts, which is the state that lost the subset 2 run.'))

    return findings


# ---------------------------------------------------------------------------
# Reconciling the history against the disk
# ---------------------------------------------------------------------------

MANIFEST_RUN_ID = re.compile(r'^\|\s*Run id\s*\|\s*(\S+)\s*\|', re.M)


def archive_run_id(dirpath: str) -> str | None:
    """The run id an archive directory belongs to.

    Reads `MANIFEST.md` first — it is written for exactly this purpose. Falls
    back to `run.run_id` in the report, and **only** that field: the report's
    `tasks[]` is located material and this module must not carry it anywhere.
    """
    man = os.path.join(dirpath, 'MANIFEST.md')
    if os.path.isfile(man):
        with open(man, errors='replace') as fh:
            m = MANIFEST_RUN_ID.search(fh.read())
        if m and m.group(1) not in ('None', 'unknown'):
            return m.group(1)
    for name in ('patcher-report.json',):
        rep = os.path.join(dirpath, name)
        if os.path.isfile(rep):
            try:
                with open(rep) as fh:
                    return ((json.load(fh).get('run') or {}).get('run_id')) or None
            except (json.JSONDecodeError, OSError):
                return None
    return None


def reconcile(rs: RecordSet, history_ids: set) -> list:
    """Find runs on disk with no row, which is the loss this protocol exists for."""
    findings = []

    if rs.archive_root and os.path.isdir(rs.archive_root):
        for name in sorted(os.listdir(rs.archive_root)):
            d = os.path.join(rs.archive_root, name)
            if not os.path.isdir(d):
                continue
            rid = archive_run_id(d)
            if rid is None:
                findings.append(Finding(
                    GAP, 'archive-unidentifiable', d, None,
                    'archive has no MANIFEST.md naming its run id, so it cannot be tied '
                    'to a history row. Write the manifest.'))
            elif rid not in history_ids:
                findings.append(Finding(
                    ERROR, 'archive-without-row', d, rid,
                    f'a run is archived here with no row in {os.path.basename(rs.history)}. '
                    'When this container is reclaimed the run vanishes and nothing in the '
                    'repository will record that it happened.'))

    if rs.run_store_root and os.path.isdir(rs.run_store_root):
        for name in sorted(os.listdir(rs.run_store_root)):
            d = os.path.join(rs.run_store_root, name)
            if not os.path.isdir(d):
                continue
            finished = not rs.report_name or os.path.isfile(os.path.join(d, rs.report_name))
            rid = archive_run_id(d) or name
            if not finished:
                findings.append(Finding(
                    NOTE, 'run-store-unfinished', d, rid,
                    'run store has no finished report — in progress, or died before '
                    'writing one. Nothing to record yet.'))
            elif rid not in history_ids:
                findings.append(Finding(
                    ERROR, 'run-never-recorded', d, rid,
                    'a finished run is sitting in the live run store with no history row. '
                    'This directory is on ephemeral disk. Archive it now.'))

    return findings


# ---------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------

def check(record_sets: list, repo: str, only_run: str | None = None) -> list:
    findings = []
    for rs in record_sets:
        rows, f = read_history(rs.history)
        findings += f
        findings += check_rows(rows, rs.history, repo)
        ids = {r.get('run_id') for _, r in rows if r.get('run_id')}
        findings += reconcile(rs, ids)
    if only_run:
        findings = [f for f in findings if f.run_id == only_run]
    return findings


def exit_code(findings: list, strict: bool = False) -> int:
    sev = {f.severity for f in findings}
    if ERROR in sev or LEAK in sev:
        return 1
    if strict and GAP in sev:
        return 1
    return 0


def render(findings: list, only_run: str | None) -> str:
    if not findings:
        scope = f' for {only_run}' if only_run else ''
        return f'run records{scope}: complete. Nothing missing, nothing unscored.'
    out = []
    for sev in SEVERITY_ORDER:
        batch = [f for f in findings if f.severity == sev]
        if not batch:
            continue
        out.append(f'\n=== {sev} ({len(batch)}) ===')
        out += [f.line() for f in batch]
    counts = ', '.join(f'{sev}={sum(1 for f in findings if f.severity == sev)}'
                       for sev in SEVERITY_ORDER
                       if any(f.severity == sev for f in findings))
    out.append(f'\n{counts}')
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# record-score — the step that had no home
# ---------------------------------------------------------------------------

CARRY_FORWARD = ('component', 'version', 'target_sha', 'inputs', 'agent', 'cost',
                 'wall_clock_time', 'in_sandbox', 'blind_audit', 'archived_to',
                 'located_detail_at', 'models_used', 'tokens', 'est_cost_usd',
                 'engine', 'invocations', 'arm')


def build_score_row(prior: dict, aggregate: dict, *, ground_truth_set: str,
                    defects: str, notes: str, located_detail_at: str | None,
                    timestamp: str | None = None) -> dict:
    """A new row that scores an already-recorded run.

    Append-only means the score cannot be edited into the original row, so it
    arrives as a rescore of it. Everything identifying the run is carried
    forward from the row being superseded — a score row that does not name the
    same commit, config digest and archive is not evidence about the same run.

    `defects` is required by the CLI and lands in the row rather than in a
    footnote: a number whose caveats live somewhere else gets re-read later as
    a clean measurement.
    """
    row = {k: prior[k] for k in CARRY_FORWARD if k in prior}
    row['run_id'] = prior['run_id']
    row['timestamp'] = timestamp or _dt.datetime.now(_dt.timezone.utc).strftime(
        '%Y-%m-%dT%H:%M:%SZ')
    row['ground_truth_set'] = ground_truth_set

    # Two row shapes are in use and both must stay readable. Every scanner row
    # carries its score under `metrics`, and `tools/eval/generate_eval_report.py`
    # indexes that key directly — a scanner row without it crashes the report
    # renderer. The patcher's archiver writes `scored`. Follow whichever shape
    # the row being superseded already uses.
    row['metrics' if isinstance(prior.get('metrics'), dict) else 'scored'] = aggregate
    row['rescore_of'] = prior['run_id']
    row['defects_in_force'] = defects
    if located_detail_at:
        row['located_detail_at'] = located_detail_at
    row['notes'] = (f'Score recorded after the run was archived. '
                    f'Oracle set: {ground_truth_set}. '
                    f'A ground-truth change invalidates comparison across it. {notes}').strip()
    archive_run.assert_publishable(row)
    return row


def record_score(history: str, run_id: str, score_path: str, *, ground_truth_set: str,
                 defects: str, notes: str, located_detail_at: str | None,
                 aggregate_key: str = 'aggregate', dry_run: bool = False) -> dict:
    rows, problems = read_history(history)
    if problems:
        raise archive_run.ArchiveError(
            'refusing to append to a history that does not read cleanly:\n  '
            + '\n  '.join(p.message for p in problems))

    matches = [r for _, r in rows if r.get('run_id') == run_id]
    if not matches:
        raise archive_run.ArchiveError(
            f'{run_id!r} has no row in {history}. Archive the run first — a score with no '
            'run behind it records a number nobody can trace to a commit, a config digest '
            'or an archive.')

    with open(score_path) as fh:
        score = json.load(fh)
    # The patcher's sighted result separates the halves structurally: `aggregate`
    # is publishable, `per_case[]` is not. The scanner's scorer writes a flat
    # metrics document instead, so the block has to be named — `.` takes the
    # whole document, and naming it is the point at which someone decides it
    # contains no located material. `assert_publishable` is the backstop, not
    # the decision.
    aggregate = score if aggregate_key == '.' else score.get(aggregate_key)
    if not isinstance(aggregate, dict) or not aggregate:
        raise archive_run.ArchiveError(
            f'{score_path} has no non-empty `{aggregate_key}` block. Pass '
            '--aggregate-key to name the publishable block (`.` for the whole '
            'document). Located per-case detail stays in the answer-key repo.')

    row = build_score_row(matches[-1], aggregate, ground_truth_set=ground_truth_set,
                          defects=defects, notes=notes,
                          located_detail_at=located_detail_at)
    if not dry_run:
        archive_run.append_row(history, row, rescore_of=run_id)
    return row


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--repo', default=REPO_ROOT)
    sub = p.add_subparsers(dest='cmd', required=True)

    c = sub.add_parser('check', help='report every incomplete or missing run record')
    c.add_argument('--run', help='restrict the report to one run_id')
    c.add_argument('--history', action='append',
                   help='override the history files (repeatable)')
    c.add_argument('--archive-root', help='private store to reconcile against')
    c.add_argument('--run-store-root', help='live run store to reconcile against')
    c.add_argument('--strict', action='store_true',
                   help='exit non-zero on GAP as well as ERROR/LEAK')
    c.add_argument('--json', action='store_true')

    s = sub.add_parser('record-score', help='write a score back into an archived run')
    s.add_argument('--history', default=None)
    s.add_argument('--run', required=True, help='run_id being scored')
    s.add_argument('--score', required=True,
                   help='sighted eval-result.json; only `aggregate` is read')
    s.add_argument('--ground-truth-set', required=True,
                   help='which oracle set produced this score. Required: a score that '
                        'does not name its oracle set will be read as a trend across one')
    s.add_argument('--defects', required=True,
                   help='defects in force during the run, or "none known". Required: '
                        'the qualification travels in the row, not in a footnote')
    s.add_argument('--notes', default='')
    s.add_argument('--located-detail-at', default=None,
                   help='pointer to where the per-case detail lives. A pointer, never '
                        'content')
    s.add_argument('--aggregate-key', default='aggregate',
                   help='which block of the score file is publishable. Default '
                        '`aggregate` (the patcher eval-result shape); use `.` for a '
                        'flat metrics document such as score_scanner.py --json-out')
    s.add_argument('--dry-run', action='store_true')

    a = p.parse_args(argv)
    repo = os.path.abspath(a.repo)

    if a.cmd == 'check':
        if a.history:
            sets = [RecordSet(os.path.basename(h), history=h,
                              archive_root=a.archive_root,
                              run_store_root=a.run_store_root,
                              report_name='patcher-report.json') for h in a.history]
        else:
            sets = default_record_sets(repo)
            if a.archive_root:
                for rs in sets:
                    rs.archive_root = a.archive_root
            if a.run_store_root:
                for rs in sets:
                    rs.run_store_root = a.run_store_root
        findings = check(sets, repo, only_run=a.run)
        if a.json:
            print(json.dumps([f.__dict__ for f in findings], indent=1))
        else:
            print(render(findings, a.run))
        return exit_code(findings, strict=a.strict)

    history = a.history or os.path.join(repo, 'results', 'eval-history', 'patcher.jsonl')
    row = record_score(history, a.run, a.score, ground_truth_set=a.ground_truth_set,
                       defects=a.defects, notes=a.notes,
                       located_detail_at=a.located_detail_at,
                       aggregate_key=a.aggregate_key, dry_run=a.dry_run)
    print(json.dumps(row, indent=1))
    print(('DRY RUN — nothing appended' if a.dry_run
           else f'appended 1 rescore row -> {history}'))
    return 0


if __name__ == '__main__':                                        # pragma: no cover
    try:
        sys.exit(main())
    except archive_run.ArchiveError as ex:
        print(f'refused:\n{ex}', file=sys.stderr)
        sys.exit(2)
