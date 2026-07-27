# [MEDIUM] Hardcoded HMAC secret key

**File:** `lib/insecurity.ts` (lines 42)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `secrets-exposure`

## Finding

hmac() (L42) hardcodes the secret 'pa4qacea4VK9t9nGv7yZtwmj'. Any HMAC/integrity value derived from this function can be forged by anyone with source access, defeating its purpose as an authenticity mechanism.

## Recommendation

Move the HMAC key to runtime configuration/secrets and rotate it.
