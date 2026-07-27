# [MEDIUM] Password-reset rate limiter keyed on attacker-controlled client IP (blanket trust proxy + X-Forwarded-For)

**File:** `server.ts` (lines 339, 340, 341, 342, 343, 344)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `rate-limit-bypass`

## Finding

The reset-password limiter uses `keyGenerator({ headers, ip }) { return headers['X-Forwarded-For'] ?? ip }` (L343). Combined with `app.enable('trust proxy')` (L339) set to blanket-true with no trusted-hop count, Express derives `req.ip` directly from the client-supplied `X-Forwarded-For` header. An anonymous attacker can therefore vary the rate-limit key on every request by rotating the `X-Forwarded-For` value, defeating the 100-requests/5-minute cap on `/rest/user/reset-password`. routes/resetPassword.ts performs no per-account lockout — the only throttle on guessing a user's security-question answer (which grants full password reset / account takeover) is this bypassable limiter, so the bypass enables unlimited offline-speed guessing of security answers. The same trust-proxy misconfiguration undermines the other rate limiters (2FA verify/setup/disable) whose default key also resolves to req.ip.

## Recommendation

Set `trust proxy` to a specific, trusted hop count or the known proxy IP(s) instead of blanket-true, so req.ip cannot be forged. Do not use X-Forwarded-For as a rate-limit key. Add a per-account attempt counter / lockout on the reset-password flow independent of source IP.
