#!/usr/bin/env python3
"""
Scores each scanned tool's findings against the hand-verified ground-truth
subset in answer-key.json's `benchmark_ground_truth` array.

Usage:
    python3 score.py --answer-key /path/to/answer-key.json --raw-dir results/raw --out results/scan-benchmark-summary.md

Each tool gets its own adapter function that reads its native output format
(whatever it produced -- JSON, SARIF, or Markdown) into a common normalized
finding shape: {file, line, title, description}. `line` may be None if the
tool didn't give one; such findings can still count as a (loose) file-level
hit but never a localization hit.

Scope: per the benchmark brief, only findings whose file matches one of the
10 ground-truth files are scored (a tool's real, additional findings
elsewhere in the app are noted in the raw counts but excluded from
precision/recall/localization -- this keeps the scored comparison to the
small, hand-verified subset, not judgment calls about the rest of the app).
"""
import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field

LINE_SLACK = 15  # "a few lines of slack" per the kickoff brief


@dataclass
class Finding:
    file: str
    line: int | None
    title: str
    description: str = ""


@dataclass
class GroundTruthEntry:
    challengeKey: str
    category: str
    file: str
    line: int
    solveCondition: str
    referenceCorrectFix: str
    exploitTest: str


def normalize_path(p: str) -> str:
    """Strip common working-copy root prefixes and normalize separators so
    findings reported with absolute paths, ./ prefixes, or a different repo
    root still compare equal to the ground truth's repo-relative paths."""
    p = p.strip().replace("\\", "/")
    # strip a leading URI scheme fragment some tools include (file://)
    p = re.sub(r"^file://", "", p)
    for root in ("/tmp/juice-shop-work/", "/tmp/juice-shop-test/", "./", "juice-shop-work/"):
        if p.startswith(root):
            p = p[len(root):]
    p = p.lstrip("/")
    return p


def file_match(finding_file: str, gt_file: str) -> bool:
    a = normalize_path(finding_file)
    b = normalize_path(gt_file)
    if not a:
        return False
    return a == b or a.endswith("/" + b) or b.endswith("/" + a)


def load_ground_truth(answer_key_path: str) -> list[GroundTruthEntry]:
    with open(answer_key_path) as f:
        d = json.load(f)
    entries = []
    for e in d["benchmark_ground_truth"]:
        entries.append(GroundTruthEntry(
            challengeKey=e["challengeKey"], category=e["category"], file=e["file"],
            line=e["line"], solveCondition=e["solveCondition"],
            referenceCorrectFix=e["referenceCorrectFix"], exploitTest=e["exploitTest"],
        ))
    return entries


def score_tool(tool_name: str, findings: list[Finding], ground_truth: list[GroundTruthEntry]) -> dict:
    in_scope = [f for f in findings if any(file_match(f.file, g.file) for g in ground_truth)]
    out_of_scope_count = len(findings) - len(in_scope)

    file_hits = {}   # gt.challengeKey -> list of matching findings (file-level)
    line_hits = set()  # gt.challengeKey with a line-level (localized) match

    for g in ground_truth:
        matches = [f for f in in_scope if file_match(f.file, g.file)]
        if matches:
            file_hits[g.challengeKey] = matches
            for m in matches:
                if m.line is not None and abs(m.line - g.line) <= LINE_SLACK:
                    line_hits.add(g.challengeKey)
                    break

    # An in-scope finding counts toward precision's numerator if it matches
    # *some* ground-truth file (regardless of line closeness -- line
    # closeness is what "localization" measures separately).
    matched_finding_ids = set()
    for g in ground_truth:
        for f in in_scope:
            if file_match(f.file, g.file):
                matched_finding_ids.add(id(f))

    precision = (len(matched_finding_ids) / len(in_scope)) if in_scope else None
    recall = len(file_hits) / len(ground_truth)
    localization = (len(line_hits) / len(file_hits)) if file_hits else None
    false_positive_in_scope = len(in_scope) - len(matched_finding_ids)

    return {
        "tool": tool_name,
        "total_findings": len(findings),
        "in_scope_findings": len(in_scope),
        "out_of_scope_findings": out_of_scope_count,
        "recall_hits": sorted(file_hits.keys()),
        "recall": recall,
        "localization_hits": sorted(line_hits),
        "localization": localization,
        "precision": precision,
        "false_positives_in_scope": false_positive_in_scope,
        "missed": sorted(g.challengeKey for g in ground_truth if g.challengeKey not in file_hits),
    }


def fmt_pct(x):
    return "n/a" if x is None else f"{x*100:.0f}%"


def render_markdown(results: list[dict], ground_truth: list[GroundTruthEntry], notes: dict) -> str:
    lines = []
    lines.append("# Scan-only benchmark: 5 harnesses vs. 10 hand-verified Juice Shop challenges\n")
    lines.append(f"Ground truth: `benchmark_ground_truth` in answer-key.json, {len(ground_truth)} challenges "
                  "spanning distinct OWASP categories. Scoring matches findings to ground truth by file + "
                  f"line proximity (±{LINE_SLACK} lines). Only findings whose file matches one of the 10 "
                  "ground-truth files count toward precision/recall/localization; a tool's other real findings "
                  "elsewhere in the app are noted in raw counts but out of scope for this comparison.\n")

    lines.append("## Summary table\n")
    lines.append("| Tool | Findings (in-scope / total) | Precision | Recall | Localization | False positives (in-scope) |")
    lines.append("|---|---|---|---|---|---|")
    for r in results:
        lines.append(
            f"| {r['tool']} | {r['in_scope_findings']} / {r['total_findings']} | "
            f"{fmt_pct(r['precision'])} | {fmt_pct(r['recall'])} ({len(r['recall_hits'])}/{len(ground_truth)}) | "
            f"{fmt_pct(r['localization'])} | {r['false_positives_in_scope']} |"
        )
    lines.append("")

    lines.append("## Per-tool detail\n")
    for r in results:
        lines.append(f"### {r['tool']}\n")
        if r["tool"] in notes:
            lines.append(notes[r["tool"]] + "\n")
        lines.append(f"- Total findings reported: {r['total_findings']}")
        lines.append(f"- In-scope findings (file matches a ground-truth challenge): {r['in_scope_findings']}")
        lines.append(f"- Out-of-scope findings (real app, not in the 10-challenge subset): {r['out_of_scope_findings']}")
        lines.append(f"- Ground-truth challenges found (file-level): {', '.join(r['recall_hits']) or 'none'}")
        lines.append(f"- Ground-truth challenges precisely localized (±{LINE_SLACK} lines): {', '.join(r['localization_hits']) or 'none'}")
        lines.append(f"- Ground-truth challenges missed entirely: {', '.join(r['missed']) or 'none'}")
        lines.append("")

    lines.append("## Ground truth reference\n")
    lines.append("| challengeKey | category | file:line |")
    lines.append("|---|---|---|")
    for g in ground_truth:
        lines.append(f"| {g.challengeKey} | {g.category} | `{g.file}:{g.line}` |")
    lines.append("")

    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--answer-key", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    ground_truth = load_ground_truth(args.answer_key)
    print(f"Loaded {len(ground_truth)} ground-truth entries", file=sys.stderr)
    # Per-tool adapters are imported and invoked from run_scoring.py, which
    # builds the `results` list and `notes` dict and calls render_markdown.
