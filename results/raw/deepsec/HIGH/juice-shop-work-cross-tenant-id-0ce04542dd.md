# [HIGH] Basket ownership bypass via HTTP Parameter Pollution / duplicate BasketId

**File:** `routes/basketItems.ts` (lines 37, 41, 42)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Finding

`addBasketItem` parses the raw body into arrays of keyed values, then validates only the FIRST BasketId: `Number(user.bid) != Number(basketIds[0])` (L37). However, the item actually inserted uses the LAST BasketId: `BasketId: basketIds[basketIds.length - 1]` (L42). An attacker can submit two `BasketId` entries — the first equal to their own basket (passing the ownership check) and the last equal to a victim's basket id — causing the item to be added to another user's basket. This is a genuine cross-tenant/IDOR authorization bypass through the mismatch between the validated index and the used index.

## Recommendation

Validate and use the same single BasketId value; reject requests containing duplicate/ambiguous BasketId keys, and always bind the insert to the authenticated user's own basket id rather than any client-supplied value.
