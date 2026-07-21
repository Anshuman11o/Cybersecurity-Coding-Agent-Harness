# Partition SG-6 — INJ Class Results

Agent: INJ trace, partition SG-6. Class focus: SQLi, command, path, SSRF, XSS,
open redirect, XXE, LDAP, API query injection, code eval/SSTI, file upload.

All assigned inputs are IDOR/broken-object-authz concerns (NAV class). For the INJ
class, every input reaches only Sequelize `where` clauses (ORM-parameterized) or a
MongoDB `.find()` keyed on a server-derived value — no injection sink.

## Dispositions

### Input #22 — payment.ts:21,41,70 (`UserId`,`id`) — /api/Cards*
- **SAFE (INJ)**: `req.body.UserId` / `req.params.id` flow into
  `CardModel.findAll/findOne/destroy({ where: { ... } })` — Sequelize parameterizes
  where-object values; no string interpolation into SQL. No SQLi.
- **CROSS-CLASS (NAV, CWE-639)**: raw `req.body.UserId` and `req.params.id`
  used as object selector without ownership check tied to authenticated identity.
  Sink: routes/payment.ts:21,41,70.

### Input #23 — address.ts:11,18,29 (`UserId`,`id`) — /api/Addresss*
- **SAFE (INJ)**: values flow into `AddressModel.findAll/findOne/destroy` where-object
  — parameterized. No SQLi.
- **CROSS-CLASS (NAV, CWE-639)**: raw `req.body.UserId` (address.ts:11) read directly;
  IDOR. Sink: routes/address.ts:11,18,29.

### Input #24 — wallet.ts:12,24,27 (`UserId`,`paymentId`,`balance`) — /rest/wallet/balance
- **SAFE (INJ)**: `WalletModel.findOne/increment` and `CardModel.findOne` use
  parameterized where-objects; `balance` passed as increment value (numeric ORM op),
  not interpolated. No SQLi.
- **CROSS-CLASS (NAV, CWE-639/840)**: raw `req.body.UserId` (wallet.ts:12) read
  directly; balance top-up authorization keyed on client-set UserId. Sink:
  routes/wallet.ts:12,24,27.

### Input #25 — deluxe.ts:19,25,35 (`UserId`,`paymentMode`,`paymentId`) — POST /rest/deluxe-membership
- **SAFE (INJ)**: `UserModel/WalletModel/CardModel` queries all parameterized;
  `paymentMode` only compared via `===` string equality. `deluxeToken(user.email)`
  operates on DB-sourced email. No SQLi/SSTI/eval.
- **CROSS-CLASS (NAV, CWE-639)**: role upgrade selected by client-set `req.body.UserId`.
  Sink: routes/deluxe.ts:19,25,35.

### Input #26 — dataExport.ts:26 (`UserId`) — POST /rest/user/data-export
- **SAFE (INJ)**: `MemoryModel.findAll({ where: { UserId: req.body.UserId } })`
  parameterized. `db.ordersCollection.find({ email: updatedEmail })` and
  `reviewsCollection.find({ author: email })` use email derived from the
  authenticated session token (loggedInUser.data.email), not from body — no NoSQL
  injection from attacker input. `memory.imagePath` interpolated into a response URL
  is DB-sourced, not a request-time injection sink.
- **CROSS-CLASS (NAV, CWE-639)**: `req.body.UserId` chooses whose memories are
  exported, independent of the token identity used for orders/reviews — scope
  mismatch / IDOR. Sink: routes/dataExport.ts:26.

## Summary
No INJ-class CANDIDATE findings in partition SG-6. All sinks are Sequelize
ORM-parameterized queries or MongoDB queries on server-derived values. The genuine
issues are broken object-level authorization (CWE-639/840) — routed CROSS-CLASS to NAV.
