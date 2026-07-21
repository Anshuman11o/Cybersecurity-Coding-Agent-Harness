# [MEDIUM] Missing basket ownership check (IDOR) in applyCoupon

**File:** `routes/coupon.ts` (lines 13, 18, 24)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `cross-tenant-id`

## Finding

applyCoupon() resolves the basket with BasketModel.findByPk(params.id) and updates it, but never compares params.id against the authenticated user's own basket id (available via the JWT/session). Although the route /rest/basket/:id/coupon/:coupon is behind security.isAuthorized() (server.ts L394 app.use prefix match), any authenticated low-privilege customer can apply a coupon to, and mutate the `coupon` field of, an arbitrary user's basket by supplying another basket id. This is a horizontal authorization (IDOR) flaw allowing cross-tenant modification of basket state.

## Recommendation

Enforce ownership: derive the basket id from the authenticated session (e.g. compare params.id to the user's bid/basket id) and reject mismatches with 401/403 before performing findByPk/update.
