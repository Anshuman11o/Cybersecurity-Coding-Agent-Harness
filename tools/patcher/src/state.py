#!/usr/bin/env python3
"""
Run state: flushed after every task, and strict about resuming.

A patch run outlives a session. It is launched detached and it will be
interrupted -- by a rate limit, a reaped session, a machine. The rule the
project already learned the hard way is that an interruption must cost one unit
of work, not the run, so state is written after every task and never held only
in memory.

The strictness on resume is the part that matters. A resumed run against a tree
that drifted since the last checkpoint would silently attribute someone else's
edits to the patcher, and nothing downstream would ever show it.
"""
from __future__ import annotations

import json
import os
import tempfile
import time


class RunState:
    def __init__(self, path: str, meta: dict | None = None):
        self.path = path
        self.meta = meta or {}
        self.records: list = []
        self.tree_digest: str | None = None
        self.started_at = time.time()
        self.infrastructure_failures: list = []

    # -- persistence --------------------------------------------------------

    def flush(self) -> None:
        """Atomic write. A half-written state file is worse than no state file."""
        os.makedirs(os.path.dirname(self.path) or '.', exist_ok=True)
        payload = {
            'meta': self.meta,
            'started_at': self.started_at,
            'updated_at': time.time(),
            'tree_digest': self.tree_digest,
            'infrastructure_failures': self.infrastructure_failures,
            'records': self.records,
        }
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or '.', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w') as fh:
                json.dump(payload, fh, indent=1)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    @classmethod
    def load(cls, path: str) -> 'RunState':
        with open(path) as fh:
            payload = json.load(fh)
        st = cls(path, payload.get('meta'))
        st.records = payload.get('records', [])
        st.tree_digest = payload.get('tree_digest')
        st.started_at = payload.get('started_at', time.time())
        st.infrastructure_failures = payload.get('infrastructure_failures', [])
        return st

    # -- progress -----------------------------------------------------------

    def completed_ids(self) -> set:
        return {r['bug_id'] for r in self.records if r.get('bug_id')}

    def append(self, record: dict, tree_digest: str) -> None:
        self.records.append(record)
        self.tree_digest = tree_digest

    def note_infrastructure_failure(self, kind: str, bug_id=None, phase=None, detail=None):
        """Named, in the report. An infrastructure failure that later reads as a
        reasoning result is the specific outcome the reporting rule forbids."""
        self.infrastructure_failures.append(
            {'kind': kind, 'bug_id': bug_id, 'phase': phase, 'detail': detail})

    def pending(self, bugs: list) -> list:
        done = self.completed_ids()
        return [b for b in bugs if b['bug_id'] not in done]

    # -- resume -------------------------------------------------------------

    def assert_tree_matches(self, digest: str) -> None:
        if self.tree_digest and self.tree_digest != digest:
            raise RuntimeError(
                'refusing to resume: the work tree has changed since the last completed '
                f'task.\n  recorded : {self.tree_digest}\n  on disk   : {digest}\n'
                'Continuing would attribute edits this run did not make to the patcher, '
                'and nothing downstream would show it. Either restore the tree to the '
                'recorded state, or start a fresh run.')
