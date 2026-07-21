# [MEDIUM] Open redirect: allowlist uses substring match (url.includes)

**File:** `lib/insecurity.ts` (lines 132, 135, 137)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `open-redirect`

## Finding

isRedirectAllowed() (L132-138) returns true whenever the user-supplied URL merely *contains* an allowlisted URL as a substring anywhere. routes/redirect.ts performRedirect() gates res.redirect(query.to) on this function, so an attacker can craft `?to=https://evil.com/?x=https://github.com/juice-shop/juice-shop` — the allowlisted string is present as a query fragment, the check passes, and the browser is redirected to evil.com. Note the file also defines a correct startsWith-based check (isUnintendedRedirect in redirect.ts), but the enforced path uses the vulnerable includes() version.

## Recommendation

Validate the redirect target by parsing it and comparing the full origin/prefix against the allowlist (e.g. startsWith on a normalized URL), not a substring `includes`.
