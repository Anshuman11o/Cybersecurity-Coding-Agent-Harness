# [MEDIUM] NoSQL operator injection via unvalidated req.body.id in _id query

**File:** `routes/likeProductReviews.ts` (lines 18, 25, 35, 50)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `js-nosql-injection`

## Finding

`req.body.id` is passed directly as `{ _id: id }` to reviewsCollection.findOne/update (L25, L35, L50) without coercion to a primitive. Because the body is JSON, an attacker can supply an object such as `{"$ne": null}` or `{"$gt": ""}`, causing the query to match an arbitrary/first review the attacker does not own and then mutate it (increment likes, overwrite likedBy). Input is not typed to a string before use.

## Recommendation

Coerce id to a string (String(req.body.id)) and reject non-string/object input before querying.
