#!/usr/bin/env python3
"""
Per-file lane token cost model for v2 scanner architecture.

Computes predicted token usage for the "one lane per file" architecture,
bucketed by file size, with separate NARROW (evidence-driven categories)
and BROAD (full category universe) scenarios.

Usage:
    python3 cost-model.py --target-dir <path> --arch-summary <path>

Requires: Python 3.7+ (standard library only).
"""

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional

TOKENS_PER_PROMPT_BYTE = 0.342
AVG_PLAYBOOK_BYTES = 2263
FIXED_OVERHEAD_BYTES = 3060
AVG_OUTPUT_TOKENS_PER_FINDING = 1389
AVG_FINDINGS_PER_LANE = 2.7
SINGLE_PASS_LINE_BUDGET = 500
CHUNK_OVERLAP_LINES = 20
BYTES_PER_LINE = 40

SKIP_EXTENSIONS = {
    '.yaml', '.yml', '.json', '.html', '.htm', '.css', '.scss', '.sass',
    '.less', '.xml', '.md', '.markdown', '.txt', '.csv', '.toml', '.ini',
    '.cfg', '.dockerignore', '.gitignore', '.editorconfig',
}
SPECIAL_SKIP_NAMES = {'Dockerfile', 'Makefile', 'LICENSE', '.gitignore',
                      '.dockerignore', '.editorconfig'}

@dataclass
class FileInfo:
    rel_path: str
    size_bytes: int
    language: str
    line_count: int = 0
    is_skip: bool = False

@dataclass
class SizeBucket:
    label: str
    min_bytes: int
    max_bytes: float
    file_count: int = 0
    hunt_count: int = 0
    skip_count: int = 0
    total_hunt_bytes: int = 0
    total_skip_bytes: int = 0
    total_input_tokens: float = 0.0
    total_output_tokens: float = 0.0
    total_chunk_overhead_tokens: float = 0.0

@dataclass
class CostModelResult:
    buckets: List[SizeBucket]
    total_files: int
    total_hunt_files: int
    total_skip_files: int
    scenario_narrow_tokens: float
    scenario_broad_tokens: float
    narrow_breakdown: Dict[str, float]
    broad_breakdown: Dict[str, float]
    skip_savings_tokens: float
    category_universe_count: int = 0
    narrow_categories_per_file: float = 0.0

