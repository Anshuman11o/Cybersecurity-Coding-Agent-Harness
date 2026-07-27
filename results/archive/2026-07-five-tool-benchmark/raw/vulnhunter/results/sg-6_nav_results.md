# SG-6 NAV Trace Results — Payment / Wallet / Address / Deluxe / Data-export

## Core finding: appendUserId override DOES win
`security.appendUserId()` (lib/insecurity.ts:173-182) executes:
`req.body.UserId = authenticatedUsers.tokenMap[jwtFrom(req)].data.id`
It is mounted as **middleware BEFORE every SG-6 handler** (server.ts:433-447, 612-621),
so it overwrites any client-supplied `req.body.UserId` prior to the handler running.
At every DB sink, `req.body.UserId` = authenticated caller's id (server-controlled).
Raw client UserId cannot reach the sink. → UserId-based IDOR is neutralized.

Verified mounts: Cards get/get:id/delete (434/436/437), Addresss get/get:id/delete
(444/446/447), wallet balance get/put (618/619), deluxe POST (621), data-export (612/613).

---

## Per-input dispositions

### #22 payment.ts:21,41,70 — `UserId`,`id` — /api/Cards*
**SAFE.** UserId forced by appendUserId (server.ts:434/436/437). `getPaymentMethodById`
and `delPaymentMethodById` query `{ id: req.params.id, UserId: <authenticated> }` — the
UserId clause binds every card lookup/delete to the caller. Enumerating `id` only returns
your own card (findOne/destroy scoped by UserId). No cross-user access. Resource ID Gate (a): ownership enforced.
`PUT /api/Cards/:id` = denyAll() (server.ts:435). Card numbers masked (last 4).

### #23 address.ts:11,18,29 — `UserId`,`id` — /api/Addresss*
**SAFE.** Same pattern. appendUserId (server.ts:444/446/447). getAddress/getAddressById/
delAddressById all filter `UserId: req.body.UserId` (= authenticated). `id` from params is
co-scoped by UserId in findOne/destroy. Despite reading "raw" req.body.UserId at address.ts:11,
the value was already overwritten by middleware. Ownership enforced.

### #24 wallet.ts:12,24,27 — `UserId`,`paymentId`,`balance` — /rest/wallet/balance
**SAFE (IDOR).** UserId forced (server.ts:618/619). getWalletBalance scoped to caller.
addWalletBalance: card lookup `{ id: paymentId, UserId: <auth> }` requires caller to OWN the
card (Resource ID Gate (a) satisfied); increment scoped to caller's wallet. No cross-user.
**NOTE (business-logic, CWE-840, out-of-class):** `req.body.balance` (wallet.ts:27) is an
unbounded, attacker-supplied top-up amount with NO real charge/settlement — self-only wallet
inflation. Not IDOR/NAV; flagging as business-logic observation only, likely DESIGN-INTENT (demo top-up).

### #25 deluxe.ts:19,25,35 — `UserId`,`paymentMode`,`paymentId` — POST /rest/deluxe-membership
**CANDIDATE — Conditional Validation Bypass / payment bypass (CWE-840, self privilege escalation).**
UserId forced by appendUserId, card/wallet lookups are ownership-scoped → no IDOR.
BUT the payment gate is keyed on `req.body.paymentMode`:
- deluxe.ts:24 `if (paymentMode === 'wallet') {...}`
- deluxe.ts:34 `if (paymentMode === 'card') {...}`
If `paymentMode` is **absent or any other value**, BOTH blocks are skipped and execution
falls through to deluxe.ts:42-48 which upgrades role customer→deluxe with a valid deluxeToken.
Result: free deluxe membership, no wallet debit, no card required ([REDACTED]).
Fails open — no `else { deny }`. CVB is immune to DESIGN-INTENT dismissal (phase2_shared §CVB).
- Gate 0: security check (payment) conditionally skipped — not exempt.
- Gate 1: reachable, server.ts:621 production route.
- Gate 2a: paymentMode attacker-controlled (request body).
- Gate 2b: none — presence-gated, no fail-closed default.
- Gate 3: attacker gains deluxe role (privilege + deluxeToken) without paying 49.
- **Severity: Medium** (authenticated customer, self privilege escalation).
- Data flow: body.paymentMode → deluxe.ts:24/34 (both branches false) → deluxe.ts:43 user.update({role: deluxe}).

### #26 dataExport.ts:26 — `UserId` — POST /rest/user/data-export
**SAFE.** Route mounts appendUserId (server.ts:612/613), so `MemoryModel.findAll({ UserId:
req.body.UserId })` (dataExport.ts:26) is scoped to the authenticated caller. Identity gate at
dataExport.ts:18-19 independently re-derives loggedInUser from the Bearer token; orders/reviews
queried by verified `email` from that token, not by client input. No cross-user export.

---

## Absent-input analysis
- deluxe paymentMode absent → payment skipped, free upgrade (captured as #25 CANDIDATE).
- UserId absent → appendUserId still sets it from token (fail-closed: 401 if no valid token). SAFE.

## Cross-class
None. All sinks are ORM object-authz (NAV class). No injection/log sinks reached.

## Summary
- CANDIDATE: #25 (deluxe payment/CVB bypass, CWE-840, Medium)
- SAFE: #22, #23, #24, #26 (appendUserId override wins at every DB sink; ownership-scoped queries)
- Note: #24 balance = out-of-class business-logic observation (self-only), not IDOR.
