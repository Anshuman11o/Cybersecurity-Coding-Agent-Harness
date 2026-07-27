# SG-1 INJ Trace Results

Partition SG-1 (Auth/Login/Password reset/2FA). Class group: INJ.

## Input dispositions

| # | Input | Disposition | Sink | Class |
|---|---|---|---|---|
| 1 | login.ts:33 `email`,`password` | **CANDIDATE** (email) / SAFE (password) | login.ts:33 | CWE-89 SQLi |
| 31 | changePassword.ts `current`,`new`,`repeat` | SAFE (INJ) + CROSS-CLASS(LOG, CWE-620) | user.update (param ORM) | — |
| 32 | resetPassword.ts `email`,`answer`,`new` | SAFE (parameterized ORM) | findOne where:{email}, update | — |
| 33 | securityQuestion.ts `email` | SAFE (parameterized ORM) | findOne where:{email} | — |
| 34 | 2fa.ts `tmpToken`,`totpToken`,`password`,`setupToken` | SAFE (INJ) | JWT verify/decode, verifySync, findByPk | — |

---

## [VULN-001] SQL Injection in login query (email)
- **Input**: #1: HTTP body field `email` (POST /rest/user/login), unauthenticated
- **Class**: CWE-89: SQL Injection
- **Severity**: High+ (unauthenticated auth bypass + full Users table read)
- **Location**: routes/login.ts:33
- **Gate 0 (intended behavior?)**: No. Login is designed to authenticate, not to
  expose the DB. Interpolating raw user input into SQL is not an intended feature.
- **Gate 1 (reachable?)**: Yes. `login()` handler mounted at POST /rest/user/login
  (unauth entry point per shared context / threat model).
- **Gate 2a (attacker-controlled?)**: Yes. `req.body.email` is anonymous-client
  HTTP body, no auth required.
- **Gate 2b (sanitization?)**: None. `req.body.email || ''` is directly interpolated
  into a template-literal raw SQL string passed to `models.sequelize.query(...)`.
  No escaping, no parameter binding. `password` is neutralized via
  `security.hash()` -> `crypto.createHash('md5').digest('hex')` (insecurity.ts:41),
  which yields hex only, so password is NOT injectable — email is the sole vector.
- **Gate 3 (new capability?)**: Yes. Classic `' OR 1=1--` authenticates as any/first
  user without credentials; UNION payloads read arbitrary Users columns. No existing
  path grants unauthenticated account access or table exfiltration.
- **Entry Point**: POST /rest/user/login
- **Data Flow**: req.body.email (login.ts:32-33) -> template literal
  `SELECT * FROM Users WHERE email = '${req.body.email || ''}' ...`
  -> models.sequelize.query(raw, {model: UserModel, plain: true}) (login.ts:33)
- **Root Cause**: User-controlled `email` string-interpolated into a raw
  Sequelize SQL query instead of using bind parameters.
- **Exploitability**: Trivial, single unauthenticated request. e.g.
  `email = "' OR 1=1--"` logs in as first user (admin);
  `' UNION SELECT ...--` dumps table data.

---

## Cross-class notes
- **CROSS-CLASS(LOG, CWE-620)** — changePassword.ts:39 `current` password check
  only runs `if (currentPassword)`; omitting `current` skips verification entirely
  (unverified password change for a session token). Not INJ; routed to LOG/NAV.
