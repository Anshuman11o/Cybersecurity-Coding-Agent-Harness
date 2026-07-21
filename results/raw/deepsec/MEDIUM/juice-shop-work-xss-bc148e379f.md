# [MEDIUM] CSP header built from unsanitized user profileImage allows directive injection

**File:** `routes/userProfile.ts` (lines 88)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `xss`

## Finding

The Content-Security-Policy is assembled with string interpolation of `user.profileImage` (L88): `img-src 'self' ${user?.profileImage}; script-src 'self' 'unsafe-eval'`. profileImage is user-controlled; injecting a value containing a semicolon/space lets an attacker append or weaken CSP directives (e.g. broaden script-src), undermining the page's XSS protection which already permits 'unsafe-eval'.

## Recommendation

Do not interpolate user-controlled values into security headers. Validate profileImage against an allowlist of hosts/paths, or omit it from the CSP.
