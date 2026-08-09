#!/usr/bin/env python3
"""
Turn a bug report into the units the outer loop iterates.

Granularity is a real lever, not a formatting choice. One task per bug means the
same file is characterised once per bug in it, and each of those tasks can
collide with its own siblings on that file. On the 24-bug subset that is
server.ts characterised 8 times, lib/insecurity.ts 5 times and
routes/fileServer.ts 5 times -- 24 tasks where 8 would do.

Grouping by file removes both costs at once, and it removes them without
introducing a merge: one agent owns a file for the whole task, so intra-file
collision is not mitigated, it is impossible. The bake-off arms that scored best
were per-file for this reason; per-bug was a regression in granularity.

  bug    one task per bug. The original behaviour, kept as the default so an
         existing config's meaning does not change under it.
  file   one task per source file, carrying every bug located in that file.

A unit is a bug-shaped dict, so nothing downstream needs to know which mode
produced it. `members` carries the constituent bugs and is what the prompt
renders; its presence is also how the playbook selector knows to merge guidance
across several classes instead of picking one.
"""
from __future__ import annotations

import collections
import re

GRANULARITIES = ('bug', 'file')

# bug_id feeds a scratch directory name, a task record key and the schema's
# ^[A-Za-z0-9][A-Za-z0-9._-]*$ -- so a path separator cannot survive into it.
_ID_UNSAFE = re.compile(r'[^A-Za-z0-9._-]+')


def unit_id_for_file(path: str) -> str:
    return 'UNIT-' + _ID_UNSAFE.sub('-', path).strip('-')


def _merged_owasp(bugs: list) -> list:
    """Union of codes, most-common first, capped at 3.

    The cap mirrors the input schema's: a unit tagged with every category tells
    the agent as little as a finding tagged with every category. The full set
    stays visible in the rendered members.
    """
    counts = collections.Counter()
    seen = {}
    for b in bugs:
        for o in b.get('owasp') or []:
            code = o.get('code')
            if not code:
                continue
            counts[code] += 1
            seen.setdefault(code, o)
    return [seen[c] for c, _ in counts.most_common(3)]


def _merged_class(bugs: list) -> str:
    """A representative class for the unit, with the count when it is mixed.

    Kept human-readable rather than synthetic: it is shown to the agent and it
    is the fallback selector if a unit somehow reaches the playbook without
    members.
    """
    classes = [b.get('class') for b in bugs if b.get('class')]
    if not classes:
        return 'unspecified'
    counts = collections.Counter(classes)
    top, n = counts.most_common(1)[0]
    if len(counts) == 1:
        return top
    return f'{top} (+{len(counts) - 1} other class(es) in this file)'


def group(bugs: list, granularity: str = 'bug') -> list:
    """-> list of units, each a bug-shaped dict. Order is stable and derived."""
    if granularity not in GRANULARITIES:
        raise ValueError(f'unknown task_granularity {granularity!r}; '
                         f'expected one of {", ".join(GRANULARITIES)}')
    if granularity == 'bug':
        return list(bugs)

    by_file: dict[str, list] = collections.OrderedDict()
    for b in bugs:
        by_file.setdefault(b['location']['file'], []).append(b)

    units = []
    for path, members in by_file.items():
        if len(members) == 1:
            # A single-bug file is not a group. Keeping it as the bug itself
            # means its id, its scratch dir and its task record are identical to
            # what per-bug mode produces, so the two modes stay comparable on
            # every file that holds one bug.
            units.append(members[0])
            continue
        members = sorted(members, key=lambda b: (b['location']['line'], b['bug_id']))
        primary = members[0]
        units.append({
            'bug_id': unit_id_for_file(path),
            'location': {'file': path, 'line': primary['location']['line']},
            'owasp': _merged_owasp(members),
            'class': _merged_class(members),
            'vulnerability': None,      # per-member text is rendered from members
            'reproduction': None,
            'members': members,
            'member_bug_ids': [b['bug_id'] for b in members],
        })
    return units


def describe(units: list) -> str:
    multi = [u for u in units if u.get('members')]
    n_bugs = sum(len(u['members']) if u.get('members') else 1 for u in units)
    return (f'{len(units)} unit(s) covering {n_bugs} bug(s); '
            f'{len(multi)} unit(s) carry more than one bug')
