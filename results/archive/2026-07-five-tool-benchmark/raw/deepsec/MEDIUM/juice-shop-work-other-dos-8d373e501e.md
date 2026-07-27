# [MEDIUM] Blocking sleep helper enables NoSQL denial-of-service

**File:** `routes/showProductReviews.ts` (lines 17, 36)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-dos`

## Finding

The global blocking `sleep()` (L17-26) busy-waits up to 2000ms on the event loop and is reachable from injected `$where` JavaScript, allowing an attacker to stall the single-threaded server per request.

## Recommendation

Remove the global blocking sleep helper and eliminate the $where injection sink.
