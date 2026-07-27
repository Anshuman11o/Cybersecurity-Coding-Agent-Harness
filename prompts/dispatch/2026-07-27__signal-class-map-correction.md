# Dispatch — Correct the signal→class map, then regenerate Stage 0.5

Small change. Edit one data file and re-run one component. Do not touch detector code.

## Why

The signal narrowing works mechanically — 553 hunt lanes went from 15 classes each to a median of
5, coverage ledger intact. But an offline check against the benchmark found that the mapping puts
24 of 98 known vulnerabilities out of reach: their class is not assigned to their file's lane, so no
model could find them regardless of quality. Ranked by frequency, the missing classes were
`misconfiguration` (14), `injection` (6), `ssrf` (2), `resource-consumption` (1), `crypto-auth` (1).

The detectors are fine. Every one of those files carries sensible signals. The mapping is what is
too narrow, in five specific ways, each of which is a general property of the class rather than a
fact about any particular file:

- **`misconfiguration` is not a code shape, it is a setting**, and a dangerous setting can be
  written in any file — a parser configured to expand entities, an upload with no size limit, a
  static handler with directory listing on. Deriving it only from `config_file` (which matched 4
  files) misses every in-code instance. It belongs in the floor, for the same reason
  `insecure-design` does: the pattern is an absence or an option, not a marker you can search for.
- **A route handler is by definition where untrusted input enters** the application, so it is a
  candidate entrypoint for injection, and it is where authentication and session handling are
  enforced or forgotten.
- **A model schema defines setters that transform untrusted input** before it is persisted, so it
  is an injection site even when no query call appears in the file.
- **Fetching a resource the caller names is the SSRF shape**, whether the name is a URL or a path.
- **Unbounded consumption arises wherever a request causes work** — a query, a parse, a file read,
  an outbound call — not only where an explicit limit is configured.

## The change

Replace `tools/scanner/shared/signal-classes.json` with exactly this:

```json
{
  "floor": ["insecure-design", "logging-monitoring", "general-catchall", "misconfiguration"],
  "signals": {
    "route_handler":  ["access-control", "api-property-auth", "resource-consumption", "injection", "crypto-auth"],
    "db_query":       ["injection", "api-property-auth", "resource-consumption"],
    "model_schema":   ["api-property-auth", "access-control", "injection"],
    "model_write":    ["injection", "integrity-failures"],
    "http_outbound":  ["ssrf", "resource-consumption"],
    "auth_check":     ["access-control", "crypto-auth"],
    "crypto_op":      ["crypto-auth"],
    "html_sink":      ["client-side", "injection"],
    "dynamic_exec":   ["injection"],
    "deserialize":    ["integrity-failures", "injection", "resource-consumption"],
    "file_io":        ["injection", "access-control", "ssrf", "resource-consumption"],
    "llm_call":       ["ai-llm-agency", "client-side"],
    "logging":        ["logging-monitoring"],
    "config_file":    ["misconfiguration", "vulnerable-components"],
    "dep_manifest":   ["vulnerable-components"]
  }
}
```

Then **re-run Stage 0.5 only** so `lane-assignments.json` picks it up.

Do **not** re-run Stage 0. The signals themselves are unchanged, and `file-signals.json` is already
correct on disk at `tools/scanner/stage0-recon/output/file-signals.json`. That directory is listed
in a `.gitignore` even though its files are tracked, so a search honouring ignore rules will not
show it — read it by path.

Do **not** run Stage 2. No scan.

## One detector note, to report but not fix

`dep_manifest` fired on **zero** files. Check whether dependency manifests are being classified as
skip lanes rather than hunt lanes, and report what you find. Do not change the skip logic in this
task.

## Report back

- The new distribution of classes per hunt lane, against the previous
  `{3: 176, 4: 63, 5: 125, 6: 72, 7: 50, 8: 39, 9: 22, 10: 5, 11: 1}` and the pre-narrowing
  `{2: 7, 15: 546}`.
- Confirmation the coverage ledger is unchanged: 918 = 553 hunt + 365 skip, 0 unaccounted.
- What you found about `dep_manifest`.

## Constraints

Work only inside this repository. `target-apps/` is read-only. Never search for, read, or reference
any answer-key or ground-truth material anywhere on this machine.
