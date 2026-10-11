# Report SARIF alignment (deferred)

**Status: deferred by the owner on 2026-10-11.** Nothing in this document is
decided or implemented. It records the analysis so it can be picked up after the
whole architecture is in place and the evaluation runs are done. The reason for
waiting: some of these fields may be better emitted by the model than computed
by the report stage, and that choice depends on what the pipeline looks like
after Step 1 and its evals.

Related: `docs/architecture/productization-plan.md` §2.8, §2.9, Part 4;
`tools/scanner/report/` (the report stage); task 1d,
`prompts/dispatch/2026-10-10__task-1d-report-stage.md`.

---

## 1. What the report emits today

`tools/scanner/report/src/sarif.ts` writes `findings.sarif`. It validates
against the OASIS SARIF 2.1.0 schema (checked with ajv draft-04, formats
enforced, on the luna run 6 artifacts).

```
SARIF document
├── $schema, version "2.1.0"
└── runs[0]
    ├── tool.driver            name "secscan", version, semanticVersion
    │   └── rules[]            one per vulnerability class: id "secscan/<class>",
    │                          name, shortDescription, fullDescription,
    │                          defaultConfiguration, properties {tags, security-severity, owasp}
    ├── originalUriBaseIds     %SRCROOT% = the target root
    ├── versionControlProvenance[]   repositoryUri, revisionId, branch (GitHub repos only)
    ├── automationDetails.id   "secscan/<scope>/<run-id>"
    ├── properties             status, status_reasons, config_hash, model
    └── results[]
        ├── ruleId, ruleIndex, level (critical/high → error, medium → warning, low → note)
        ├── message.text       title + description + severity + confidence + attack + remediation
        ├── locations[0]       uri relative to %SRCROOT%, region {startLine, snippet}
        ├── partialFingerprints  {"secscanFingerprint/v1": sha256(path, sink text, primary class)}
        ├── codeFlows[0].threadFlows[0].locations[]   the trace, kinds source / pass-through / sink
        └── properties         id, severity, security-severity, confidence, confidence_band,
                               classes, owasp, cwe, permalink, location_unresolved
```

### Known quirks in today's output, deliberately left as they are

| Quirk | Why it matters | Candidate fix (see §3) |
|---|---|---|
| `message.text` concatenates everything | GitHub shows the message as the alert text; a long one buries the point | 1 to 2 finding-specific sentences; the rest in `message.markdown` and properties |
| rule `security-severity` is the highest severity among *this run's* findings for the class | it changes from run to run, and every finding of a class gets the same score | a fixed score per rule |
| result-level `security-severity` | GitHub reads it from the rule only, so it is ignored | drop it, or keep it as documentation |
| CWE tags unpadded (`external/cwe/cwe-89`) | CodeQL's convention pads to three digits (`external/cwe/cwe-089`) | pad |
| `rule.shortDescription` is thin ("injection (A03)") | it is the human title of the rule | one written title per class |
| property names are snake_case | SARIF's own names are camelCase | one documented camelCase set |

---

## 2. Gap analysis against a practical baseline

"Practical baseline" means what a source-code vulnerability report usually
carries for GitHub code scanning and SARIF viewers, not what the SARIF
specification makes mandatory.

### 2.1 Baseline fields

| Field | SARIF location | Today |
|---|---|---|
| Format version | `version` | ✅ "2.1.0" |
| Schema | `$schema` | ✅ |
| Scanner name | `run.tool.driver.name` | ✅ |
| Scanner version | `run.tool.driver.version`, `.semanticVersion` | ✅ |
| Rule id | `rule.id` | ✅ stable, one per class |
| Finding's rule | `result.ruleId` (+ `ruleIndex`) | ✅ |
| Finding text | `result.message.text` | ⚠️ too long (§1) |
| File | `result.locations[].physicalLocation.artifactLocation.uri` | ✅ relative to %SRCROOT% |
| Start line | `...region.startLine` | ✅ first sink step |

