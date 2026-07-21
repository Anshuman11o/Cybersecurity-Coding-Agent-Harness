# [MEDIUM] TOCTOU race lets a user like the same review multiple times

**File:** `routes/likeProductReviews.ts` (lines 25, 35, 43, 50)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-race-condition`

## Finding

The like flow is read-check-write with no atomicity: findOne to check `likedBy.includes(email)` (L25-33), then $inc likesCount (L35), then after a 150ms sleep re-read likedBy, push the email, and $set it back (L43-53). Concurrent requests from the same user all pass the includes() check before any writes back the updated likedBy, so likesCount can be incremented many times and the user recorded once — inflating like counts arbitrarily. The deliberate sleep(150) widens the window. The read-modify-write on likedBy also loses concurrent updates from other users (last-write-wins overwrites the whole array).

## Recommendation

Perform the like as a single atomic conditional update (e.g. update matching {_id, likedBy not containing email} with $addToSet likedBy and $inc likesCount) rather than read-then-write; remove the artificial sleep.
