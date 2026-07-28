export const playbook = `
Playbook for Cryptographic and Authentication Failures (OWASP A02, A07)
=======================================================================

Scope: Detect weak or incorrect implementations of cryptography, authentication, session management, and identity verification.

## OWASP Categories Covered
- OWASP A02: Cryptographic Failures
- OWASP A07: Identification and Authentication Failures

## Sink Patterns to Hunt For

### Cryptographic Weaknesses
1. Password storage using unsalted or weak hash functions (MD5, SHA-1, SHA-256 without key stretching). Acceptable: bcrypt, Argon2, scrypt with appropriate cost/work factors.
2. Use of deprecated or broken cryptographic algorithms for data protection: DES, RC4, MD5 for integrity, SHA-1 for signatures.
3. Hardcoded cryptographic keys, initialization vectors, or secrets in source code or configuration.
4. Missing encryption for sensitive data at rest or in transit where it is expected (e.g., credentials, personal data, payment information).

### Authentication Weaknesses
5. Token/signature handling: acceptance of tokens without signature verification, algorithm confusion (accepting "none" algorithm or switching asymmetric to symmetric with public key as secret), weak or hardcoded signing secrets, missing expiration claims.
6. Session management: predictable session token generation (weak random number generators, incrementing IDs), missing secure flags on session cookies, session IDs exposed in URLs.
7. Password reset flows: tokens with insufficient entropy, tokens that do not expire, tokens sent via insecure channels, reset flows that reveal whether an account exists.
8. Multi-factor authentication: bypassable MFA on sensitive operations (password change, email change, account deletion), weak MFA seed generation, missing rate limiting on MFA verification.

## Distinguishing Real Findings from False Positives
- The mere presence of cryptographic or authentication mechanisms is NOT a finding. Every application needs them.
- The finding is in weak implementation: wrong algorithm, missing controls on the critical path, bypassable enforcement, or secrets exposed in code.
- A finding requires demonstrating how the weakness can be exploited: e.g., "unsalted hash enables precomputed lookup" or "missing signature verification enables token forgery."
- Missing optional hardening is a recommendation, not a vulnerability.
- A validation layer that explicitly rejects weak configurations before they take effect is a valid control.

## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the identity is established correctly and the gap is that a verified caller reaches a
  resource that is not theirs — that is access-control
- the weak value is a framework or library option left at an unsafe default rather than
  an algorithm or protocol implemented incorrectly here — that is misconfiguration
- the algorithm is sound but the library version implementing it is known-vulnerable —
  that is vulnerable-components
- the secret is handled correctly but written to a log, trace, or error response — that
  is logging-monitoring
- the flow is authenticated correctly and the design still permits the abuse — that is
  insecure-design

Choose crypto-auth when the secret, token, hash, or identity proof is itself forgeable,
guessable, replayable, or protected by an algorithm inadequate for its purpose.

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The specific cryptographic/auth operation
2. The weakness (algorithm, missing check, predictable generation, exposed secret)
3. The attack path: how an attacker exploits the weakness
4. The impact: what unauthorized access or data exposure results.
`
