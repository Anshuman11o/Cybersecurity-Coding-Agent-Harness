# [HIGH] Open redirect via substring allowlist match in isRedirectAllowed

**File:** `routes/redirect.ts` (lines 15, 16, 19)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `open-redirect`

## Finding

performRedirect() reads the user-controlled `to` query parameter and redirects to it if security.isRedirectAllowed(toUrl) returns true. isRedirectAllowed (lib/insecurity.ts L132-138) validates with `url.includes(allowedUrl)` — a substring check, not a prefix/origin check. An attacker can therefore embed an allowlisted URL anywhere in an attacker-controlled URL to pass validation, e.g. `/redirect?to=https://evil.example.com/?x=https://github.com/juice-shop/juice-shop` or `/redirect?to=https://evil.example.com/#http://leanpub.com/juice-shop`. res.redirect() then sends the victim to evil.example.com. Notably, a correctly-implemented check using startsWith (isUnintendedRedirect, L27-33) exists in this very file but is unused. This enables phishing and OAuth/token-theft redirect chains.

## Recommendation

Validate the redirect target with a strict allowlist using exact match or URL origin comparison (parse with new URL() and compare the origin against the allowlist). Replace the includes()-based isRedirectAllowed with startsWith/origin logic, or wire up the existing isUnintendedRedirect helper.
