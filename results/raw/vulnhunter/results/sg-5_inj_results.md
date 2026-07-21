# Partition SG-5 — INJ Trace Results

Agent: INJ trace, class group = injection. Scope: SQLi, command inj, path traversal,
SSRF, XSS, open redirect, XXE, LDAP, API-query inj, code eval/SSTI, file upload.

## Dispositions

### #13 — body `couponData` (order.ts:196) — POST /rest/basket/:id/checkout
**SAFE (INJ).** base64-decoded, split on `-`, `couponCode` used only as an object
property key into the hardcoded `campaigns` map (order.ts:199); `couponDate` coerced
via `Number()`. No injection sink reached. Derived `discountAmount` stored in
`ordersCollection.insert` as a numeric string — no operator injection. Coupon/price
manipulation (forged discount) is a business-logic concern → CROSS-CLASS(LOG).

### #14 — route param `id` basket (order.ts:34) — POST /rest/basket/:id/checkout
**SAFE (INJ).** Used in `BasketModel.findOne({ where: { id } })` — Sequelize
parameterizes; string-typed param, no SQLi. Interpolated only into an Error message
(order.ts:182). Missing ownership check → CROSS-CLASS(NAV, CWE-639 IDOR).

### #15 — route param `id` basket (basket.ts:18) — GET /rest/basket/:id
**SAFE (INJ).** `BasketModel.findOne({ where: { id } })` parameterized; string param.
No injection sink. IDOR (basketAccessChallenge) → CROSS-CLASS(NAV, CWE-639).

### #47 — body `caption` + image (memory.ts:13) — POST /rest/memories
**CANDIDATE — Stored XSS (CWE-79).** `req.body.caption` → `MemoryModel.create` with no
sanitization/encoding → second-order read `getMemories()` (memory.ts:24) returns it in
JSON `data` → rendered on the Angular photo-wall. No escaping at any hop.
- Gate 0: not intended (arbitrary markup persisted + rendered).
- Gate 1: reachable, server.ts:310 (auth+appendUserId) + server.ts:622 read.
- Gate 2a: attacker-controlled body field.
- Gate 2b: no sanitizer between source and stored output.
- Severity: Medium (stored, victim renders).

**image (upload) — SAFE (INJ).** Filename via `security.sanitizeFilename(originalname)`
and extension forced from `mimeTypeMap[file.mimetype]` (server.ts:700-706); mime
validated (server.ts:693). Path traversal / unrestricted-upload mitigated.

### #48 — body `ProductId`,`quantity` (basketItems.ts:60,71) — POST|PUT /api/BasketItems
**SAFE (INJ).** `ProductId`/`quantity` flow into `QuantityModel.findOne({where:{ProductId}})`
and `BasketItemModel.build/save` — Sequelize parameterized; no string interpolation.
Negative-quantity / mass-assignment (BasketId spoof, negativeOrderChallenge) is logic/authz
→ CROSS-CLASS(LOG/NAV), not injection.

### #21 — route param `id` (orderHistory.ts:36) — PUT /rest/order-history/:id/delivery-status
**SAFE (INJ).** `ordersCollection.update({ _id: req.params.id }, ...)`. Express route
params are always strings, so NoSQL operator ($-object) injection is NOT reachable via
`:id`; `_id` is a plain string equality match. `deliveryStatus` is negated to boolean,
`eta` hardcoded. No operator/value injection. Guarded by isAccounting but no per-order
ownership → CROSS-CLASS(NAV, CWE-639 IDOR).

### #51 — header `authorization` Bearer (orderHistory.ts:13) — order-history / dataExport
**SAFE (INJ).** Token string used only as key in in-memory `authenticatedUsers.get()`
map lookup. Resolved `email` (from stored user record, vowels masked) → `ordersCollection
.find({ email })` — string equality, value not attacker-shaped into operators. No injection
sink.

## Summary
- CANDIDATE: 1 — #47 caption Stored XSS (CWE-79, Medium), memory.ts:13 → getMemories.
- SAFE (INJ): #13, #14, #15, #47(image), #48, #21, #51.
- CROSS-CLASS flagged: #13(LOG price), #14/#15/#21(NAV CWE-639), #48(LOG/NAV).
