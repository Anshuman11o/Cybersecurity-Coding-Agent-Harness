# [HIGH] Hardcoded RSA private key in source

**File:** `lib/insecurity.ts` (lines 21, 54, 148)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `secrets-exposure`

## Finding

A full RSA private key is hardcoded as the `privateKey` constant (L21) and used to sign all session JWTs (L54) and to derive the deluxe-membership HMAC token (L148). Anyone with source access (public repo, client bundle leakage, or decompiled build) can sign valid tokens for any user/role and forge deluxeToken values, fully bypassing authentication and authorization.

## Recommendation

Load signing keys from secrets management / environment at runtime, never commit private keys, and rotate the exposed key.
