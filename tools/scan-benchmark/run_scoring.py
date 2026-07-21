#!/usr/bin/env python3
"""Orchestrates scoring across all five tools and writes
results/scan-benchmark-summary.md. See score.py / adapters.py for the engine
and per-tool parsers."""
import json
import sys

from score import load_ground_truth, score_tool, render_markdown
from adapters import load_security_audit_skill, load_vulnhunter, load_raptor, load_deepsec

ANSWER_KEY = "/workspace/juice-shop-answer-key/answer-key.json"

NOTES = {
    "VulnHunter (Capital One)": (
        "**Did not complete.** Hit the Anthropic org's monthly Opus spend limit "
        "partway through Phase 2 (hunt across partitions) and exited before "
        "writing a final report. Scored from its 37 partial per-partition "
        "result files (SG-1 through roughly SG-8/9) that had already been "
        "written to disk; the two hunting lanes it hadn't reached yet "
        "(AI/LLM, and part of client-side/XSS) show up as misses below, not "
        "necessarily as true negatives."
    ),
    "VVAH (Visa)": (
        "**Did not complete.** Timed out (28-minute bound) partway through "
        "Stage 4/11 (taint analysis) of its 11-stage pipeline; per its own "
        "`estimate` output the full repo scope is ~4M input tokens per pass "
        "across 9 detection stages, which needs materially longer than this "
        "run's time budget. No SARIF/Markdown report was ever emitted (that "
        "happens at S9), so there is nothing to score -- not included in the "
        "summary table below."
    ),
    "security-audit-skill (Cloudflare)": (
        "Completed. Run scoped to 5 parallel hunting lanes rather than the "
        "skill's full attack-class matrix (see `results/security-audit-skill/REPORT.md`)."
    ),
    "raptor (community)": (
        "Completed as literally invoked in the brief (`/scan`, no extra "
        "flags) -- CodeQL is off by default for that command, so this is a "
        "Semgrep-only static-pattern scan, not raptor's full agentic "
        "`/agentic`/`/validate` pipeline. Much lower recall is expected and "
        "observed: pattern matching alone catches the SSRF and (via a "
        "generic hardcoded-secret rule, imprecisely localized) the "
        "insecurity.ts file, but none of the logic-heavy access-control, "
        "auth-bypass, or prompt-injection classes that need semantic "
        "reasoning to find."
    ),
    "deepsec (Vercel Labs)": (
        "Completed scan + process + export. Skipped the optional `revalidate` "
        "step (which defaults to Opus and would have spent more of an "
        "already-exhausted budget) -- the brief marked it optional."
    ),
}


def main():
    gt = load_ground_truth(ANSWER_KEY)
    results = []

    sec_audit = load_security_audit_skill("/tmp/results/security-audit-skill/findings.json")
    results.append(score_tool("security-audit-skill (Cloudflare)", sec_audit, gt))

    vh = load_vulnhunter("/tmp/results/vulnhunter/juice-shop-work_VULNHUNT_RESULTS_2026-07-21-211326")
    results.append(score_tool("VulnHunter (Capital One)", vh, gt))

    raptor = load_raptor("/tmp/tools-recon/raptor/out/projects/juice-shop/scan-20260721-213422-pid20495-5458")
    results.append(score_tool("raptor (community)", raptor, gt))

    deepsec = load_deepsec("/tmp/results/deepsec-findings")
    results.append(score_tool("deepsec (Vercel Labs)", deepsec, gt))

    md = render_markdown(results, gt, NOTES)

    # VVAH: no findings to score, but still document its attempt for completeness.
    vvah_section = (
        "\n### VVAH (Visa)\n\n"
        + NOTES["VVAH (Visa)"]
        + "\n\n- Total findings reported: 0 (pipeline never reached the report-emission stage)\n"
    )
    md = md.replace("## Ground truth reference", vvah_section + "\n## Ground truth reference")

    out_path = "/home/user/Cybersecurity-Coding-Agent-Harness/results/scan-benchmark-summary.md"
    with open(out_path, "w") as f:
        f.write(md)
    print(f"Wrote {out_path}", file=sys.stderr)

    for r in results:
        print(json.dumps(r, indent=2))


if __name__ == "__main__":
    main()
