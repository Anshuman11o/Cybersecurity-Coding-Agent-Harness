# SG-1 LOG-class Trace Results — Auth / Login / Password reset / 2FA

Partition SG-1. Class group: race/cache/credential-scope/resource-exhaustion/
proto-pollution/crypto/int-overflow. Sources audited: routes/login.ts,
changePassword.ts, resetPassword.ts, securityQuestion.ts, 2fa.ts,
lib/insecurity.ts, server.ts.

## Disposition Summary

| # | Input | LOG Disposition | Sink | Class |
|---|-------|-----------------|------|-------|
| 1 | login email/password | CROSS-CLASS(INJ) for SQL; CANDIDATE(LOG) no-rate-limit + MD5 hash | login.ts:33 | CWE-307 / CWE-916 |
| 31 | change-password current/new | CANDIDATE(LOG) | changePassword.ts:39 | CWE-620 |
| 32 | reset-password email/answer/new | CANDIDATE(LOG) | server.ts:343 | CWE-307 |
| 33 | security-question email | SAFE (ORM-parameterized); CROSS-CLASS(NAV) email enum | securityQuestion.ts:18 | — |
| 34 | 2fa tmpToken/setupToken/password | SAFE / DESIGN-INTENT | 2fa.ts | — |

---

## [VULN-LOG-01] Password-reset rate limiter keyed on attacker-controlled header
- **Input**: #32 body email/answer/new to POST /rest/user/reset-password
- **Class**: CWE-307 (Improper Restriction of Excessive Auth Attempts) / rate-limit scope bypass
- **Severity**: High (account takeover via security-answer brute force)
- **Location**: server.ts:340-344 (keyGenerator), consumed by resetPassword.ts:41
- **Gate 0**: Not intended — the rate limit exists specifically to stop brute force; its key is trivially rotatable, defeating the control.
- **Gate 1**: Reachable — mounted at server.ts:340, route server.ts:590.
- **Gate 2a**: `keyGenerator` returns `headers['X-Forwarded-For'] ?? ip`; X-Forwarded-For is fully attacker-controlled and unauthenticated.
- **Gate 2b**: No normalization/trusted-proxy check. Attacker sends a unique XFF per request → each gets its own 100/5min bucket → effectively unlimited attempts.
- **Gate 3**: New capability = unlimited guesses of `security.hmac(answer)` (resetPassword.ts:41) against a known security question (leaked by input #33), yielding password reset of any account. Counter-scope-bypass rule (class file) applies.
- **Data Flow**: X-Forwarded-For header → keyGenerator (server.ts:343) → per-key bucket → bypass → SecurityAnswerModel compare (resetPassword.ts:41) → user.update password (resetPassword.ts:44).

## [VULN-LOG-02] change-password skips current-password check when omitted (CWE-620)
- **Input**: #31 query `current`,`new`,`repeat` to GET /rest/user/change-password
- **Class**: CWE-620 Unverified Password Change (Conditional Validation Bypass)
- **Severity**: High (aids CSRF account takeover; CVB — immune to Gate 0/Gate 3 dismissal)
- **Location**: changePassword.ts:39
- **Analysis**: `if (currentPassword && security.hash(currentPassword) !== loggedInUser.data.password)` — the current-password check runs ONLY when `current` is present. Omit `current` entirely and the guard is skipped; password is updated (line 51) with no proof of knowing the old one. Absent-input fail-open. Combined with credentials-in-GET-querystring this is a CSRF password change.
- **Gate 2a**: `query.current`/`query.new` attacker-controlled; session from Bearer header.
- **Data Flow**: absent `current` → guard at :39 skipped → user.update({ password: newPasswordInString }) at :51.

## [VULN-LOG-03] No anti-automation on login (CWE-307)
- **Input**: #1 POST /rest/user/login
- **Location**: server.ts:588 — no rateLimit mounted (unlike reset-password/2fa).
- **Severity**: Low (overshadowed by SQLi auth bypass at login.ts:33, but independent finding).
- Enables offline-free credential brute force; note SQLi (CROSS-CLASS INJ) is the dominant issue here.

## Crypto notes (lib/insecurity.ts)
- CANDIDATE/DESIGN-INTENT: `hash` = unsalted MD5 for passwords (insecurity.ts:41, CWE-916); `hmac` uses hardcoded key literal (insecurity.ts:42, CWE-321). Both are Juice-Shop intentional and shared across partitions — flag once, low actionability.
- 2FA (input #34): `security.verify`+`decode` (2fa.ts:20,115) rely on jws/publicKey; RS256-public-key-as-secret weakness noted in shared context, rooted in insecurity.ts:52-56 — CROSS-CLASS shared node, not re-scored here. setupToken binds only {secret,type} but setup() gates on session user + password + totpSecret==='' → no cross-user binding gap. SAFE.

## CROSS-CLASS flags
- #1 login.ts:33 — SQL string interpolation → CROSS-CLASS(INJ, CWE-89).
- #33 securityQuestion.ts:18 — email enumeration leaks security question → CROSS-CLASS(NAV, info disclosure). ORM-parameterized so no SQLi.
