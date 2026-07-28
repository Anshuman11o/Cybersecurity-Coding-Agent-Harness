export const playbook = `
Playbook for Unclassified and General Findings
===============================================

Scope: Detect any vulnerability that does not fit the specialized playbook categories but still meets the bar for a concrete, exploitable finding.

## Categories Covered
- Any vulnerability class not covered by specialized playbooks
- OWASP API10: Unsafe Consumption of APIs (blindly trusting external responses)

## Sink Patterns to Hunt For
1. Unsafe consumption of third-party API responses: making security decisions based on unvalidated external responses (e.g., trusting a payment gateway response without verifying a signature, acting on an external identity assertion without validating the token).
2. Trusting external redirect targets without allow-listing: open redirect vulnerabilities where a URL parameter controls the redirect destination.
3. Blindly trusting webhook/callback payloads without verifying the source (missing signature verification, missing source validation).
4. Any other exploitable pattern that does not fit the specialized categories: race conditions, logic flaws, information disclosure, or novel attack vectors.

## Distinguishing Real Findings from False Positives
- The standard bar applies: concrete entrypoint-to-sink trace, specific attack scenario, and named impact.
- "Could be improved" is not a finding. The finding must demonstrate exploitability.
- For uncategorized findings: the finding must still meet the standard rigor — a named vulnerability class, a concrete trace, and a clear impact statement.

## Distinguishing From Adjacent Classes
This is the class of last resort. Before choosing it, confirm the finding matches none of
the specific classes — in particular:
- an outbound request to a caller-influenced destination is ssrf, never this class
- an unsafe option, default, or exposed surface is misconfiguration
- an unverified payload or update channel is integrity-failures
- a response consumed without schema validation, where the destination is fixed and the
  trust is misplaced, is integrity-failures

Choose general-catchall only when the defect is genuinely real and traceable but fits no
other class in the assigned set. Preferring it over a specific class that applies is a
labelling error, not caution.

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The entrypoint accepting external input or making external calls
2. The missing validation or control
3. The downstream exploitation path
4. The security impact.
`
