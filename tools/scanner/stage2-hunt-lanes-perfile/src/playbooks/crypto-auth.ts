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

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The specific cryptographic/auth operation
2. The weakness (algorithm, missing check, predictable generation, exposed secret)
3. The attack path: how an attacker exploits the weakness
4. The impact: what unauthorized access or data exposure results.
`
