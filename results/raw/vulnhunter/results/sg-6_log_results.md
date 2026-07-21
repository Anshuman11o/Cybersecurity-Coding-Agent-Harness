# SG-6 LOG trace results (race / crypto / resource / integer / scope)

Middleware fact: `security.appendUserId()` (insecurity.ts:173-182) runs before every
SG-6 handler and **overwrites** `req.body.UserId` with the authenticated token's
`data.id`. So `req.body.UserId` at every DB/response sink is server-controlled, not
raw client input. IDOR/object-scope concerns (NAV class) are therefore closed here;
noted as CROSS-CLASS(NAV) where relevant but not LOG findings.

## Per-input dispositions

### #22 payment.ts (`UserId`,`id`) — /api/Cards*
- **SAFE (LOG).** No crypto/race/overflow sink. `id` = `req.params.id` scoped by
  server-set `UserId` in `CardModel.findOne/destroy` (payment.ts:41,70). Card number
  masked (payment.ts:32,58). No LOG-class sink reached.

### #23 address.ts (`UserId`,`id`) — /api/Addresss*
- **SAFE (LOG).** No LOG sink. `UserId` server-set via appendUserId; `id` scoped by
  it (address.ts:18,29). No race/crypto/exhaustion.

### #24 wallet.ts (`balance`,`paymentId`,`UserId`) — PUT /rest/wallet/balance
- **CANDIDATE — CWE-840/CWE-20 (business-logic, unbounded/unvalidated amount).**
  Sink: `WalletModel.increment({ balance: req.body.balance }, ...)` **wallet.ts:27**.
  `req.body.balance` is fully attacker-controlled and unvalidated (no positive/upper
  bound; model `isInt` validate is bypassed by the atomic `increment` SQL path). A
  user holding ANY saved card (card existence is the only gate, wallet.ts:24) can
  credit their own wallet by an arbitrary amount unrelated to the card — value
  creation. Also accepts negative balance. Gate3(LOG): business-invariant violation
  = new capability, do NOT dismiss as self-only. Severity: Medium.
- **Race (read-modify-write): SAFE.** Balance mutation uses Sequelize atomic
  `increment`/`decrement` (`SET balance = balance + X`), so concurrent top-ups do not
  lose updates. Not a race finding.

### #25 deluxe.ts (`paymentMode`,`paymentId`,`UserId`) — POST /rest/deluxe-membership
- **CANDIDATE — CWE-367 (check-then-act TOCTOU on wallet payment), Low.**
  deluxe.ts:25-31: `WalletModel.findOne` reads balance, checks `balance < 49`, then
  a separate `WalletModel.decrement(49)`. The read and the decrement are not one
  atomic guarded op. Concurrent requests can both pass the `< 49` check and both
  decrement, driving balance negative (pay 49 but debit more, or upgrade near-free).
  Bounded value (deluxe role granted once) → Low.
- Card branch (deluxe.ts:35): `id`+server-set `UserId`, expiry validated — SAFE.
- `deluxeToken`/`authorize` crypto (deluxe.ts:43-47): delegated to insecurity.ts,
  no attacker-controlled crypto input here — SAFE.

### #26 dataExport.ts (`UserId`) — POST /rest/user/data-export
- **SAFE (LOG).** `UserId` server-set (appendUserId); orders/reviews scoped by
  session `loggedInUser.email` (dataExport.ts:18-40). No unbounded collection input,
  no crypto/race sink. `security.hash` used on own email only.

## Cross-class note
Raw-`UserId` IDOR surface (address.ts:11, wallet.ts:12) is neutralized by
appendUserId override → not exploitable; belongs to NAV if re-examined.
