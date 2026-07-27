#!/usr/bin/env python3
"""
Scores this harness's own scanner output (`candidate-findings.json` from a hunt-lane
stage, or `validated-findings.json` from Stage 3) against the hand-verified ground
truth.

    python3 score_scanner.py \
        --findings tools/scanner/stage2-hunt-lanes-perfile/output/candidate-findings.json \
        --answer-key /path/to/answer-key.json \
        --label stage2-v2-perfile

The answer-key path is a REQUIRED argument with no default, deliberately: the
path must not be committed anywhere inside this repository. See
`docs/protocols/blind-development.md`.

Distinct from `score.py`, which scores *third-party* tools in the five-tool
benchmark and normalizes their many native output formats. This script knows one
format — ours — and in exchange reports the class-model metrics that only make
sense for a scanner that emits vulnerability classes.

## Metrics

    recall            file match + line within RECALL_SLACK + category intersection
    localization      file match + line within LOCALIZATION_SLACK + category intersection
    precision proxy   findings landing within LOCALIZATION_SLACK of any ground-truth
                      entry; reported category-blind and category-aware
    per-class recall  recall broken down by vulnerability class, so a gap points at
                      one playbook rather than at "the scanner"
    hedging rate      mean classes and codes emitted per finding

## Hedging rate — why it is not optional

Findings may name up to two classes, and `categories` carries the union of those
classes' alias codes. That makes category intersection easier by construction, so a
recall improvement is only interpretable next to how many labels were spent earning
it. Before the class model, every finding emitted exactly one code (mean 1.00). A
recall jump with a flat hedging rate is real; a recall jump that tracks the hedging
rate is a wider net.

## --alias-expand

Expands both sides to their classes' full alias code sets before intersecting, so a
finding labelled `API1` scores identically to one labelled `A01`. Use it to re-score
a run that predates the class model, which is the only way to compare it fairly
against one that postdates it — otherwise the improvement from consistent labelling
is indistinguishable from the improvement in detection.
"""
import argparse
import json
import os
import re
import statistics
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import LINE_SLACK, file_match  # noqa: E402

RECALL_SLACK = 0
LOCALIZATION_SLACK = LINE_SLACK

CODE_RE = re.compile(r"\b(?:A0[1-9]|A10|API[1-9]0?|LLM0[1-9]|LLM10)\b")

DEFAULT_CLASSES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "scanner", "shared", "vuln-classes.json"
)

# A run whose findings mostly yield no OWASP code is a schema fault, not a bad scan.
# Scoring it would report a collapse that reads like a reasoning regression.
MIN_CODE_EXTRACTION_RATE = 0.95


def load_classes(path):
    with open(path) as fh:
        registry = json.load(fh)
    class_codes = {cid: list(spec["codes"]) for cid, spec in registry.items()}
    code_to_class = {c: cid for cid, codes in class_codes.items() for c in codes}
    return class_codes, code_to_class


def expand_aliases(codes, class_codes, code_to_class):
    """Widen a code set to every alias of every class it touches."""
    out = set()
    for code in codes:
        cid = code_to_class.get(code)
        out |= set(class_codes[cid]) if cid else {code}
    return out


def load_ground_truth(path):
    with open(path) as fh:
        raw = json.load(fh)
    return [
        {
            "key": e["challengeKey"],
            "file": e["file"],
            "line": e["line"],
            "codes": set(e.get("owasp_codes", [])),
        }
        for e in raw["benchmark_ground_truth"]
    ]


def load_findings(path):
    with open(path) as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        for key in ("findings", "candidate_findings", "validated_findings"):
            if key in data:
                data = data[key]
                break
    if not isinstance(data, list):
        sys.exit(f"error: could not find a findings array in {path}")
    return data


def extract_codes(finding):
    codes = set()
    for cat in finding.get("categories", []):
        codes |= set(CODE_RE.findall(str(cat)))
    return codes


def finding_classes(finding, code_to_class):
    """Class ids for a finding, from the explicit field when present and derived
    from its codes when scoring a run that predates the class model."""
    declared = finding.get("finding_classes")
    if declared:
        out = []
        for entry in declared:
            cid = entry.get("class") if isinstance(entry, dict) else entry
            if cid:
                out.append(cid)
        if out:
            return out
    return sorted({code_to_class[c] for c in extract_codes(finding) if c in code_to_class})


def check_code_extraction(findings):
    """`categories` must hold OWASP codes, never class ids. If a schema change ever
    puts class ids there, every intersection silently empties and the run reports a
    total collapse. Fail loudly instead."""
    if not findings:
        sys.exit("error: no findings to score")
    with_codes = sum(1 for f in findings if extract_codes(f))
    rate = with_codes / len(findings)
    if rate < MIN_CODE_EXTRACTION_RATE:
        sample = next((f.get("categories") for f in findings if not extract_codes(f)), None)
        sys.exit(
            f"error: only {with_codes}/{len(findings)} findings ({rate:.1%}) yield an OWASP "
            f"code from `categories`; the floor is {MIN_CODE_EXTRACTION_RATE:.0%}.\n"
            f"`categories` must contain code strings such as \"A01\", not class ids.\n"
            f"first offending value: {sample!r}"
        )
    return rate


