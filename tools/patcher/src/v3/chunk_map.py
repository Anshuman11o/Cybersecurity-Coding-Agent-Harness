#!/usr/bin/env python3
"""
Load and validate the offline chunk map.

The map is the whole of v3's planning. It is produced once, offline, by a
generator under `tools/patcher/plan/`, checked in, and read at runtime. No model
computes it and nothing recomputes it during a run -- v2's planner already
showed why that matters: recomputing a plan against an already-patched tree lets
a fix that added an import silently reshape the remaining schedule, and the run
then executes two plans while reporting one.

This module consumes the `chunk-map/v1` schema and refuses anything that would
make the run's numbers unreadable. Every check below is here because the failure
it prevents is silent:

  a bug in two chunks      two agents fix the same defect in two trees. Whichever
                           merges second is a conflict at best and a double-fix at
                           worst, and the run's bug denominator no longer matches
                           the report's.
  a bug in no chunk        the denominator quietly shrinks and the run reads as a
                           BETTER result than it is. This is the same failure the
                           v2 grouping tests pin, in a new place.
  a file in two chunks     the ownership guarantee is the only reason chunk agents
                           can run concurrently without a merge protocol. A map
                           that breaks it has not divided the codebase, it has
                           just relabelled the collision.
  a task whose file the    the chunk does not own the file it is being asked to
  chunk does not own       patch, so every fix it makes is an out-of-boundary
                           write and the whole chunk merges last. Silent, and it
                           serialises the run.
  a file with no task      one lane per file means the executor reads the whole
                           file into the prompt. A file carrying no bug is pure
                           prompt cost and pure read surface.
  a denylisted file        `models/challenge.ts` is 114 lines of literal challenge
  anywhere in a chunk      keys. Assigning it to a chunk is exactly the v2
                           per-file lane bug, which cost two runs' blindness.
  a dependency inside      brackets in one phase run CONCURRENTLY. A depends_on
  the same phase           edge between two of them is a claim the schedule does
                           not honour.

`validate()` raises on the first class of problem it finds and names every
instance, rather than returning a boolean -- a map is loaded once, before any
money is spent, so there is no reason to be economical about the error.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

from . import boundary as boundary_mod

MAP_ID = 'chunk-map/v1'

# The brackets the architecture defines, and the order the phases must respect.
# Recorded here as documentation, not as a constraint: a map may legitimately
# carry fewer brackets (a subset run) or name them differently. What is enforced
# is internal consistency, not this particular naming.
KNOWN_BRACKETS = {
    'A': 'core -- lib/**, models/**',
    'B': 'frontend + contracts -- no import edge to the server side',
    'C': 'handlers + seed -- routes/**, data/**',
    'D': 'wiring -- server.ts',
}


class ChunkMapError(ValueError):
    """A map that cannot be run. Raised before anything is spent."""


# ----------------------------------------------------------------------------
# Shapes
# ----------------------------------------------------------------------------

@dataclass
class Task:
    """One bug. v3's unit of work is the bug, not the file -- see the cost note
    in `docs/patcher/ARCHITECTURE-V3.md` §6, which is not a small one."""

    bug_id: str
    file: str
    line: int | None = None
    bug_class: str | None = None

    @classmethod
    def parse(cls, doc: dict) -> 'Task':
        return cls(bug_id=doc.get('bug_id'), file=doc.get('file'),
                   line=doc.get('line'), bug_class=doc.get('class'))

    def as_record(self) -> dict:
        return {'bug_id': self.bug_id, 'file': self.file, 'line': self.line,
                'class': self.bug_class}


@dataclass
class Chunk:
    chunk_id: str
    bracket: str
    phase: int
    reason: str = ''
    files: list = field(default_factory=list)
    tasks: list = field(default_factory=list)

    @property
    def bug_ids(self) -> list:
        return [t.bug_id for t in self.tasks]


@dataclass
class Bracket:
    bracket: str
    name: str
    phase: int
    depends_on: list = field(default_factory=list)
    concurrency: int = 1
    chunks: list = field(default_factory=list)


# ----------------------------------------------------------------------------
# The map
# ----------------------------------------------------------------------------

class ChunkMap:
    """A validated map. Constructing one that is invalid is not possible --
    `parse()` validates before it returns."""

    def __init__(self, doc: dict, brackets: list, phases: list, source: str | None = None):
        self.doc = doc
        self.brackets = brackets
        self.phases = phases
        self.source = source

    # -- accessors ---------------------------------------------------------

    @property
    def map_id(self) -> str:
        return self.doc.get('map_id')

    @property
    def shared_extension_zone(self) -> tuple:
        return tuple(self.doc.get('shared_extension_zone')
                     or boundary_mod.DEFAULT_SHARED_EXTENSION_ZONE)

    @property
    def never_writable(self) -> tuple:
        return tuple(self.doc.get('never_writable')
                     or boundary_mod.DEFAULT_NEVER_WRITABLE)

    @property
    def read_denylist(self) -> tuple:
        return tuple(self.doc.get('read_denylist')
                     or boundary_mod.DEFAULT_READ_DENYLIST)

    @property
    def excluded_bugs(self) -> list:
        return list(self.doc.get('excluded_bugs') or [])

    def bracket(self, name: str) -> Bracket:
        for b in self.brackets:
            if b.bracket == name:
                return b
        raise KeyError(name)

    @property
    def chunks(self) -> list:
        """Every chunk, in phase then bracket then chunk order.

        Deterministic, because this order is the merge order's tiebreak and a
        merge order settled by a race is not comparable across runs.
        """
        out = []
        for phase_no in self.phase_order():
            for b in sorted((b for b in self.brackets if b.phase == phase_no),
                            key=lambda x: x.bracket):
                out += sorted(b.chunks, key=lambda c: c.chunk_id)
        return out

    def chunk(self, chunk_id: str) -> Chunk:
        for c in self.chunks:
            if c.chunk_id == chunk_id:
                return c
        raise KeyError(chunk_id)

    def phase_order(self) -> list:
        return [p['phase'] for p in self.phases]

    def brackets_in_phase(self, phase_no: int) -> list:
        return sorted((b for b in self.brackets if b.phase == phase_no),
                      key=lambda b: b.bracket)

    def chunks_in_phase(self, phase_no: int) -> list:
        out = []
        for b in self.brackets_in_phase(phase_no):
            out += sorted(b.chunks, key=lambda c: c.chunk_id)
        return out

    def concurrency_for_phase(self, phase_no: int) -> int:
        """The phase's own cap if it declares one, otherwise the widest bracket in it.

        A phase-level cap is the box's limit; a bracket's is the planner's view
        of how much of that bracket may safely run at once. When both are
        present the phase wins, because it is the one bounded by real hardware.
        """
        for p in self.phases:
            if p['phase'] == phase_no and p.get('concurrency'):
                return max(1, int(p['concurrency']))
        return max([1] + [b.concurrency for b in self.brackets_in_phase(phase_no)])

    def bug_ids(self) -> list:
        return [t.bug_id for c in self.chunks for t in c.tasks]

    def chunk_of_bug(self, bug_id: str) -> Chunk | None:
        for c in self.chunks:
            if bug_id in c.bug_ids:
                return c
        return None

    def owned_files(self) -> dict:
        return {c.chunk_id: list(c.files) for c in self.chunks}

    # -- boundary ----------------------------------------------------------

    def boundary_for(self, chunk_id: str) -> boundary_mod.WriteBoundary:
        """The write boundary a chunk's agent is handed and the merge queue judges by."""
        c = self.chunk(chunk_id)
        return boundary_mod.WriteBoundary(
            chunk_id=c.chunk_id, owned=c.files,
            shared_extension_zone=self.shared_extension_zone,
            never_writable=self.never_writable,
            read_denylist=self.read_denylist)

    # -- summary -----------------------------------------------------------

    def describe(self) -> str:
        lines = [f'{self.map_id}  {len(self.chunks)} chunk(s), '
                 f'{len(self.bug_ids())} task(s), {len(self.phases)} phase(s), '
                 f'{len(self.excluded_bugs)} excluded']
        for p in self.phases:
            n = p['phase']
            lines.append(f"  phase {n}  brackets {','.join(sorted(p['brackets']))}  "
                         f'concurrency {self.concurrency_for_phase(n)}')
            for c in self.chunks_in_phase(n):
                lines.append(f'    {c.chunk_id:<6} {len(c.tasks):>3} task(s)  '
                             f'{len(c.files):>3} file(s)  [{c.bracket}]')
        return '\n'.join(lines)


