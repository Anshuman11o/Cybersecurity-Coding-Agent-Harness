# [MEDIUM] Weak regex-based HTML sanitizer (sanitizeLegacy)

**File:** `lib/insecurity.ts` (lines 59)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `xss`

## Finding

sanitizeLegacy() (L59) attempts to strip tags with a single regex `/<(?:\w+)\W+?[\w]/gi`. This is easily bypassed (e.g. `<img src=x onerror=alert(1)>` variants, malformed/nested tags, `<svg/onload=...>`), providing a false sense of XSS protection wherever it is used instead of the real sanitizer.

## Recommendation

Remove the regex sanitizer; use a vetted HTML sanitizer (sanitize-html) with a strict allowlist for all untrusted HTML.