def score(findings, gt, class_codes, code_to_class, alias_expand):
    def codes_of(finding):
        codes = extract_codes(finding)
        return expand_aliases(codes, class_codes, code_to_class) if alias_expand else codes

    def gt_codes_of(entry):
        return (
            expand_aliases(entry["codes"], class_codes, code_to_class)
            if alias_expand
            else entry["codes"]
        )

    per_gt = {}
    hit_finding_ids = set()          # any distance, category-blind
    localized_finding_ids = set()    # within slack, category-blind
    matched_finding_ids = set()      # within slack AND category

    for entry in gt:
        want = gt_codes_of(entry)
        hits = []
        for finding in findings:
            best = None
            for step in finding.get("trace", []):
                if not file_match(step.get("file", ""), entry["file"]):
                    continue
                line = step.get("line")
                delta = abs(line - entry["line"]) if line is not None else None
                if best is None or (delta is not None and (best is None or best[0] is None or delta < best[0])):
                    best = (delta, line)
            if best is None:
                continue
            delta = best[0]
            category_match = bool(codes_of(finding) & want)
            fid = finding.get("finding_id")
            hit_finding_ids.add(fid)
            if delta is not None and delta <= LOCALIZATION_SLACK:
                localized_finding_ids.add(fid)
                if category_match:
                    matched_finding_ids.add(fid)
            hits.append({"delta": delta, "category_match": category_match})

        recall_ok = any(
            h["delta"] is not None and h["delta"] <= RECALL_SLACK and h["category_match"] for h in hits
        )
        localized_ok = any(
            h["delta"] is not None and h["delta"] <= LOCALIZATION_SLACK and h["category_match"] for h in hits
        )
        localized_blind = any(
            h["delta"] is not None and h["delta"] <= LOCALIZATION_SLACK for h in hits
        )
        recall_blind = any(h["delta"] is not None and h["delta"] <= RECALL_SLACK for h in hits)
        per_gt[entry["key"]] = {
            "classes": sorted({code_to_class[c] for c in entry["codes"] if c in code_to_class}),
            "recall": recall_ok,
            "recall_category_blind": recall_blind,
            "localized": localized_ok,
            "localized_category_blind": localized_blind,
            "any_file_hit": bool(hits),
        }

    total = len(gt)
    recall_n = sum(1 for v in per_gt.values() if v["recall"])
    recall_blind_n = sum(1 for v in per_gt.values() if v["recall_category_blind"])
    local_n = sum(1 for v in per_gt.values() if v["localized"])
    local_blind_n = sum(1 for v in per_gt.values() if v["localized_category_blind"])
    file_n = sum(1 for v in per_gt.values() if v["any_file_hit"])

    # Per-class recall. A ground-truth entry spanning two classes counts toward both:
    # either playbook finding it is a success for that playbook.
    per_class = defaultdict(lambda: {"total": 0, "recall": 0, "localized": 0})
    for verdict in per_gt.values():
        for cid in verdict["classes"] or ["<unmapped>"]:
            per_class[cid]["total"] += 1
            per_class[cid]["recall"] += int(verdict["recall"])
            per_class[cid]["localized"] += int(verdict["localized"])

    n = len(findings)
    class_counts = [len(finding_classes(f, code_to_class)) for f in findings]
    code_counts = [len(extract_codes(f)) for f in findings]

    return {
        "ground_truth_entries": total,
        "findings_total": n,
        "recall": {"hits": recall_n, "total": total, "pct": round(recall_n / total * 100, 1)},
        "recall_category_blind": {
            "hits": recall_blind_n,
            "total": total,
            "pct": round(recall_blind_n / total * 100, 1),
        },
        "localization": {"hits": local_n, "total": total, "pct": round(local_n / total * 100, 1)},
        "localization_category_blind": {
            "hits": local_blind_n,
            "total": total,
            "pct": round(local_blind_n / total * 100, 1),
        },
        "file_level": {"hits": file_n, "total": total, "pct": round(file_n / total * 100, 1)},
        "precision_proxy": {
            "category_blind": round(len(localized_finding_ids) / n * 100, 1) if n else 0.0,
            "category_aware": round(len(matched_finding_ids) / n * 100, 1) if n else 0.0,
            "localized_findings": len(localized_finding_ids),
            "category_matched_findings": len(matched_finding_ids),
        },
        "hedging": {
            "mean_classes_per_finding": round(statistics.mean(class_counts), 3) if class_counts else 0.0,
            "max_classes_per_finding": max(class_counts) if class_counts else 0,
            "class_count_distribution": dict(sorted(Counter(class_counts).items())),
            "mean_codes_per_finding": round(statistics.mean(code_counts), 3) if code_counts else 0.0,
            "multi_class_findings": sum(1 for c in class_counts if c > 1),
        },
        "per_class_recall": {
            cid: {
                "total": v["total"],
                "recall": v["recall"],
                "localized": v["localized"],
                "recall_pct": round(v["recall"] / v["total"] * 100, 1),
            }
            for cid, v in sorted(per_class.items())
        },
        "class_distribution": dict(
            Counter(cid for f in findings for cid in finding_classes(f, code_to_class)).most_common()
        ),
    }


