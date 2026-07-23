export const playbook = `
Playbook for Cryptographic and Authentication Failures (OWASP A02, A07, API2)
============================================================================

Scope: Detect weak or incorrect implementations of cryptography, authentication, and session management.

## OWASP Categories Covered
- OWASP A02: Cryptographic Failures
- OWASP A07: Identification and Authentication Failures
- OWASP API2: Broken Authentication

## Sink Patterns to Hunt For
1. Password hashing: Look for md5(), sha1(), sha256() used alone for password storage. Acceptable: bcrypt, argon2, scrypt (with appropriate cost/work factors). Any hash without salt is a finding.
2. JWT handling: algorithm confusion (accepting alg:none, switching from RS256 to HS256 with the public key as HMAC secret), weak or hardcoded signing secrets, missing expiration (exp) claims, tokens accepted without signature verification.
3. Session management: predictable session token generation (Math.random(), incrementing IDs), missing Secure/HttpOnly/SameSite flags on cookies, session IDs exposed in URLs.
4. Security questions: low-entropy questions (mother's maiden name, birth city), predictable or guessable answers, no rate limiting on answer attempts.
5. 2FA implementation: TOTP seed generation with weak entropy, missing 2FA verification on sensitive operations (password change, email change, account deletion), 2FA bypass via backup codes without rate limiting.

## Distinguishing Real Findings from False Positives
- The mere presence of cryptographic or authentication mechanisms is NOT a finding. Every app needs them.
- The finding is in weak implementation: wrong algorithm, missing controls on the critical path, or bypassable enforcement.
- A finding requires demonstrating how the weakness can be exploited: e.g., "sha256 without salt enables rainbow table lookup" or "alg:none acceptance enables token forgery."
- Missing optional hardening (e.g., no PBKDF2 iterations, missing certificate pinning) is a recommendation, not a vulnerability.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The specific cryptographic/auth operation
2. The weakness (algorithm, missing check, predictable generation)
3. The attack path: how an attacker exploits the weakness
4. The impact: what unauthorized access or data exposure results.
`;
