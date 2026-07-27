# SG-4 NAV Trace Results (CSRF, IDOR, auth bypass, CVB, identity spoofing, confused deputy, mass assignment, param pollution)

Partition: Profile / SSTI / SSRF / image + Data erasure
Auditor: NAV / partition SG-4

## Per-input dispositions

### #4 — body `imageUrl` (profileImageUrlUpload.ts:19) — POST /profile/image/url
- **IDOR (Resource ID Gate):** SAFE. File write path and `UserModel.findByPk` both use `loggedInUser.data.id` derived from the session cookie (line 21,29,31,35) — no client-supplied ID. Not attacker-selectable.
- **Confused deputy:** SAFE. `fetch(url)` (line 24) attaches NO credentials/user-identity — no on-behalf-of trust to abuse.
- **SSRF:** CROSS-CLASS(INJ, CWE-918) — `fetch(req.body.imageUrl)` at profileImageUrlUpload.ts:24, unvalidated outbound fetch.
- **Stored value → CSP header:** CROSS-CLASS(INJ, CWE-113/79) — catch block stores raw `url` as `profileImage` (line 36); later interpolated into `Content-Security-Policy` header at userProfile.ts:88.
- **CSRF:** CANDIDATE(CWE-352) — state-changing (writes file + DB profileImage update), cookie-session auth (`req.cookies.token`), no CSRF token; no CSRF middleware anywhere in server.ts. server.ts:309.

### #41 — body `username` (updateUserProfile.ts:33) — POST /profile
- **Request Body Gate (CWE-915):** SAFE. Handler explicitly maps only `req.body.username` into `user.update` (line 33); no catch-all spread; `username` is a self-editable field. No sensitive field passes through.
- **IDOR:** SAFE. `findByPk(loggedInUser.data.id)` — session-bound (line 25).
- **SSTI:** CROSS-CLASS(INJ, CWE-94) — stored `username` reaches `eval(code)` at userProfile.ts:61 (second-order via DB).
- **CSRF:** CANDIDATE(CWE-352) — this IS the [REDACTED] endpoint (line 31). Cookie-authenticated, changes username + reissues token, no CSRF token. updateUserProfile.ts:33 / server.ts:659. Severity Medium.

### #52 — image bytes (profileImageFileUpload.ts) — POST /profile/image/file
- **IDOR / path:** SAFE. Write path uses session `loggedInUser.data.id` + `file-type`-derived ext (line 41,51) — no attacker-controlled identifier or filename.
- **Mass assignment:** SAFE — only `profileImage` set to a server-computed path.
- **CSRF:** CANDIDATE(CWE-352) — state-changing upload, cookie auth, no token. server.ts:308.

### #53 — config `application.logo/favicon/theme` (userProfile/dataErasure)
- **NO-MATCH (NAV).** Values originate from server config (trust=config), not attacker-controlled (Gate 2a fails). Template-injection concern only if config is writable → CROSS-CLASS(INJ, SSTI/XSS) at userProfile.ts:76-83, dataErasure.ts:53-100.

### #40 — body `layout` + `...req.body` (dataErasure.ts:103-124) — POST /dataerasure
- **Request Body Gate (CWE-915):** SAFE for persistence. `PrivacyRequestModel.create` sets only `UserId: loggedInUser.data.id` (server) and hardcoded `deletionRequested:true` (line 84-85). No body field is persisted. `...req.body` (line 109,124) is spread only into `res.render` locals — a template/LFI sink, not a state store.
- **IDOR:** SAFE — deletion request bound to session user id.
- **LFI / path traversal:** CROSS-CLASS(INJ, CWE-98/22) — `path.resolve(req.body.layout)` → `res.render` at dataErasure.ts:104-107; forbidden-file filter is a weak substring blocklist (`ftp`/`ctf.key`/`encryptionkeys` only). This is the [REDACTED].
- **CSRF:** CANDIDATE(CWE-352) — state-changing (creates deletion/privacy request, clears cookie), cookie auth, no token. server.ts:648.

## Post-trace authorization-helper coverage audit
All four handlers consistently gate on `security.authenticatedUsers.get(req.cookies.token)` and deny when absent. No sibling handler omits the check → no CWE-862/306 gap. Note: in profileImageUrlUpload the auth check sits inside `if (req.body.imageUrl !== undefined)` — when `imageUrl` is absent the block is skipped, but only a harmless redirect occurs (no security-critical op), so not a Conditional Validation Bypass.

## Summary of NAV candidates
- CSRF (CWE-352) on all four cookie-authenticated state-changing endpoints: POST /profile, /profile/image/url, /profile/image/file, /dataerasure. No CSRF token validation and no CSRF middleware in server.ts. Severity Medium. (Gate 0: absence of an anti-CSRF control is a missing security check, not a feature — flagged for 2b.)

## Cross-class flags (not NAV)
- INJ CWE-918 SSRF: profileImageUrlUpload.ts:24
- INJ CWE-94 SSTI: userProfile.ts:61 (via stored username)
- INJ CWE-113/79 header injection: userProfile.ts:88 (via stored profileImage url)
- INJ CWE-98/22 LFI: dataErasure.ts:104-107 (layout param)
- INJ SSTI/XSS: config-into-template userProfile.ts:76-83, dataErasure.ts:53-100