# ----------------------------------------------------------------------------
# Parsing and validation
# ----------------------------------------------------------------------------

def _need(doc: dict, key: str, errors: list, kind=None):
    if key not in doc:
        errors.append(f'missing required key {key!r}')
        return None
    v = doc[key]
    if kind is not None and not isinstance(v, kind):
        errors.append(f'{key!r} must be {kind.__name__}, got {type(v).__name__}')
        return None
    return v


def _dupes(values) -> list:
    seen, dup = set(), []
    for v in values:
        if v in seen and v not in dup:
            dup.append(v)
        seen.add(v)
    return dup


def parse(doc: dict, *, source: str | None = None) -> ChunkMap:
    """Build a ChunkMap, or raise ChunkMapError listing everything wrong with it."""
    errors: list = []
    if not isinstance(doc, dict):
        raise ChunkMapError('chunk map must be a JSON object')

    if doc.get('map_id') != MAP_ID:
        errors.append(f'map_id must be {MAP_ID!r}, got {doc.get("map_id")!r}')

    raw_brackets = _need(doc, 'brackets', errors, list) or []
    raw_phases = _need(doc, 'phases', errors, list) or []
    if errors:
        raise ChunkMapError('; '.join(errors))

    # -- brackets and chunks ---------------------------------------------
    brackets: list = []
    for rb in raw_brackets:
        b = Bracket(bracket=rb.get('bracket'), name=rb.get('name') or '',
                    phase=rb.get('phase'), depends_on=list(rb.get('depends_on') or []),
                    concurrency=max(1, int(rb.get('concurrency') or 1)))
        for rc in rb.get('chunks') or []:
            b.chunks.append(Chunk(
                chunk_id=rc.get('chunk_id'), bracket=b.bracket, phase=b.phase,
                reason=rc.get('reason') or '',
                files=[boundary_mod.normalise(f) for f in (rc.get('files') or [])],
                tasks=[Task.parse(t) for t in (rc.get('tasks') or [])]))
        brackets.append(b)

    phases = []
    for rp in raw_phases:
        phases.append({'phase': rp.get('phase'),
                       'brackets': list(rp.get('brackets') or []),
                       'concurrency': rp.get('concurrency')})
    phases.sort(key=lambda p: (p['phase'] is None, p['phase']))

    cmap = ChunkMap(doc, brackets, phases, source=source)
    validate(cmap)
    return cmap


