# [BUG] Incorrect operator precedence in lastLoginTime computation

**File:** `routes/authenticatedUsers.ts` (lines 21)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Finding

Line 21 computes new Date(parsedToken?.iat ?? 0 * 1000). Due to operator precedence, * binds tighter than ??, so this parses as parsedToken?.iat ?? (0 * 1000) = parsedToken?.iat ?? 0. The intent was clearly to convert the JWT iat (seconds) to milliseconds via iat * 1000, but the multiplication only applies to the fallback 0 and never to the actual iat. As a result, iat (a Unix timestamp in seconds) is passed to new Date() as milliseconds, yielding a lastLoginTime near 1970 instead of the real login time — the reported value is wrong by a factor of ~1000.

## Recommendation

Fix precedence and unit conversion: lastLoginTime = parsedToken?.iat ? Math.floor(new Date(parsedToken.iat * 1000).getTime()) : null.