### 2.2 Recommended security metadata

| Field | SARIF location | Today | Possibility |
|---|---|---|---|
| Rule title | `rule.shortDescription.text` | ⚠️ thin | one written title per class (14) |
| Rule machine name | `rule.name` | ⚠️ `injection` | PascalCase, e.g. `Injection` |
| Rule description | `rule.fullDescription.text` | ⚠️ generic | from each playbook's summary |
| Diagnostic level | `result.level` | ✅ | keep the mapping |
| Security severity | `rule.properties["security-severity"]` | ⚠️ varies per run | fixed per rule |
| CWE tags | `rule.properties.tags` | ⚠️ unpadded | pad; or move to taxonomies |
| Rule precision | `rule.properties.precision` | ❌ | from measured per-class precision (§3.3) |
| Remediation | `rule.help.text`, `.markdown` | ❌ | class-level fix guidance, written once |
| Documentation link | `rule.helpUri` | ❌ | OWASP or CWE page for the class |
| Exact range | `region.startColumn/endLine/endColumn` | ❌ lines only | `endLine`; columns only if something produces them (§4) |
| Code evidence | `region.snippet.text` | ✅ the cited line, read from disk | keep |
| Stable identity | `result.partialFingerprints` | ✅ | keep |
| Data flow | `result.codeFlows[].threadFlows[].locations[]` | ✅ | keep |
| Other locations | `result.relatedLocations[]` | ❌ | entry point and cited lines, linked from the message |
| Structured patch | `result.fixes[]` | ❌ | not without real patches (§3.5) |

### 2.3 Scan context and lifecycle

| Field | SARIF location | Today | Possibility |
|---|---|---|---|
| Repository | `versionControlProvenance[].repositoryUri` | ✅ GitHub only | keep |
| Commit | `.revisionId` | ✅ | keep |
| Branch | `.branch` | ✅ | keep |
| Scan start/end | `invocations[].startTimeUtc`, `.endTimeUtc` | ❌ | from the CLI's `run-record.json` (`stages[]`, `created_at`, `updated_at`) |
| Completed? | `invocations[].executionSuccessful` | ❌ | false when the report is INCOMPLETE |
| Problems during the run | `invocations[].toolExecutionNotifications` | ❌ | failed lanes, blocked reads, cap reached |
| Command / config | `invocations[].commandLine`, `.arguments` | ❌ | arguments only; API keys come from env vars and never appear |
| Analysis category | `automationDetails.id` | ✅ stable category | keep |
| First / last seen | `result.provenance.firstDetectionTimeUtc`, `.lastDetectionTimeUtc` | ❌ | from the run store's index (see §5) |
| vs previous scan | `result.baselineState` | ❌ | new / unchanged / updated / absent, by fingerprint against the previous run |
| Suppression | `result.suppressions[]` | ❌ | from a committed suppressions file, with justification |
| Ticket | `result.workItemUris[]` | ❌ | out of scope |

---

## 3. Design calls to make (options, not decisions)

### 3.1 Rule granularity

- **A. One rule per vulnerability class (today).** The rule id never changes for
  a given class, which is what alert tracking needs (GitHub tracks an alert by
  rule plus fingerprint). Coarse: 14 rules.
- **B. One rule per CWE.** Closer to how CodeQL and Semgrep name rules and gives
  the user-facing title "SQL injection" directly. But the CWE is chosen by the
  model per finding and can change between runs, so the rule id, and with it
  the alert, would churn. Findings without a CWE need a fallback.
- **C. A, plus CWE and OWASP as SARIF `taxonomies` with `result.taxa[]`.** Keeps
  A's stability and still carries the classification in the standard place.

Leaning: C. Depends on whether CWE stays model-emitted (§4).

### 3.2 Severity, confidence and classification are different things

