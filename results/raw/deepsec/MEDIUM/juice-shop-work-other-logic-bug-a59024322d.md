# [MEDIUM] Deluxe upgrade grants membership without payment for unknown paymentMode

**File:** `routes/deluxe.ts` (lines 24, 34, 43)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Finding

Payment is only collected when `req.body.paymentMode === 'wallet'` (L24) or `=== 'card'` (L34). Any other value (or an omitted `paymentMode`) skips both payment branches, yet the code still unconditionally runs `user.update({ role: security.roles.deluxe, ... })` and issues a fresh deluxe token (L43-48). An authenticated customer can therefore obtain paid deluxe membership for free simply by sending an arbitrary paymentMode. This is a business-logic / authorization bypass on a paid feature.

## Recommendation

Reject the request unless paymentMode is a recognized value and payment was actually collected; only upgrade the role after a successful charge/decrement.
