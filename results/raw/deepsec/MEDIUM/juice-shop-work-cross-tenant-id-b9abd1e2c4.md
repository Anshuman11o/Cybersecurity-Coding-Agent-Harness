# [MEDIUM] Weak order ownership check via lossy masked-email comparison

**File:** `routes/chat.ts` (lines 164, 165, 168)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `cross-tenant-id`

## Finding

getOrderById enforces ownership by comparing order.email to the current user's email with vowels replaced by '*' (email.replace(/[aeiou]/gi, '*')). This masking is lossy and collision-prone: distinct real emails can map to the same masked value, so a customer could retrieve another customer's order whose masked email collides with theirs. The ownership boundary should be an exact identity match, not a lossy transform.

## Recommendation

Associate orders with an authoritative user id and compare against the authenticated user's id (or exact email) instead of a lossy masked string.
