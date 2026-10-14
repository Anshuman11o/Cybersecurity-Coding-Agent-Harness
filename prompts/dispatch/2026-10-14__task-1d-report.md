# Dispatch: Task 1d, end-of-scan report (npm CLI only)

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside the harness
repository. Do not open any other directory under `/home/user/`.

Scope: productization plan Task 1d, as re-decided with the owner on 2026-10-14.
Option A (the npm CLI) only; nothing for the GitHub Action. The report reads
what the scanner already writes. **No Stage 2 prompt, schema or artifact
changes.** No model calls.

## What the user gets

After a scan, in the run's own folder (`<reports>/runs/<run-id>/`, where
`<reports>` is the folder chosen at "Save reports to?", default
`<target>/.secscan/`):

- `findings.json` (`secscan.findings/1`): run facts, scan gaps, summary counts,
  the not-scanned list, the resume command, then every Stage 2 finding exactly
  as written plus one added field, `location` {file, line}, copied from the
  trace's last step. The trace is never modified.
- `report.html`: one self-contained page (inline CSS and JS, no network
  requests) rendered from that same object, with a Summary view and a Findings
  view.
- `<reports>/index.html`: every run that has a report, newest first, rebuilt
  from `runs/*/findings.json` each time.

The data contract is `tools/scanner/report/src/types.ts`.

## Owner decisions (binding)

| Topic | Decision |
|---|---|
| Fields | Stage 2's fields only, verbatim: `finding_id`, `lane_id`, `title`, `description`, `severity_estimate`, `confidence`, `finding_classes`, `categories`, `trace`. Added: `location` only. No CWE, remediation, attack scenario, severity reason, code excerpts or fingerprints. |
| Severity, confidence | Shown exactly as written. No "priority" field. The confidence band (High >= 0.8, Medium 0.5 to < 0.8, Low < 0.5) is a display field shown next to confidence where a finding is listed. There is no confidence breakdown table. |
| Wording | Findings are "vulnerabilities". No per-finding "unverified" labels. No model-benchmark line. |
| Scan gaps box | Facts about this run only (stopped early and why, files not scanned with counts by reason, failures). Hidden when nothing applies. |
| Partial runs | An INCOMPLETE run that scanned x of N files reports exactly those x files and their y findings, says "Partial scan: x of N files scanned", and gives the resume command. |
| Same-line findings | All kept and counted; the Findings view groups findings sharing a `file:line` under one location header. A group sorts by its most severe member. |
| Order | Severity (critical, high, medium, low), then confidence descending, then file, line, finding id. |
| Summary sections | Header (status, target, branch @ commit, date, run id, pass, model, version); headline counts (vulnerabilities, distinct locations, files with findings) and severity tiles; Scan gaps; Review first (top 10); By vulnerability type (a finding counts under every type it carries); Top files (10, with severity split); Coverage (files in repo, skipped by selector, skipped because no selected class applies after class review, excluded by scope, in scope, scanned, not scanned by reason); Cost (spent vs budget only, no estimate); Usage (input/output tokens, wall clock; no model calls count, no concurrency). |
| Copy button | Each finding has a button that copies that finding's JSON exactly as in findings.json. |
| Locations | Plain `path:line`, plus an "Open in VS Code" link (`vscode://file/<abs path>:<line>`). |
| After a scan | Print both paths and open report.html automatically when attached to a terminal; `--no-open` disables. |
| Report failure | Never changes the scan's exit code; print the error and the rebuild command. |
| Extras | `secscan report [run-id] [--out <reports>] [--no-open]` rebuilds both files and the index from disk. `index.html` lists only runs with a report. |

## When a report is written

Any run that scanned at least one file, and every COMPLETE run. A run that
scanned zero files gets a report only when it ended in a failure
(`stage_failed`, `provider_quota`, `provider_failing`, `unpriced_service_tier`);
the page then says "No files were scanned", never "0 vulnerabilities". No
report when the user quit at confirmation, pressed Ctrl-C before any file
finished, or the budget could not cover the first file.

