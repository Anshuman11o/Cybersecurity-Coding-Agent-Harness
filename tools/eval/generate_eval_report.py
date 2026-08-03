#!/usr/bin/env python3
"""
Render the scanner architecture + evaluation report as a PDF.

Source of truth for scores is results/eval-history/*.jsonl (append-only).
To record a new run: append one JSON object per line to the relevant
history file, then re-run this script. Nothing here is hand-edited.

Usage:  python3 tools/eval/generate_eval_report.py
Output: results/reports/scanner-architecture-and-eval-report.pdf
"""
import json
import os
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether,
)

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HIST = os.path.join(REPO, "results", "eval-history")
OUT = os.path.join(REPO, "results", "reports", "scanner-architecture-and-eval-report.pdf")

INK = colors.HexColor("#1a1a1a")
MUTED = colors.HexColor("#5b5b5b")
RULE = colors.HexColor("#c8c8c8")
BAND = colors.HexColor("#eef1f4")
WARN = colors.HexColor("#8a4b00")

styles = getSampleStyleSheet()
S = {
    "title": ParagraphStyle("t", parent=styles["Title"], fontSize=21, leading=25,
                            textColor=INK, spaceAfter=2),
    "sub": ParagraphStyle("s", parent=styles["Normal"], fontSize=10.5, leading=14,
                          textColor=MUTED, alignment=TA_LEFT),
    "h1": ParagraphStyle("h1", parent=styles["Heading1"], fontSize=15, leading=18,
                         textColor=INK, spaceBefore=16, spaceAfter=7),
    "h2": ParagraphStyle("h2", parent=styles["Heading2"], fontSize=11.5, leading=14,
                         textColor=INK, spaceBefore=11, spaceAfter=4),
    "body": ParagraphStyle("b", parent=styles["Normal"], fontSize=9.3, leading=13,
                           textColor=INK, spaceAfter=5),
    "note": ParagraphStyle("n", parent=styles["Normal"], fontSize=8.4, leading=11.5,
                           textColor=MUTED, spaceAfter=4),
    "warn": ParagraphStyle("w", parent=styles["Normal"], fontSize=8.8, leading=12,
                           textColor=WARN, spaceAfter=4),
    "cell": ParagraphStyle("c", parent=styles["Normal"], fontSize=8.1, leading=10.4,
                           textColor=INK),
    "cellb": ParagraphStyle("cb", parent=styles["Normal"], fontSize=8.1, leading=10.4,
                            textColor=INK, fontName="Helvetica-Bold"),
    "mono": ParagraphStyle("m", parent=styles["Normal"], fontSize=7.6, leading=10,
                           textColor=INK, fontName="Courier"),
}


def P(t, s="body"):
    return Paragraph(t, S[s])


def table(rows, widths, header=True, zebra=True):
    data = []
    for r_i, row in enumerate(rows):
        style = "cellb" if (header and r_i == 0) else "cell"
        data.append([c if not isinstance(c, str) else Paragraph(c, S[style]) for c in row])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        cmds.append(("BACKGROUND", (0, 0), (-1, 0), BAND))
    if zebra:
        for i in range(1 if header else 0, len(data)):
            if i % 2 == (0 if header else 1):
                cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#fafbfc")))
    t.setStyle(TableStyle(cmds))
    return t


