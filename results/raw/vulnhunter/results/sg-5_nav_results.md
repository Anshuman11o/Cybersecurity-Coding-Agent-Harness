# SG-5 NAV Trace Results — Basket / Order / Coupon / Delivery / Order-history

Class focus: CSRF, IDOR, auth bypass, conditional validation bypass, identity
spoofing, confused deputy, security-signal spoofing, mass assignment, parameter
pollution. Audited TS sources only (routes/, lib/, models/, server.ts).

## Disposition summary
| # | Input | Disposition | Sink | Class |
|---|-------|-------------|------|-------|
| 15 | `req.params.id` GET /rest/basket/:id | **CANDIDATE** | basket.ts:19 | CWE-639 IDOR |
| 14 | `req.params.id` POST /rest/basket/:id/checkout | **CANDIDATE** | order.ts:35 | CWE-639 IDOR |
| 48 | BasketId (raw body) POST /api/BasketItems | **CANDIDATE** | basketItems.ts:37-42 | CWE-639/CWE-235 param pollution |
| 48b | `req.params.id` PUT /api/BasketItems/:id | **CANDIDATE** | basketItems.ts:68 → finale update | CWE-639 IDOR |
| 13 | `couponData` body | DESIGN-INTENT (coupon feature; price logic) | order.ts:196 | not NAV |
| 47 | `caption` POST /rest/memories | CROSS-CLASS(INJ) | memory.ts:13 (stored XSS) | CWE-79 |
| 21 | `req.params.id` PUT /rest/order-history/:id/delivery-status | SAFE (isAccounting role gate) / CROSS-CLASS(INJ) NoSQL | orderHistory.ts:36 | role-gated |
| 51 | `authorization` Bearer | SAFE (server-issued token, in-memory map lookup) | orderHistory.ts:13 | — |

---

## [VULN-501] IDOR — read any user's basket (GET /rest/basket/:id)
- **Input**: #15 route param `id`
- **Class**: CWE-639 Insecure Direct Object Reference
- **Severity**: High
- **Location**: routes/basket.ts:18-28 (sink :19)
- **Gate 0**: Not intended — reading another principal's basket is not a feature.
- **Gate 1**: Reachable; mounted server.ts:595 behind isAuthorized (351/394).
- **Gate 2a**: `id` fully attacker-controlled path param.
- **Gate 2b**: NO ownership check. `appendUserId()` sets `req.body.UserId` but
  handler never uses it; `BasketModel.findOne({ where: { id } })` binds only to
  the supplied id. `basketAccessChallenge` solveIf is neutered `() => false`.
- **Gate 3**: Attacker reads arbitrary basket contents of other users.
- **Data Flow**: req.params.id (basket.ts:18) → BasketModel.findOne where id
  (19) → res.json (28). No JWT-user↔basket binding.
- **Root Cause**: Authentication present, authorization (ownership) absent.

## [VULN-502] IDOR — checkout/destroy any user's basket (POST /rest/basket/:id/checkout)
- **Input**: #14 route param `id`
- **Class**: CWE-639 IDOR (state-changing)
- **Severity**: High
- **Location**: routes/order.ts:34-51
- **Gate 0**: Not intended — placing order against a basket you do not own.
- **Gate 1**: Reachable; server.ts:596 under isAuthorized (394) + appendUserId (351).
- **Gate 2a**: `id` attacker-controlled path param.
- **Gate 2b**: No check that JWT user owns basket `id`. `req.body.UserId` IS
  forced by appendUserId (wallet ops are self-scoped), but the *basket* selection
  is unbound — attacker checks out victim's basket and destroys its items
  (BasketItemModel.destroy WHERE BasketId=id, order.ts:51).
- **Gate 3**: Cross-principal state change: victim's basket emptied / coupon
  cleared; order PDF generated for victim's contents.
- **Root Cause**: Basket id not bound to authenticated user.

## [VULN-503] Parameter-pollution ownership bypass (POST /api/BasketItems)
- **Input**: #48 `BasketId` (parsed from rawBody, allows duplicate keys)
- **Class**: CWE-639 / CWE-235 (multiple params) — parameter pollution
- **Severity**: High
- **Location**: routes/basketItems.ts:36-47
- **Gate 0**: Not intended (this is the basketManipulateChallenge behavior).
- **Gate 1**: Reachable; server.ts:422.
- **Gate 2a/2b**: Ownership check uses `basketIds[0]` (`Number(user.bid) !=
  Number(basketIds[0])`, :37) but the persisted item uses `basketIds[last]`
  (:42). Sending BasketId=<own> first then BasketId=<victim> last passes the
  guard yet writes to victim's basket. Also, omitting BasketId entirely
  (basketIds[0] falsy / 'undefined') skips the guard (conditional-validation
  bypass shape).
- **Gate 3**: Attacker injects items into another user's basket.
- **Root Cause**: Validation index ≠ use index; duplicate-key body parsing.

## [VULN-504] IDOR — update any basket item (PUT /api/BasketItems/:id)
- **Input**: #48b route param `id`
- **Class**: CWE-639 IDOR
- **Severity**: Medium/High
- **Location**: routes/basketItems.ts:68 (findOne by params.id, no ownership),
  then finale auto-REST update (server.ts:421 → finale resource BasketItem 480/494).
- **Gate 1**: Reachable; server.ts:421.
- **Gate 2b**: `quantityCheckBeforeBasketItemUpdate` only validates quantity/stock;
  never checks the item's BasketId belongs to caller. finale update then mutates
  the row selected purely by `:id`.
- **Gate 3**: Attacker modifies quantity of another user's basket item.

---

## Non-candidates (recorded)
- **#13 couponData (order.ts:196)** DESIGN-INTENT for NAV: base64 coupon →
  hardcoded `campaigns` table + date equality; it is the coupon/clock-manipulation
  feature (price logic, not an auth/identity NAV sink). No IDOR/spoof. Business-logic
  price manipulation — out of NAV scope.
- **#47 memory caption (memory.ts:13)** CROSS-CLASS(INJ): `caption` stored via
  MemoryModel.create then rendered → stored XSS (CWE-79). NAV angle clean: UserId
  forced by appendUserId (server.ts:310); no identity spoof. Sink memory.ts:13.
- **#21 delivery-status id (orderHistory.ts:36)** SAFE for NAV: route gated by
  `isAccounting()` (server.ts:617) — role-restricted, accounting toggling delivery
  is design-intent. CROSS-CLASS(INJ): `req.params.id` → `ordersCollection.update({_id})`
  is a Mongo sink, but a string route param cannot inject an operator object; low.
- **#51 authorization Bearer (orderHistory.ts:13)** SAFE: token resolved via
  `authenticatedUsers.get` in-memory map (server-issued tokens only); identity/email
  derived from stored session, not from attacker-forgeable claims on this path.
  Route lacks route-level auth but handler fails closed when token absent from map.

## Auth-helper coverage audit
orderHistory.ts: `allOrders`/`toggleDeliveryStatus` gated by isAccounting at route;
`orderHistory` self-checks map — consistent, no gap. basket/order handlers rely on
mounted isAuthorized but omit ownership (see VULN-501/502) — reported above.
