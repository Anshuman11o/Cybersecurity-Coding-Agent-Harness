#!/usr/bin/env python3
"""
Usage Aggregator — Predicted vs Actual token consumption comparison.

Reads per-lane usage records from an output directory's usage/ subdirectory
and produces a predicted-vs-actual comparison report.

Usage:
    python3 usage-aggregator.py <output-dir>
    python3 usage-aggregator.py --help

The output directory should contain a usage/ subdirectory with per-lane
JSON files (written by usage-tracker.ts emitLaneUsage).
"""

import argparse
import json
import os
import sys


def aggregate_usage(output_dir):
    usage_dir = os.path.join(output_dir, "usage")
    if not os.path.exists(usage_dir):
        return {
            "generatedAt": "N/A (no usage directory found)",
            "totalLanes": 0,
            "completedLanes": 0,
            "skippedLanes": 0,
            "failedLanes": 0,
            "predictedNarrowTotal": 0,
            "actualInputTotal": 0,
            "actualOutputTotal": 0,
            "actualTotalTokens": 0,
            "totalWallClockSeconds": 0,
            "inputAccuracy": None,
            "outputAccuracy": None,
            "totalAccuracy": None,
            "overBudgetLanes": 0,
            "underBudgetLanes": 0,
            "bucketBreakdown": [],
            "lanes": [],
        }

    lanes = []
    for fname in sorted(os.listdir(usage_dir)):
        if fname.endswith(".json"):
            fpath = os.path.join(usage_dir, fname)
            with open(fpath) as f:
                lanes.append(json.load(f))

    lanes.sort(key=lambda l: l["laneId"])

    completed = [l for l in lanes if l.get("completedAt") is not None]
    skipped = [l for l in lanes if l.get("sizeBucket") == "skip"]
    failed = [l for l in completed if l.get("actualTotalTokens") is None]
    successful = [l for l in completed if l.get("actualTotalTokens") is not None]

    actual_input = sum(l.get("actualInputTokens") or 0 for l in successful)
    actual_output = sum(l.get("actualOutputTokens") or 0 for l in successful)
    actual_total = sum(l.get("actualTotalTokens") or 0 for l in successful)
    total_wall = sum(l.get("wallClockSeconds") or 0 for l in successful)

    predicted_total = sum(l.get("predictedTotalTokens", 0) for l in successful)
    predicted_input = sum(l.get("predictedInputTokens", 0) for l in successful)
    predicted_output = sum(l.get("predictedOutputTokens", 0) for l in successful)
    predicted_narrow_all = sum(l.get("predictedTotalTokens", 0) for l in lanes)

    input_acc = actual_input / predicted_input if predicted_input > 0 else None
    output_acc = actual_output / predicted_output if predicted_output > 0 else None
    total_acc = actual_total / predicted_total if predicted_total > 0 else None

    over = sum(1 for l in successful if (l.get("actualTotalTokens") or 0) > l.get("predictedTotalTokens", 0))
    under = sum(1 for l in successful if (l.get("actualTotalTokens") or 0) <= l.get("predictedTotalTokens", 0))

    bucket_map = {}
    for l in successful:
        bucket = l.get("sizeBucket", "unknown")
        bucket_map.setdefault(bucket, []).append(l)

    bucket_breakdown = []
    for bucket, blanes in sorted(bucket_map.items()):
        b_pred = sum(l.get("predictedTotalTokens", 0) for l in blanes)
        b_actual = sum(l.get("actualTotalTokens") or 0 for l in blanes)
        b_acc = b_actual / b_pred if b_pred > 0 else None
        b_wall = sum(l.get("wallClockSeconds") or 0 for l in blanes)
        b_avg_wall = b_wall / len(blanes) if blanes else None
        bucket_breakdown.append({
            "bucket": bucket,
            "laneCount": len(blanes),
            "predictedTotal": b_pred,
            "actualTotal": b_actual,
            "accuracy": b_acc,
            "avgWallClockSeconds": b_avg_wall,
        })

    return {
        "generatedAt": "aggregated at runtime",
        "totalLanes": len(lanes),
        "completedLanes": len(completed),
        "skippedLanes": len(skipped),
        "failedLanes": len(failed),
        "predictedNarrowTotal": predicted_narrow_all,
        "actualInputTotal": actual_input,
        "actualOutputTotal": actual_output,
        "actualTotalTokens": actual_total,
        "totalWallClockSeconds": total_wall,
        "inputAccuracy": input_acc,
        "outputAccuracy": output_acc,
        "totalAccuracy": total_acc,
        "overBudgetLanes": over,
        "underBudgetLanes": under,
        "bucketBreakdown": bucket_breakdown,
        "lanes": lanes,
    }


