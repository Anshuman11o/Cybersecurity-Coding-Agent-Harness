#!/usr/bin/env python3
"""
Archive a completed patcher run: aggregate to the repository, located detail to
the private store.

    python3 tools/patcher/src/archive_run.py \
        --run-dir /home/user/patcher-work/runs/patch-run-subset-02 \
        --label subset-02-v3 \
        [--score <sighted eval-result.json>] [--notes "..."] [--dry-run]

WHY THIS EXISTS

A patcher run writes to `outputs.run_dir`, which every shipped config points
OUTSIDE the repository -- deliberately, because a per-task record pairs a bug id
with a file and a line and the publishing rule does not allow that in a committed
artefact. The consequence nobody wired up: the run store is therefore on
ephemeral disk with nothing durable pointing at it, and a container recycle takes
the whole run with it. That has already happened once here. The scanner has
`.claude/skills/archive-run` and `results/eval-history/scanner.jsonl` for exactly
this; the patcher had neither, so a completed, paid-for run left no trace a later
session could find.

THE SPLIT, WHICH IS THE WHOLE DESIGN

    aggregate  ->  results/eval-history/patcher.jsonl     committed, publishable
    located    ->  <private-store>/<stamp>/               outside the repository

`patcher-report.json` carries both: `totals` is aggregate, `tasks[]` is located.
This tool builds the history row from an explicit ALLOWLIST of aggregate fields
and never walks `tasks[]`, then re-checks the finished row against the forbidden
patterns before writing it. Two independent mechanisms, because the failure is
silent -- a leaked row looks exactly like a clean one, and the leak is discovered
by a later reader rather than by the run.

The scanner repo has had four recorded blind-boundary breaches, two of them from
eval write-up rather than from code. `docs/protocols/eval-howto.md` states the
rule this implements: aggregate here, located evidence in the answer-key repo.

APPEND-ONLY

`patcher.jsonl` is append-only, for the same reason `docs/benchmarking-results.md`
is: each row cost a real run and cannot be reconstructed. A run found invalid
later is annotated in a NEW row that references it, never edited in place. This
tool refuses to write a row whose `run_id` is already present unless
`--rescore-of` names the row it supersedes -- in which case it appends, and says
so in the row.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import subprocess
import sys

# ---------------------------------------------------------------------------
# The blind boundary
# ---------------------------------------------------------------------------

# Only these may appear in a history row. Anything not named here is dropped
# rather than passed through: a permissive filter over an evolving report shape
# leaks the first time someone adds a field.
PUBLISHABLE_RUN_KEYS = (
    'run_id', 'started_at', 'finished_at', 'wall_s', 'target_dir', 'target_sha',
    'bug_report_id', 'playbook_id', 'config_digest', 'resumed_from',
)

# Patterns that must never appear anywhere in a row. Checked against every
# string in the finished object, keys included.
FORBIDDEN_VALUE_PATTERNS = (
    (re.compile(r'\bBUG-\d+\b'), 'a bug id'),
    (re.compile(r'\b[a-z][A-Za-z0-9]*Challenge\b'), 'a challenge key'),
    (re.compile(r'\.(ts|js|tsx|mjs|cjs|pug|yml|json):\d+'), 'a file:line reference'),
    (re.compile(r'(?<![\w/.-])(lib|routes|models|views|data|frontend)/[\w./-]+\.(ts|js|tsx|pug)'),
     'a source file path'),
)

# Key names that carry located material by construction.
#
# `workflow_red` and `antioracle_claims` are here for the same reason as the
# rest: their entries are "<test file> :: <it() title>" and {test, it_title, why},
# so every one of them names a test file, and an anti-oracle claim additionally
# pairs that file with a defect the agent believes it was asserting. Only the
# per-task record may hold them. The published row carries the disposition
# HISTOGRAM -- a count under the bare name `fixed_workflow_red`, which locates
# nothing -- and never the lists behind it.
#
# `test_file` joined them when the v3 fix phase became measured: a per-round gate
# result carries `failures[].test_file`, which names the test that went red for a
# given bug. `test_title` was already here and `test_file` was not, and the value
# patterns do not catch a path under `test/` -- so the pair "this bug, that test"
# had a way through. Tightening only; a row that trips this is rephrased, never
# the guard.
FORBIDDEN_KEYS = ('tasks', 'per_case', 'bug_id', 'bugs', 'location', 'line',
                  'file', 'files', 'challenge', 'challenge_key', 'it_title',
                  'test_title', 'test_file', 'workflow_red', 'antioracle_claims')


class ArchiveError(RuntimeError):
    """Refuse the archive rather than produce a half-recorded run."""


def _walk_strings(node, path='$'):
    """Yield (json_path, string) for every string in the object, keys included."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield f'{path}.{k}', str(k)
            yield from _walk_strings(v, f'{path}.{k}')
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk_strings(v, f'{path}[{i}]')
    elif isinstance(node, str):
        yield path, node