def _flatten_metrics(m):
    """Accept both metrics schemas.

    Entries up to 2026-07-27 were hand-written flat (`recall_pct`,
    `recall_fraction`, ...). From the first Luna run onward the block is the
    scorer's own JSON pasted verbatim, which is nested (`recall: {hits, total,
    pct}`). Both are correct records; only the shape differs. This maps the
    nested form onto the flat keys the report reads, and leaves an already-flat
    block untouched. Purely a read-time adapter — nothing on disk is rewritten.
    """
    if "recall_pct" in m or "recall" not in m:
        return m
    f = dict(m)

    def put(prefix, block):
        if not isinstance(block, dict):
            return
        f[f"{prefix}_pct"] = block.get("pct")
        if "hits" in block and "total" in block:
            f[f"{prefix}_fraction"] = f"{block['hits']}/{block['total']}"

    put("recall", m.get("recall"))
    put("localization", m.get("localization"))

    fl = m.get("file_level") or {}
    f["file_match_any_line_pct"] = fl.get("pct")
    if "hits" in fl and "total" in fl:
        f["file_match_fraction"] = f"{fl['hits']}/{fl['total']}"

    pp = m.get("precision_proxy") or {}
    total = m.get("findings_total")
    f["precision_proxy_category_blind_pct"] = pp.get("category_blind")
    f["precision_proxy_category_blind_fraction"] = (
        f"{pp.get('localized_findings')}/{total}" if total else "n/a")
    f["precision_proxy_category_aware_pct"] = pp.get("category_aware")

    hg = m.get("hedging") or {}
    f["hedging_mean_classes_per_finding"] = hg.get("mean_classes_per_finding")
    f["hedging_class_count_distribution"] = hg.get("class_count_distribution")

    # category-blind ceilings, so a detection gap reads apart from a label gap
    for src, dst in (("recall_category_blind", "recall_category_blind"),
                     ("localization_category_blind", "localization_category_blind")):
        b = m.get(src) or {}
        f[f"{dst}_pct"] = b.get("pct")

    f["candidate_findings"] = total
    return f


def load_jsonl(name):
    p = os.path.join(HIST, name)
    if not os.path.exists(p):
        return []
    out = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line:
                rec = json.loads(line)
                if isinstance(rec.get("metrics"), dict):
                    rec["metrics"] = _flatten_metrics(rec["metrics"])
                out.append(rec)
    return out


def pct(v):
    return "n/a" if v is None else f"{v}%"


# ---------------------------------------------------------------- content ---
story = []

story += [
    P("Scanner Architecture and Evaluation Report", "title"),
    P("Vulnerability-Class Remediation Harness &mdash; scan/find phase", "sub"),
    Spacer(1, 3 * mm),
]

