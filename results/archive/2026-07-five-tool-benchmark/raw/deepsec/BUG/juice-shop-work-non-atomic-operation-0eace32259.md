# [BUG] Wallet balance check and decrement are not atomic (TOCTOU)

**File:** `routes/deluxe.ts` (lines 26, 29, 30)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `non-atomic-operation`

## Finding

`WalletModel.findOne` reads the balance and the `< 49` check (L26) is separated from `WalletModel.decrement` (L30) with no transaction or row lock. Two concurrent upgrade requests for the same wallet can both pass the balance check before either decrements, allowing the balance to be driven negative or a single balance to fund two upgrades. Also, when no wallet exists (`wallet == null`) the guard falls through to the `else` branch and calls `decrement` anyway (a no-op, but the upgrade still proceeds without payment).

## Recommendation

Perform the balance check and decrement inside a single transaction with a locking read (or use an atomic conditional UPDATE that decrements only when balance >= 49 and verify affected-row count). Handle the null-wallet case explicitly.
