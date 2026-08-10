#!/usr/bin/env python3
"""
The write boundary: what a chunk owns, what it must declare, what it may never
touch, and what it may not even read.

WHY THIS IS NOT A DENY LIST

The obvious rule -- "you may only write the files your chunk owns" -- is one
line in the sandbox hook and it is wrong. Measured on the Subset 3 pilot: one
*correct* CSRF fix spanned four files to plumb a token from a library, through a
route, into a view. Token-based CSRF cannot be done in one file. A hard deny
would have silently restricted the solution space to whatever happens to be
locally patchable and the run would still have looked successful, which is the
worst available outcome -- a measurement that is wrong in the flattering
direction.

So there are four classes, not two:

  owned              write freely. The chunk is the only writer, by construction
                     of the map: `chunk_map` rejects any map that puts one file
                     in two chunks.
  shared_extension   views/**, config/**, swagger.yml. Reachable, but only by
                     DECLARING the file and the reason. A chunk that writes here
                     merges last, because several chunks legitimately extend the
                     same view or config and the queue needs an order that is not
                     a race.
  outside            any other file. Same rule as shared_extension: declare it.
                     An undeclared write is not dropped -- dropping it would
                     silently produce a half-applied fix -- it is recorded as a
                     boundary violation and still forces merge-last.
  never_writable     test/**, **/*.spec.ts. The test corpus is how the work is
                     judged. A patch that edits a test is not a patch. This one
                     IS a hard deny.

`read_denylist` is a separate axis and it is not about collisions at all: those
files are answer-key-adjacent (a literal list of challenge keys, the anti-cheat
module, the seeder), and a chunk agent that reads one has learned the answers it
is being scored against. `chunk_map` refuses to assign them to a chunk; this
module is the second place that says no, because the v2 lane selector's failure
mode was a guard that existed, was correct, and was never wired in.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

OWNED = 'owned'
SHARED_EXTENSION = 'shared_extension'
OUTSIDE = 'outside'
NEVER_WRITABLE = 'never_writable'

# Defaults, used when a map does not carry its own. The map is the authority;
# these exist so a boundary can be built in a test without a full map.
DEFAULT_SHARED_EXTENSION_ZONE = ('views/**', 'config/**', 'swagger.yml')
DEFAULT_NEVER_WRITABLE = ('test/**', '**/*.spec.ts')
DEFAULT_READ_DENYLIST = ('models/challenge.ts', 'lib/antiCheat.ts',
                         'data/datacreator.ts')


# ----------------------------------------------------------------------------
# Globs
# ----------------------------------------------------------------------------

def _to_regex(pattern: str) -> re.Pattern:
    """Path glob -> anchored regex, with `**` crossing separators and `*` not.

    `fnmatch` is not usable here: its `*` matches `/`, so `config/*` would match
    `config/a/b.ts` and `**/*.spec.ts` would match nothing more than `*.spec.ts`
    does. The distinction is the whole point of the zone patterns.
    """
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith('**/', i):
            out.append('(?:.*/)?')
            i += 3
        elif pattern.startswith('**', i):
            out.append('.*')
            i += 2
        elif pattern[i] == '*':
            out.append('[^/]*')
            i += 1
        elif pattern[i] == '?':
            out.append('[^/]')
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile('^' + ''.join(out) + '$')


def normalise(rel: str) -> str:
    return (rel or '').replace('\\', '/').lstrip('./')


def matches(rel: str, patterns) -> bool:
    rel = normalise(rel)
    return any(_to_regex(p).match(rel) for p in (patterns or ()))


# ----------------------------------------------------------------------------
# Review
# ----------------------------------------------------------------------------

@dataclass
class BoundaryReview:
    """What one chunk's actual writes did to its boundary.

    Every field is a list of paths, so the report says *which* file rather than
    "a violation occurred". A count without a name cannot be acted on.
    """

    chunk_id: str
    owned: list = field(default_factory=list)
    declared: list = field(default_factory=list)
    undeclared: list = field(default_factory=list)
    denied: list = field(default_factory=list)
    unused_declarations: list = field(default_factory=list)

    @property
    def merge_last(self) -> bool:
        """Any write outside the owned set puts this chunk at the back of the queue.

        Declared or not: the reason for merging last is that another chunk may
        own or extend the same file, and that is true whether or not the agent
        remembered to say so.
        """
        return bool(self.declared or self.undeclared)

    @property
    def clean(self) -> bool:
        return not self.undeclared and not self.denied

    def as_record(self) -> dict:
        return {'chunk_id': self.chunk_id, 'owned': self.owned,
                'declared': self.declared, 'undeclared': self.undeclared,
                'denied': self.denied,
                'unused_declarations': self.unused_declarations,
                'merge_last': self.merge_last, 'clean': self.clean}


class WriteBoundary:
    """One chunk's slice of the filesystem."""

    def __init__(self, chunk_id: str, owned,
                 shared_extension_zone=DEFAULT_SHARED_EXTENSION_ZONE,
                 never_writable=DEFAULT_NEVER_WRITABLE,
                 read_denylist=DEFAULT_READ_DENYLIST):
        self.chunk_id = chunk_id
        self.owned = frozenset(normalise(f) for f in (owned or ()))
        self.shared_extension_zone = tuple(shared_extension_zone or ())
        self.never_writable = tuple(never_writable or ())
        self.read_denylist = tuple(read_denylist or ())

    # -- classification ----------------------------------------------------

    def classify(self, rel: str) -> str:
        """Which of the four classes this path falls into.

        `never_writable` is checked FIRST and beats ownership. A map that
        somehow assigned `test/x.spec.ts` to a chunk must not thereby make it
        writable -- the hard deny is the last thing that should be overridable
        by data.
        """
        rel = normalise(rel)
        if matches(rel, self.never_writable):
            return NEVER_WRITABLE
        if rel in self.owned:
            return OWNED
        if matches(rel, self.shared_extension_zone):
            return SHARED_EXTENSION
        return OUTSIDE

    def may_write(self, rel: str, declared=()) -> bool:
        cls = self.classify(rel)
        if cls == NEVER_WRITABLE:
            return False
        if cls == OWNED:
            return True
        return normalise(rel) in {normalise(d) for d in (declared or ())}

    def may_read(self, rel: str) -> bool:
        """Reads are unrestricted except for the answer-key-adjacent set.

        A chunk has to read outside itself to fix anything -- the caller of the
        function it is hardening, the type it returns. Restricting reads would
        break fixes for no collision benefit, since a read cannot collide.
        """
        return not matches(rel, self.read_denylist)

    # -- review ------------------------------------------------------------

    def review(self, written, declared=()) -> BoundaryReview:
        """Classify a chunk's actual write set against its declarations."""
        declared_set = {normalise(d) for d in (declared or ())}
        rev = BoundaryReview(chunk_id=self.chunk_id)
        touched = set()
        for rel in sorted({normalise(w) for w in (written or ())}):
            touched.add(rel)
            cls = self.classify(rel)
            if cls == NEVER_WRITABLE:
                rev.denied.append(rel)
            elif cls == OWNED:
                rev.owned.append(rel)
            elif rel in declared_set:
                rev.declared.append(rel)
            else:
                rev.undeclared.append(rel)
        rev.unused_declarations = sorted(declared_set - touched)
        return rev

    def as_record(self) -> dict:
        return {'chunk_id': self.chunk_id, 'owned': sorted(self.owned),
                'shared_extension_zone': list(self.shared_extension_zone),
                'never_writable': list(self.never_writable),
                'read_denylist': list(self.read_denylist)}

    def __repr__(self):                                          # pragma: no cover
        return f'WriteBoundary({self.chunk_id!r}, {len(self.owned)} owned file(s))'
