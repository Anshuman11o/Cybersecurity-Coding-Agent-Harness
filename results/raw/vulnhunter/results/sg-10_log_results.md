# SG-10 LOG Trace Results

Partition: Captcha / Feedback / user CRUD + misc unauth reads + Websocket
Class focus: race conditions, cache isolation, credential scope, resource
exhaustion, prototype pollution, crypto, integer overflow (+ captcha
bypass/replay, weak PRNG, websocket handling).

---

## Dispositions

| # | Input | Disposition | Sink | Class |
|---|-------|-------------|------|-------|
| 35 | body captchaId/captcha (verifyCaptcha) | **CANDIDATE** | routes/captcha.ts:37-38 | CWE-384/307 captcha replay |
| 36 | body answer (verifyImageCaptcha) | **CANDIDATE** | routes/imageCaptcha.ts:52 | CWE-303/307 captcha fail-open bypass |
| 27 | cookie token | CROSS-CLASS | routes/currentUser.ts:17 → lib/insecurity.ts (security.verify) | CWE-347 JWT verify (crypto, shared node) |
| 28 | query fields | CROSS-CLASS | routes/currentUser.ts:29-31 | CWE-200 field over-exposure (password hash), self-only → NAV |
| 28 | query callback | CROSS-CLASS | routes/currentUser.ts:54-59 (res.jsonp) | CWE-79 JSONP reflected XSS → INJ |
| 29 | header true-client-ip | CROSS-CLASS | routes/saveLoginIp.ts:18-25,32 | CWE-79 stored header XSS → INJ |
| 49 | auto-CRUD role/fields (finale /api/*) | CROSS-CLASS | server.ts finale mount / models | CWE-915/639 mass-assignment role → NAV |
| 50 | websocket data | SAFE | registerWebsocketEvents.ts:33-51 | no dangerous sink; only notification splice by flag |

---

## Candidates

### [VULN-SG10-01] CAPTCHA replay: verified captcha never invalidated
- **Input**: #35 body `captchaId`,`captcha` (POST /api/Feedbacks)
- **Class**: CWE-384 (session/token replay) / CWE-307 (rate-limit bypass)
- **Severity**: Medium
- **Location**: routes/captcha.ts:35-46 (verifyCaptcha), mounted server.ts:399
- **Gate 0**: Captcha exists precisely to throttle automated feedback; skipping
  that throttle is NOT the designed feature (Gate 0 does not exempt a security
  control that is silently reusable). Note server.ts:401 mounts
  `captchaBypassChallenge()` confirming this is a recognized weakness.
- **Gate 1**: Reachable — POST /api/Feedbacks (server.ts:399), unauth.
- **Gate 2a**: `req.body.captchaId` and `req.body.captcha` fully attacker-set.
- **Gate 2b**: None. verifyCaptcha does `findOne({where:{captchaId}})` then
  `req.body.captcha === captcha.answer` and calls next() on match. The
  CaptchaModel row is NEVER deleted/marked-used after a successful match
  (grep: no destroy/update on CaptchaModel anywhere). Additionally the answer
  is returned to the client by `captchas()` (res.json includes `answer`,
  captcha.ts:22-31) and `captchaId` is a predictable sequential counter
  (`req.app.locals.captchaId++`).
- **Gate 3**: New capability — a single solved (captchaId, answer) pair is
  replayable unlimited times, defeating the anti-automation invariant and
  enabling automated/bulk feedback submission. Weak `Math.random()` PRNG
  (captcha.ts:14-19, CWE-338) is secondary since the answer is disclosed anyway.
- **Data Flow**: attacker GET /rest/captcha → learns {captchaId, answer} →
  POST /api/Feedbacks {captchaId, captcha:answer} repeatedly → verifyCaptcha
  matches every time (captcha.ts:37-38) → next() → feedback stored.
- **Root Cause**: Captcha row consumed without single-use invalidation.

### [VULN-SG10-02] Image CAPTCHA verification fails open when no captcha exists
- **Input**: #36 body `answer` (POST /rest/user/data-export)
- **Class**: CWE-303 (incorrect impl of auth algo) / CWE-307 / Conditional
  Validation Bypass
- **Severity**: Medium
- **Location**: routes/imageCaptcha.ts:52, mounted server.ts:612
- **Gate 0**: N/A (Gate 0 does not apply to a security check being skipped).
- **Gate 1**: Reachable — POST /rest/user/data-export (server.ts:612), auth.
- **Gate 2a**: attacker controls whether an image captcha exists (never calls
  GET /rest/image-captcha) and `req.body.answer`.
- **Gate 2b**: None. Guard is `if (!captchas[0] || req.body.answer ===
  captchas[0].answer) next()`. When the user has no captcha row in the last
  5 min (imageCaptcha.ts:42-51), `!captchas[0]` is true and next() runs with
  NO answer check — fail-open. Also, the row is not deleted after use, so a
  valid answer is replayable for 5 min.
- **Gate 3**: New capability — data-export captcha bypassed entirely by simply
  never requesting a captcha; also automatable replay.
- **Data Flow**: POST /rest/user/data-export with no prior captcha → findAll
  returns [] → `!captchas[0]` short-circuits → next() → export proceeds.
- **Root Cause**: Absence of a captcha treated as pass instead of deny.

---

## Cross-class notes (for owning class groups)
- #28 `callback` → INJ: JSONP reflected XSS at currentUser.ts:54-59.
- #28 `fields` → NAV: arbitrary field selection returns password hash
  (currentUser.ts:29-31), self-only, CWE-200.
- #29 `true-client-ip` → INJ: unsanitized stored XSS when
  httpHeaderXssChallenge enabled (saveLoginIp.ts:22-25).
- #49 `role` → NAV: mass-assignment privilege escalation via POST /api/Users.
- #27 token → crypto verify handled in shared lib/insecurity.ts (CWE-347).

## SAFE
- #50 websocket: handlers perform no dangerous sink; `notification received`
  only splices a notification matching a flag value; no proto pollution,
  injection, or auth impact. CORS origin fixed to localhost:4200.
