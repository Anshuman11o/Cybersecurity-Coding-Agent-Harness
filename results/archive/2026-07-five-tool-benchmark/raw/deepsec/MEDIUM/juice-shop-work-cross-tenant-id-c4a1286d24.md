# [MEDIUM] Checkout by arbitrary basket id destroys another user's basket (IDOR)

**File:** `routes/order.ts` (lines 34, 35, 51)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `cross-tenant-id`

## Finding

placeOrder fetches the basket solely by `req.params.id` (L34-35) and never compares it to the authenticated user's own basket id. Although `/rest/basket` is wrapped by isAuthorized+appendUserId (so wallet UserId is the caller's), the basket id itself is unowned: any logged-in user can POST /rest/basket/{otherId}/checkout to generate an order from and then empty (BasketItemModel.destroy, L51) another user's basket, and reduce product inventory (L78-81) on their behalf. This is a cross-tenant write/DoS on another customer's cart.

## Recommendation

Verify the basket belongs to the authenticated user (compare basket.UserId to the session id) before processing checkout.