def estimate_lines(size_bytes):
    return max(1, size_bytes // BYTES_PER_LINE)

def estimate_chunks(line_count, single_pass_budget):
    if line_count <= single_pass_budget:
        return 1
    effective = single_pass_budget - CHUNK_OVERLAP_LINES
    return math.ceil((line_count - single_pass_budget) / effective) + 1

def estimate_seed_prompt_bytes(file_size, line_count, single_pass_budget):
    if line_count <= 0:
        return 0
    chunks = estimate_chunks(line_count, single_pass_budget)
    if chunks <= 1:
        numbered_bytes = file_size + (line_count * 6)
        return numbered_bytes + 10
    else:
        total_bytes = 0
        for i in range(chunks):
            if i == 0:
                chunk_lines = single_pass_budget
            elif i == chunks - 1:
                remaining = line_count - (i - 1) * (single_pass_budget - CHUNK_OVERLAP_LINES) - CHUNK_OVERLAP_LINES
                chunk_lines = max(1, remaining)
            else:
                chunk_lines = single_pass_budget
            chunk_bytes = chunk_lines * BYTES_PER_LINE
            numbered = chunk_bytes + (chunk_lines * 6)
            total_bytes += numbered + 10
        return total_bytes

def estimate_category_prompt_bytes(num_categories):
    if num_categories <= 0:
        return 0
    return num_categories * AVG_PLAYBOOK_BYTES

def compute_bucket_boundaries(file_sizes):
    if not file_sizes:
        return [
            ("under 2 KB", 0, 2048),
            ("2-8 KB", 2048, 8192),
            ("8-20 KB", 8192, 20480),
            ("20-50 KB", 20480, 51200),
            ("over 50 KB", 51200, float('inf')),
        ]
    sizes = sorted(file_sizes)
    n = len(sizes)
    p25 = sizes[int(n * 0.25)]
    p50 = sizes[int(n * 0.50)]
    p75 = sizes[int(n * 0.75)]
    p90 = sizes[int(n * 0.90)]
    def round_up_kb(v):
        return int(math.ceil(v / 1024) * 1024)
    return [
        ("under {} KB".format(round_up_kb(p25) // 1024), 0, round_up_kb(p25)),
        ("{}-{} KB".format(round_up_kb(p25) // 1024, round_up_kb(p50) // 1024), round_up_kb(p25), round_up_kb(p50)),
        ("{}-{} KB".format(round_up_kb(p50) // 1024, round_up_kb(p75) // 1024), round_up_kb(p50), round_up_kb(p75)),
        ("{}-{} KB".format(round_up_kb(p75) // 1024, round_up_kb(p90) // 1024), round_up_kb(p75), round_up_kb(p90)),
        ("over {} KB".format(round_up_kb(p90) // 1024), round_up_kb(p90), float('inf')),
    ]

def classify_language(ext):
    ext_map = {
        '.ts': 'typescript', '.tsx': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.rb': 'ruby', '.go': 'go',
        '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
        '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
        '.cs': 'csharp', '.php': 'php', '.swift': 'swift',
        '.sol': 'solidity',
        '.html': 'html', '.htm': 'html',
        '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
        '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
        '.xml': 'xml', '.md': 'markdown', '.markdown': 'markdown',
        '.txt': 'txt', '.toml': 'toml', '.ini': 'ini', '.cfg': 'cfg',
        '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
        '.csv': 'csv',
    }
    if ext in SPECIAL_SKIP_NAMES:
        return 'skip-marker'
    return ext_map.get(ext, ext.lstrip('.').lower() if ext else 'unknown')

def is_skip_language(lang):
    lang_lower = lang.lower()
    skip_set = {
        'yaml', 'json', 'html', 'css', 'scss', 'sass', 'less',
        'xml', 'markdown', 'txt', 'csv', 'toml', 'ini', 'cfg',
        'skip-marker',
    }
    return lang_lower in skip_set

def load_file_inventory(arch_summary_path, target_dir):
    files = []
    if target_dir and os.path.exists(target_dir):
        for root, dirs, filenames in os.walk(target_dir):
            dirs[:] = [d for d in dirs
                       if not d.startswith('.') and d not in
                       ('node_modules', '.git', 'dist', 'build', 'out')]
            for fname in filenames:
                fpath = os.path.join(root, fname)
                try:
                    size = os.path.getsize(fpath)
                except OSError:
                    continue
                _, ext = os.path.splitext(fname)
                if not ext and fname in SPECIAL_SKIP_NAMES:
                    ext = fname
                lang = classify_language(ext)
                line_count = estimate_lines(size)
                skip = is_skip_language(lang)
                rel = os.path.relpath(fpath, target_dir)
                files.append(FileInfo(
                    rel_path=rel, size_bytes=size,
                    language=lang, line_count=line_count, is_skip=skip,
                ))
    return files

def run_model(files, category_universe_count,
              single_pass_budget=SINGLE_PASS_LINE_BUDGET,
              narrow_categories_per_file=1.5):
    file_sizes = [f.size_bytes for f in files if not f.is_skip]
    boundaries = compute_bucket_boundaries(file_sizes)
    buckets = [SizeBucket(label=l, min_bytes=mn, max_bytes=mx)
               for l, mn, mx in boundaries]

    for f in files:
        for b in buckets:
            if b.min_bytes <= f.size_bytes < b.max_bytes:
                if f.is_skip:
                    b.skip_count += 1
                    b.total_skip_bytes += f.size_bytes
                else:
                    b.hunt_count += 1
                    b.total_hunt_bytes += f.size_bytes
                break

    total_hunt_files = sum(b.hunt_count for b in buckets)
    total_skip_files = sum(b.skip_count for b in buckets)

    n_input = 0.0; n_output = 0.0; n_overhead = 0.0
    n_playbook = 0.0; n_chunking = 0.0; n_skip_saved = 0.0
    b_input = 0.0; b_output = 0.0; b_overhead = 0.0
    b_playbook = 0.0; b_chunking = 0.0

    for b in buckets:
        if b.hunt_count == 0:
            continue
        avg_file_bytes = b.total_hunt_bytes / b.hunt_count
        avg_lines = estimate_lines(int(avg_file_bytes))
        avg_chunks = estimate_chunks(avg_lines, single_pass_budget)

        fixed_oh = FIXED_OVERHEAD_BYTES
        seed_b = estimate_seed_prompt_bytes(int(avg_file_bytes), avg_lines, single_pass_budget)
        narrow_pb = estimate_category_prompt_bytes(narrow_categories_per_file)
        broad_pb = estimate_category_prompt_bytes(category_universe_count)

        narrow_prompt = fixed_oh + seed_b + narrow_pb
        broad_prompt = fixed_oh + seed_b + broad_pb
        narrow_inp = narrow_prompt * TOKENS_PER_PROMPT_BYTE
        broad_inp = broad_prompt * TOKENS_PER_PROMPT_BYTE

        if avg_chunks > 1:
            extra_per_pass = (FIXED_OVERHEAD_BYTES + CHUNK_OVERLAP_LINES * BYTES_PER_LINE * 1.15 + narrow_pb) * TOKENS_PER_PROMPT_BYTE
            nc_extra = extra_per_pass * (avg_chunks - 1)
            bc_extra = extra_per_pass * (avg_chunks - 1)
        else:
            nc_extra = 0; bc_extra = 0

        out_tok = AVG_OUTPUT_TOKENS_PER_FINDING * AVG_FINDINGS_PER_LANE
        n_cnt = b.hunt_count

        b.total_input_tokens = narrow_inp * n_cnt
        b.total_output_tokens = out_tok * n_cnt
        b.total_chunk_overhead_tokens = nc_extra * n_cnt

        n_input += narrow_inp * n_cnt
        n_overhead += fixed_oh * TOKENS_PER_PROMPT_BYTE * n_cnt
        n_playbook += narrow_pb * TOKENS_PER_PROMPT_BYTE * n_cnt
        n_chunking += nc_extra * n_cnt
        n_output += out_tok * n_cnt

        b_input += broad_inp * n_cnt
        b_overhead += fixed_oh * TOKENS_PER_PROMPT_BYTE * n_cnt
        b_playbook += broad_pb * TOKENS_PER_PROMPT_BYTE * n_cnt
        b_chunking += bc_extra * n_cnt
        b_output += out_tok * n_cnt

        for _ in range(b.skip_count):
            skip_seed = estimate_seed_prompt_bytes(int(avg_file_bytes), avg_lines, single_pass_budget)
            skip_prompt = FIXED_OVERHEAD_BYTES + skip_seed + narrow_pb
            n_skip_saved += skip_prompt * TOKENS_PER_PROMPT_BYTE + AVG_OUTPUT_TOKENS_PER_FINDING * AVG_FINDINGS_PER_LANE

    scenario_narrow = n_input + n_output + n_chunking
    scenario_broad = b_input + b_output + b_chunking

    return CostModelResult(
        buckets=buckets, total_files=len(files),
        total_hunt_files=total_hunt_files, total_skip_files=total_skip_files,
        scenario_narrow_tokens=scenario_narrow, scenario_broad_tokens=scenario_broad,
        narrow_breakdown={"fixed_overhead": n_overhead, "content_variable": n_input - n_overhead - n_playbook,
                          "playbook_category": n_playbook, "chunking_overhead": n_chunking,
                          "output_findings": n_output},
        broad_breakdown={"fixed_overhead": b_overhead, "content_variable": b_input - b_overhead - b_playbook,
                         "playbook_category": b_playbook, "chunking_overhead": b_chunking,
                         "output_findings": b_output},
        skip_savings_tokens=n_skip_saved,
        category_universe_count=category_universe_count,
        narrow_categories_per_file=narrow_categories_per_file,
    )

def format_report(result):
    L = []
    L.append("=" * 80)
    L.append("PER-FILE LANE TOKEN COST MODEL")
    L.append("=" * 80)
    L.append("")
    L.append("Total files in inventory: {}".format(result.total_files))
    L.append("  Hunt-eligible:         {}".format(result.total_hunt_files))
    L.append("  Skip (non-executable): {}".format(result.total_skip_files))
    L.append("")
    L.append("SIZE BUCKET TABLE (hunt-eligible files only)")
    L.append("-" * 80)
    L.append("{:<25} {:>6} {:>10} {:>10} {:>10} {:>12}".format(
        "Bucket", "Count", "Avg Size", "Input Tok", "Output Tok", "Subtotal"))
    L.append("-" * 80)
    for b in result.buckets:
        if b.hunt_count == 0:
            continue
        avg_size = b.total_hunt_bytes / b.hunt_count
        subtotal = b.total_input_tokens + b.total_output_tokens + b.total_chunk_overhead_tokens
        L.append("{:<25} {:>6} {:>10,.0f} {:>10,.0f} {:>10,.0f} {:>12,.0f}".format(
            b.label, b.hunt_count, avg_size,
            b.total_input_tokens, b.total_output_tokens, subtotal))
    L.append("-" * 80)
    ti = sum(b.total_input_tokens for b in result.buckets)
    to = sum(b.total_output_tokens for b in result.buckets)
    tc = sum(b.total_chunk_overhead_tokens for b in result.buckets)
    gt = ti + to + tc
    L.append("{:<25} {:>6} {:>10} {:>10,.0f} {:>10,.0f} {:>12,.0f}".format(
        "TOTAL", result.total_hunt_files, "", ti, to, gt))
    L.append("")
    L.append("SCENARIO COMPARISON")
    L.append("-" * 80)
    L.append("SCENARIO NARROW (evidence-driven categories, avg {:.1f}/file):".format(
        result.narrow_categories_per_file))
    L.append("  Total predicted tokens: {:>12,.0f}".format(result.scenario_narrow_tokens))
    L.append("")
    L.append("SCENARIO BROAD (full category universe, {} categories/file):".format(
        result.category_universe_count))
    L.append("  Total predicted tokens: {:>12,.0f}".format(result.scenario_broad_tokens))
    L.append("")
    ratio = result.scenario_broad_tokens / result.scenario_narrow_tokens if result.scenario_narrow_tokens > 0 else 0
    L.append("Ratio BROAD/NARROW: {:.1f}x".format(ratio))
    L.append("")
    L.append("COST BREAKDOWN -- NARROW SCENARIO")
    L.append("-" * 80)
    for comp, val in result.narrow_breakdown.items():
        pct = val / result.scenario_narrow_tokens * 100 if result.scenario_narrow_tokens > 0 else 0
        L.append("  {:<25} {:>12,.0f} tokens ({:>5.1f}%)".format(comp, val, pct))
    L.append("")
    L.append("COST BREAKDOWN -- BROAD SCENARIO")
    L.append("-" * 80)
    for comp, val in result.broad_breakdown.items():
        pct = val / result.scenario_broad_tokens * 100 if result.scenario_broad_tokens > 0 else 0
        L.append("  {:<25} {:>12,.0f} tokens ({:>5.1f}%)".format(comp, val, pct))
    L.append("")
    tcn = result.narrow_breakdown.get("chunking_overhead", 0)
    tcb = result.broad_breakdown.get("chunking_overhead", 0)
    L.append("CHUNKING MULTIPLIER IMPACT")
    L.append("-" * 80)
    L.append("  NARROW: {:>12,.0f} tokens from multi-pass overhead ({:.1f}% of total)".format(
        tcn, tcn / result.scenario_narrow_tokens * 100 if result.scenario_narrow_tokens > 0 else 0))
    L.append("  BROAD:  {:>12,.0f} tokens from multi-pass overhead ({:.1f}% of total)".format(
        tcb, tcb / result.scenario_broad_tokens * 100 if result.scenario_broad_tokens > 0 else 0))
    L.append("")
    L.append("SKIP SAVINGS")
    L.append("-" * 80)
    L.append("  {} non-executable files skipped".format(result.total_skip_files))
    L.append("  Tokens saved by skipping: {:>12,.0f}".format(result.skip_savings_tokens))
    denom = result.scenario_narrow_tokens + result.skip_savings_tokens
    skip_pct = result.skip_savings_tokens / denom * 100 if denom > 0 else 0
    L.append("  This represents {:.1f}% of what a naive full-scan (no skips)".format(skip_pct))
    L.append("  would cost under NARROW")
    L.append("")
    L.append("CALIBRATION")
    L.append("-" * 80)
    L.append("  Tokens per prompt byte: {}".format(TOKENS_PER_PROMPT_BYTE))
    L.append("  Avg playbook size: {:,} bytes".format(AVG_PLAYBOOK_BYTES))
    L.append("  Fixed overhead per lane: {:,} bytes".format(FIXED_OVERHEAD_BYTES))
    L.append("  Avg output tokens per finding: {:,.0f}".format(AVG_OUTPUT_TOKENS_PER_FINDING))
    L.append("  Avg findings per lane: {:.1f}".format(AVG_FINDINGS_PER_LANE))
    L.append("  Single pass line budget: {:,} lines".format(SINGLE_PASS_LINE_BUDGET))
    L.append("  Chunk overlap: {} lines".format(CHUNK_OVERLAP_LINES))
    L.append("")
    L.append("KEY ASSUMPTIONS & RISK FLAGS")
    L.append("-" * 80)
    L.append("  1. TOKENS_PER_PROMPT_BYTE (0.342): If the LLM model changes (different")
    L.append("     tokenization or model tier), this ratio shifts. Re-calibrate per model.")
    L.append("  2. narrow_categories_per_file ({:.1f}): If recon evidence is sparse, more".format(result.narrow_categories_per_file))
    L.append("     files fall to universe_default, pushing actual cost toward BROAD.")
    L.append("  3. category_universe_count ({}): If the framework set grows, BROAD".format(result.category_universe_count))
    L.append("     scenario cost scales linearly with this count (major cost driver).")
    L.append("  4. AVG_FINDINGS_PER_LANE ({:.1f}): If find rate changes, output tokens".format(AVG_FINDINGS_PER_LANE))
    L.append("     scale proportionally. Currently ~7% of total cost; low sensitivity.")
    L.append("  5. FIXED_OVERHEAD_BYTES ({:,}): If prompt templates change significantly,".format(FIXED_OVERHEAD_BYTES))
    L.append("     re-measure. In v2 this is paid ~N times (once per file), making it")
    L.append("     the dominant per-file cost driver even though it is small per unit.")
    L.append("  6. CHUNK_OVERLAP_LINES (20): If overlap changes, multi-pass cost shifts.")
    L.append("  7. SINGLE_PASS_LINE_BUDGET ({}): Lower budget means more files need".format(SINGLE_PASS_LINE_BUDGET))
    L.append("     chunking, which amplifies fixed overhead payment frequency.")
    L.append("")
    L.append("=" * 80)
    return "\n".join(L)

def main():
    parser = argparse.ArgumentParser(description="Per-file lane token cost model")
    parser.add_argument("--target-dir", required=True, help="Path to target codebase")
    parser.add_argument("--arch-summary", default=None, help="Path to architecture-summary.json")
    parser.add_argument("--categories", type=int, default=21, help="Category universe count")
    parser.add_argument("--narrow-cats", type=float, default=1.5, help="Avg cats/file NARROW")
    parser.add_argument("--single-pass-lines", type=int, default=SINGLE_PASS_LINE_BUDGET, help="Lines per pass")
    parser.add_argument("--output", default=None, help="Output report file path")
    args = parser.parse_args()

    files = load_file_inventory(args.arch_summary, args.target_dir)
    if not files:
        print("ERROR: No files found.", file=sys.stderr)
        sys.exit(1)

    result = run_model(
        files=files,
        category_universe_count=args.categories,
        single_pass_budget=args.single_pass_lines,
        narrow_categories_per_file=args.narrow_cats,
    )

    report = format_report(result)
    if args.output:
        d = os.path.dirname(os.path.abspath(args.output))
        os.makedirs(d, exist_ok=True)
        with open(args.output, 'w') as f:
            f.write(report)
        print("Report written to " + args.output)
    else:
        print(report)

    json_path = None
    if args.output:
        base, _ = os.path.splitext(args.output)
        json_path = base + ".json"
    else:
        json_path = "cost-model-output.json"

    json_output = {
        "total_files": result.total_files,
        "total_hunt_files": result.total_hunt_files,
        "total_skip_files": result.total_skip_files,
        "scenario_narrow_tokens": round(result.scenario_narrow_tokens),
        "scenario_broad_tokens": round(result.scenario_broad_tokens),
        "narrow_breakdown": {k: round(v) for k, v in result.narrow_breakdown.items()},
        "broad_breakdown": {k: round(v) for k, v in result.broad_breakdown.items()},
        "skip_savings_tokens": round(result.skip_savings_tokens),
        "category_universe_count": result.category_universe_count,
        "buckets": [
            {
                "label": b.label, "file_count": b.hunt_count,
                "skip_count": b.skip_count, "total_hunt_bytes": b.total_hunt_bytes,
                "total_input_tokens": round(b.total_input_tokens),
                "total_output_tokens": round(b.total_output_tokens),
                "chunking_overhead_tokens": round(b.total_chunk_overhead_tokens),
            }
            for b in result.buckets
        ],
    }
    with open(json_path, 'w') as f:
        json.dump(json_output, f, indent=2)
    print("JSON output written to " + json_path)

if __name__ == "__main__":
    main()
