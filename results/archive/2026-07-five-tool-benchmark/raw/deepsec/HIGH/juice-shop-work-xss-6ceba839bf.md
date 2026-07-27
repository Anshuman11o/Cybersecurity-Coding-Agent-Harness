# [HIGH] Stored XSS via true-client-ip header written to lastLoginIp without sanitization

**File:** `routes/saveLoginIp.ts` (lines 18, 22, 23, 25, 32)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

saveLoginIp() takes the attacker-controlled `true-client-ip` request header and stores it as the authenticated user's lastLoginIp. Sanitization via security.sanitizeSecure is only applied in the ELSE branch: when utils.isChallengeEnabled(challenges.[REDACTED]) is true (challenges are active by default in Juice Shop), the raw header value is stored with no sanitization (L22-26). lastLoginIp is embedded in the JWT and rendered by the frontend LastLoginIpComponent, which wraps it in `<small>${lastLoginIp}</small>` via DomSanitizer.bypassSecurityTrustHtml and binds it with [innerHTML] (frontend/src/app/last-login-ip/last-login-ip.component.ts L39 and .html L10). An attacker who logs in (self-registration is open) and sends `true-client-ip: <img src=x onerror=...>` on the /rest/saveLoginIp request achieves persistent stored XSS that executes whenever the victim (self) — or via account takeover chains — views the page. The value is fully attacker-controlled and reaches an innerHTML sink with sanitization explicitly bypassed.

## Recommendation

Always sanitize/escape the header value before persistence regardless of challenge state, and remove bypassSecurityTrustHtml on the frontend — render lastLoginIp as text (interpolation) instead of [innerHTML]. Do not trust client-supplied IP headers; prefer req.socket.remoteAddress.