def render(result, args, extraction_rate):
    r = result
    print(f"=== scanner eval — {args.label or os.path.basename(args.findings)} ===")
    print(f"alias expansion: {'ON (comparability mode)' if args.alias_expand else 'off'}")
    print(f"ground truth: {r['ground_truth_entries']} entries | findings: {r['findings_total']}")
    print(f"code-extraction rate: {extraction_rate:.1%}\n")

    print(f"Recall        (file + <={RECALL_SLACK} line + category) : "
          f"{r['recall']['hits']}/{r['recall']['total']} = {r['recall']['pct']}%")
    print(f"  category-blind equivalent                : "
          f"{r['recall_category_blind']['hits']}/{r['recall_category_blind']['total']} "
          f"= {r['recall_category_blind']['pct']}%  <- ceiling if category never mismatched")
    print(f"Localization  (file + <={LOCALIZATION_SLACK} lines + category): "
          f"{r['localization']['hits']}/{r['localization']['total']} = {r['localization']['pct']}%")
    print(f"  category-blind equivalent                : "
          f"{r['localization_category_blind']['hits']}/{r['localization_category_blind']['total']} "
          f"= {r['localization_category_blind']['pct']}%  <- ceiling if category never mismatched")
    print(f"File-level    (any line, any category)     : "
          f"{r['file_level']['hits']}/{r['file_level']['total']} = {r['file_level']['pct']}%")

    p = r["precision_proxy"]
    print(f"\nPrecision proxy  category-blind: {p['category_blind']}%  "
          f"({p['localized_findings']}/{r['findings_total']} findings)")
    print(f"                 category-aware: {p['category_aware']}%  "
          f"({p['category_matched_findings']}/{r['findings_total']} findings)")

    h = r["hedging"]
    print(f"\nHedging rate   mean classes/finding: {h['mean_classes_per_finding']}  "
          f"(max {h['max_classes_per_finding']}, multi-class {h['multi_class_findings']})")
    print(f"               mean codes/finding  : {h['mean_codes_per_finding']}")
    print(f"               distribution        : {h['class_count_distribution']}")
    print("               baseline before the class model was 1.000 classes/finding; a recall")
    print("               gain that tracks this number is a wider net, not better detection.")

    print("\nPer-class recall (ground-truth entries by class):")
    print(f"  {'class':26s} {'recall':>12s} {'localized':>12s}")
    for cid, v in r["per_class_recall"].items():
        print(f"  {cid:26s} {v['recall']:>5d}/{v['total']:<6d} {v['localized']:>5d}/{v['total']:<6d}"
              f"  {v['recall_pct']:>5.1f}%")

    print("\nFindings emitted per class:")
    for cid, count in r["class_distribution"].items():
        print(f"  {cid:26s} {count}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--findings", required=True, help="path to candidate-findings.json / validated-findings.json")
    ap.add_argument("--answer-key", required=True, help="path to answer-key.json (never commit this path)")
    ap.add_argument("--classes", default=DEFAULT_CLASSES, help="path to vuln-classes.json")
    ap.add_argument("--alias-expand", action="store_true",
                    help="expand both sides to full class alias sets before intersecting")
    ap.add_argument("--label", help="run label for the report header and the JSON record")
    ap.add_argument("--json-out", help="write the metrics block here for eval-history")
    args = ap.parse_args()

    class_codes, code_to_class = load_classes(args.classes)
    gt = load_ground_truth(args.answer_key)
    findings = load_findings(args.findings)

    extraction_rate = check_code_extraction(findings)
    result = score(findings, gt, class_codes, code_to_class, args.alias_expand)
    result["alias_expand"] = args.alias_expand
    result["code_extraction_rate"] = round(extraction_rate, 4)

    render(result, args, extraction_rate)

    if args.json_out:
        with open(args.json_out, "w") as fh:
            json.dump(result, fh, indent=2)
        print(f"\nwrote {args.json_out}")


if __name__ == "__main__":
    main()
