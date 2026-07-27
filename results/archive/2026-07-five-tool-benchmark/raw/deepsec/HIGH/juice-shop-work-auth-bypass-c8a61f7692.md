# [HIGH] Password change does not require the current password

**File:** `routes/changePassword.ts` (lines 39, 45, 51)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `auth-bypass`

## Finding

The current-password check is guarded by `if (currentPassword && ...)` (L39). If the request simply omits the `current` query parameter, the check is skipped entirely and the password is updated using only the bearer token (L45-51). An attacker who has any foothold that yields a valid session token (leaked/stolen token, an XSS payload that reads the token, or a fixated token) can set a new password without knowing the old one, achieving full account takeover. Because the endpoint is a GET (`app.get('/rest/user/change-password')`, server.ts L589) that performs a state-changing write and reads all inputs from `req.query`, it is also trivially triggerable via a crafted URL, and the operation is not idempotent.

## Recommendation

Always require and verify the current password before allowing a change. Convert the endpoint to POST/PUT, take inputs from the request body, and add CSRF protection.