def _walk_keys(node, path='$'):
    if isinstance(node, dict):
        for k, v in node.items():
            yield f'{path}.{k}', k
            yield from _walk_keys(v, f'{path}.{k}')
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk_keys(v, f'{path}[{i}]')


def assert_publishable(row: dict) -> None:
    """Raise unless every string in `row` is safe to commit.

    Deliberately paranoid and deliberately dumb. It does not try to understand
    the row; it looks for the shapes that a located finding takes. A false
    positive costs one argument to rephrase. A false negative is a breach that
    is found by a reader months later, which is how the last two happened.
    """
    problems: list = []

    for jpath, key in _walk_keys(row):
        if key in FORBIDDEN_KEYS:
            problems.append(f'{jpath}: key {key!r} carries located material by '
                            'construction and may not be published')

    for jpath, text in _walk_strings(row):
        for pattern, what in FORBIDDEN_VALUE_PATTERNS:
            m = pattern.search(text)
            if m:
                problems.append(f'{jpath}: contains {what} ({m.group(0)!r})')

    if problems:
        raise ArchiveError(
            'this row would put located material in the repository:\n  - '
            + '\n  - '.join(problems)
            + '\n\nAggregate belongs in results/eval-history/patcher.jsonl; the '
              'located evidence belongs in the answer-key repo. See '
              'docs/protocols/eval-howto.md.')


# ---------------------------------------------------------------------------
# Reading the run
# ---------------------------------------------------------------------------

def _read_json(path: str, what: str) -> dict:
    if not os.path.isfile(path):
        raise ArchiveError(f'{what} not found: {path}')
    with open(path) as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError as ex:
            raise ArchiveError(f'{what} is not valid JSON: {path}: {ex}') from ex


def _git_sha(repo: str) -> str | None:
    try:
        out = subprocess.run(['git', '-C', repo, 'rev-parse', '--short', 'HEAD'],
                             capture_output=True, text=True, timeout=30)
        return out.stdout.strip() or None if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def build_row(report: dict, *, label: str, harness_sha: str | None,
              archived_to: str, score: dict | None = None,
              notes: str = '', rescore_of: str | None = None,
              located_detail_at: str | None = None,
              timestamp: str | None = None) -> dict:
    """The one line that goes into `patcher.jsonl`.

    Built by naming fields, never by copying the report. `report['tasks']` is
    not read at all -- not filtered, not summarised, not touched.
    """
    run = report.get('run') or {}
    totals = report.get('totals') or {}

    row: dict = {
        'run_id': run.get('run_id'),
        'timestamp': timestamp or _dt.datetime.now(_dt.timezone.utc).strftime(
            '%Y-%m-%dT%H:%M:%SZ'),
        'component': f'patcher ({label})',
        'version': harness_sha,
        'target_sha': run.get('target_sha'),
        'inputs': {
            'bug_report_id': run.get('bug_report_id'),
            'playbook_id': run.get('playbook_id'),
            'config_digest': run.get('config_digest'),
        },
        'agent': run.get('agent') or {},
        'cost': run.get('cost') or {},
        'wall_clock_time': {'run_wall_s': run.get('wall_s')},

        # In-sandbox self-measurement. NOT an eval result, and labelled so in
        # the key name -- `patcher-report.schema.json` says the same thing in
        # its description and it has still been misread.
        'in_sandbox': {
            # `tasks_total`, not `tasks`: the guard forbids the key `tasks`
            # outright because that is the name of the report's located array,
            # and a count sharing its name invites the array to be dropped in
            # later by someone who sees the key already there.
            'tasks_total': totals.get('tasks'),
            'dispositions': totals.get('dispositions'),
            'self_verification': totals.get('self_verification'),
            'rounds_to_green': totals.get('rounds_to_green'),
            'blast_radius': totals.get('blast_radius'),
            'tasks_reverted': totals.get('tasks_reverted'),
            'violations_total': totals.get('violations_total'),
            'attestation_calibration': totals.get('attestation_calibration'),
        },

        # Sighted score, if the run was scored. `aggregate` only -- the schema
        # in the answer-key repo encodes that `per_case[]` is not publishable,
        # and this is where that rule is enforced on the harness side.
        'scored': (score or {}).get('aggregate'),

        'blind_audit': {
            'contaminated': (report.get('blind_audit') or {}).get('contaminated'),
            'denials': (report.get('blind_audit') or {}).get('denials'),
        },
        'archived_to': archived_to,
        'located_detail_at': located_detail_at,
        'rescore_of': rescore_of,
        'notes': notes,
    }
    assert_publishable(row)
    return row


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def existing_run_ids(history_path: str) -> list:
    if not os.path.isfile(history_path):
        return []
    out = []
    with open(history_path) as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line).get('run_id'))
            except json.JSONDecodeError as ex:
                raise ArchiveError(
                    f'{history_path}:{n} is not valid JSON ({ex}). The history is '
                    'append-only and every line must parse; fix the file before '
                    'appending.') from ex
    return out


