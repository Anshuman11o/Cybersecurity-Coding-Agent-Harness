# Partition SG-1 — NAV Trace Results

Scope: CSRF, IDOR, auth bypass, conditional validation bypass, identity spoofing,
confused deputy, mass assignment, parameter pollution. TS sources only.

Shared crypto facts (lib/insecurity.ts): `hash`=MD5 (41), `hmac`=SHA256 w/ hardcoded
key (42), `authorize`=jwt.sign RS256 (54), `verify`=jws.verify vs publicKey (55),
`decode`=jws.decode payload (56), `authenticatedUsers` in-memory token map (70).

---

## Dispositions

### Input #1 — login.ts:33 `email`,`password` (POST /rest/user/login, unauth)
**CROSS-CLASS (INJ)** — sink is string-interpolated SQL:
`SELECT * FROM Users WHERE email = '${req.body.email}' AND password = '${hash(...)}'`
at routes/login.ts:33. Classic SQLi → authentication bypass. Sink class is SQL
injection (INJ), not a NAV authz sink. Flag: CROSS-CLASS (#1, login.ts:33, INJ).
Note for INJ: exploitable auth bypass (`' OR 1=1--`).

### Input #31 — changePassword.ts `current`,`new`,`repeat` (GET /rest/user/change-password, auth)
**CANDIDATE** — see VULN-001 (missing current-password / CVB) and VULN-002 (CSRF).

### Input #32 — resetPassword.ts `email`,`answer`,`new`,`repeat` (POST /rest/user/reset-password, unauth)
**DESIGN-INTENT / SAFE.** Reset flow verifies `hmac(answer) === data.answer` (resetPassword.ts:41)
before `user.update({ password: newPassword })` (44). Only `password` is written — no
mass-assignment (Request Body Gate: mapper writes single literal field, not the body).
Email/answer used only for lookup + HMAC compare. Security-question knowledge is the
intended credential. No NAV finding. (Weak: unlimited answer guesses / no lockout in
code — informational, not recorded as candidate.)

### Input #33 — securityQuestion.ts `email` (GET /rest/user/security-question, unauth)
**SAFE.** `email` reaches Sequelize `where: { email: email?.toString() }`
(securityQuestion.ts:19) — parameterized, no SQLi. Returns only the security-question
text for the email. Resource ID Gate: no state change, non-sensitive public-ish lookup
required by the reset flow (self-service). DESIGN-INTENT. (Minor email-enumeration /
question disclosure — informational only.)

### Input #34 — 2fa.ts `tmpToken`,`totpToken`,`password`,`setupToken`,`initialToken` (/rest/2fa/*, mixed)
**SAFE / DESIGN-INTENT.**
- `verify`: `tmpToken` is server-signed (login.ts:40, type `password_valid_needs_second_factor_token`),
  re-verified via `security.verify` + type check (2fa.ts:20-24); TOTP checked against
  the bound user's `totpSecret` (31). Identity comes from the signed token's `userId`,
  not a raw request field — no spoofing.
- `setup`/`disable`: identity from `authenticatedUsers.from(req)` (session token), password
  re-confirmed (`user.password !== hash(password)`, 2fa.ts:107/152), `setupToken` server-signed
  with type `totp_setup_secret` (115-118), `initialToken` TOTP-verified against the signed
  secret (119). Secret is bound to a server signature so the client cannot inject an
  arbitrary secret. No IDOR (operates on own session's user id), no CVB (missing password/token
  fails closed via thrown error → 401).

---

## Candidates

#### [VULN-001] Change-password does not require the current password (auth bypass of re-auth)
- **Input**: #31 query `current`,`new`,`repeat`
- **Class**: CWE-620 (Unverified Password Change) / conditional validation bypass
- **Severity**: Medium
- **Location**: routes/changePassword.ts:39
- **Gate 0**: Not intended — the current-password check exists but is skippable; a
  validation that can be silently disabled is a vulnerability, not a feature.
- **Gate 1**: Reachable — mounted `app.get('/rest/user/change-password', changePassword())` in server.ts.
- **Gate 2a**: Attacker-controlled — `current`/`new` are raw query params.
- **Gate 2b**: The guard is `if (currentPassword && hash(currentPassword) !== loggedInUser.data.password)`
  (changePassword.ts:39). When `current` is **omitted**, the boolean short-circuits and the
  check is skipped — fails open. New password applied unconditionally (51).
- **Gate 3**: Attacker who obtains a session token (e.g. via XSS/token leak, or CSRF below)
  changes the victim's password without knowing the old one → full account takeover, and
  can lock the victim out. Not otherwise achievable without the current password.
- **Entry Point**: GET /rest/user/change-password
- **Data Flow**: query.current/new → changePassword.ts:14-17 → guard skipped (39) → user.update({password}) (51)
- **Root Cause**: Presence-gated re-authentication (`if (currentPassword && ...)`) instead of mandatory check.

#### [VULN-002] Change-password is a state-changing GET with no CSRF protection
- **Input**: #31 query `current`,`new`,`repeat`
- **Class**: CWE-352 (CSRF)
- **Severity**: Medium
- **Location**: routes/changePassword.ts:12-57 (handler); registered as GET in server.ts
- **Gate 0**: Not intended — password change should not be a cross-site-forgeable GET.
- **Gate 1**: Reachable production route.
- **Gate 2a/2b**: No CSRF token validated anywhere in the handler; auth is a Bearer token
  the browser/app supplies, and no anti-CSRF middleware is mounted app-wide. Combined with
  VULN-001, an attacker page issuing `GET /rest/user/change-password?new=x&repeat=x`
  (image/link) changes the victim's password with no current-password needed.
- **Gate 3**: Cross-site account takeover of any logged-in victim via a single forged GET.
- **Entry Point**: GET /rest/user/change-password
- **Data Flow**: forged cross-site GET → query params → password update (51) with no token/origin check.
- **Root Cause**: Sensitive mutation exposed over GET without CSRF token or SameSite enforcement.

---

## Post-Trace Authorization-Helper Coverage Audit
Handlers in this partition each gate correctly relative to their purpose: login (unauth by
design), resetPassword/securityQuestion (unauth self-service reset flow), changePassword
(session-token via authenticatedUsers), 2fa (session-token + signed tokens). No sibling
handler invokes an authz helper that a peer omits. No additional CWE-862 gap.