story.append(table([
    ["Field", "Value"],
    ["Generated", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")],
    ["Repository", "Cybersecurity-Coding-Agent-Harness"],
    ["Scope of this document",
     "Stages 0 through 4 of the scanner (find phase). The patch/verify phase is future work "
     "and is not covered."],
    ["Score source of truth",
     "results/eval-history/*.jsonl (append-only). This PDF is generated from those files by "
     "tools/eval/generate_eval_report.py and is not hand-edited."],
], [38 * mm, 128 * mm]))

story += [
    P("1. Pipeline architecture", "h1"),
    P("Six stages. Recon establishes what the target is; the lane selector decides what to hunt "
      "and where; the budget governor bounds every lane before any spend; hunt lanes do the "
      "reasoning in parallel; validation independently re-checks each candidate; output "
      "assembles the final artifact.", "body"),
]

story.append(table([
    ["Stage", "Name", "Determinism", "Build status"],
    ["0", "Recon", "AST/filesystem extraction (deterministic) + 2 LLM passes", "Built"],
    ["0.5", "Dynamic Lane Selector", "Deterministic instantiation + 1 LLM verification pass", "Built"],
    ["1", "Budget Governor", "Fully deterministic (arithmetic, no model call)", "Built"],
    ["2", "Hunt Lanes", "N parallel LLM lanes, 3 phases", "Built"],
    ["3", "Validate", "1 LLM pass per consolidated finding", "Built, redesign pending"],
    ["4", "Output", "Schema assembly, no model call expected", "Not started"],
], [12 * mm, 44 * mm, 68 * mm, 42 * mm]))

story += [
    P("2. Per-stage input / output contracts", "h1"),

    P("Stage 0 &mdash; Recon", "h2"),
]
story.append(table([
    ["Direction", "Contract"],
    ["Input", "Target repository root. Path is supplied via <font face='Courier'>--target</font> "
              "CLI argument or <font face='Courier'>SCANNER_TARGET</font> environment variable. "
              "No answer-key or category material is ever provided."],
    ["Output 1", "<font face='Courier'>architecture-summary.json</font> &mdash; route table "
                 "(method / path / handler / middleware / auth / file / line), auto-CRUD resource "
                 "table with per-model exclude lists, persistence-layer map, dependency list, "
                 "swagger coverage diff, client-side escape-hatch findings, LLM tool-calling "
                 "verdict, file inventory, framework detection."],
    ["Output 2", "<font face='Courier'>category-applicability.json</font> &mdash; one row per "
                 "OWASP Top 10 / API Security Top 10 / LLM Top 10 category: verdict "
                 "(present / absent / uncertain), evidence string, confidence 0-1."],
    ["Consumed by", "Stage 0.5 (lane instantiation) and Stage 1 (budget sizing needs the seed "
                    "footprint)."],
], [26 * mm, 140 * mm]))

story += [P("Stage 0.5 &mdash; Dynamic Lane Selector", "h2")]
story.append(table([
    ["Direction", "Contract"],
    ["Input", "Stage 0's architecture summary + category applicability table."],
    ["Output", "<font face='Courier'>lane-manifest.json</font> &mdash; array of lanes, each with "
               "<font face='Courier'>lane_id</font>, <font face='Courier'>categories[]</font>, "
               "<font face='Courier'>subsystem_scope</font>, "
               "<font face='Courier'>seed_files[]</font>, "
               "<font face='Courier'>playbook_reference</font>."],
    ["Special rules",
     "(a) A permanent seed-file denylist excludes 3 benchmark-infrastructure files from every "
     "lane. (b) Unclassified-surface files from the inventory are filtered (non-executable "
     "languages dropped) then bin-packed into size-capped shards. (c) Detected smart-contract "
     "files get a dedicated lane."],
    ["Consumed by", "Stage 1 (needs lane count + seed footprint) and Stage 2 (lane assignments)."],
], [26 * mm, 140 * mm]))

story += [P("Stage 1 &mdash; Budget Governor", "h2")]
story.append(table([
    ["Direction", "Contract"],
    ["Input", "Lane manifest + on-disk byte size of every seed file."],
    ["Output", "<font face='Courier'>budget-plan.json</font> &mdash; per lane: "
               "<font face='Courier'>model_tier</font>, "
               "<font face='Courier'>token_ceiling</font>, "
               "<font face='Courier'>wall_clock_ceiling</font>, "
               "<font face='Courier'>escalation_flag</font> plus the reason the flag was set."],
    ["Method", "Arithmetic only, no model call. Ceilings are sized from each lane's own seed "
               "footprint; escalation is flagged when a lane's footprint sits in the top quartile "
               "by bytes or by file count."],
    ["Design intent", "Per-lane ceilings, deliberately not one global cap, so a single expensive "
                      "lane cannot starve the others."],
], [26 * mm, 140 * mm]))

story += [P("Stage 2 &mdash; Hunt Lanes", "h2")]
story.append(table([
    ["Direction", "Contract"],
    ["Input", "Architecture summary + lane assignment + category playbook + seed file contents "
              "(line-numbered) + budget ceiling + optional Semgrep hints (additive context only, "
              "never a filter)."],
    ["Output 1", "<font face='Courier'>candidate-findings.json</font> &mdash; per finding: "
                 "<font face='Courier'>finding_id</font>, <font face='Courier'>lane_id</font>, "
                 "<font face='Courier'>categories[]</font>, <font face='Courier'>title</font>, "
                 "<font face='Courier'>description</font>, "
                 "<font face='Courier'>trace[]</font> of {kind, file, line, description} where "
                 "kind is entrypoint / propagation / sink, "
                 "<font face='Courier'>severity_estimate</font>, "
                 "<font face='Courier'>confidence</font>."],
    ["Output 2", "<font face='Courier'>budget-consumption.json</font> &mdash; per lane: "
                 "<font face='Courier'>tokens_used</font>, "
                 "<font face='Courier'>seconds_elapsed</font>, "
                 "<font face='Courier'>ceiling_hit</font>."],
    ["Phases", "Phase 1 hunt across all lanes; Phase 2 orchestrator review of scope requests and "
               "escalation candidates; Phase 3 approved second passes. Findings are deduplicated "
               "before emission."],
    ["Validity rules", "A finding is dropped unless its trace is non-empty, starts with an "
                       "entrypoint step, and ends with a sink step."],
], [26 * mm, 140 * mm]))

story.append(PageBreak())

# --------------------------------------------------------------- eval ------
story += [
    P("3. Evaluation methodology", "h1"),
    P("3.1 Universal record &mdash; captured for every run of every component", "h2"),
    P("These fields are mandatory regardless of which stage is being measured. A score without "
      "them is not interpretable later.", "body"),
]
story.append(table([
    ["Field", "Why it is mandatory"],
    ["run_id / timestamp", "Identifies the run so history can be diffed."],
    ["component + version (git SHA)", "Ties a score to an exact reproducible artifact."],
    ["ground_truth_set (name + size)", "Scores are meaningless without knowing what they were measured against."],
    ["models_used", "Cost and quality both hinge on model tier."],
    ["tokens (in / out / cached)", "Primitive usage measure; survives pricing changes."],
    ["est_cost_usd", "Derived from tokens and current pricing; recorded as null when pricing is not established."],
    ["wall_clock_time", "Latency and total compute-time diverge under parallel lanes; both are recorded."],
    ["primary correctness metrics", "Defined per component below."],
    ["delta_vs_baseline", "The 'did it improve' signal, computed against both the prior run and the best-known run."],
    ["pass / fail vs target", "Turns numbers into a decision rather than just data."],
], [48 * mm, 118 * mm]))

story += [P("3.2 Scanner correctness metrics &mdash; exact definitions in force", "h2")]
story.append(table([
    ["Metric", "Exact definition as implemented"],
    ["File match", "Suffix-based path normalization between a candidate trace step's file and the "
                   "ground-truth file, so absolute vs repo-relative paths compare equal."],
    ["Recall", "Ground-truth entries for which some candidate finding has a trace step that "
               "file-matches AND sits at the EXACT ground-truth line (slack = 0) AND whose "
               "category codes intersect the ground-truth entry's codes. Divided by total "
               "ground-truth entries."],
    ["Localization", "Same as recall but with a line slack of plus/minus 15 lines instead of exact "
                     "match. Reported as the softer 'how close did it get' diagnostic."],
    ["File-match rate", "Ground-truth entries where any candidate touched the right file at any "
                        "line, ignoring category. Diagnostic only: separates 'never looked at the "
                        "file' from 'looked but mislocalized or miscategorized'."],
    ["Precision proxy", "Candidate findings that localize to some real ground-truth entry within "
                        "15 lines, ignoring category, divided by total candidate findings. Named "
                        "a proxy because unmatched findings are not automatically false "
                        "positives &mdash; some are real bugs outside the fixed benchmark set."],
    ["Category codes", "Extracted by regex over category labels: A01-A10, API1-API10, LLM01-LLM10. "
                       "Ground-truth codes are pre-encoded in the answer key rather than "
                       "re-extracted per run."],
], [30 * mm, 136 * mm]))

story += [
    P("Deliberate asymmetry: recall is the STRICTER bar (exact line) and localization the softer "
      "one (15 lines). This is intentional and was set explicitly &mdash; a scanner that names the "
      "wrong line still hands a patcher the wrong place to edit.", "note"),
    P("Multi-vulnerability lines: the ground truth contains locations carrying genuinely distinct "
      "vulnerability classes at one identical line (verified: 4 such locations). Each is a separate "
      "ground-truth entry and must be found and categorized independently to count. Credit is not "
      "shared across categories at the same line.", "note"),
]

story += [P("3.3 Per-stage evaluation method", "h2")]
story.append(table([
    ["Stage", "What is measured", "Method"],
    ["0 Recon", "Category-applicability accuracy (diagnostic)",
     "Compare present/absent/uncertain verdicts against the categories actually exercised by the "
     "ground truth. Isolates whether a recall miss originated in lane selection rather than "
     "hunting."],
    ["0 Recon", "Surface-discovery completeness",
     "Every source file in the target must be accounted for as analyzed, divided, or "
     "excluded-with-reason. Deterministic assertion, not a judgement call."],
    ["0.5 Lane Selector", "Seed coverage",
     "For each ground-truth entry, is its file present in at least one lane's seed set. Directly "
     "separates 'not seeded' misses from 'seeded but not found' misses."],
    ["1 Budget Governor", "Ceiling correctness",
     "Cross-check per-lane ceilings in budget-plan.json against actual usage in "
     "budget-consumption.json. Pass condition: no lane silently exceeds its ceiling, and "
     "ceiling_hit is reported truthfully."],
    ["2 Hunt Lanes", "Recall / localization / precision proxy, overall and per lane",
     "The definitions in 3.2, applied to candidate-findings.json. Per-lane breakdown attributes a "
     "miss to a specific playbook."],
    ["2 Hunt Lanes", "Prompt-reachability (added after a defect was found here)",
     "For each ground-truth line, confirm it was actually inside the prompt text sent to some "
     "lane. Distinguishes a reasoning failure from a truncation failure."],
    ["3 Validate", "Validator precision / recall",
     "Of the raw candidates, how many did validation correctly keep versus correctly kill. "
     "Isolates whether a false result originated in the hunter or the validator."],
    ["4 Output", "Schema conformance",
     "Structural validation against the findings schema. Not a correctness check."],
], [24 * mm, 46 * mm, 96 * mm]))

story += [P("3.4 Whole-scanner evaluation", "h2")]
story.append(table([
    ["Metric", "Definition"],
    ["Precision / Recall / F1", "Aggregate across the full pipeline output, against the complete "
                                "ground-truth set."],
    ["Total pipeline cost and time", "Summed across all stages for one full run; parallel-lane "
                                     "wall clock reported separately from summed compute time."],
    ["Run-to-run stability", "Variance in findings across repeated runs on identical input. "
                             "Agentic components are stochastic. Measured only at milestone "
                             "points, since repeating an eval N times multiplies its cost by N."],
    ["Out-of-scope findings", "Real findings outside the fixed ground-truth set. Tracked, not "
                              "scored &mdash; signals whether the scanner finds genuine bugs "
                              "beyond the benchmark."],
    ["Delta vs previous version", "Trend across harness iterations over calendar time, not only "
                                  "within one component."],
], [42 * mm, 124 * mm]))

story += [
    P("Operative targets in force: precision at or above 95%, recall at or above 90%, "
      "localization at or above 90%. The 100/100/100 observed ceiling is a reference point, not a "
      "definition of done.", "body"),
]

story.append(PageBreak())

# ------------------------------------------------------------- datasets ----
story += [
    P("4. Datasets", "h1"),
]
story.append(table([
    ["Property", "juice-shop-benchmark-v1", "juice-shop-benchmark-v2"],
    ["Ground-truth entries", "10", "98"],
    ["Purpose", "External five-tool comparison", "Full-scope scanner evaluation"],
    ["Derivation", "10 hand-verified challenges spanning distinct OWASP categories",
     "All 113 built-in challenges, minus 15 excluded: 12 judged non-vulnerabilities, 3 "
     "reclassified during verification and recorded with reasons"],
    ["Confidence", "Hand-verified", "All 98 entries at high confidence after three verification passes"],
    ["Schema per entry", "challengeKey, category, file, line, solveCondition, referenceCorrectFix, exploitTest",
     "challengeKey, category, owasp_codes, file, line, confidence, note (the original 10 retain the richer fields)"],
    ["Target application", "juice-shop-blind", "juice-shop-blind"],
    ["Target size", "same as v2", "918 source files inventoried"],
    ["Language mix", "same as v2",
     "TypeScript 531, JSON 151, CSS 86, HTML 82, YAML 46, JavaScript 10, Solidity 5, Python 3, Docker 2, Shell 2"],
    ["Attack surface", "same as v2", "148 hand-written routes, 28 auto-CRUD resources, 16 models"],
], [30 * mm, 50 * mm, 86 * mm]))

story += [
    P("Both sets measure the same target application; v2 supersedes v1 for scanner evaluation. "
      "The answer key lives in a separate restricted repository and is never made available to any "
      "scanner-building or scanning agent.", "note"),
    P("Statistical caveat that must travel with any v1 number: n=10. A single miss swings recall by "
      "10 points. All four completing tools hit 100% precision partly because the set is small "
      "enough that none happened to misfire on it. Directional only.", "warn"),
    P("Contamination caveat that must travel with any number from either set: OWASP Juice Shop is "
      "heavily publicly documented. A model may recognize it from pretraining and reconstruct known "
      "bugs from memory rather than genuine analysis. Neither set proves generalization to an "
      "unfamiliar codebase; only a held-out obscure or synthetic target would.", "warn"),
]

# --------------------------------------------------------------- results ---
story += [P("5. Recorded evaluation results", "h1")]

ext = load_jsonl("external-baseline.jsonl")
story += [P("5.1 External five-tool baseline &mdash; dataset juice-shop-benchmark-v1 (10 challenges)", "h2")]
rows = [["Tool", "Precision", "Recall", "Localization", "Findings in-scope / total"]]
for r in ext:
    m = r["metrics"]
    rows.append([
        r["component"], pct(m.get("precision_pct")),
        "n/a" if m.get("recall_pct") is None else f"{m['recall_pct']}% ({m.get('recall_fraction','')})",
        pct(m.get("localization_pct")),
        f"{m.get('findings_in_scope')} / {m.get('findings_total')}",
    ])
story.append(table(rows, [46 * mm, 21 * mm, 33 * mm, 26 * mm, 40 * mm]))

for r in ext:
    story.append(P(f"<b>{r['component']}</b> &mdash; {r['notes']}", "note"))

sc = load_jsonl("scanner.jsonl")
story += [P("5.2 This harness's scanner &mdash; dataset juice-shop-benchmark-v2 (98 challenges)", "h2")]
def _pp(m):
    """Precision proxy. Runs before the class model recorded one figure;
    runs after record a category-blind and a category-aware one. Show the
    blind figure so the column stays comparable, and mark the newer runs."""
    if "precision_proxy_pct" in m:
        return f"{m['precision_proxy_pct']}% ({m['precision_proxy_fraction']})"
    if "precision_proxy_category_blind_pct" in m:
        return (f"{m['precision_proxy_category_blind_pct']}% "
                f"({m['precision_proxy_category_blind_fraction']})*")
    return "n/a"


def _hedge(m):
    """Mean classes per finding. Absent before the class model, when every
    finding carried exactly one label by construction."""
    v = m.get("hedging_mean_classes_per_finding")
    return "1.000" if v is None else f"{v:.3f}"


rows = [["Run", "Version", "Recall (exact line)", "Localization (15 lines)", "File match", "Precision proxy", "Classes/finding", "Findings"]]
for r in sc:
    m = r["metrics"]
    rows.append([
        r["run_id"].replace("scanner-", ""), r["version"],
        f"{m['recall_pct']}% ({m['recall_fraction']})",
        f"{m['localization_pct']}% ({m['localization_fraction']})",
        f"{m['file_match_any_line_pct']}% ({m['file_match_fraction']})",
        _pp(m),
        _hedge(m),
        str(m["candidate_findings"]),
    ])
story.append(table(rows, [22 * mm, 15 * mm, 25 * mm, 26 * mm, 23 * mm, 24 * mm, 20 * mm, 15 * mm]))
story.append(P(
    "* category-blind figure. Runs from 2026-07-27 onward also record a "
    "category-aware precision proxy, and their recall is not directly comparable "
    "to earlier runs &mdash; findings now carry a vulnerability class and all of "
    "that class's OWASP alias codes, so category matching succeeds where it "
    "previously failed on a naming disagreement. Compare against the "
    "<i>-aliasexpanded</i> re-score, which applies the same alias semantics to "
    "the older findings. The classes-per-finding column is the control: a recall "
    "gain that tracks it is a wider net rather than better detection.", "note"))

rows = [["Run", "Stage 2 tokens", "Lane seconds (summed)", "Lanes", "Ceiling hits"]]
for r in sc:
    m = r["metrics"]
    tk = r.get("tokens") or {}
    wc = r.get("wall_clock_time") or {}
    rows.append([
        r["run_id"].replace("scanner-", ""),
        f"{tk.get('stage2_total'):,}" if tk.get("stage2_total") else "n/a",
        str(wc.get("stage2_lane_seconds_summed", "n/a")),
        str(m.get("lanes", "n/a")),
        str(m.get("lanes_hitting_ceiling", "n/a")),
    ])
story.append(table(rows, [24 * mm, 32 * mm, 42 * mm, 20 * mm, 26 * mm]))

for r in sc:
    story.append(P(f"<b>{r['run_id']}</b> ({r['version']}) &mdash; {r['notes']}", "note"))

story += [
    P("Status against target: both recorded runs are far below the operative floor "
      "(recall at or above 90%, localization at or above 90%). FAIL. The defects in section 6 "
      "account for a substantial and quantified share of the gap; they are not an explanation for "
      "all of it.", "warn"),
]

# --------------------------------------------------------------- defects ---
story += [
    P("6. Known defects qualifying the current scores", "h1"),
    P("These are confirmed by direct inspection, not inferred. Any reading of section 5 that "
      "ignores them will misattribute infrastructure failures to reasoning quality.", "body"),
]
story.append(table([
    ["#", "Defect", "Evidence", "Ground-truth impact", "Status"],
    ["1", "Seed files truncated at 15,000 characters before the prompt is built",
     "server.ts is 40,967 numbered characters (2.7x the cap) and is seeded to all 16 lanes, so "
     "every lane reads only its first ~37%. Byte offset of line 477 is 22,805.",
     "5 entries physically unreachable: changeProductChallenge, registerAdminChallenge, "
     "adminSectionChallenge, forgedFeedbackChallenge, errorHandlingChallenge",
     "Open"],
    ["2", "Findings inherit their lane's category list rather than naming their own",
     "hunt-executor.ts assigns f.categories = lane.categories. The hunt prompt's required-output "
     "list never asks the model for a category. All 14 producing lanes emitted exactly one "
     "distinct category list each.",
     "Breaks scoring in both directions: correct findings miss on category, and blanket lists "
     "grant credit that may not be earned",
     "Open"],
    ["3", "misconfiguration lane rejected by upstream content filter",
     "HTTP 400 with 0 tokens consumed. Root cause: a literal PEM RSA private key in a seed file.",
     "Removed all A05 / API8 / API9 coverage in run -a",
     "Fixed (1f2fa23)"],
    ["4", "Unclassified-surface shards admit non-target files",
     "244 test/spec files and 10 vendored or minified assets seeded, including a single 853 KB "
     "third-party graphics library occupying its own shard.",
     "No direct ground-truth loss; wastes budget that proportional sizing is meant to protect",
     "Open"],
    ["5", "One ground-truth entry is unreachable by deliberate design",
     "Its location sits in a file on the permanent seed denylist.",
     "1 entry (retrieveBlueprintChallenge) can never be found",
     "Accepted"],
], [7 * mm, 34 * mm, 52 * mm, 46 * mm, 18 * mm]))

story += [
    P("7. Recording a future run", "h1"),
    P("Append one JSON object per line to the appropriate file in "
      "<font face='Courier'>results/eval-history/</font>, then regenerate this PDF with "
      "<font face='Courier'>python3 tools/eval/generate_eval_report.py</font>. Every field in "
      "section 3.1 must be populated; use null where a value is genuinely unestablished rather "
      "than estimating it.", "body"),
]
story.append(table([
    ["File", "Holds"],
    ["results/eval-history/scanner.jsonl", "Runs of this harness's own scanner, any stage subset. "
                                           "Record which stages ran in the component field."],
    ["results/eval-history/external-baseline.jsonl", "Third-party tool comparisons. Frozen unless "
                                                     "a new external tool is benchmarked."],
    ["(future) results/eval-history/patcher.jsonl", "Patch/fix phase, once that component exists."],
    ["(future) results/eval-history/verifier.jsonl", "Verify phase, once that component exists."],
], [64 * mm, 102 * mm]))

story += [
    P("Two rules that keep this log trustworthy: never overwrite a historical record, even when a "
      "run is later found to be invalid &mdash; annotate it in the notes field instead, as run -a "
      "is annotated for its failed lane. And never record a score without also recording the "
      "defects known to be in force at that time, or the number will be re-read later as a clean "
      "measurement of reasoning quality.", "note"),
]


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.4)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 12 * mm,
                      "Scanner Architecture and Evaluation Report - generated from results/eval-history/*.jsonl")
    canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"Page {doc.page}")
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.4)
    canvas.line(18 * mm, 15 * mm, A4[0] - 18 * mm, 15 * mm)
    canvas.restoreState()


doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=18 * mm, rightMargin=18 * mm,
    topMargin=16 * mm, bottomMargin=20 * mm,
    title="Scanner Architecture and Evaluation Report",
    author="Cybersecurity-Coding-Agent-Harness",
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f"Written: {OUT}")
