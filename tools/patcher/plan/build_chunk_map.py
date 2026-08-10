#!/usr/bin/env python3
"""
Build the static chunk map: the whole codebase divided, offline, into chunks an
agent can be handed one at a time.

    python3 build_chunk_map.py --bug-report <br.json> [--tree <app>] [--out map.json]

WHY A SECOND PLANNER

`src/wave_plan.py` schedules ONE run: it layers the units of a single bug report
by longest path through the import graph, and its shape therefore changes every
time the report changes. That is right for executing a run and wrong for talking
about the codebase, because nothing in it is stable across reports.

This planner answers the other question -- *which parts of this application can
be worked on independently, and in what order* -- and it answers it with a fixed
partition of the tree into four brackets that do not move when the bug list does.
A bracket is a claim about the application's architecture; a chunk is a claim
about one bracket's internal structure and the size an agent can hold at once.

It shares wave_plan's dependency source of truth. `wave_plan.import_graph()` is
imported, never reimplemented: two copies of "what imports what" would drift, and
the drift would be invisible until a cycle was split across two chunks.

DETERMINISM

Pure function of (bug report, tree). No model, no clock, no filesystem order.
Every sort key is total: components sort by (-bug_count, first file path), tasks
by (file, line, bug_id). The bug_id tiebreak is load-bearing -- two findings on
one line are common (three of Subset 2's are) and without it the task order would
be inherited from the input's order, which is not part of the input's meaning.

THE FOUR BRACKETS

  A  core                 lib/**, models/**
  B  frontend+contracts   frontend/**, data/static/web3-snippets/**
  C  handlers+seed        routes/**, and the rest of data/**
  D  wiring               server.ts, app.ts

Phase 0 runs A and B together, phase 1 runs C, phase 2 runs D. A and B share a
phase because they are genuinely disjoint -- verified against the real tree, the
frontend and contract files have zero import edges to any server-side file, so
"they are independent" is a measurement here and not an assumption. C lands after
the core it calls into; D lands last because it is the wiring and should be
edited against a tree where every other fix is already in.

WHAT IS DELIBERATELY ABSENT

Files with no bug never appear. The map is a work plan, not an inventory: a file
listed here is a file an agent will be told to open, and listing a clean file
would put it in a prompt for no reason.

Files on the scanner's SEED_DENYLIST never appear either, and their bugs are
recorded in `excluded_bugs` instead. The denylist is *read from*
tools/scanner/shared/read-guard.ts at generation time rather than copied here.
A second copy of that list is exactly how the original guard was missed: the v2
lane selector was forked before the denylist moved into shared/ and silently
never picked it up, and two runs' numbers were not blind as a result.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PATCHER = os.path.dirname(_HERE)                  # tools/patcher
_REPO = os.path.dirname(os.path.dirname(_PATCHER))  # repo root
sys.path.insert(0, os.path.join(_PATCHER, 'src'))
import wave_plan                                # noqa: E402

MAP_ID = 'chunk-map/v1'
READ_GUARD = 'tools/scanner/shared/read-guard.ts'

# Per-chunk bug cap. D is uncapped: the wiring files are one editing surface and
# splitting them would hand two agents adjacent lines of the same app bootstrap.
CAP = {'A': 4, 'B': 4, 'C': 4, 'D': None}

BRACKET_NAME = {'A': 'core', 'B': 'frontend+contracts',
                'C': 'handlers+seed', 'D': 'wiring'}
BRACKET_PHASE = {'A': 0, 'B': 0, 'C': 1, 'D': 2}
BRACKET_DEPENDS = {'A': [], 'B': [], 'C': ['A', 'B'], 'D': ['A', 'B', 'C']}

# ORDER IS SIGNIFICANT -- first match wins. data/static/web3-snippets/** must be
# tested before data/**, or the smart contracts would land in the handlers+seed
# bracket and be scheduled a phase later than the frontend they belong with.
BRACKET_RULES = (
    ('A', 'lib/**'),
    ('A', 'models/**'),
    ('B', 'frontend/**'),
    ('B', 'data/static/web3-snippets/**'),
    ('C', 'routes/**'),
    ('C', 'data/**'),
    ('D', 'server.ts'),
    ('D', 'app.ts'),
)

# Zones the map states rather than computes. They are properties of the target
# app, not of any bug report, and every chunk's prompt needs them.
SHARED_EXTENSION_ZONE = ['views/**', 'config/**', 'swagger.yml']
NEVER_WRITABLE = ['test/**', '**/*.spec.ts']

DETERMINISTIC = (
    'Brackets are fixed path rules, components come from real import statements, '
    'packing walks components in (-bug_count, first file path) order and tasks '
    'sort by (file, line, bug_id) -- so the same report and the same tree '
    'produce the same map byte for byte, with no model involved.'
)

DENYLIST_REASON = (
    'on the scanner SEED_DENYLIST in {guard}: the file enumerates challenge keys, '
    'so an agent assigned a bug here would read the answers it is scored against'
)


class MapError(Exception):
    """A defect in the inputs. Raised loudly; never worked around silently."""


# ---- inputs ----------------------------------------------------------------

def read_denylist(repo_root: str, tree: str) -> list:
    """SEED_DENYLIST from read-guard.ts, as target-relative paths.

    Parsed, not copied. If the array cannot be found the generator fails: an
    empty denylist that looks like 'nothing to exclude' is the failure mode this
    whole function exists to prevent.
    """
    path = os.path.join(repo_root, READ_GUARD)
    try:
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
    except OSError as exc:
        raise MapError(f'cannot read the read guard at {READ_GUARD}: {exc}')

    m = re.search(r'SEED_DENYLIST\s*:[^=]*=\s*\[(.*?)\]', src, re.S)
    if not m:
        raise MapError(
            f'no SEED_DENYLIST array found in {READ_GUARD}. It may have been '
            f'renamed or moved; fix this parser rather than hardcoding a copy.')
    entries = re.findall(r"""['"]([^'"]+)['"]""", m.group(1))
    if not entries:
        raise MapError(f'SEED_DENYLIST in {READ_GUARD} parsed as empty')

    # The guard lists every corpus it protects, so the same three files appear
    # once per corpus. Strip the corpus prefix and keep one copy each, in
    # first-seen order, so the field is target-relative like a bug location and
    # stable across regenerations.
    prefix = tree.rstrip('/') + '/'
    out = []
    for e in entries:
        rel = e[len(prefix):] if e.startswith(prefix) else \
            re.sub(r'^target-apps/[^/]+/', '', e)
        if rel not in out:
            out.append(rel)
    return out


def load_report(path: str) -> dict:
    with open(path, encoding='utf-8') as fh:
        br = json.load(fh)
    if not isinstance(br.get('bugs'), list) or not br['bugs']:
        raise MapError(f'{path} carries no bugs')
    return br


# ---- brackets --------------------------------------------------------------

def _matches(path: str, pattern: str) -> bool:
    if pattern.endswith('/**'):
        return path.startswith(pattern[:-2])
    return path == pattern


def bracket_of(path: str) -> str | None:
    for bracket, pattern in BRACKET_RULES:
        if _matches(path, pattern):
            return bracket
    return None


def assign_brackets(files: list) -> dict:
    """file -> bracket. An unmatched bug-bearing file is an error, not a bucket.

    Silently defaulting would put a file in a phase nobody chose and give the
    map's ordering claim no basis.
    """
    out, orphans = {}, []
    for f in files:
        b = bracket_of(f)
        if b is None:
            orphans.append(f)
        else:
            out[f] = b
    if orphans:
        raise MapError(
            'these bug-bearing files match no bracket rule:\n  '
            + '\n  '.join(sorted(orphans))
            + '\nAdd a rule to BRACKET_RULES and say which phase it belongs in. '
              'Do not let a file fall through into a default bracket.')
    return out


# ---- components ------------------------------------------------------------

def components(files: list, imports: dict) -> list:
    """Mutual-reachability classes over the bug-bearing files of one bracket.

    Two files that transitively import each other cannot be ordered relative to
    one another, so they must be edited as one thing. Reachability is computed
    over the WHOLE graph and only then restricted to the bug-bearing files: a
    cycle that runs through a clean intermediate file is still a cycle, and
    restricting the graph first would hide it.

    A file the graph does not know about -- a .sol contract, anything under
    frontend/, which wave_plan does not walk -- reaches nothing and is its own
    component. That is the honest answer: no import edge was observed.
    """
    reach = {f: wave_plan._reachable(f, imports) for f in sorted(files)}
    comps, seen = [], set()
    for f in sorted(files):
        if f in seen:
            continue
        members = [g for g in sorted(files)
                   if g == f or (g in reach[f] and f in reach[g])]
        seen.update(members)
        comps.append(members)
    return comps


# ---- packing ---------------------------------------------------------------

def pack(comps: list, bugs_by_file: dict, cap: int | None) -> list:
    """Components -> chunks, first-fit in (-bug_count, first file path) order.

    A component at or above the cap gets a chunk to itself; it is already as much
    as an agent should hold, and adding to it would make the largest chunk larger
    still. Everything smaller is first-fit into the earliest chunk that stays
    within the cap and does not already hold an oversized component -- so an
    11-bug file is never quietly topped up to 12.
    """
    def size(comp):
        return sum(len(bugs_by_file[f]) for f in comp)

    ordered = sorted(comps, key=lambda c: (-size(c), c[0]))
    chunks: list = []
    for comp in ordered:
        n = size(comp)
        if cap is not None and n >= cap:
            chunks.append({'comps': [comp], 'bugs': n, 'oversized': True})
            continue
        for ch in chunks:
            if ch['oversized']:
                continue
            if cap is None or ch['bugs'] + n <= cap:
                ch['comps'].append(comp)
                ch['bugs'] += n
                break
        else:
            chunks.append({'comps': [comp], 'bugs': n, 'oversized': False})
    return chunks


def chunk_reason(chunk: dict, cap: int | None, bracket: str) -> str:
    comps = chunk['comps']
    cycles = [c for c in comps if len(c) > 1]
    parts = []
    if cycles:
        for c in cycles:
            parts.append('import cycle: ' + ', '.join(c)
                         + ' are mutually reachable through real import '
                           'statements and cannot be ordered relative to each '
                           'other, so they are one editing unit')
    if cap is None:
        parts.append(f'bracket {bracket} is uncapped: the wiring files are one '
                     f'editing surface and land together in the final phase')
    elif chunk['oversized']:
        head = comps[0][0] if len(comps[0]) == 1 else 'the cycle'
        parts.append(f'{head} carries {chunk["bugs"]} bugs, at or above the '
                     f'per-chunk cap of {cap}, so it is a chunk on its own')
    elif len(comps) > 1:
        parts.append('first-fit packing: '
                     + ', '.join(c[0] if len(c) == 1 else '+'.join(c)
                                 for c in comps)
                     + f' import nothing of each other, and {chunk["bugs"]} bugs '
                       f'total stays within the cap of {cap}')
    else:
        parts.append(f'{comps[0][0]} alone, {chunk["bugs"]} bug(s), '
                     f'nothing else in the bracket fits beside it within the '
                     f'cap of {cap}')
    return '; '.join(parts)


# ---- the map ---------------------------------------------------------------

def build(br: dict, tree: str, *, repo_root: str = _REPO,
          bug_report_path: str = '') -> dict:
    # The map records the tree repo-relatively however it was addressed on the
    # command line. An absolute path baked into the artifact would make the
    # committed map differ per machine, and a determinism test would then be
    # asserting something about the checkout rather than about the planner.
    tree_rel = tree.replace(os.sep, '/').rstrip('/')
    if os.path.isabs(tree):
        try:
            tree_rel = os.path.relpath(tree, repo_root).replace(os.sep, '/')
        except ValueError:
            pass

    denylist = read_denylist(repo_root, tree_rel)

    bugs_by_file: dict = {}
    excluded = []
    for bug in br['bugs']:
        f = bug['location']['file']
        if f in denylist:
            excluded.append({
                'bug_id': bug['bug_id'],
                'file': f,
                'reason': DENYLIST_REASON.format(guard=READ_GUARD),
            })
            continue
        bugs_by_file.setdefault(f, []).append(bug)
    excluded.sort(key=lambda e: (e['file'], e['bug_id']))

    by_bracket = assign_brackets(sorted(bugs_by_file))
    imports, _ = wave_plan.import_graph(tree)

    brackets = []
    chunk_count = 0
    for b in ('A', 'B', 'C', 'D'):
        files = sorted(f for f, x in by_bracket.items() if x == b)
        cap = CAP[b]
        packed = pack(components(files, imports), bugs_by_file, cap)
        chunks = []
        for i, ch in enumerate(packed, start=1):
            ch_files = sorted(f for comp in ch['comps'] for f in comp)
            tasks = sorted(
                ({'bug_id': bug['bug_id'], 'file': f,
                  'line': bug['location']['line'], 'class': bug['class']}
                 for f in ch_files for bug in bugs_by_file[f]),
                key=lambda t: (t['file'], t['line'], t['bug_id']))
            chunks.append({
                'chunk_id': f'{b}{i:02d}',
                'reason': chunk_reason(ch, cap, b),
                'files': ch_files,
                'tasks': tasks,
            })
        chunk_count += len(chunks)
        brackets.append({
            'bracket': b,
            'name': BRACKET_NAME[b],
            'phase': BRACKET_PHASE[b],
            'depends_on': list(BRACKET_DEPENDS[b]),
            'concurrency': len(chunks),
            'chunks': chunks,
        })

    conc = {b['bracket']: b['concurrency'] for b in brackets}
    phases = []
    for ph in sorted({b['phase'] for b in brackets}):
        members = [b['bracket'] for b in brackets if b['phase'] == ph]
        phases.append({'phase': ph, 'brackets': members,
                       'concurrency': sum(conc[m] for m in members)})

    return {
        'map_id': MAP_ID,
        'generated_from': {
            'bug_report': bug_report_path,
            'bug_report_id': br.get('report_id', ''),
            'tree': tree_rel,
        },
        'deterministic': DETERMINISTIC,
        'bug_count': sum(len(v) for v in bugs_by_file.values()),
        'chunk_count': chunk_count,
        'excluded_bugs': excluded,
        'shared_extension_zone': list(SHARED_EXTENSION_ZONE),
        'never_writable': list(NEVER_WRITABLE),
        'read_denylist': denylist,
        'phases': phases,
        'brackets': brackets,
    }


def render(m: dict) -> str:
    out = [f"chunk map  bugs {m['bug_count']}  chunks {m['chunk_count']}"
           f"  brackets {len(m['brackets'])}  phases {len(m['phases'])}"
           f"  excluded {len(m['excluded_bugs'])}"]
    for e in m['excluded_bugs']:
        out.append(f"  EXCLUDED {e['bug_id']:10s} {e['file']}  ({e['reason']})")
    by_bracket = {b['bracket']: b for b in m['brackets']}
    for ph in m['phases']:
        out.append(f"\nphase {ph['phase']}  brackets {'+'.join(ph['brackets'])}"
                   f"  concurrency {ph['concurrency']}")
        for name in ph['brackets']:
            b = by_bracket[name]
            dep = ('after ' + ','.join(b['depends_on'])) if b['depends_on'] else 'no deps'
            out.append(f"  bracket {b['bracket']} {b['name']:20s}"
                       f" {len(b['chunks'])} chunk(s), {dep}")
            for c in b['chunks']:
                out.append(f"     {c['chunk_id']}  {len(c['tasks'])} task(s)"
                           f"  {', '.join(c['files'])}")
                out.append(f"          reason: {c['reason']}")
    return '\n'.join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--bug-report', required=True)
    ap.add_argument('--tree', help='defaults to the report target_dir')
    ap.add_argument('--out')
    args = ap.parse_args()

    br = load_report(args.bug_report)
    tree = args.tree or br.get('target_dir')
    if not tree:
        raise SystemExit('no --tree and the report carries no target_dir')

    rel = os.path.relpath(os.path.abspath(args.bug_report), _REPO).replace(os.sep, '/')
    try:
        m = build(br, tree, bug_report_path=rel)
    except MapError as exc:
        print(f'chunk map FAILED: {exc}', file=sys.stderr)
        return 1

    print(render(m))
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            json.dump(m, fh, indent=1)
            fh.write('\n')
        print(f'\nwrote {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
