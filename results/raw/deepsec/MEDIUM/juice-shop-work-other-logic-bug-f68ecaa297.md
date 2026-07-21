# [MEDIUM] Wallet top-up credits an arbitrary attacker-supplied balance with no payment processing

**File:** `routes/wallet.ts` (lines 23, 24, 27)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-logic-bug`

## Finding

In addWalletBalance, the amount credited comes straight from `req.body.balance` and is applied via `WalletModel.increment({ balance: req.body.balance }, { where: { UserId } })`. The only gate is that a card with `paymentId` exists and belongs to the user (`CardModel.findOne({ where: { id: cardId, UserId } })`); no charge is ever made against that card and the amount is never validated (no upper bound, no server-side price). An authenticated user who owns any saved card can therefore credit their own wallet with an unlimited amount of money for free. `UserId` itself is safely set by `appendUserId()` from the token, so this is a business-logic/authorization flaw rather than injection.

## Recommendation

Do not trust a client-supplied balance for financial credit; process an actual payment against the card and credit only the confirmed, server-validated amount. At minimum validate that `balance` is a positive number within sane bounds.
