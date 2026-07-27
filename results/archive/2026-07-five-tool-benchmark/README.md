# Five-tool scan-only benchmark (July 2026) — ARCHIVED

Five existing open-source AI security scanners run against a 10-challenge subset
of the target app, scored on precision, recall and localization.

## Status: superseded

This measured a 10-entry ground truth. Current evaluation uses the 98-entry set,
so these numbers are not comparable to current results and should not be cited
as a live baseline.

It is kept because it is the provenance for decisions still in force:

- the operative targets in `docs/protocols/eval-framework.md`
  (precision >= 95%, recall >= 90%, localization >= 90%)
- the architectural conclusion that pattern matching alone misses logic-heavy
  vulnerability classes, which is why hunt lanes reason rather than pattern-match
- per-lane rather than global budget ceilings, after one tool died on a
  single org-wide spend cap
- stopping on a budget estimate rather than merely reporting it, after another
  tool correctly predicted its own cost and then timed out anyway

## Redaction

Challenge identifiers have been replaced with `[REDACTED]`. The original files
enumerated which ground-truth challenges each tool found, which is answer-key
material and must not sit in a repository the scanning agent can read. The
unredacted originals are in the private eval archive.
