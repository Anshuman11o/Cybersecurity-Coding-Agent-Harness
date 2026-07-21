# [BUG] Order lookup relies on .then rather than await (flagged missing-await)

**File:** `routes/trackOrder.ts` (lines 18)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-missing-await`

## Finding

db.ordersCollection.find(...) is consumed via .then(onFulfilled, onRejected) rather than await. This works functionally (the promise is handled), but the handler function itself returns before the promise settles and errors are only caught by the rejection callback. This is not a correctness defect on its own, noted for completeness against the scanner flag; the security issue is the $where injection above.

## Recommendation

Prefer async/await with try/catch for clearer error handling, though the current .then form is functionally acceptable.