def append_row(history_path: str, row: dict, *, rescore_of: str | None = None) -> None:
    """Append exactly one line. Never rewrite, never reorder, never deduplicate."""
    assert_publishable(row)
    seen = existing_run_ids(history_path)
    if row['run_id'] in seen and not rescore_of:
        raise ArchiveError(
            f'run_id {row["run_id"]!r} is already in {history_path}. The history is '
            'append-only: a correction is a NEW row carrying --rescore-of, not an '
            'edit to the original. A rewritten history cannot be trusted to show a '
            'regression.')
    os.makedirs(os.path.dirname(history_path) or '.', exist_ok=True)
    with open(history_path, 'a') as fh:
        fh.write(json.dumps(row) + '\n')


def copy_run(run_dir: str, dest: str) -> int:
    """Copy the run store verbatim. Returns the file count actually written.

    Verbatim, not filtered: the private store is where located material is
    SUPPOSED to live, and a filtered archive would lose the per-task records
    that are the only evidence of what the agent did.
    """
    if not os.path.isdir(run_dir):
        raise ArchiveError(f'run directory not found: {run_dir}')
    if os.path.exists(dest):
        raise ArchiveError(f'archive destination already exists: {dest}. Refusing to '
                           'merge two runs into one directory.')
    shutil.copytree(run_dir, dest, symlinks=True)
    return sum(len(files) for _, _, files in os.walk(dest))


MANIFEST = """# Patcher run archive

| | |
|---|---|
| Run id | {run_id} |
| Archived at | {archived_at} |
| Label | {label} |
| Harness commit | {harness_sha} |
| Target sha | {target_sha} |
| Bug report | {bug_report_id} |
| Playbook | {playbook_id} |
| Agent | {agent} |
| Cost | {cost} |
| Wall clock | {wall_s} s |
| Files archived | {file_count} |

## In-sandbox self-measurement

These are the run's own numbers. They are **not** eval results: the vulnerability
oracle is on the sighted side and the patcher never sees it.

```
{dispositions}
```

## Defects in force during this run

{defects}

## Provenance

{provenance}
"""


