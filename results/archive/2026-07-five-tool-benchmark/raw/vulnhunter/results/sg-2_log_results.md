# SG-2 LOG Trace Results (partition: Product Search / Reviews)

Class focus: race conditions, cache isolation, credential scope, resource exhaustion, prototype pollution, crypto, integer overflow.

## Disposition Summary
| # | Input | Disposition | Class | Sink |
|---|---|---|---|---|
| 2 | search `q` | CROSS-CLASS(INJ, SQLi) | INJ | search.ts:19 |
| 16 | update `id`,`message` | CROSS-CLASS(INJ, NoSQL operator injection) | INJ | updateProductReviews.ts:16 |
| 17 | show `id` | CANDIDATE (LOG DoS) + CROSS-CLASS(INJ) | LOG/INJ | showProductReviews.ts:31-36 |
| 18 | create `message`,`author` | CROSS-CLASS(INJ stored XSS / NAV author spoof) | INJ/NAV | createProductReviews.ts:20-26 |
| 19 | like `id` | CANDIDATE (LOG race condition) | LOG | likeProductReviews.ts:25-53 |

Inputs 2, 16, 18 contain no LOG-class sink (no crypto, race, cache, prototype
pollution, integer overflow, or unbounded allocation). `q` (#2) is length-capped
at 200 (search.ts:18) so no resource-exhaustion angle. Flagged CROSS-CLASS.

---

## [VULN-LOG-01] Read-modify-write race in review "like" allows one-user-many-likes
- **Input**: #19: body `id` + attacker-controlled request concurrency, POST /rest/products/reviews
- **Class**: CWE-362 (Race Condition, read-modify-write) / CWE-367 TOCTOU
- **Severity**: Medium (auth required; violates one-like-per-user invariant; race required → floored at Medium)
- **Location**: likeProductReviews.ts:31 (check) → 35 (increment) → 45 (push) → 50 (write)
- **Gate 0**: Not intended. Liking is a feature; the invariant is "each user likes a review once" (enforced by `likedBy.includes` check at :31). The race defeats that invariant — not designed behavior. The artificial `sleep(150)` at :41 widens the window.
- **Gate 1**: Reachable. Mounted server.ts:627 `app.post('/rest/products/reviews', security.isAuthorized(), likeProductReviews())`. 1 production call site.
- **Gate 2a**: Attacker-controlled. Any registered user (open registration) sends N concurrent requests for the same review `id`.
- **Gate 2b**: No mitigation. `likedBy.includes` check (:31) and the `likedBy.push` write (:45→:50) are a non-atomic read-modify-write with a 150ms gap. No lock, no atomic CAS, no unique constraint on (review,user). The `$inc` at :37 is itself atomic but unbounded per user.
- **Gate 3 (new capability)**: LOG Gate-3 business-invariant rule applies. Concurrent requests all pass the `includes` check before any write, so each increments `likesCount` (:35-38) and appends the same email repeatedly to `likedBy` (:45). Attacker inflates a review's `likesCount` arbitrarily and creates duplicate self-entries — violating the count-limited "one like per user" invariant.
- **Data Flow**: req.body.id (:18) → findOne (:25) → includes-check (:31) → $inc likesCount (:35) → sleep 150ms (:41) → re-read (:43) → push email (:45) → $set likedBy (:50). Two concurrent requests interleave between :31 and :50.
- **Root Cause**: Non-atomic read-modify-write on `likedBy`/`likesCount` with no per-user uniqueness enforcement.
- **Exploitability**: High practicality — fire simultaneous requests; the built-in 150ms sleep makes the window trivially wide (this is the app's [REDACTED] surface).

---

## [VULN-LOG-02] Event-loop-blocking DoS via injected sleep in $where (NoSQL DoS)
- **Input**: #17: route param `id`, GET /rest/products/:id/reviews
- **Class**: CWE-400 (Uncontrolled Resource Consumption / event-loop blocking DoS)
- **Severity**: Medium (unauth; each request blocks event loop up to 2s per sleep call, per document)
- **Location**: showProductReviews.ts:36 `find({ $where: 'this.product == ' + id })`; sink amplifier global.sleep :17-26
- **Gate 0**: Not intended feature; server-side JS injection into `$where` is a flaw.
- **Gate 1**: Reachable. server.ts:624 `app.get('/rest/products/:id/reviews', showProductReviews())` (unauth).
- **Gate 2a**: Attacker-controlled `req.params.id`.
- **Gate 2b**: When `[REDACTED]` enabled, id is only `utils.trunc(id,40)` (:31) — no numeric coercion — so JS payload (e.g. `0;sleep(2000)`) is concatenated into `$where` and executed by Mongo. When disabled, `Number()` neutralizes it. `global.sleep` caps a single call at 2000ms (:19-20) but the blocking while-loop (:22-25) freezes the Node event loop, and $where runs per-document.
- **Gate 3**: New capability — an unauthenticated client stalls the single-threaded event loop, denying service to all users (this is the app's [REDACTED]). Injected JS can also read arbitrary review-collection fields → also INJ.
- **CROSS-CLASS**: (INJ, server-side JS/NoSQL injection, showProductReviews.ts:36) — injection primitive itself is INJ-owned; the resource-exhaustion consequence is the LOG finding above.
- **Root Cause**: String concatenation of user input into a `$where` JS predicate with only length truncation.
