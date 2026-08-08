#!/usr/bin/env python3
"""
Plan a parallel run: turn a bug report into ordered waves of independent units.

Everything here is deterministic. The same bug report and the same target tree
produce the same plan, byte for byte, with no model involved -- the inputs
already contain what scheduling needs (a file per bug) and the rest is read off
the import graph. A planner that needed judgement would add a nondeterminism to
a problem that has an exact answer.

    python3 wave_plan.py --bug-report <br.json> --tree <app> [--out plan.json]

THE FOUR STEPS

  1. Units      group bugs by file (grouping.py). Files are disjoint, so two
                agents can never edit the same file. The intra-file collision
                class is removed by construction, not mitigated.

  2. Edges      U -> V when V's file imports U's file. V should see U's change,
                so U lands first. Resolved from real import statements, not
                guessed from directory names.

  3. Condense   circular imports are legal in TypeScript and do occur, so the
                graph is not guaranteed acyclic. Strongly-connected components
                collapse to one node; a component holding more than one unit is
                marked serial_within_wave, because "these mutually depend and
                must not run concurrently" is exactly what a cycle means.

  4. Layer      wave = longest path to a node in the condensed DAG. Every unit
                in a wave is independent of every other unit in that wave, and
                depends only on waves before it.

WHY A HUB GETS A WAVE TO ITSELF

Step 1 makes same-file collisions impossible, but a unit may still need to touch
a file outside its own -- measured: one correct CSRF fix spanned four files to
plumb a token to a form, so out-of-scope writes cannot simply be forbidden. The
risk that remains is two units reaching for the same *shared* file, and the
shared files are known: one library here is imported by 34 files, and three
bake-off units editing it concurrently produced conflict markers and a failed
build.

--isolate-hubs (default on) gives any unit whose file is imported more widely
than --hub-threshold a wave of its own. It costs wall clock and buys the one
collision the file partition cannot prevent. Turn it off to measure that trade
rather than assume it.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import grouping                              # noqa: E402

SRC_EXTS = ('.ts', '.js', '.mjs', '.cjs')
SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', 'coverage', 'test',
             'frontend', '.patcher-scratch', '.patcher-snapshots'}

IMPORT_RE = re.compile(
    r"""(?:^|\n)\s*(?:import\b[^'"]*?from\s*|import\s*|export\b[^'"]*?from\s*)"""
    r"""['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)""", re.S)

# The app aliases its own model package; treated as an intra-app import so the
# dependency is not silently dropped as if it were a third-party package.
ALIASES = {'@juice-shop/': ''}


def iter_source(tree: str):
    for dirpath, dirs, files in os.walk(tree):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if fn.endswith(SRC_EXTS):
                yield os.path.relpath(os.path.join(dirpath, fn), tree).replace(os.sep, '/')


def _resolve(spec: str, from_file: str, known: set) -> str | None:
    """Import specifier -> repo-relative file, or None if it leaves the app."""
    for pre, sub in ALIASES.items():
        if spec.startswith(pre):
            spec = sub + spec[len(pre):]
            base = spec
            break
    else:
        if not spec.startswith('.'):
            return None                       # third-party package
        base = os.path.normpath(os.path.join(os.path.dirname(from_file), spec))
    base = base.replace(os.sep, '/').lstrip('./')
    for cand in (base, *(base + e for e in SRC_EXTS),
                 *(f'{base}/index{e}' for e in SRC_EXTS)):
        if cand in known:
            return cand
    return None


def import_graph(tree: str):
    """-> (imports, importers) over intra-app source files."""
    known = set(iter_source(tree))
    imports: dict[str, set] = {f: set() for f in known}
    importers: dict[str, set] = {f: set() for f in known}
    for f in known:
        try:
            with open(os.path.join(tree, f), encoding='utf-8', errors='replace') as fh:
                src = fh.read()
        except OSError:
            continue
        for m in IMPORT_RE.finditer(src):
            spec = m.group(1) or m.group(2)
            if not spec:
                continue
            target = _resolve(spec, f, known)
            if target and target != f:
                imports[f].add(target)
                importers[target].add(f)
    return imports, importers


def _reachable(start: str, edges: dict) -> set:
    """Transitive closure from one node."""
    seen, stack = set(), [start]
    while stack:
        cur = stack.pop()
        for nxt in edges.get(cur, ()):
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return seen


def _sccs(nodes: list, succ: dict) -> list:
    """Tarjan. Returns components in a deterministic order."""
    index, low, on_stack, stack, out = {}, {}, set(), [], []
    counter = [0]

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on_stack.add(v)
        for w in sorted(succ.get(v, ())):
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                comp.append(w)
                if w == v:
                    break
            out.append(sorted(comp))

    sys.setrecursionlimit(max(10000, sys.getrecursionlimit()))
    for v in sorted(nodes):
        if v not in index:
            strong(v)
    return out


def plan(bugs: list, tree: str, *, isolate_hubs: bool = True,
         hub_threshold: int = 8) -> dict:
    units = grouping.group(bugs, 'file')
    by_file = {u['location']['file']: u for u in units}
    files = sorted(by_file)

    imports, importers = import_graph(tree)
    # Depend on a unit if this unit's file transitively imports it. Transitive,
    # not direct: A -> shared -> B still means A should see B's change, and a
    # direct-only rule would schedule them together.
    depends: dict[str, set] = {}
    for f in files:
        reach = _reachable(f, imports)
        depends[f] = {g for g in files if g != f and g in reach}

    succ = {f: set() for f in files}          # dependency -> dependent
    for f in files:
        for d in depends[f]:
            succ[d].add(f)

    comps = _sccs(files, succ)
    comp_of = {f: i for i, c in enumerate(comps) for f in c}
    comp_succ: dict[int, set] = {i: set() for i in range(len(comps))}
    for f in files:
        for g in succ[f]:
            if comp_of[f] != comp_of[g]:
                comp_succ[comp_of[f]].add(comp_of[g])

    # longest-path layering over the condensed DAG
    level = {i: 0 for i in range(len(comps))}
    for _ in range(len(comps)):
        changed = False
        for i in range(len(comps)):
            for j in comp_succ[i]:
                if level[j] < level[i] + 1:
                    level[j] = level[i] + 1
                    changed = True
        if not changed:
            break

    hub_score = {f: len(importers.get(f, ())) for f in files}
    entries = []
    for i, comp in enumerate(comps):
        for f in comp:
            entries.append({
                'unit_id': by_file[f]['bug_id'],
                'file': f,
                'bug_count': len(by_file[f].get('members') or []) or 1,
                'bug_ids': by_file[f].get('member_bug_ids') or [by_file[f]['bug_id']],
                'wave': level[i],
                'depends_on_units': sorted(by_file[g]['bug_id'] for g in depends[f]),
                'imported_by_files': hub_score[f],
                'serial_within_wave': len(comp) > 1,
                'cycle_with': sorted(by_file[g]['bug_id'] for g in comp if g != f),
            })

    # Hub isolation operates on COMPONENTS, never on single units. A cycle means
    # "these mutually depend", so it cannot be ordered -- splitting one across two
    # waves would claim one member can land before the other, which is precisely
    # what the cycle denies. lib/insecurity.ts and models/feedback.ts are such a
    # pair in this target, and an earlier unit-level version of this pass did
    # exactly that and produced a plan that read as two clean solo waves.
    isolated = []
    if isolate_hubs:
        comp_level = {i: level[i] for i in range(len(comps))}
        comp_hub = {i: max((hub_score[f] for f in comps[i]), default=0)
                    for i in range(len(comps))}
        for i in sorted(range(len(comps)),
                        key=lambda k: (comp_level[k], -comp_hub[k])):
            if comp_hub[i] < hub_threshold:
                continue
            if any(comp_level[j] == comp_level[i] for j in range(len(comps)) if j != i):
                for j in range(len(comps)):
                    if comp_level[j] > comp_level[i] or (
                            comp_level[j] == comp_level[i] and j != i):
                        comp_level[j] += 1
            isolated += [by_file[f]['bug_id'] for f in comps[i]]
        for e in entries:
            e['wave'] = comp_level[comp_of[
                next(f for f in files if by_file[f]['bug_id'] == e['unit_id'])]]

    waves = collections.defaultdict(list)
    for e in entries:
        waves[e['wave']].append(e)
    ordered = []
    for w in sorted(waves):
        members = sorted(waves[w], key=lambda e: (-e['bug_count'], e['unit_id']))
        ordered.append({
            'wave': len(ordered),
            'parallel': len(members) > 1 and not any(m['serial_within_wave'] for m in members),
            'units': members,
        })

    n_bugs = sum(e['bug_count'] for e in entries)
    return {
        'plan_id': 'wave-plan/v1',
        'deterministic': ('units from the bug report, edges from real import '
                          'statements, waves from longest-path layering. No model.'),
        'tree': tree,
        'bug_count': n_bugs,
        'unit_count': len(entries),
        'wave_count': len(ordered),
        'max_parallelism': max((len(w['units']) for w in ordered), default=0),
        'isolate_hubs': isolate_hubs,
        'hub_threshold': hub_threshold,
        'hubs_isolated': isolated,
        'critical_path_units': len(ordered),
        'waves': ordered,
    }


def render(p: dict) -> str:
    out = [f"units {p['unit_count']}  bugs {p['bug_count']}  waves {p['wave_count']}"
           f"  max parallel {p['max_parallelism']}"
           f"  isolate_hubs={p['isolate_hubs']} (threshold {p['hub_threshold']})"]
    if p['hubs_isolated']:
        out.append(f"  hubs given their own wave: {', '.join(p['hubs_isolated'])}")
    for w in p['waves']:
        tag = 'parallel' if w['parallel'] else ('serial' if len(w['units']) > 1 else 'alone')
        out.append(f"\n  wave {w['wave']}  ({len(w['units'])} unit(s), {tag})")
        for u in w['units']:
            dep = f"  after {','.join(u['depends_on_units'])}" if u['depends_on_units'] else ''
            cyc = f"  CYCLE with {','.join(u['cycle_with'])}" if u['cycle_with'] else ''
            out.append(f"     {u['unit_id']:32s} {u['bug_count']:2d} bug(s)"
                       f"  imported_by={u['imported_by_files']:3d}{dep}{cyc}")
    return '\n'.join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--bug-report', required=True)
    ap.add_argument('--tree', required=True)
    ap.add_argument('--out')
    ap.add_argument('--no-isolate-hubs', action='store_true')
    ap.add_argument('--hub-threshold', type=int, default=8)
    args = ap.parse_args()

    with open(args.bug_report) as fh:
        br = json.load(fh)
    p = plan(br['bugs'], args.tree,
             isolate_hubs=not args.no_isolate_hubs, hub_threshold=args.hub_threshold)
    print(render(p))
    if args.out:
        with open(args.out, 'w') as fh:
            json.dump(p, fh, indent=1)
        print(f'\nwrote {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
