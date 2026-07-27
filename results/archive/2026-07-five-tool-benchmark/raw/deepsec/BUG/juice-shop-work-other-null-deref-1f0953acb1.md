# [BUG] Null dereference when render returns empty html without an error

**File:** `routes/dataErasure.ts` (lines 110, 111, 112)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-null-deref`

## Finding

In the res.render callback (line 110-112): `if (!html || error) { next(new Error(error.message)) }`. If the render produces no html but `error` is null/undefined, `error.message` throws a TypeError, potentially crashing the request handler rather than forwarding a proper error to next().

## Recommendation

Guard the error path: `next(error ? new Error(error.message) : new Error('Rendering failed'))`.
