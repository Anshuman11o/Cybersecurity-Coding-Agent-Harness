# [MEDIUM] Basket item update pre-check fetches item by id without ownership verification

**File:** `routes/basketItems.ts` (lines 68)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `missing-auth`

## Finding

`quantityCheckBeforeBasketItemUpdate` (L68) loads the basket item via `findOne({ where: { id: req.params.id } })` with no check that the item belongs to the authenticated user's basket. The handler only enforces stock/quantity limits and never verifies ownership before allowing the update flow to proceed, permitting a user to reference another user's basket item id.

## Recommendation

Join the basket item to the authenticated user's basket and reject if the item's BasketId does not match `user.bid` before processing the update.
