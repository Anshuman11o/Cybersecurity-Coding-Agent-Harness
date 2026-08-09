#!/usr/bin/env python3
"""
Functional tests that cannot survive a correct fix.

Some tests in the corpus assert that an attack payload was *acted upon*: they send
`%2500`, or `../`, or a query operator, and then assert a 2xx or that the sink was
reached. A change that closes the path makes such a test fail, necessarily. Left in
the regression net it charges a correct fix with damage, and the orchestrator reverts
it.

Not a hypothesis. Measured on wave 1 of the subset 2 run: `UNIT-routes-fileServer.ts`
spent its whole reconcile budget -- five rounds, 37 min, $10.79 -- with typecheck
passing, its own workflow test passing and its probe blocked on every round, and V4
red on the same two rows each time. The blocking row asserts that
`GET /ftp/package.json.bak%2500.md` returns 200. The agent moved the null-byte strip
ahead of the allow-list decision, which is correct, and that is exactly why the row
went red. The unit was reverted as `abandoned` and was the sole source of the run's
in-sandbox overclaim rate.

WHERE THE LIST COMES FROM, AND WHERE IT MUST NOT

It is derived from the test files in the work tree, which the agent may already read.
Nothing here consults the answer key, and nothing here reaches a prompt -- the agent
is told *less* than before, never more.

That distinction is the whole reason this module exists rather than a config pointing
at the ground truth's `known-conflicts.json`. Those titles name challenges, and a
challenge identifier paired with a file is precisely what may not enter this
repository.

The classifier is imported from the blind-development generator so the two can never
disagree about what counts as attack-dependent. If that import fails the net is left
exactly as it was: a missing exclusion costs a correct fix, a guessed one hides real
damage, and only the second is silent.
"""
from __future__ import annotations

import os
import re
import sys

_GENERATOR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          '..', '..', 'blind-development')

# `describe('/ftp', ...)` / `void describe("...")`. A suite row appears in the output
# as a result of its own, derived from its children.
_DESCRIBE_RE = re.compile(r"""(?:^|\s)describe\s*\(\s*['"`]([^'"`]+)['"`]""", re.M)


def _classifier():
    """The generator's attack-dependence classifier, or None if unavailable."""
    try:
        if _GENERATOR not in sys.path:
            sys.path.insert(0, _GENERATOR)
        import split_answer_key as g       # noqa: PLC0415
        return (g.extract_it_blocks, g.dedupe_nested,
                g.attack_payloads_in, g.asserts_attack_dependent_behaviour)
    except Exception:                                            # noqa: BLE001
        return None


def detect(tree: str, test_files) -> dict:
    """Scan the regression net's own files.

    -> {'tests': {rel: {title, ...}}, 'suites': {rel: {title, ...}},
        'available': bool}

    `available` False means the classifier could not be loaded and nothing may be
    excused; the caller must not treat that as "no anti-oracles found".
    """
    parts = _classifier()
    out = {'tests': {}, 'suites': {}, 'available': parts is not None}
    if parts is None:
        return out
    extract, dedupe, payloads_in, asserts_dependent = parts

    for rel in test_files or ():
        try:
            with open(os.path.join(tree, rel), encoding='utf-8', errors='replace') as fh:
                text = fh.read()
        except OSError:
            continue
        flagged = set()
        for _s, _e, title, body in dedupe(extract(text)):
            if title and payloads_in(body) and asserts_dependent(body):
                flagged.add(title.strip())
        if flagged:
            out['tests'][rel] = flagged
            out['suites'][rel] = {m.group(1).strip()
                                  for m in _DESCRIBE_RE.finditer(text)}
    return out


def filter_regressions(rel: str, regressions: list, info: dict) -> tuple:
    """(real, excused) for one file's V4 regressions.

    Two steps, and the second is what makes the first worth anything. Excusing the
    attack-dependent test alone leaves the `describe()` row it made red still failing,
    so the gate stays red and nothing changes. A suite row is therefore excused too --
    but only once every non-suite failure in that file has been excused, so a genuine
    regression sitting beside an anti-oracle still counts.
    """
    flagged = (info.get('tests') or {}).get(rel) or set()
    if not flagged:
        return list(regressions), []

    suites = (info.get('suites') or {}).get(rel) or set()
    excused = [r for r in regressions if r.get('title') in flagged]
    rest = [r for r in regressions if r.get('title') not in flagged]
    if not excused:
        return rest, []

    if all(r.get('title') in suites for r in rest):
        return [], excused + rest
    return rest, excused
