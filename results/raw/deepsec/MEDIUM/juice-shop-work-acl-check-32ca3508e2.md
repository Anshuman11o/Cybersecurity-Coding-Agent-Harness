# [MEDIUM] Any authenticated user can enumerate the entire user table

**File:** `routes/authenticatedUsers.ts` (lines 12, 16, 26, 27)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `acl-check`

## Finding

retrieveUserList (mounted at GET /rest/user/authentication-details, server.ts:593) is gated only by security.isAuthorized() (server.ts:393), which verifies that *some* valid session exists but performs no role/ownership check. It then returns UserModel.findAll() — every user record — to the caller. Registration is fully open, so any anonymous attacker can create a customer account and retrieve the full list of users including admins: emails, roles, deletedAt status, and all other user.dataValues fields. Although password and totpSecret are masked with replace(/./g,'*'), the masking preserves length, leaking each user's exact password length and whether TOTP is configured (and its secret length), which aids targeted attacks. This is a missing authorization (should be admin-only) plus information disclosure.

## Recommendation

Restrict this endpoint to administrators (e.g. security.isAuthorized() combined with an admin role check). Do not return the full user table to non-admins, and avoid length-preserving masking that leaks secret length — omit the fields entirely.
