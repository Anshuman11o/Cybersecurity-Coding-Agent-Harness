# [HIGH] NoSQL operator injection and missing ownership check in review update

**File:** `routes/updateProductReviews.ts` (lines 15, 16, 17, 18, 19)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `js-nosql-injection`

## Finding

The handler passes `req.body.id` directly as the `_id` selector to `db.reviewsCollection.update({ _id: req.body.id }, { $set: { message: req.body.message } }, { multi: true })`. `req.body.id` is untyped and fully attacker-controlled. An authenticated low-privilege user can send a JSON object as `id` (e.g. `{"id": {"$ne": "-1"}, "message": "pwned"}`) so the selector becomes an operator query that matches ALL documents; combined with `multi: true` this overwrites the `message` of every review in the store. Even without operator injection, there is no check that the review identified by `id` belongs to the authenticated user (`security.authenticatedUsers.from(req)` is read but never compared against the review's author), so any user can edit/forge any other user's review by supplying its `_id`. The route is only gated by `security.isAuthorized()` which confirms login but not resource ownership. This is a broken-access-control + NoSQL-injection combination.

## Recommendation

Coerce `req.body.id` to a string before use (e.g. `String(req.body.id)`) so operator objects cannot be injected, and remove `multi: true` for a single-document update. Enforce ownership by including the authenticated user's id in the selector (e.g. `{ _id: String(req.body.id), author: user.data.email }`) so users can only edit their own reviews. Validate/sanitize `req.body.message` as well.
