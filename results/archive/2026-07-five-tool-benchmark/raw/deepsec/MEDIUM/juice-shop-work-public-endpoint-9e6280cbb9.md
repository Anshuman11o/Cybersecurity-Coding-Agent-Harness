# [MEDIUM] Unauthenticated /metrics endpoint discloses aggregate business/user data

**File:** `routes/metrics.ts` (lines 84, 85, 86, 87, 88, 148, 194, 212)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `public-endpoint`

## Finding

serveMetrics() is registered publicly (app.get('/metrics', ...) at server.ts L668 and L720) with no authentication middleware. It returns the full Prometheus registry, which the update loop populates with sensitive operational figures: total registered users (and split by customer/deluxe type), total orders placed, review/feedback/complaint counts, aggregate cheat score, coding-challenge progress, and the summed balance of ALL users' digital wallets (walletMetrics from WalletModel.sum('balance')). An anonymous attacker can poll this endpoint to enumerate business KPIs and monitor user/wallet growth in real time. Prometheus metrics endpoints should be internal-only or authenticated.

## Recommendation

Bind /metrics to an internal interface or require an auth token/allowlist. Do not expose financially sensitive aggregates (total wallet balance) on an unauthenticated endpoint.
