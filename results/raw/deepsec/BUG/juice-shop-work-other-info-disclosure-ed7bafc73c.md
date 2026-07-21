# [BUG] Basket existence/id echoed in error message

**File:** `routes/coupon.ts` (lines 20)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-info-disclosure`

## Finding

When the basket is not found, the handler calls next(new Error(`Basket with id=${id} does not exist.`)), echoing the supplied id back through the error pipeline. This is a minor information/behavior leak (confirms basket non-existence) but low impact.

## Recommendation

Return a generic 404 without reflecting the supplied id.
