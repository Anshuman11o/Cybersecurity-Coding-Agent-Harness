# [BUG] User-registration validation sends 400 response then still calls next()

**File:** `server.ts` (lines 403, 409, 410, 413)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-logic-bug`

## Finding

In the pre-registration middleware (L403-414), when email/password are present but empty, the code calls `res.status(400).send(...)` (L410) but does not `return`; execution falls through to `next()` (L413), allowing the request to continue down the handler chain after a response has already been sent. This can trigger an 'ERR_HTTP_HEADERS_SENT' error and continued processing of an input the validator meant to reject.

## Recommendation

Return immediately after sending the 400 response (add `return` after res.status(400).send(...)), or restructure to only call next() on the valid branch.