def validate(cmap: ChunkMap) -> None:
    """Raise ChunkMapError unless every invariant in the module docstring holds."""
    errors: list = []
    brackets, phases = cmap.brackets, cmap.phases

    # -- identity ---------------------------------------------------------
    if not brackets:
        errors.append('map has no brackets')
    if not phases:
        errors.append('map has no phases')

    dup = _dupes([b.bracket for b in brackets])
    if dup:
        errors.append(f'bracket id(s) declared twice: {dup}')
    if any(b.bracket is None for b in brackets):
        errors.append('every bracket needs a "bracket" id')

    all_chunks = [c for b in brackets for c in b.chunks]
    dup = _dupes([c.chunk_id for c in all_chunks])
    if dup:
        errors.append(f'chunk id(s) declared twice: {dup}')

    # -- phases -----------------------------------------------------------
    phase_of_bracket: dict = {}
    for p in phases:
        if p['phase'] is None:
            errors.append('every phase entry needs a "phase" number')
            continue
        if not p['brackets']:
            errors.append(f'phase {p["phase"]} lists no brackets')
        for name in p['brackets']:
            if name in phase_of_bracket:
                errors.append(f'bracket {name!r} appears in two phases '
                              f'({phase_of_bracket[name]} and {p["phase"]})')
            phase_of_bracket[name] = p['phase']

    dup = _dupes([p['phase'] for p in phases if p['phase'] is not None])
    if dup:
        errors.append(f'phase number(s) declared twice: {dup}')

    known = {b.bracket for b in brackets}
    for name, ph in phase_of_bracket.items():
        if name not in known:
            errors.append(f'phase {ph} lists unknown bracket {name!r}')
    for b in brackets:
        if b.bracket not in phase_of_bracket:
            errors.append(f'bracket {b.bracket!r} is in no phase, so it would never run')
        elif b.phase != phase_of_bracket[b.bracket]:
            # Two statements of the same fact that disagree. Whichever the runner
            # happens to read, the other is a lie sitting in a checked-in artefact.
            errors.append(f'bracket {b.bracket!r} says phase {b.phase} but the phase '
                          f'list puts it in phase {phase_of_bracket[b.bracket]}')

    # -- dependencies ------------------------------------------------------
    for b in brackets:
        for dep in b.depends_on:
            if dep not in known:
                errors.append(f'bracket {b.bracket!r} depends on unknown bracket {dep!r}')
                continue
            dep_phase = phase_of_bracket.get(dep)
            own_phase = phase_of_bracket.get(b.bracket)
            if dep_phase is None or own_phase is None:
                continue
            if dep_phase >= own_phase:
                errors.append(
                    f'bracket {b.bracket!r} (phase {own_phase}) depends on {dep!r} '
                    f'(phase {dep_phase}); a dependency must land in a STRICTLY '
                    'earlier phase, or the schedule does not honour it')

    # -- ownership ---------------------------------------------------------
    owner_of_file: dict = {}
    for c in all_chunks:
        if not c.chunk_id:
            errors.append('every chunk needs a "chunk_id"')
        if not c.tasks:
            errors.append(f'chunk {c.chunk_id!r} has no tasks, so it would spawn an '
                          'agent with nothing to do')
        for rel in c.files:
            if rel in owner_of_file and owner_of_file[rel] != c.chunk_id:
                errors.append(
                    f'file {rel!r} is owned by both {owner_of_file[rel]!r} and '
                    f'{c.chunk_id!r}; single ownership is the ONLY reason chunks may '
                    'run concurrently without a merge protocol')
            owner_of_file[rel] = c.chunk_id
        dup = _dupes(c.files)
        if dup:
            errors.append(f'chunk {c.chunk_id!r} lists file(s) twice: {dup}')

    # -- tasks -------------------------------------------------------------
    owner_of_bug: dict = {}
    for c in all_chunks:
        with_task = set()
        for t in c.tasks:
            if not t.bug_id:
                errors.append(f'chunk {c.chunk_id!r} has a task with no bug_id')
                continue
            if t.bug_id in owner_of_bug:
                errors.append(
                    f'bug {t.bug_id!r} appears in both {owner_of_bug[t.bug_id]!r} and '
                    f'{c.chunk_id!r}; a bug fixed twice in two trees is a conflict at '
                    'best and a double fix at worst, and the denominator no longer '
                    'matches the report')
            owner_of_bug[t.bug_id] = c.chunk_id
            rel = boundary_mod.normalise(t.file or '')
            with_task.add(rel)
            if rel not in set(c.files):
                errors.append(
                    f'chunk {c.chunk_id!r} has a task on {rel!r} but does not own that '
                    'file; every fix it makes would be an out-of-boundary write')
        for rel in c.files:
            if rel not in with_task:
                errors.append(
                    f'chunk {c.chunk_id!r} owns {rel!r} but no task targets it; a chunk '
                    'file list is bug-bearing files only')

    # -- excluded bugs -----------------------------------------------------
    for ex in cmap.excluded_bugs:
        bid = ex.get('bug_id') if isinstance(ex, dict) else None
        if not bid:
            errors.append('every excluded_bugs entry needs a bug_id')
            continue
        if not (isinstance(ex, dict) and ex.get('reason')):
            errors.append(f'excluded bug {bid!r} has no reason; an unexplained '
                          'exclusion silently lowers the denominator')
        if bid in owner_of_bug:
            errors.append(f'bug {bid!r} is both excluded and assigned to '
                          f'{owner_of_bug[bid]!r}')

    declared = cmap.doc.get('bug_count')
    if isinstance(declared, int):
        actual = len(owner_of_bug) + len(cmap.excluded_bugs)
        if actual != declared:
            errors.append(
                f'bug_count says {declared} but the map accounts for {actual} '
                f'({len(owner_of_bug)} assigned + {len(cmap.excluded_bugs)} excluded); '
                'an unaccounted bug lowers the denominator and reads as a better score')
    declared_chunks = cmap.doc.get('chunk_count')
    if isinstance(declared_chunks, int) and declared_chunks != len(all_chunks):
        errors.append(f'chunk_count says {declared_chunks} but the map holds '
                      f'{len(all_chunks)}')

    # -- the blind boundary ------------------------------------------------
    deny = cmap.read_denylist
    for c in all_chunks:
        bad = [rel for rel in c.files if boundary_mod.matches(rel, deny)]
        if bad:
            errors.append(
                f'chunk {c.chunk_id!r} is assigned read-denylisted file(s) {bad}; one '
                'lane per file means the whole file is read into the prompt, which is '
                'exactly the v2 per-file lane failure that cost two runs their '
                'blindness')
        bad = [rel for rel in c.files
               if boundary_mod.matches(rel, cmap.never_writable)]
        if bad:
            errors.append(f'chunk {c.chunk_id!r} is assigned never-writable file(s) {bad}')

    if errors:
        raise ChunkMapError('invalid chunk map:\n  - ' + '\n  - '.join(errors))