def format_report(agg):
    lines = []
    lines.append("=" * 80)
    lines.append("USAGE TRACKER -- Predicted vs Actual Token Consumption")
    lines.append("=" * 80)
    lines.append("")
    lines.append("Generated: {}".format(agg["generatedAt"]))
    lines.append("Total lanes:       {}".format(agg["totalLanes"]))
    lines.append("Completed:         {}".format(agg["completedLanes"]))
    lines.append("Skipped:           {}".format(agg["skippedLanes"]))
    lines.append("Failed:            {}".format(agg["failedLanes"]))
    lines.append("")
    lines.append("PREDICTED vs ACTUAL")
    lines.append("-" * 80)
    lines.append("  Predicted (NARROW): {:>12,} tokens".format(agg["predictedNarrowTotal"]))
    lines.append("")
    lines.append("  Actual input:       {:>12,} tokens".format(agg["actualInputTotal"]))
    lines.append("  Actual output:      {:>12,} tokens".format(agg["actualOutputTotal"]))
    lines.append("  Actual total:       {:>12,} tokens".format(agg["actualTotalTokens"]))
    lines.append("  Wall clock:         {:>12.1f}s".format(agg["totalWallClockSeconds"]))
    lines.append("")

    if agg["totalAccuracy"] is not None:
        lines.append("  Accuracy (total):   {:.1f}% of predicted".format(agg["totalAccuracy"] * 100))
        if agg["inputAccuracy"] is not None:
            lines.append("  Accuracy (input):   {:.1f}% of predicted".format(agg["inputAccuracy"] * 100))
        if agg["outputAccuracy"] is not None:
            lines.append("  Accuracy (output):  {:.1f}% of predicted".format(agg["outputAccuracy"] * 100))
        lines.append("")
        lines.append("  Over budget lanes:  {}".format(agg["overBudgetLanes"]))
        lines.append("  Under budget lanes: {}".format(agg["underBudgetLanes"]))
    else:
        lines.append("  No completed lanes yet -- accuracy cannot be computed.")

    lines.append("")
    lines.append("PER-BUCKET BREAKDOWN")
    lines.append("-" * 80)
    lines.append("{:<20} {:>5} {:>12} {:>12} {:>10} {:>12}".format(
        "Bucket", "Lanes", "Predicted", "Actual", "Accuracy", "Avg Wall(s)"))
    lines.append("-" * 80)

    for b in agg["bucketBreakdown"]:
        acc = "{:.1f}%".format(b["accuracy"] * 100) if b["accuracy"] is not None else "N/A"
        wall = "{:.1f}".format(b["avgWallClockSeconds"]) if b["avgWallClockSeconds"] is not None else "N/A"
        lines.append("{:<20} {:>5} {:>12,} {:>12,} {:>10} {:>12}".format(
            b["bucket"], b["laneCount"], b["predictedTotal"], b["actualTotal"], acc, wall))

    lines.append("")
    lines.append("=" * 80)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Usage aggregator for v2 per-file lanes")
    parser.add_argument("output_dir", help="Stage 2 output directory (contains usage/ subdirectory)")
    parser.add_argument("--output", default=None, help="Write report to file instead of stdout")
    args = parser.parse_args()

    agg = aggregate_usage(args.output_dir)
    report = format_report(agg)

    if args.output:
        d = os.path.dirname(os.path.abspath(args.output))
        os.makedirs(d, exist_ok=True)
        with open(args.output, 'w') as f:
            f.write(report)
        print("Report written to " + args.output)
    else:
        print(report)

    # JSON output
    json_path = os.path.join(args.output_dir, "usage-aggregate.json")
    with open(json_path, 'w') as f:
        json.dump(agg, f, indent=2)
    print("JSON aggregate written to " + json_path)


if __name__ == "__main__":
    main()
