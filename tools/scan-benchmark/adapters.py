"""Per-tool adapters: read each tool's native output format into a list of
score.Finding(file, line, title, description)."""
import json
import re

from score import Finding


def load_security_audit_skill(findings_json_path: str) -> list[Finding]:
    with open(findings_json_path) as f:
        data = json.load(f)
    out = []
    for entry in data:
        if entry.get("verdict") != "confirmed":
            continue
        trace = entry.get("trace", [])
        sink = next((t for t in trace if t.get("kind") == "sink"), trace[-1] if trace else None)
        if sink:
            out.append(Finding(file=sink["file"], line=sink.get("line"), title=entry["title"],
                                description=entry.get("description", "")))
        else:
            out.append(Finding(file="", line=None, title=entry["title"],
                                description=entry.get("description", "")))
    return out


_FILE_LINE_RE = re.compile(r"([\w./-]+\.\w+):(\d+)")


def _extract_file_line(text: str):
    """Find a file.ext:NN token in a metadata line (Location/File/Sink/etc)."""
    m = _FILE_LINE_RE.search(text)
    if m:
        return m.group(1), int(m.group(2))
    return None, None


def load_vulnhunter(report_dir: str) -> list[Finding]:
    """VulnHunter's phase-based markdown output. Prefers the final report if
    Phase 4 completed; falls back to the per-partition results/*.md files
    (each finding is a '## [VULN-NNN] Title' block with a '**Location**:
    file:line' metadata line) if the run didn't reach a final report."""
    import glob
    import os
    out = []
    candidates = glob.glob(os.path.join(report_dir, "**", "*REPORT*.md"), recursive=True)
    candidates += glob.glob(os.path.join(report_dir, "**", "README.md"), recursive=True)
    if not candidates:
        candidates = glob.glob(os.path.join(report_dir, "**", "results", "*.md"), recursive=True)
    for path in candidates:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        blocks = re.split(r"\n(?=#{2,3}\s*\[?VULN|^#{2,3}\s)", text, flags=re.MULTILINE)
        for block in blocks:
            title_m = re.search(r"^#{2,3}\s*(\[?VULN[^\]]*\]?\s*.+)$", block, re.MULTILINE)
            if not title_m:
                continue
            loc_m = re.search(r"\*{0,2}(?:Location|File|Sink)\*{0,2}:?\s*(.+)", block, re.IGNORECASE)
            file_, line_ = (None, None)
            if loc_m:
                file_, line_ = _extract_file_line(loc_m.group(1))
            if file_ is None:
                file_, line_ = _extract_file_line(block)
            if file_ is None:
                continue
            out.append(Finding(file=file_, line=line_, title=title_m.group(1).strip(), description=block[:2000]))
    return out


def _load_one_sarif(sarif_path: str) -> list[Finding]:
    with open(sarif_path) as f:
        sarif = json.load(f)
    out = []
    for run in sarif.get("runs", []):
        for result in run.get("results", []):
            title = result.get("message", {}).get("text", result.get("ruleId", "finding"))
            locations = result.get("locations", [])
            file, line = "", None
            if locations:
                phys = locations[0].get("physicalLocation", {})
                file = phys.get("artifactLocation", {}).get("uri", "")
                region = phys.get("region", {})
                line = region.get("startLine")
            out.append(Finding(file=file, line=line, title=title, description=title))
    return out


def load_vvah(sarif_path: str) -> list[Finding]:
    """VVAH emits a single SARIF 2.1.0 file per its README."""
    return _load_one_sarif(sarif_path)


def load_raptor(scan_dir: str) -> list[Finding]:
    """raptor's /scan writes one SARIF file per policy category/engine under
    the scan run directory (semgrep_category_*.sarif, semgrep_semgrep_*.sarif);
    merge all of them. Empty-result files are skipped automatically since
    _load_one_sarif just yields nothing for a run with no results."""
    import glob
    import os
    out = []
    for path in glob.glob(os.path.join(scan_dir, "*.sarif")):
        out.extend(_load_one_sarif(path))
    return out


def load_deepsec(export_dir: str) -> list[Finding]:
    """deepsec's `export --format md-dir` writes one markdown file per finding
    under --out/<SEVERITY>/, each starting '# [SEVERITY] Title' followed by
    '**File:** `path` (lines NN)'."""
    import glob
    import os
    out = []
    for path in glob.glob(os.path.join(export_dir, "**", "*.md"), recursive=True):
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        title_m = re.search(r"^#\s*(?:\[\w+\]\s*)?(.+)$", text, re.MULTILINE)
        file_m = re.search(r"\*\*File:\*\*\s*`([^`]+)`(?:\s*\(lines?\s*(\d+))?", text, re.IGNORECASE)
        file, line = "", None
        if file_m:
            file = file_m.group(1)
            line = int(file_m.group(2)) if file_m.group(2) else None
        out.append(Finding(file=file, line=line, title=(title_m.group(1).strip() if title_m else path),
                            description=text[:2000]))
    return out
