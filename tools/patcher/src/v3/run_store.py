#!/usr/bin/env python3
"""
Durable run store for the v3 dispatcher.

`Dispatcher` holds its results in the dict it returns. That is fine for a unit
test and catastrophic for a paid run: the subset 2 run was scored and then lost
exactly this way -- its records, transcripts, cost and disposition histogram are
gone, and its row in `results/eval-history/patcher.jsonl` still carries nulls
where those numbers should be. A v3 run is longer than a v2 one and outlives a
session, so it must be able to lose the session without losing the run.

This module is that guarantee. Nothing here decides anything about a patch; it
only writes down what already happened, as soon as it happens.

## What is on disk

    run_dir/
      v3-state.json          the cursor: meta, completed phases, digests, spend
      tasks.jsonl            append-only, one record per task, written at task end
      chunks/<chunk_id>.json one chunk's result, written when the chunk finishes
      phases/phase-<n>.json  one phase's result, written after its merge queue
      guard/<chunk_id>.jsonl written by the dispatcher, one per chunk
      guard/combined.jsonl   every chunk's guard log, concatenated, for the audit
      patcher-report.json    the final report, what `archive_run.py` reads

## Which file is authoritative, and why there are two

`tasks.jsonl` is the **crash-safety stream**. A record lands in it the moment the
task ends, before the chunk it belongs to has been merged -- so a record there
may carry a disposition that the merge queue later overturns. A chunk whose
submission is rejected has every task re-disposed `abandoned`, and that happens
after these lines are already on disk.

`phases/phase-<n>.json` is **authoritative**. It is written after the phase's
merge queue has drained and the verdicts have been applied, so its task records
are final.

Both are kept. The stream is the only thing that survives a crash mid-phase; the
phase file is the only thing that is correct. `task_records()` returns the
authoritative set and falls back to the stream only for phases that never
completed, and it says which it used.

## Resume

`completed_phases` is the cursor. `Dispatcher.run()` skips phases already in it
and folds their stored records back into the returned run. `assert_tree_matches`
refuses a resume whose trunk has moved since the last completed phase, for the
same reason `state.RunState` does: continuing would attribute edits this run did
not make to the patcher, and nothing downstream would show it.
"""
from __future__ import annotations

import glob
import json
import os
import tempfile
import threading
import time


STATE_NAME = 'v3-state.json'
TASKS_NAME = 'tasks.jsonl'
COMBINED_GUARD = 'combined.jsonl'