A cancelled resume (frozen run, quit at confirmation) rewrites
`run-record.json` without hunting; the existing report is left as it is.

When Stage 2 left no fresh `run-status.json` (stage killed), the scanned count
comes from Stage 2's checkpoint (`budget-consumption.json` entries that did not
fail, within the scan plan's admitted lanes), and not-scanned files are the
admitted lanes without a finished entry, reason `unrecorded`.

`secscan report` on a run with no `run-record.json` shows status UNKNOWN; when
the findings are newer than the run record, status is INCOMPLETE with gap
"a later pass did not finish". It refuses a run whose hunt is still writing
progress (status running, updated in the last two minutes).

## Files

| Path | Role |
|---|---|
| `tools/scanner/report/src/types.ts` | Contract (exists) |
| `tools/scanner/report/src/build.ts` | Pure: run folder + stage-dir resolver -> FindingsReport; eligibility |
| `tools/scanner/report/src/gaps.ts` | Reason code -> plain sentence |
| `tools/scanner/report/src/html.ts` | `renderReportHtml(report: FindingsReport): string` |
| `tools/scanner/report/src/index-page.ts` | `renderIndexHtml(entries: IndexEntry[], generatedAt: string): string` |
| `tools/scanner/report/src/write.ts` | Atomic writes, index rebuild, run discovery |
| `tools/scanner/report/src/open.ts` | Open a file in the default browser (open, xdg-open, start) |
| `tools/scanner/cli/src/secscan.ts`, `args.ts` | Call after `writeRunRecord` in `finish()`; `report` subcommand; `--no-open` |

Stage directories are resolved through `runPath()` by the CLI and passed in;
the report module never builds a stage path itself.

## HTML requirements

- One file, inline CSS and JS, **no external resources and no network URLs**
  (no CDN, fonts, images or analytics). A strict Content-Security-Policy meta
  tag: `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`.
- The FindingsReport is embedded once as JSON in
  `<script type="application/json" id="report-data">`, with `<` written as
  `<` (and U+2028/U+2029 escaped) so no value can close the tag.
- Every model-written string (title, description, trace descriptions, class
  ids, codes, file paths) reaches the page as text: `textContent` or
  `createTextNode`, never `innerHTML` with data. Any server-side (build time)
  HTML uses an escaping function for every interpolated value.
- Works opened from `file://`. Light and dark mode via `prefers-color-scheme`.
  Print styles so "Save as PDF" in the browser produces the summary and the
  findings legibly.
- Summary view, then Findings view (tabs or anchored sections). Deep links:
  each finding has `id="<finding_id>"`; Review first rows, severity tiles,
  type rows and top-file rows link to or filter the Findings view.
- Findings view: filters for severity, type, file and confidence range, text
  search, and a sort switch (report order, or file then line). Findings sharing
  a `file:line` sit under one location header. Each finding shows: id, title,
  severity badge, confidence number with band, location with VS Code link,
  type tags, OWASP code tags (with names from `summary.category_names` when
  present, code alone otherwise), description, a collapsible numbered trace
  (kind, `file:line`, description; the step each class is justified by is
  marked), lane id, and a Copy JSON button.
- INCOMPLETE runs show "Partial scan: x of N files scanned" under the header
  when both numbers are known. Zero scanned files shows "No files were
  scanned" in place of the count headline. A COMPLETE run with zero findings
  shows "No vulnerabilities found in N scanned files".
- Unknown values (null) render as "unknown", never 0.
- Must stay responsive with 2,000 findings (render the list once, filter by
  toggling visibility; traces collapsed by default).

## Tests (run, all must pass)

1. Every row of the termination table, including partial counts equal to the
   files and findings actually finished.
2. Counts reconcile (severity sums, class counts with multi-class findings,
   distinct locations, files with findings).
3. `location` equals the trace's last step for every finding.
4. Trace untouched: removing `location` from each findings.json entry gives the
   Stage 2 entry exactly; candidate-findings.json's SHA-256 is unchanged.
