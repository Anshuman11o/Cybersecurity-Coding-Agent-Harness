# [MEDIUM] Bearer token parsed with fragile string slicing

**File:** `routes/changePassword.ts` (lines 27)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-weak-token-parsing`

## Finding

The token is extracted with `headers.authorization.substr('Bearer='.length)` (L27), i.e. a fixed 7-char slice matching the literal 'Bearer=' rather than the standard 'Bearer ' scheme. This diverges from RFC 6750 and from the rest of the codebase (which uses `utils.jwtFrom`). It is brittle and can lead to inconsistent auth parsing across endpoints.

## Recommendation

Use the shared `utils.jwtFrom(req)` helper for consistent, robust token extraction.