def _atomic_write_json(path: str, payload) -> None:
    """Write-then-rename. A half-written checkpoint is worse than no checkpoint."""
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as fh:
            json.dump(payload, fh, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


class RunStore:
    """Everything the dispatcher produces, on disk, as it is produced."""

    def __init__(self, run_dir: str, meta: dict | None = None):
        self.run_dir = os.path.abspath(run_dir)
        self.meta = dict(meta or {})
        self.started_at = time.time()
        self.completed_phases: list = []
        self.tree_digest: str | None = None
        self.spend_usd: float = 0.0
        self.infrastructure_failures: list = []
        self._tasks_seen = 0
        self._lock = threading.RLock()

    # -- paths -------------------------------------------------------------

    @property
    def state_path(self) -> str:
        return os.path.join(self.run_dir, STATE_NAME)

    @property
    def tasks_path(self) -> str:
        return os.path.join(self.run_dir, TASKS_NAME)

    @property
    def guard_dir(self) -> str:
        return os.path.join(self.run_dir, 'guard')

    def phase_path(self, phase_no: int) -> str:
        return os.path.join(self.run_dir, 'phases', f'phase-{phase_no}.json')

    def chunk_path(self, chunk_id: str) -> str:
        return os.path.join(self.run_dir, 'chunks', f'{chunk_id}.json')

    # -- lifecycle ---------------------------------------------------------

    def begin(self) -> 'RunStore':
        for sub in ('', 'phases', 'chunks', 'guard', 'logs'):
            os.makedirs(os.path.join(self.run_dir, sub), exist_ok=True)
        self.flush()
        return self

    def flush(self) -> None:
        with self._lock:
            _atomic_write_json(self.state_path, {
                'store_id': 'v3-run-store/v1',
                'meta': self.meta,
                'started_at': self.started_at,
                'updated_at': time.time(),
                'completed_phases': sorted(self.completed_phases),
                'tree_digest': self.tree_digest,
                'spend_usd': round(self.spend_usd, 4),
                'tasks_streamed': self._tasks_seen,
                'infrastructure_failures': self.infrastructure_failures,
            })

    @classmethod
    def load(cls, run_dir: str) -> 'RunStore':
        with open(os.path.join(run_dir, STATE_NAME)) as fh:
            payload = json.load(fh)
        st = cls(run_dir, payload.get('meta'))
        st.started_at = payload.get('started_at', time.time())
        st.completed_phases = list(payload.get('completed_phases') or [])
        st.tree_digest = payload.get('tree_digest')
        st.spend_usd = float(payload.get('spend_usd') or 0.0)
        st._tasks_seen = int(payload.get('tasks_streamed') or 0)
        st.infrastructure_failures = list(
            payload.get('infrastructure_failures') or [])
        return st

    @classmethod
    def exists_at(cls, run_dir: str) -> bool:
        return os.path.isfile(os.path.join(run_dir, STATE_NAME))

    # -- recording ---------------------------------------------------------

    def record_task(self, rec: dict) -> None:
        """One task, the moment it ends. Called from chunk worker threads.

        Appended, never rewritten: this is the stream that survives a crash. The
        record may be superseded by the phase file if the merge queue later
        rejects its chunk -- see the module docstring.
        """
        line = json.dumps(rec, sort_keys=True)
        with self._lock:
            os.makedirs(self.run_dir, exist_ok=True)
            with open(self.tasks_path, 'a') as fh:
                fh.write(line + '\n')
                fh.flush()
                os.fsync(fh.fileno())
            self._tasks_seen += 1

    def record_chunk(self, chunk_record: dict) -> None:
        """One chunk's result, when its agent is done and before it is merged."""
        cid = chunk_record.get('chunk_id')
        if not cid:
            raise ValueError('chunk record has no chunk_id')
        with self._lock:
            _atomic_write_json(self.chunk_path(cid), chunk_record)

    def record_phase(self, phase_record: dict, *, tree_digest=None,
                     spend_usd=None) -> None:
        """A phase, after its merge queue drained. This one is authoritative.

        Written before the next phase starts, so a session that dies in phase N+1
        still has every earlier phase intact and resumable.
        """
        phase_no = phase_record.get('phase')
        if phase_no is None:
            raise ValueError('phase record has no phase number')
        with self._lock:
            _atomic_write_json(self.phase_path(phase_no), phase_record)
            if phase_no not in self.completed_phases:
                self.completed_phases.append(phase_no)
            if tree_digest is not None:
                self.tree_digest = tree_digest
            elif phase_record.get('tree_digest'):
                self.tree_digest = phase_record['tree_digest']
            if spend_usd is not None:
                self.spend_usd = float(spend_usd)
            self.flush()

    def note_infrastructure_failure(self, kind: str, detail=None,
                                    chunk_id=None, phase=None) -> None:
        """Named, in the report. An infrastructure failure that later reads as a
        reasoning result is the specific outcome the reporting rule forbids."""
        with self._lock:
            self.infrastructure_failures.append(
                {'kind': kind, 'detail': detail, 'chunk_id': chunk_id,
                 'phase': phase})
            self.flush()

    # -- reading back ------------------------------------------------------

    def phase_records(self, phases=None) -> list:
        """Stored phase records, in phase order."""
        out = []
        for phase_no in sorted(self.completed_phases):
            if phases is not None and phase_no not in set(phases):
                continue
            path = self.phase_path(phase_no)
            if not os.path.isfile(path):
                continue
            with open(path) as fh:
                out.append(json.load(fh))
        return out

    def streamed_tasks(self) -> list:
        if not os.path.isfile(self.tasks_path):
            return []
        out = []
        with open(self.tasks_path) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def task_records(self) -> tuple:
        """The authoritative task set, and a note on where it came from.

        Phase files win. The stream fills in only tasks belonging to phases that
        never completed -- work that was really done and really lost its phase,
        which must not silently vanish from the denominator.
        """
        from_phases, seen = [], set()
        for p in self.phase_records():
            for c in p.get('chunks') or []:
                for t in c.get('tasks') or []:
                    from_phases.append(t)
                    seen.add((t.get('chunk_id'), t.get('bug_id')))
        orphans = [t for t in self.streamed_tasks()
                   if (t.get('chunk_id'), t.get('bug_id')) not in seen]
        note = (f'{len(from_phases)} task(s) from completed phase records'
                + (f'; {len(orphans)} from the crash-safety stream, belonging to '
                   'a phase that never completed -- their dispositions are '
                   'pre-merge' if orphans else ''))
        return from_phases + orphans, note

    # -- guard logs --------------------------------------------------------

    def merge_guard_logs(self) -> str | None:
        """Concatenate every per-chunk guard log into one the auditor can read.

        `blind_guard.audit_run` takes a single path, and the dispatcher writes one
        log per chunk. Auditing any single one of them reads the other chunks as
        clean because empty -- a blind run certified from a third of its evidence.
        """
        os.makedirs(self.guard_dir, exist_ok=True)
        combined = os.path.join(self.guard_dir, COMBINED_GUARD)
        parts = sorted(p for p in glob.glob(os.path.join(self.guard_dir, '*.jsonl'))
                       if os.path.basename(p) != COMBINED_GUARD)
        if not parts:
            return None
        with open(combined, 'w') as out:
            for part in parts:
                with open(part) as fh:
                    for line in fh:
                        if line.strip():
                            out.write(line if line.endswith('\n') else line + '\n')
            out.flush()
            os.fsync(out.fileno())
        return combined

    def guard_log_parts(self) -> list:
        return sorted(os.path.basename(p)
                      for p in glob.glob(os.path.join(self.guard_dir, '*.jsonl'))
                      if os.path.basename(p) != COMBINED_GUARD)

    # -- the report --------------------------------------------------------

    def write_report(self, report: dict) -> str:
        path = os.path.join(self.run_dir, 'patcher-report.json')
        _atomic_write_json(path, report)
        return path

    # -- resume ------------------------------------------------------------

    def assert_tree_matches(self, digest: str) -> None:
        if self.tree_digest and self.tree_digest != digest:
            raise RuntimeError(
                'refusing to resume: the trunk has changed since the last completed '
                f'phase.\n  recorded : {self.tree_digest}\n  on disk   : {digest}\n'
                'Continuing would attribute edits this run did not make to the '
                'patcher, and nothing downstream would show it. Either restore the '
                'trunk to the recorded state, or start a new run.')
