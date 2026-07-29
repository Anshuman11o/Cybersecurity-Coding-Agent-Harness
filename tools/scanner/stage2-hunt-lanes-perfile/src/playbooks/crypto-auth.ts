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

### The authentication-outcome anchor
The patterns above describe defects *in* an authentication mechanism. This class is also established by a defect of any *other* kind that changes who the application believes the caller is.

9. When a defect lets an attacker reach an authenticated state, skip a credential check, control whose identity is selected, or influence the outcome of an identity decision, that defect establishes this class **as well as** the class of the mechanism it abuses. Name both. Choosing only the mechanism class discards the authentication consequence, which is the part an attacker actually uses.
10. The code shapes where this applies are structural, not incidental — treat a defect at any of them as establishing this class:
   - the query, comparison, or lookup that verifies a credential and decides whether login succeeds
   - the statement that issues, signs, or sets a session token, cookie, or API key
   - a password-reset, security-question, or account-recovery decision
   - a multi-factor or step-up verification decision
   - any code that resolves a request to a user identity that later authorizes an action
11. Concretely: an injection flaw in a credential-verification query is both an injection finding and an authentication finding, on the same line and the same trace, because it yields authentication bypass. A missing rate limit on a login or reset endpoint is both a resource-consumption finding and an authentication finding, because it permits credential brute force. A predictable or forgeable identity token is both an integrity finding and an authentication finding.

## Distinguishing Real Findings from False Positives
- The mere presence of cryptographic or authentication mechanisms is NOT a finding. Every application needs them.
- The finding is in weak implementation: wrong algorithm, missing controls on the critical path, bypassable enforcement, or secrets exposed in code.
- A finding requires demonstrating how the weakness can be exploited: e.g., "unsalted hash enables precomputed lookup" or "missing signature verification enables token forgery."
- Missing optional hardening is a recommendation, not a vulnerability.
- A validation layer that explicitly rejects weak configurations before they take effect is a valid control.

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The specific cryptographic/auth operation
2. The weakness (algorithm, missing check, predictable generation, exposed secret)
3. The attack path: how an attacker exploits the weakness
4. The impact: what unauthorized access or data exposure results.
`
