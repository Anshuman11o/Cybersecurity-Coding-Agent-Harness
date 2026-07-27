#!/usr/bin/env python3
"""
Scores Stage 0 (Recon) on its own terms, separately from whether the scanner
later finds anything.

    python3 score_stage0.py \
        --recon-dir tools/scanner/stage0-recon/output \
        --target-dir target-apps/juice-shop-blind \
        --answer-key /path/to/answer-key.json

The answer-key path is a REQUIRED argument with no default, deliberately: the
path must not be committed anywhere inside this repository. See
`docs/protocols/blind-development.md`.

## Why Stage 0 needs its own score

Recon produces no findings, so the end-to-end recall number says nothing about
whether it did its job. But everything downstream is bounded by it: a file
missing from the inventory is never scanned, a route missing from the route table
is never shown to the lane that handles it, and a signal that fails to fire
removes a whole vulnerability class from a file. Each of those caps the scanner
before a hunting prompt is ever written, and each is invisible in a scan — the
lane runs, costs tokens, reports nothing, and reads as a detection miss.

This scores the four things Stage 0 controls.

## Metrics

    inventory coverage        do the files containing known vulnerabilities
                              appear in the file inventory at all? A file absent
                              here cannot be scanned by anything downstream.

    route table completeness  for ground-truth files that back HTTP routes, is
                              the route present, and does it carry its auth
                              field? The auth column is the evidence a lane needs
                              to judge whether a handler is reachable unprotected.

    category applicability    recon marks each OWASP category present, absent or
                              uncertain. Scored against the categories the
                              benchmark actually exercises. A category the
                              benchmark exercises but recon called absent is the
                              expensive error; the reverse merely costs tokens.

    signal detection          for each ground-truth file, did the signals recon
                              detected imply the class that file's vulnerability
                              belongs to? This is the same question the pre-flight
                              gate asks, scored here per signal so a specific
                              detector can be blamed rather than the stage.

Recall-shaped errors dominate throughout: over-detection costs prompt tokens,
under-detection removes reachability permanently. The two are not symmetric and
this report does not average them together.
"""
import argparse
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import file_match  # noqa: E402

DEFAULT_CLASSES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "scanner", "shared", "vuln-classes.json"
)
DEFAULT_SIGNALS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "scanner", "shared", "signal-classes.json"
)


def pct(n, d):
    return f"{n}/{d} = {n / d * 100:.1f}%" if d else f"{n}/0 = n/a"


def load_json(path):
    with open(path) as fh:
        return json.load(fh)


def score_inventory(arch, gt, lanes):
    """Coverage is measured against the lane assignments, because those are what
    actually gets scanned.

    The architecture summary is NOT the right source: its `by_language` groups
    carry `sample_paths`, a sample rather than a listing, so files genuinely in
    the inventory can be absent from the summary's enumeration. Scoring the
    summary reports coverage failures that do not exist — an early version of
    this script called `routes/chat.ts` and `server.ts` unscanned when both are
    hunt lanes. The summary's enumeration is still reported, as a documentation
    completeness note, clearly separated from coverage."""
    inventory = arch.get("file_inventory") or {}
    enumerated = set()
    for group in inventory.get("unclassified_surface") or []:
        enumerated.update(group.get("files") or [])
    for group in (inventory.get("by_language") or {}).values():
        enumerated.update(group.get("files") or group.get("sample_paths") or [])
    enumerated.update(inventory.get("smart_contract_files") or [])

    gt_files = sorted({e["file"] for e in gt})
    unscanned, skipped = [], []
    for path in gt_files:
        lane = next((l for l in lanes if file_match(l["target_file"], path)), None)
        if lane is None:
            unscanned.append(path)
        elif lane.get("disposition") != "hunt":
            skipped.append((path, lane.get("skip_reason")))

    return {
        "declared_total": inventory.get("total_source_files"),
        "enumerated_in_summary": len(enumerated),
        "lanes_total": len(lanes),
        "gt_files": len(gt_files),
        "gt_files_unscanned": unscanned,
        "gt_files_skipped": skipped,
    }


