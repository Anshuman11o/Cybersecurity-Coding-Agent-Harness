# [LOW] Error object passed to client via next(error)

**File:** `routes/basketItems.ts` (lines 52)
**Project:** juice-shop-work
**Severity:** LOW  •  **Confidence:** low  •  **Slug:** `error-message-leak`

## Finding

Save failures pass the raw error to the Express error handler (L52/L79), which may surface internal details depending on the global error handler configuration.

## Recommendation

Ensure the central error handler returns generic messages to clients.