def write_manifest(dest: str, report: dict, *, label: str, harness_sha: str | None,
                   file_count: int, defects: str, provenance: str,
                   archived_at: str) -> str:
    run = report.get('run') or {}
    totals = report.get('totals') or {}
    path = os.path.join(dest, 'MANIFEST.md')
    with open(path, 'w') as fh:
        fh.write(MANIFEST.format(
            run_id=run.get('run_id'), archived_at=archived_at, label=label,
            harness_sha=harness_sha or 'unknown',
            target_sha=run.get('target_sha') or 'unknown',
            bug_report_id=run.get('bug_report_id') or 'unknown',
            playbook_id=run.get('playbook_id') or 'unknown',
            agent=json.dumps(run.get('agent') or {}),
            cost=json.dumps(run.get('cost') or {}),
            wall_s=run.get('wall_s'),
            file_count=file_count,
            dispositions=json.dumps(totals.get('dispositions') or {}, indent=2),
            defects=defects or '_None recorded. If that is wrong, say so here — a '
                               'number without its caveats is re-read later as a clean '
                               'measurement._',
            provenance=provenance or '_Not recorded._'))
    return path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--run-dir', required=True,
                   help='the run store, i.e. outputs.run_dir from the run config')
    p.add_argument('--label', required=True,
                   help='architecture variant that ran, e.g. subset-02-v3')
    p.add_argument('--private-store', default='/home/user/harness-private/patcher-runs',
                   help='where located detail is archived. Must be outside this repo.')
    p.add_argument('--repo', default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  '..', '..', '..'),
                   help='harness repository root')
    p.add_argument('--score', help='sighted eval-result.json; only its `aggregate` '
                                   'block is read')
    p.add_argument('--notes', default='', help='what happened, including failure')
    p.add_argument('--defects', default='', help='defects in force during the run')
    p.add_argument('--provenance', default='', help='restarts, what was lost, resumes')
    p.add_argument('--located-detail-at', default=None,
                   help='pointer to where the sighted per-case detail lives, e.g. an '
                        'answer-key repo branch and commit. A pointer, never content.')
    p.add_argument('--rescore-of', default=None,
                   help='run_id this row supersedes; appends rather than edits')
    p.add_argument('--dry-run', action='store_true',
                   help='build and check the row, copy nothing, append nothing')
    a = p.parse_args(argv)

    repo = os.path.abspath(a.repo)
    run_dir = os.path.abspath(a.run_dir)
    store = os.path.abspath(a.private_store)

    if store == repo or store.startswith(repo + os.sep):
        raise ArchiveError(
            f'--private-store {store} is inside the repository at {repo}. Located '
            'detail pairs a bug id with a file and a line and may not be committed.')

    report = _read_json(os.path.join(run_dir, 'patcher-report.json'), 'patcher-report.json')
    score = _read_json(a.score, 'eval result') if a.score else None
    harness_sha = _git_sha(repo)
    now = _dt.datetime.now(_dt.timezone.utc)
    stamp = now.strftime('%Y-%m-%dT%H-%MZ')
    archived_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    dest = os.path.join(store, f'{stamp}__{a.label}__{harness_sha or "nosha"}')

    row = build_row(report, label=a.label, harness_sha=harness_sha,
                    archived_to=dest, score=score, notes=a.notes,
                    rescore_of=a.rescore_of,
                    located_detail_at=a.located_detail_at,
                    timestamp=archived_at)

    history = os.path.join(repo, 'results', 'eval-history', 'patcher.jsonl')

    if a.dry_run:
        print('DRY RUN — nothing copied, nothing appended')
        print(f'  would archive : {run_dir}\n             -> : {dest}')
        print(f'  would append  : {history}')
        print(json.dumps(row, indent=1))
        return 0

    os.makedirs(store, exist_ok=True)
    count = copy_run(run_dir, dest)
    manifest = write_manifest(dest, report, label=a.label, harness_sha=harness_sha,
                              file_count=count, defects=a.defects,
                              provenance=a.provenance, archived_at=archived_at)
    append_row(history, row, rescore_of=a.rescore_of)

    print(f'archived {count} file(s) -> {dest}')
    print(f'manifest                 -> {manifest}')
    print(f'appended 1 row           -> {history}')
    print('\nStill to do by hand:')
    print('  - commit the private store and this repository SEPARATELY')
    print('  - put the sighted per-case detail in the answer-key repo, never here')
    return 0


if __name__ == '__main__':                                        # pragma: no cover
    try:
        sys.exit(main())
    except ArchiveError as ex:
        print(f'archive refused:\n{ex}', file=sys.stderr)
        sys.exit(2)