5. Byte-identical output for the same inputs apart from `generated_at`.
6. Model text rendered safely: hostile `</script>`, `<img onerror>` and
   `<script>` in titles, descriptions, trace steps and paths never appear
   unescaped in the HTML.
7. No `http://` or `https://` anywhere in report.html or index.html.
8. index.html rebuild: lists runs with a report, newest first; a deleted run
   disappears on the next rebuild.

Plus the existing cli and shared suites, unchanged and green.

## Amendment, 2026-10-14: owner review of the first real report

After the end-to-end run (`scanner-2026-10-14-luna6-e2e-product`) the owner
reviewed its report. Changes, applied by rebuilding that run's report from
disk with `secscan report`, no new scan:

- Critical shows only when the run has a critical finding: no `critical`
  count in `findings.json`, no Critical tile, chip or column otherwise. Stage 2
  can still write critical (earlier runs by other models did), so it is kept
  for those runs rather than dropped. Severity values themselves are unchanged.
- The severity tiles carry a heading, "Severity range".
- The header drops the Pass field (`run.passes` stays in `findings.json`).
- Review first becomes a table with one field per column: rank, severity,
  vulnerability, file, line, confidence, confidence band, titled "Top 10 most
  severe vulnerabilities to review first". Rows are findings, not files: one
  file can appear twice.
- The type table's code column is headed by the code families present ("OWASP
  codes", "OWASP and CWE codes", "OWASP and other codes"), and each code shows
  its name once ("A01: Broken Access Control", not "A01 A01: ...").
- Section descriptions sit beside their title ("Top files  Files with the most
  findings"); action hints stay on the right.
- The CLI's and Stage 2's progress lines name critical only when there is one.

## Amendment 2, 2026-10-14: report option 1, summary only

The owner asked for two or three report designs to choose between; this is
option 1, kept in `tools/scanner/report/src/option1-summary.ts` (shared
helpers stay in `html.ts`). Applied by rebuilding the same run's report.

- The Findings view, its tab and every link into it are removed; the page is
  the summary only and embeds no report data.
- Links open `findings.json` in VS Code at the finding (`vscode://file/<abs
  path>:<line>`): each Top 10 row at its finding, each severity tile at the
  first finding of that severity (findings are in severity order). The type
  and file tables have no links, since their findings are spread through the
  file.
- Top 10 columns: Rank, Severity, Vulnerability (the finding's types, not its
  title), File, LLM confidence score. Line and confidence band are dropped.
- The severity columns are headed "Severity band (High · Medium · Low)"; Top
  files reads "Files with the most bugs".

## Amendment 3, 2026-10-14: report option 2, ZAP-style summary

A second design to compare with option 1, kept in
`tools/scanner/report/src/option2-zap-style.ts`; option 1 is unchanged and
`report.html` stays option 1. `secscan report [run-id] --template 2` also writes
`report-option-2.html` beside it. Design references: ZAP's Modern report
(Corporate theme) and High Level report, read from ZAP's template source.

- White page; navy header rows, zebra rows, ZAP's red / orange / yellow risk
  colours. No chart library: the doughnut is inline SVG built at render time.
- Sections: Summary (Run details and Scan results tables), Vulnerability
  Severity (doughnut and legend), Vulnerabilities by Type (one split bar per
  type, each severity's count in its own segment, total at the end), Top 10
  Files with the Most Bugs, Vulnerability Impact.
- Impact table: types ranked by most highs, then mediums, then lows; impact
  text is the playbook's Scope line, then "In this codebase:" and the playbook
  agent's reason from playbook-plan.json (`report/src/impact.ts`). Citation
  links and "Source: <url>" tails are dropped for display. Nothing is written
  to findings.json.
- Links: severity legend entries and impact type names open findings.json in
  VS Code (first finding of that severity; the type's most severe finding).

Owner review of option 2, same day: title "Vulnerability Scan Summary Report";
a "View detailed JSON bug report on VS Code" link (findings.json, line 1) and a
note that every link opens findings.json under the title; each top-10 file
links to its most severe finding; the per-type counts under the impact table's
type names are removed.

