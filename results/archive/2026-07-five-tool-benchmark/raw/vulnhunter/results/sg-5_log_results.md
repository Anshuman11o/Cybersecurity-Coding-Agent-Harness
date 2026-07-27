# SG-5 LOG Trace Results (race/crypto/int/exhaustion/proto/cache/cred-scope)

Target: /tmp/juice-shop-work (TypeScript sources). Class: LOG.

## Dispositions

### #48 BasketItems `quantity` — basketItems.ts:60,71,85 → order.ts:93,157 — CANDIDATE (LOG)
- **Class**: CWE-1339/CWE-840 (business-logic sign/negative value), effectively CWE-190-adjacent.
- **Location**: routes/basketItems.ts:92-93 (quantityCheck), routes/order.ts:93,106,157.
- Gate0: NOT pure design — no positivity constraint on a financial quantity.
- Gate1: reachable via POST|PUT /api/BasketItems (auth+appendUserId), consumed at checkout.
- Gate2a: `quantity` fully attacker-controlled (raw body / parseJsonCustom).
- Gate2b: NONE. `quantityCheck` only tests `product.quantity >= quantity` and `limitPerUser >= quantity`; a NEGATIVE quantity passes both. No lower-bound / integer sign check anywhere.
- Gate3: NEW capability — negative quantity yields negative `itemTotal` → negative `totalPrice` (order.ts:93,106,117,136) and INCREASES stock at order.ts:80-81 (`newQuantity = quantity - (negative)`). With paymentId!=wallet the negative total is never charged, and `totalPoints`/wallet increment (order.ts:157) plus stock inflation violate order invariants. Double-benefit / free-credit. ([REDACTED], order.ts:144).
- **Severity**: High (authenticated user, self-account financial invariant break — LOG Gate3 do-not-eliminate: business-logic invariant violation is a new capability).

### #14 + checkout — RACE: quantity read-modify-write — order.ts:78-81 — CANDIDATE (LOG)
- **Class**: CWE-362 (read-modify-write, no atomic decrement / no lock).
- `QuantityModel.findOne` → `newQuantity = quantityRow.quantity - BasketItem.quantity` → `QuantityModel.update`. Concurrent checkouts of the same basket/product lose updates → oversell / inconsistent stock.
- Gate0/1/2a: reachable, basket-owner auth, quantities attacker-influenced. Gate2b: none (not `decrement`, plain read-compute-write). Gate3: violates one-to-one stock invariant.
- **Severity**: Medium (race required, authenticated).

### #14 + checkout — RACE: wallet balance check-then-act — order.ts:148-150 — CANDIDATE (LOG)
- **Class**: CWE-362 (check `wallet.balance >= totalPrice` then separate `WalletModel.decrement`).
- Concurrent wallet-payment checkouts pass the same balance check → double-spend / overdraft. `req.body.UserId` client-set (also NAV concern) makes target wallet attacker-selectable.
- Gate3: double-spend invariant break = new capability.
- **Severity**: Medium/High (race; UserId client-controlled widens it — also CROSS-CLASS NAV CWE-639 for arbitrary UserId at order.ts:148,150,157).

### #13 `couponData` — order.ts:196-204 — DESIGN-INTENT / SAFE (LOG)
- base64 decode → split('-') → `campaigns[couponCode]` object READ (no write) → no prototype pollution (read-only lookup; polluted key returns undefined/func, harmless). Coupon redemption is intended feature; `couponDate == campaign.validOn` loose compare is the intended [REDACTED], not a new capability. Coupon crypto (insecurity.ts:41 MD5 hash, z85, hardcoded hmac key line 42) is weak but is challenge/design; caller-supplied coupon = Gate0 feature. No LOG candidate.

### #51 `authorization` Bearer — orderHistory.ts:13 — SAFE (LOG)
- `authenticatedUsers.get(token)` is an in-memory map lookup of server-issued tokens; identity from stored session, no credential-scope over-permissioning. Fail-closed else-branch present (line 19-20). No LOG issue.

## CROSS-CLASS flags
- #14 basket `id` — order.ts:35 `BasketModel.findOne({where:{id}})` no ownership check → CROSS-CLASS NAV (CWE-639 IDOR).
- #15 basket `id` — basket.ts:19 same, GET returns other users' basket → CROSS-CLASS NAV (CWE-639).
- #21 orderHistory `id` — orderHistory.ts:36 `ordersCollection.update({_id: req.params.id})` unsanitized → CROSS-CLASS INJ (NoSQL injection, CWE-943); also `req.body.deliveryStatus` toggle.
- #47 memory `caption` — memory.ts:13 stored unsanitized, rendered → CROSS-CLASS INJ/NAV (stored XSS CWE-79); `req.body.UserId` raw → CROSS-CLASS NAV (CWE-639).

## Summary
LOG candidates: 3 (negative-quantity business-logic; stock read-modify-write race; wallet check-then-act race). Coupon & token = safe/design. 4 cross-class (2 NAV IDOR, 1 INJ NoSQL, 1 INJ XSS).
