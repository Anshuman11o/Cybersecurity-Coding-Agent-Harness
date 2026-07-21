# [CRITICAL] JWT verification without algorithm pinning enables RS256→HS256 algorithm confusion

**File:** `lib/insecurity.ts` (lines 52, 187)
**Project:** juice-shop-work
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `jwt-handling`

## Finding

isAuthorized() (L52) calls expressJwt({ secret: publicKey }) and updateAuthenticatedUsers() (L187) calls jwt.verify(token, publicKey, cb) — neither pins `algorithms`. Tokens are signed RS256 with a private key (L54), but verification accepts any algorithm the token header declares. Because publicKey (L20) is a readable RSA public key (encryptionkeys/jwt.pub, also shipped in the repo), an attacker can forge a token with header alg=HS256 and compute the HMAC using the public key string as the shared secret. The verifier will treat the public key as an HMAC secret and accept the forgery, allowing arbitrary identity/role (e.g. role=admin) impersonation and full authentication bypass. updateAuthenticatedUsers() further inserts the forged decoded token into the in-memory authenticatedUsers map.

## Recommendation

Pin algorithms explicitly on every verification path: expressJwt({ secret: publicKey, algorithms: ['RS256'] }) and jwt.verify(token, publicKey, { algorithms: ['RS256'] }, cb). Never allow HMAC algorithms when verifying with an asymmetric public key.