def validate_against_report(cmap: ChunkMap, bugs) -> None:
    """Every bug in the report is assigned or explicitly excluded, and nothing else.

    Separate from `validate()` because a map is a standalone artefact and has to
    be checkable without the report. This is the check that pins the two
    together, and it runs before the first agent is spawned: a map built for a
    different bug report is a run that measures a different denominator.
    """
    errors: list = []
    report_ids = [b.get('bug_id') for b in (bugs or [])]
    dup = _dupes(report_ids)
    if dup:
        errors.append(f'bug report itself has duplicate bug_id(s): {dup}')

    assigned = set(cmap.bug_ids())
    excluded = {e.get('bug_id') for e in cmap.excluded_bugs if isinstance(e, dict)}
    known = assigned | excluded

    missing = sorted(set(report_ids) - known)
    if missing:
        errors.append(f'{len(missing)} bug(s) in the report are neither assigned nor '
                      f'excluded: {missing[:10]}{"..." if len(missing) > 10 else ""}')
    extra = sorted(known - set(report_ids))
    if extra:
        errors.append(f'{len(extra)} bug(s) in the map are not in the report: '
                      f'{extra[:10]}{"..." if len(extra) > 10 else ""}')

    by_id = {b.get('bug_id'): b for b in (bugs or [])}
    for c in cmap.chunks:
        for t in c.tasks:
            bug = by_id.get(t.bug_id)
            if bug is None:
                continue
            rel = boundary_mod.normalise((bug.get('location') or {}).get('file') or '')
            if rel and rel != boundary_mod.normalise(t.file or ''):
                errors.append(f'task {t.bug_id!r} in chunk {c.chunk_id!r} says '
                              f'{t.file!r} but the report says {rel!r}')

    if errors:
        raise ChunkMapError('chunk map does not match the bug report:\n  - '
                            + '\n  - '.join(errors))


def load(path: str) -> ChunkMap:
    if not os.path.isfile(path):
        raise ChunkMapError(f'chunk map not found: {path}')
    with open(path) as fh:
        try:
            doc = json.load(fh)
        except json.JSONDecodeError as ex:
            raise ChunkMapError(f'{path} is not valid JSON: {ex}') from ex
    return parse(doc, source=os.path.abspath(path))


if __name__ == '__main__':                                        # pragma: no cover
    import sys as _sys
    print(load(_sys.argv[1]).describe())
