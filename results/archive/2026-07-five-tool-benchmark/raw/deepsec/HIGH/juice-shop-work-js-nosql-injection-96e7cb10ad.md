# [HIGH] Server-side JavaScript injection via MongoDB/MarsDB $where string concatenation

**File:** `routes/showProductReviews.ts` (lines 31, 36)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `js-nosql-injection`

## Finding

`db.reviewsCollection.find({ $where: 'this.product == ' + id })` (L36) concatenates the request-derived `id` directly into a `$where` JavaScript expression evaluated by MarsDB. When the noSqlCommand challenge path is active, `id = utils.trunc(req.params.id, 40)` is an attacker-controlled string, so a payload like `0;return this` or code using the blocking `global.sleep()` helper defined at L17 executes arbitrary JS in the DB context (data exfiltration and DoS). The route `/rest/products/:id/reviews` is public (no auth middleware). Even in the default numeric path, the `$where` pattern is the classic injection sink.

## Recommendation

Never build `$where` from request data. Query with a typed equality filter, e.g. `find({ product: Number(req.params.id) })`, and reject non-numeric input. Avoid `$where` entirely.
