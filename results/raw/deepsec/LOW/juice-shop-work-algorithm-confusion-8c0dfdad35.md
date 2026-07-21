# [LOW] jwt.verify without algorithm pinning (challenge-detection path)

**File:** `routes/verify.ts` (lines 88)
**Project:** juice-shop-work
**Severity:** LOW  •  **Confidence:** low  •  **Slug:** `algorithm-confusion`

## Finding

`jwt.verify(token, security.publicKey, cb)` (L88) does not pass an `algorithms: ['RS256']` allowlist, leaving it open to RS256->HS256 algorithm-confusion in principle. In this file the call only drives neutered challenge-detection bookkeeping (every `solveIf` is passed `() => false`) and grants no access, so exploitability here is negligible. Note, however, that the same missing pinning exists in the real auth gate `isAuthorized = expressJwt({ secret: publicKey })` in lib/insecurity.ts (out of scope for this file list) where it would matter.

## Recommendation

Always pin the expected algorithm(s) in both jwt.verify and the express-jwt configuration.
