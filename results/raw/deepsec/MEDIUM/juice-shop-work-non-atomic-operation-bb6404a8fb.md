# [MEDIUM] Non-atomic inventory decrement (read-then-write TOCTOU)

**File:** `routes/order.ts` (lines 78, 81)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `non-atomic-operation`

## Finding

Product stock is updated by reading QuantityModel then writing quantity - BasketItem.quantity (L78-81) without a transaction or atomic decrement. Concurrent checkouts of the same product race on the read, so the final quantity can be wrong (oversell / lost decrements) on a resource shared across all requests.

## Recommendation

Use an atomic DB decrement (QuantityModel.decrement) or a transaction with row locking instead of read-modify-write.