def score_route_table(arch, gt, target_dir):
    """A ground-truth file is route-backed when one of its exported symbols is a
    handler in the route table. Scored only over those files: a model file that
    backs no route is not a route-table failure."""
    rt = arch.get("route_table") or {}
    hand = rt.get("hand_written_routes") or []
    handlers = defaultdict(list)
    for r in hand:
        h = str(r.get("handler") or "")
        if h:
            handlers[h.split(".")[0]].append(r)
        for m in r.get("middleware") or []:
            for tok in str(m).replace("(", " ").replace(")", " ").replace(",", " ").split():
                handlers[tok.split(".")[0]].append(r)

    import re

    export_re = re.compile(r"export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)")
    route_backed, with_auth_field, missing_auth = 0, 0, []

    for path in sorted({e["file"] for e in gt}):
        full = os.path.join(target_dir, path)
        if not os.path.exists(full):
            continue
        try:
            src = open(full, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        syms = set(export_re.findall(src))
        matched = [r for s in syms for r in handlers.get(s, [])]
        if not matched:
            continue
        route_backed += 1
        if all("auth" in r for r in matched):
            with_auth_field += 1
        else:
            missing_auth.append(path)

    return {
        "hand_written_routes": len(hand),
        "auto_crud_routes": len(rt.get("auto_crud_routes") or []),
        "gt_files_route_backed": route_backed,
        "route_backed_with_auth_field": with_auth_field,
        "missing_auth_field": missing_auth,
    }


def score_applicability(applicability, gt, code_to_class):
    """A code recon never evaluates only caps recall when the entry carrying it
    has no other code that IS evaluated. The benchmark's single LLM07 entry also
    carries LLM01, so it stays reachable; reporting it as a cap would be wrong."""
    verdicts = {}
    for row in applicability:
        name = str(row.get("name", ""))
        code = name.split(":")[0].strip()
        verdicts[code] = row.get("verdict", "unknown")

    exercised = Counter()
    for entry in gt:
        for code in entry.get("owasp_codes", []):
            exercised[code] += 1

    # an entry is capped only if EVERY code it carries is unusable
    usable = {c for c, v in verdicts.items() if v in ("present", "uncertain")}
    capped = []
    for entry in gt:
        codes = set(entry.get("owasp_codes", []))
        if codes and not (codes & usable):
            capped.append((entry["file"], entry["line"], sorted(codes)))

    called_absent, uncertain, correct, not_exercised_present = [], [], 0, 0
    for code, n in exercised.items():
        v = verdicts.get(code, "NOT EVALUATED BY RECON")
        if v == "present":
            correct += 1
        elif v == "uncertain":
            uncertain.append((code, n, v))
        else:
            called_absent.append((code, n, v))
    for code, v in verdicts.items():
        if v == "present" and code not in exercised:
            not_exercised_present += 1

    return {
        "categories_evaluated": len(verdicts),
        "exercised_by_benchmark": len(exercised),
        "exercised_and_called_present": correct,
        "exercised_but_uncertain": uncertain,
        "exercised_but_called_absent": called_absent,
        "present_but_not_exercised": not_exercised_present,
        "entries_capped": capped,
    }


def score_signals(signals, gt, code_to_class, signal_map):
    files = signals.get("files") or {}
    floor = set(signal_map.get("floor") or [])
    sigmap = signal_map.get("signals") or {}

    covered, gaps = 0, []
    blame = Counter()
    for entry in gt:
        want = {code_to_class[c] for c in entry.get("owasp_codes", []) if c in code_to_class}
        key = next((k for k in files if file_match(k, entry["file"])), None)
        if key is None:
            gaps.append((entry["file"], sorted(want), None))
            continue
        detected = files[key]
        implied = set(floor)
        for s in detected:
            implied |= set(sigmap.get(s, []))
        if want & implied:
            covered += 1
        else:
            gaps.append((entry["file"], sorted(want), sorted(detected)))
            for cls in want:
                blame[cls] += 1

    freq = Counter(s for v in files.values() for s in v)
    dead = sorted(set(sigmap) - set(freq))
    return {
        "files_with_signals": sum(1 for v in files.values() if v),
        "files_total": len(files),
        "gt_entries_covered": covered,
        "gt_entries_total": len(gt),
        "gaps": gaps,
        "class_blame": blame,
        "signal_frequency": freq,
        "dead_detectors": dead,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recon-dir", required=True)
    ap.add_argument("--lanes", required=True,
                    help="lane-assignments.json — the authority on what is actually scanned")
    ap.add_argument("--target-dir", required=True)
    ap.add_argument("--answer-key", required=True, help="path to answer-key.json (never commit this path)")
    ap.add_argument("--classes", default=DEFAULT_CLASSES)
    ap.add_argument("--signal-map", default=DEFAULT_SIGNALS)
    ap.add_argument("--json-out")
    args = ap.parse_args()

    arch = load_json(os.path.join(args.recon_dir, "architecture-summary.json"))
    applicability = load_json(os.path.join(args.recon_dir, "category-applicability.json"))
    sig_path = os.path.join(args.recon_dir, "file-signals.json")
    signals = load_json(sig_path) if os.path.exists(sig_path) else {"files": {}}
    gt = load_json(args.answer_key)["benchmark_ground_truth"]
    registry = load_json(args.classes)
    code_to_class = {c: cid for cid, spec in registry.items() for c in spec["codes"]}
    signal_map = load_json(args.signal_map)

    lanes = load_json(args.lanes)["lanes"]
    inv = score_inventory(arch, gt, lanes)
    routes = score_route_table(arch, gt, args.target_dir)
    applic = score_applicability(applicability, gt, code_to_class)
    sigs = score_signals(signals, gt, code_to_class, signal_map)

    print("=== Stage 0 (Recon) eval ===\n")

    print("-- inventory coverage (measured against lane assignments) --")
    print(f"  total_source_files reported        : {inv['declared_total']}")
    print(f"  lanes created                      : {inv['lanes_total']}")
    print(f"  ground-truth files with a hunt lane: "
          f"{pct(inv['gt_files'] - len(inv['gt_files_unscanned']) - len(inv['gt_files_skipped']), inv['gt_files'])}")
    for m in inv["gt_files_unscanned"]:
        print(f"    NO LANE (never scanned): {m}")
    for m, why in inv["gt_files_skipped"]:
        print(f"    SKIPPED: {m}  reason={why}")
    print(f"  enumerated by path in the summary  : {inv['enumerated_in_summary']}"
          f"  (documentation completeness only; by_language lists samples, not listings)")

    print("\n-- route table completeness --")
    print(f"  hand-written routes extracted      : {routes['hand_written_routes']}")
    print(f"  auto-CRUD routes extracted         : {routes['auto_crud_routes']}")
    print(f"  ground-truth files backing a route : {routes['gt_files_route_backed']}")
    print(f"  of those, carrying an auth field   : "
          f"{pct(routes['route_backed_with_auth_field'], routes['gt_files_route_backed'])}")
    for m in routes["missing_auth_field"]:
        print(f"    no auth field: {m}")

    print("\n-- category applicability --")
    print(f"  categories evaluated               : {applic['categories_evaluated']}")
    print(f"  exercised by the benchmark         : {applic['exercised_by_benchmark']}")
    print(f"  of those, called present           : "
          f"{pct(applic['exercised_and_called_present'], applic['exercised_by_benchmark'])}")
    for code, n, v in applic["exercised_but_called_absent"]:
        print(f"    '{v}' but exercised by {n} entries: {code}")
    if applic["entries_capped"]:
        print("    ENTRIES CAPPED (no code they carry is usable):")
        for f, ln, codes in applic["entries_capped"]:
            print(f"      {f}:{ln} {codes}")
    else:
        print("    no entry is capped: every one carries at least one usable code")
    for code, n, v in applic["exercised_but_uncertain"]:
        print(f"    uncertain, exercised by {n} entries: {code}")
    print(f"  called present but not exercised   : {applic['present_but_not_exercised']}"
          f"   (costs tokens, not recall)")

    print("\n-- signal detection --")
    print(f"  files carrying >=1 signal          : {pct(sigs['files_with_signals'], sigs['files_total'])}")
    print(f"  ground-truth entries whose class is implied by their file's signals:")
    print(f"                                       {pct(sigs['gt_entries_covered'], sigs['gt_entries_total'])}")
    if sigs["dead_detectors"]:
        print(f"  DETECTORS THAT NEVER FIRED         : {', '.join(sigs['dead_detectors'])}")
        print(f"    a detector that never fires is broken or its files are all skipped")
    if sigs["gaps"]:
        print("  gaps (class not implied by any detected signal):")
        for path, want, detected in sigs["gaps"]:
            print(f"    {path}  needs {want}  detected {detected}")
        print("  classes most often unreachable:")
        for cls, n in sigs["class_blame"].most_common():
            print(f"    {cls:26s} {n}")
    print("\n  signal frequency:")
    for s, n in sigs["signal_frequency"].most_common():
        print(f"    {s:16s} {n}")

    if args.json_out:
        blob = {
            "inventory": inv,
            "route_table": routes,
            "category_applicability": applic,
            "signals": {
                k: (dict(v) if isinstance(v, Counter) else v)
                for k, v in sigs.items()
            },
        }
        with open(args.json_out, "w") as fh:
            json.dump(blob, fh, indent=2)
        print(f"\nwrote {args.json_out}")


if __name__ == "__main__":
    main()
