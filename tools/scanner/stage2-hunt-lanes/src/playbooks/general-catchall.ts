export const playbook = `
Playbook for Unsafe API Consumption and Uncategorized Findings (API10, General)
===============================================================================

Scope: Detect unsafe consumption of third-party API responses and any other categories not covered by specialized playbooks.

## OWASP Categories Covered
- OWASP API10: Unsafe Consumption of APIs
- Additional categories identified during reconnaissance but not yet classified

## Sink Patterns to Hunt For
1. Outbound calls to third-party APIs whose response drives control flow without schema validation: the application makes decisions based on unvalidated external API responses (e.g., trusting a payment gateway's response without verifying signature, acting on a third-party identity assertion without validating the token).
2. Accepting data from external systems without integrity checks: no checksums, no signatures, no allow-listing of expected response structures.
3. Trusting external redirect targets without allow-listing: open redirect vulnerabilities where a URL parameter controls the redirect destination without validation against a known-good list.
4. Blindly trusting webhook/callback payloads without verifying the source (missing HMAC verification, missing source IP validation, missing signature validation).
5. Aggregating data from multiple external sources without reconciling conflicting or contradictory values.

## Distinguishing Real Findings from False Positives
- Calling an external API is normal. Trusting its response blindly for security decisions without validation is the finding.
- A third-party API that is well-known and has strong SLAs (e.g., Stripe, AWS) still requires response validation — the finding is not "this provider is untrustworthy" but "this application does not validate responses."
- An open redirect is a finding when the redirect target can be controlled by an attacker and the redirect occurs in a security-sensitive context (post-login redirect, password reset redirect).
- For uncategorized findings from recon: the finding must still meet the standard bar — concrete entrypoint-to-sink trace, specific attack scenario, and named impact.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint consuming external data
2. The missing validation or integrity check
3. The downstream decision driven by the unvalidated data
4. The security impact: incorrect authorization, data corruption, redirect abuse.
`;
