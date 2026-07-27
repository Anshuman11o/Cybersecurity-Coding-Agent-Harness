# Partition SG-10 — NAV Trace Results

## Dispositions

| # | Input | Disposition | Sink | Class |
|---|---|---|---|---|
| 49 | finale `role` (POST /api/Users) | **CANDIDATE** | server.ts:474/494/504; models/user.ts:74-93 | CWE-915 mass assignment |
| 49 | finale User list (GET /api/Users) | **CANDIDATE** | server.ts:494-500 | CWE-639 over-exposure |
| 29 | header `true-client-ip` | **CANDIDATE** | saveLoginIp.ts:18-32 | CWE-290 signal spoofing |
| 35 | `captchaId`,`captcha` | **SAFE** | captcha.ts:37-42 | answer match enforced; replay = anti-automation only |
| 36 | imageCaptcha `answer` | **NO-MATCH** | imageCaptcha.ts | captcha logic, not NAV |
| 27 | cookie `token` | **CROSS-CLASS** | insecurity.ts JWT verify (RS256/pubkey) | LOG/crypto |
| 28 | query `callback` | **CROSS-CLASS** | currentUser.ts:58 res.jsonp | INJ (JSONP XSS) |
| 28 | query `fields` | **SAFE** | currentUser.ts:27-33 | own-session data only, not cross-principal |
| 50 | websocket `data` | **CROSS-CLASS** | registerWebsocketEvents.ts | INJ (message injection) |

---

## [VULN-SG10-1] Privilege escalation via `role` mass-assignment on open registration
- **Input**: #49 — POST /api/Users body field `role`
- **Class**: CWE-915 Mass Assignment / CWE-269 Privilege Escalation
- **Severity**: High+ (unauthenticated → admin)
- **Location**: server.ts:474 (finale.initialize) / :494 (User resource) / models/user.ts:74-93
- **Gate 0**: Registration is intended, but assigning oneself `role: admin` is NOT the designed function — Request Body Gate forbids DESIGN-INTENT for body fields based on caller trust.
- **Gate 1**: Reachable — POST /api/Users is public (no auth guard; only get/put/delete of /api/Users are guarded, server.ts:358-362). Registration pre-hooks (server.ts:403-417) only trim email/password and solve challenges; none strips `role`.
- **Gate 2a**: Fully attacker-controlled — anonymous JSON body.
- **Gate 2b**: No field-level authorization. `role` setter (models/user.ts:80) accepts the value; `validate.isIn` (line 78) explicitly whitelists `'admin'`. Finale `create` copies every non-excluded attribute (`exclude: ['password','totpSecret']` only, server.ts:477) — `role` passes through unfiltered.
- **Gate 3**: New capability = attacker registers a self-controlled admin account (admin API, admin sections, all-user data).
- **Data Flow**: POST /api/Users `{email,password,role:"admin"}` → server.ts:403-417 (no role strip) → finale create server.ts:494/504 → UserModel.init role.set models/user.ts:80-92 → persisted role=admin.
- **Root Cause**: Auto-CRUD create trusts client-supplied `role`; no beforeCreate hook forces `role='customer'` on registration.

## [VULN-SG10-2] Any authenticated user can enumerate all users' emails (finale over-exposure)
- **Input**: #49 — GET /api/Users
- **Class**: CWE-639 / CWE-200 broken read authorization
- **Severity**: Medium
- **Location**: server.ts:358 (isAuthorized only), :494-500
- **Gate 1**: GET /api/Users guarded by `security.isAuthorized()` (authentication only, no per-record ownership). Finale list returns every User row (excludes only password/totpSecret) — email, role, lastLoginIp, deluxeToken of all principals to any low-priv registered user.
- **Root Cause**: Authentication credited as authorization; no field/row scoping on the auto-CRUD list endpoint.

## [VULN-SG10-3] Spoofable `true-client-ip` header stored as login-IP audit signal
- **Input**: #29 — request header `true-client-ip`
- **Class**: CWE-290 Security-Signal / Identity Spoofing
- **Severity**: Low-Medium
- **Location**: saveLoginIp.ts:18-32
- **Gate 0**: NAV Gate-0 exemption applies — attacker-controlled value flowing into a security/attribution signal breaks trust binding.
- **Gate 1**: Reachable via GET /rest/saveLoginIp for any authenticated user.
- **Gate 2a**: Fully attacker-controlled header; no proxy/trusted-source validation.
- **Gate 2b**: Only `sanitizeSecure` (XSS-oriented) applied, and skipped entirely when [REDACTED] enabled (line 22-24). No IP-format validation.
- **Gate 3**: Attacker forges their own `lastLoginIp` audit record (falsify login origin; also stored-XSS vector rendered in whoami/profile).
- **Root Cause**: `req.headers['true-client-ip']` trusted verbatim over `req.socket.remoteAddress`.

## Authorization Helper Coverage audit
POST /api/Users registration path intentionally has no auth (public registration) — the gap is field-level (`role`), captured in VULN-SG10-1, not a missing endpoint guard.
