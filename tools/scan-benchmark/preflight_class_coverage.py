#!/usr/bin/env python3
"""
Pre-flight gate for class narrowing. Answers one question, offline and for free:

    for every ground-truth entry, is its vulnerability class still assigned to
    the lane that owns its file?

    python3 preflight_class_coverage.py \
        --lanes tools/scanner/stage05-lane-selector-perfile/output/lane-assignments.json \
        --answer-key /path/to/answer-key.json

The answer-key path is a REQUIRED argument with no default, deliberately: the path
must not be committed anywhere inside this repository. See
`docs/protocols/blind-development.md`.

## Why this exists

Narrowing a lane's class list is a trade. Removing a class the file cannot exhibit
saves prompt tokens. Removing one it *can* exhibit makes every defect of that class
in that file unfindable — not harder to find, unfindable, because the class is not
in the lane's schema enum and its playbook is never loaded. No amount of model
quality recovers it.

That failure is invisible in a scan: the lane runs, costs tokens, reports nothing,
and looks like a detection miss. This script makes it visible **before** the scan,
by checking the narrowed lane assignments against ground truth directly.

Run it after any change to signal detection or to the signal-to-class table, and
before committing to a scan. Exit code 1 means the narrowing has already capped
recall and the run would be measuring the cap, not the scanner.

## What each failure means

    UNREACHABLE   the file is hunted, but the ground truth's class is not in the
                  lane's class list. The signal that should imply that class did
                  not fire. Fix the detector or the mapping.
    SKIPPED       the file is not hunted at all. A scoping decision, not a
                  narrowing one, but equally fatal to that entry.
    NO LANE       the file is absent from the inventory entirely.
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


def load_code_to_class(path):
    with open(path) as fh:
        registry = json.load(fh)
    return {c: cid for cid, spec in registry.items() for c in spec["codes"]}


def lane_classes(lane, code_to_class):
    """A lane's classes, from the explicit field when narrowing is in effect and
    derived from its codes when it is not, so pre- and post-narrowing assignment
    files both score."""
    declared = lane.get("classes")
    if declared:
        return set(declared)
    return {
        code_to_class[c["code"]]
        for c in lane.get("categories", [])
        if c.get("code") in code_to_class
    }


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--lanes", required=True, help="path to lane-assignments.json")
    ap.add_argument("--answer-key", required=True, help="path to answer-key.json (never commit this path)")
    ap.add_argument("--classes", default=DEFAULT_CLASSES, help="path to vuln-classes.json")
    ap.add_argument("--verbose", action="store_true", help="list every entry, not only failures")
    args = ap.parse_args()

    code_to_class = load_code_to_class(args.classes)
    with open(args.lanes) as fh:
        lanes = json.load(fh)["lanes"]
    with open(args.answer_key) as fh:
        gt = json.load(fh)["benchmark_ground_truth"]

    failures = []
    ok = 0
    signal_gap = Counter()      # which class went missing, and how often
    per_file_gap = defaultdict(set)

    for entry in gt:
        want = {
            code_to_class[c] for c in entry.get("owasp_codes", []) if c in code_to_class
        }
        lane = next((l for l in lanes if file_match(l["target_file"], entry["file"])), None)

        if lane is None:
            failures.append(("NO LANE", entry, want, set()))
            continue
        if lane.get("disposition") != "hunt":
            failures.append(("SKIPPED", entry, want, set()))
            continue

        have = lane_classes(lane, code_to_class)
        if want & have:
            ok += 1
            if args.verbose:
                print(f"  ok         {entry['file']}:{entry['line']}  {sorted(want)}")
        else:
            failures.append(("UNREACHABLE", entry, want, have))
            for cls in want:
                signal_gap[cls] += 1
            per_file_gap[entry["file"]] |= want

    total = len(gt)
    print(f"=== pre-flight class coverage ===")
    print(f"lane file : {args.lanes}")
    print(f"narrowing : {'ON  (lanes carry an explicit classes list)' if any('classes' in l for l in lanes) else 'off (derived from category codes)'}")
    print()
    print(f"reachable   : {ok}/{total}")
    print(f"unreachable : {len(failures)}/{total}")

    if failures:
        print("\n--- every ground-truth entry the narrowing puts out of reach ---")
        for kind, entry, want, have in failures:
            print(f"  [{kind:11s}] {entry['file']}:{entry['line']}")
            print(f"      needs class : {sorted(want)}")
            if kind == "UNREACHABLE":
                print(f"      lane has    : {sorted(have)}")
                print(f"      signals     : {sorted(next((l.get('signals', []) for l in lanes if file_match(l['target_file'], entry['file'])), []))}")

        print("\n--- classes most often missing (fix these detectors or mappings first) ---")
        for cls, n in signal_gap.most_common():
            print(f"  {cls:26s} {n}")

        print(f"\nFAIL — {len(failures)} of {total} ground-truth entries cannot be found by any")
        print("model, because their class is not assigned to their file's lane. A scan run now")
        print("would measure this cap, not the scanner. Fix the detectors or the mapping first.")
        sys.exit(1)

    print("\nPASS — every ground-truth entry's class is assigned to its file's lane.")
    print("Narrowing has not capped recall. Safe to scan.")


if __name__ == "__main__":
    main()
