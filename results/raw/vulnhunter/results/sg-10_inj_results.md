# SG-10 INJ Results — Injection class (partition SG-10)

Target: /tmp/juice-shop-work (TypeScript sources only)

## Disposition Summary
| # | Input | Disposition | Sink | Class |
|---|-------|-------------|------|-------|
| 35 | body captchaId/captcha (captcha.ts:37) | SAFE | Sequelize `where` (parameterized) | — |
| 36 | body answer (imageCaptcha.ts:52) | SAFE | Sequelize findAll (parameterized), value comparison | — |
| 49 | finale auto-CRUD fields | CROSS-CLASS + partial CANDIDATE | see below | NAV / CWE-79 |
| 27 | cookie token (currentUser.ts:17) | SAFE | verify()/authenticatedUsers.get — no injection sink | — |
| 28 | query fields/callback (currentUser.ts:22,54) | SAFE | see below | — |
| 29 | header true-client-ip (saveLoginIp.ts:18) | CANDIDATE | stored → rendered | CWE-79 |
| 50 | websocket data (registerWebsocketEvents.ts) | SAFE | findIndex compare / solveIf — no sink | — |

---

## [VULN-INJ-01] Stored XSS via `true-client-ip` header (saveLoginIp)
- **Input**: #29 header `true-client-ip`
- **Class**: CWE-79 (Stored/reflected XSS)
- **Severity**: Medium (requires victim rendering; unauth-spoofable header)
- **Location**: routes/saveLoginIp.ts:18-33
- **Gate 0**: Not intended — the challenge-enabled branch deliberately SKIPS sanitization.
- **Gate 1**: Reachable — GET /rest/saveLoginIp mounted, called after login.
- **Gate 2a**: Attacker-controlled — arbitrary `true-client-ip` request header.
- **Gate 2b**: When `isChallengeEnabled(httpHeaderXssChallenge)` is true (default),
  code calls `solveIf(...)` and does NOT call `security.sanitizeSecure`; raw header
  value stored to `UserModel.lastLoginIp` (line 32). The `else` branch that would
  sanitize is unreachable while the challenge is enabled.
- **Gate 3**: New capability — stored value later returned by whoami and rendered as
  "Last Login IP" in the SPA → script execution in victim/admin context.
- **Data Flow**: req.headers['true-client-ip'] (saveLoginIp.ts:18) → lastLoginIp
  (unsanitized, :25 skipped) → user.update({lastLoginIp}) DB (:32) → whoami response
  → frontend render.
- **Root Cause**: Sanitization gated behind challenge flag; enabled path stores raw.

## [VULN-INJ-02] Stored XSS via Feedback `comment` (single-pass sanitizer bypass)
- **Input**: #49 finale POST /api/Feedbacks body `comment`
- **Class**: CWE-79 (Stored XSS)
- **Severity**: Medium (unauth POST; rendered in feedback carousel to all users)
- **Location**: models/feedback.ts:39-50; sink lib/insecurity.ts:58
- **Gate 0**: Not intended — bypassable single-pass sanitizer used on enabled path.
- **Gate 1**: Reachable — POST /api/Feedbacks (unauth) → finale create → model setter.
- **Gate 2a**: Attacker-controlled comment body field.
- **Gate 2b**: When `persistedXssFeedbackChallenge` enabled (default), setter uses
  `security.sanitizeHtml` = single-pass `sanitize-html` (insecurity.ts:58), which is
  bypassable via nested tags (e.g. `<<script>...`). Non-challenge path uses recursive
  `sanitizeSecure` (safe). Enabled path = weak sanitizer.
- **Gate 3**: Stored comment rendered unescaped in feedback carousel → XSS to viewers.
- **Data Flow**: POST /api/Feedbacks comment → finale → Feedback.comment setter
  (feedback.ts:41) → sanitizeHtml single-pass (insecurity.ts:58) → DB → carousel render.
- **Root Cause**: Single-pass HTML sanitizer leaves nested/mutation-XSS payloads.

---

## SAFE / NO-MATCH detail
- **#28 `callback` (currentUser.ts:54,58)**: `res.jsonp(response)`. Express `res.jsonp`
  sanitizes the callback name via `callback.replace(/[^\[\]\w$.]/g,'')`, stripping
  `< > ( ) " '` — reflected XSS via callback NOT achievable. SAFE.
- **#28 `fields` (currentUser.ts:22-33)**: used only as object key to select existing
  keys of `user.data`; returns the authenticated user's OWN data (incl. password field
  = own-data over-exposure, not injection, no sink). No INJ sink. SAFE for INJ.
- **#35/#36 captcha inputs**: reach Sequelize `where`/findAll — parameterized ORM, no
  string interpolation. captcha replay/bypass is a rate-limit/logic issue (non-INJ).
- **#50 websocket data**: only used in `findIndex` equality compare and `solveIf`
  side-effects; no injection sink. SAFE.

## CROSS-CLASS flags
- **#49 finale auto-CRUD** `POST /api/Users` `role` (and other privileged model
  fields) mass-assignment → privilege escalation. CROSS-CLASS(NAV, CWE-915/CWE-269).
  finale mounted server.ts:474-494 with `exclude: []`. Not an INJ sink.
- **#29 true-client-ip** is also a spoofable trust-header (NAV) but the exploitable
  sink here is XSS → reported above as INJ candidate.
