# Stage 4 — Output

**Not built.** This documents the design target, not existing code.

## Intended input
Stage 3 verdicts plus validator evidence.

## Intended output
A schema-validated `findings.json` plus a human-readable summary, with a thin
SARIF projection for interop.

The schema follows the report schema of the highest-scoring benchmarked tool,
with two additions this architecture needs:

- `categories[]` — multi-label rather than one forced category, because a single
  line can genuinely belong to more than one vulnerability class
- `lane_provenance` — which lane produced the candidate, so a wrong finding can
  be traced back to the playbook that caused it

## Notes
No model call should be needed if Stage 3 already emits schema-shaped fields.
`remediation.code_changes[].fixed_code` stays empty in this scan-only phase —
the field exists for forward compatibility, but designing fixes is the patcher's
job, not the scanner's.
