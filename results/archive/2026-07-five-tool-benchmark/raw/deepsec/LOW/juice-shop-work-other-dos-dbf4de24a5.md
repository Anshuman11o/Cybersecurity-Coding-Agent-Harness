# [LOW] Unauthenticated endpoint grows unbounded in-memory Set from request body

**File:** `routes/web3Wallet.ts` (lines 15, 16)
**Project:** juice-shop-work
**Severity:** LOW  •  **Confidence:** low  •  **Slug:** `other-dos`

## Finding

POST /rest/web3/walletExploitAddress is registered with no auth (server.ts L637). Each request adds req.body.walletAddress directly to the module-level `walletsConnected` Set (L15-16) with no validation or size bound, so an anonymous attacker can send many requests with distinct values to grow the Set unboundedly (memory exhaustion). The `process.env.ALCHEMY_API_KEY ?? ''` fallback (L20) is an empty string, not a hardcoded credential, so it is not a secret-exposure finding.

## Recommendation

Validate walletAddress format, bound/expire the Set, and consider rate-limiting the endpoint.