| Our concept | Candidate SARIF home |
|---|---|
| severity (critical/high/medium/low) | `result.level` + `result.properties.severity`; the rule carries a fixed `security-severity` |
| confidence 0 to 1, band | `result.properties.confidence`; optionally `result.rank` (0 to 100) from severity × confidence |
| vulnerability class | the rule |
| CWE, OWASP code | taxonomies + tags |
| attack scenario, per-finding remediation | `result.message.markdown` sections + properties (SARIF has no text-only per-result fix field) |
| class-level remediation | `rule.help` |
| coverage, status | `invocations[]`; optionally `run.artifacts[]` listing scanned files |

`level` is a diagnostic category, not a severity scale; `security-severity` and
`precision` are GitHub conventions in the property bag, not SARIF fields; GitHub
ignores property-bag keys outside its supported set, so confidence and the
explanation fields will not show in its UI. They still matter for the VS Code
viewer, for `findings.json` consumers and for anyone reading the file.

### 3.3 `precision`

- **A.** Compute a per-class precision proxy in the scorer (an aggregate, so
  publishable under the blind-development rule) and map it to
  very-high / high / medium / low.
- **B.** A flat value now. "low" is honest given the 12.5% floor on luna, but
  how GitHub treats "low" precision should be checked first.
- **C.** Omit until measured.

### 3.4 Message wording

1 to 2 sentences specific to the finding in `message.text`; everything else in
`message.markdown`, `rule.help` and properties. Check how GitHub builds its
alert title (rule `shortDescription` versus result message) before settling it.

### 3.5 `fixes[]`

A SARIF fix must carry concrete artifact changes (replacements). The scanner
produces none; the plan keeps remediation high-level and the patcher is out of
scope. A fabricated patch would be worse than none, so `fixes[]` stays empty
until a patcher produces verified patches.

### 3.6 Property naming

One documented camelCase set under `result.properties`, mirrored one to one in
`findings.json`, with a mapping table in `tools/scanner/report/README.md`
(finding → result, class → rule, trace → codeFlow, fingerprint →
partialFingerprints). The HTML and Markdown reports keep plain words.

---

## 4. Open question: which fields should the model emit?

This is why the work is deferred. Candidates:

| Field | Report computes it | Model emits it |
|---|---|---|
| CWE | from a class → CWE table (stable, coarse) | per finding (specific, can drift; already emitted since task 1d) |
| Precise sink span (columns, end line) | not possible from line-level traces | the model could name a column range; it would need the same disk check lines get |
| Per-finding remediation | not possible | already emitted (`remediation`) |
| Class-level help text | written once per class | n/a |
| Related locations | from the trace | n/a |
| Rule title for a finding | from the class | the finding `title` already is one |
| Exploitability / preconditions | no | partly in `attack_scenario`; a structured form would be new schema |
| Validation status | no verifier exists | would come from a verification stage (§2.12 of the plan) |

Every model-emitted field costs output tokens on every lane, twice under the
trace loop, and any field that becomes a location must be checked against the
file on disk, as lines are now.

---

## 5. Dependencies

- **Run store** (added in task 1d, implemented; see `tools/scanner/report/README.md`):
  `<store>/index.json` and each run's `findings.json` and `run-record.json` make `baselineState` and
  first/last detection computable locally, by fingerprint against earlier runs.
- **Suppressions** need a committed file format (team decisions belong in the
  repository, not in the git-ignored store), plus how GitHub treats SARIF
  suppressions on upload, which should be checked.
- **GitHub-specific behaviour** (alert title, annotations, precision handling,
  upload limits) can only be proven by a real upload: the Report row re-run in
  Step 3 (Option B).

## 6. Validation when this is picked up

- Keep the OASIS 2.1.0 schema check.
- Add Microsoft's SARIF Multitool validation (https://github.com/microsoft/sarif-sdk),
  which has rules aimed at GitHub ingestion; confirm the current option names.
- Check GitHub's current upload limits (file size, results per run). Luna run 6's
  SARIF is about 6 MB uncompressed.

## References

- OASIS SARIF 2.1.0: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
- GitHub, SARIF support for code scanning: https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
