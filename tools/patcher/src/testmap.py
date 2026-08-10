#!/usr/bin/env python3
"""
Which existing tests exercise the code a task touched.

The per-task regression net. `docs/patcher/EVAL-METRICS.md` is blunt about the
asymmetry it is approximating: axis A is scoped to the case, axis B is scoped to
the whole application, and there is no such thing as a safely out-of-scope file.
Running the whole suite inside a retry loop, once per task, is not affordable, so
this module picks the subset most likely to notice damage and the run closes with
one full-suite gate at the end.

Two sources, unioned:
  1. what the agent named in `characterisation.json` -- it read the code
  2. what a static scan of the test corpus says imports or references the file

Neither is sufficient alone. The agent misses tests it did not think to look
for; the static scan misses tests that reach the code through three layers of
indirection. Together they are a usable net, and the end-of-run full suite is
the backstop that makes the gap survivable.
"""
from __future__ import annotations

import os
import re

TEST_ROOTS = ('test/api', 'test/server')
API_ROOT = 'test/api'
SERVER_ROOT = 'test/server'

# Files whose importers are essentially the whole application. Selecting on them
# degrades to "run everything", which the caller cannot afford, so they fall
# through to the end-of-run full suite instead of pretending to be scoped.
_TOO_CENTRAL = re.compile(r'^(app|server)\.ts$|^models/index\.ts$')


def _module_keys(rel_path: str):
    """The strings a test file would use to reach this module."""
    stem, _ = os.path.splitext(rel_path)
    base = os.path.basename(stem)
    return {k for k in (rel_path, stem, base) if k}


def _is_test_file(name: str) -> bool:
    return name.endswith('.test.ts') or name.endswith('.unit.test.ts')


def list_test_files(work_tree: str) -> list:
    out = []
    for root_rel in TEST_ROOTS:
        root = os.path.join(work_tree, root_rel)
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if _is_test_file(f):
                    out.append(os.path.relpath(os.path.join(dirpath, f), work_tree))
    return sorted(out)


def scan(work_tree: str, changed_files, *, limit: int = 12) -> list:
    """Existing test files that mention any of `changed_files`.

    Ranked: an explicit import beats a bare mention of the basename, because a
    basename like `search` matches a great deal of prose.
    """
    targets = {}
    for rel in changed_files:
        if _TOO_CENTRAL.search(rel):
            continue
        targets[rel] = _module_keys(rel)
    if not targets:
        return []

    scored = {}
    for test_rel in list_test_files(work_tree):
        try:
            with open(os.path.join(work_tree, test_rel), encoding='utf-8',
                      errors='replace') as fh:
                text = fh.read()
        except OSError:
            continue
        score = 0
        for rel, keys in targets.items():
            stem = os.path.splitext(rel)[0]
            if re.search(rf'''from\s+['"][^'"]*{re.escape(stem)}['"]''', text):
                score += 10
            elif re.search(rf'''require\(\s*['"][^'"]*{re.escape(stem)}['"]''', text):
                score += 10
            elif stem in text:
                score += 3
            elif re.search(rf'\b{re.escape(os.path.basename(stem))}\b', text):
                score += 1
        if score:
            scored[test_rel] = score
    return [t for t, _ in sorted(scored.items(), key=lambda kv: (-kv[1], kv[0]))][:limit]


def select(work_tree: str, changed_files, agent_named=(), *, limit: int = 12) -> list:
    """Union of the agent's list and the static scan, agent's first.

    An agent-named file that does not exist is dropped rather than run: it is
    usually a hallucinated path, and a missing file would otherwise be recorded
    as a harness error on every subsequent round of the task.
    """
    picked, seen = [], set()
    for rel in agent_named or ():
        rel = str(rel).strip().lstrip('./')
        if rel in seen or not _is_test_file(rel):
            continue
        if os.path.isfile(os.path.join(work_tree, rel)):
            picked.append(rel)
            seen.add(rel)
    for rel in scan(work_tree, changed_files, limit=limit):
        if rel not in seen:
            picked.append(rel)
            seen.add(rel)
    return picked[:limit]


def env_for(test_rel: str) -> str:
    """Which test environment a file needs: 'server' or 'api'.

    The two suites bootstrap differently, and running a file under the wrong one
    fails in a way that looks like a regression.
    """
    return 'server' if test_rel.replace('\\', '/').startswith(SERVER_ROOT) else 'api'
