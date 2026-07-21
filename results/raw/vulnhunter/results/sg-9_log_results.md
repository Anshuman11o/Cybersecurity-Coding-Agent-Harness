# SG-9 LOG-class Trace Results

Class focus: race/cache/credential-scope/resource-exhaustion/prototype-pollution/crypto/integer-overflow.
Target: `/tmp/juice-shop-work` TypeScript sources. Routes confirmed unauth + reachable (server.ts:630-637).

---

## Input #44 — `privateKey` (body) — checkKeys.ts:16 — POST /rest/web3/submitKey
**Disposition: DESIGN-INTENT** (crypto / hardcoded secret)

- checkKeys.ts:10 hardcodes a BIP-39 mnemonic; privateKey derived at 12 via `HDNodeWallet.fromPhrase`.
- Used ONLY in equality comparison `req.body.privateKey === privateKey` (line 16). The key is **never disclosed** in any response body (messages at 17-24 leak no key material).
- Hardcoded mnemonic IS the intentional `nftUnlockChallenge` (Gate 0 — application's designed CTF purpose). Non-constant-time `===` compare is moot: secret derives from an intentionally-discoverable literal.
- No key disclosure, no reachable crypto weakness beyond the intended challenge. **Not a vulnerability.**

---

## Input #43 — `walletAddress` (body) — web3Wallet.ts:15, nftMint.ts:41
**Disposition: CANDIDATE (Low)** — CWE-400 unbounded in-memory Set growth

- web3Wallet.ts:16 `walletsConnected.add(metamaskAddress)` — module-level `Set` (line 10), fed one arbitrary attacker string per unauth POST /rest/web3/walletExploitAddress. Only ever pruned on a rare on-chain `ContractExploited` event (26-31); no cap, no TTL, no eviction.
- Gate 0: not a designed feature (unbounded accumulation is incidental). Gate 1: reachable (server.ts:637, unauth). Gate 2a: attacker-controlled body. Gate 2b: no size/rate bound. Gate 3: attacker grows process memory unboundedly with unique addresses → memory-exhaustion DoS. Low (single-node, slow growth).
- Location: web3Wallet.ts:16 (Set `walletsConnected`).
- nftMint.ts:41-43 `addressesMinted.has/delete` is check-then-act but only toggles a challenge flag (no count/one-to-one invariant) and the Set is populated by contract events, not user input → SAFE (no race impact).
- No injection into ethers: contract address hardcoded (web3Wallet.ts:9, nftMint.ts:9), provider URL uses env `ALCHEMY_API_KEY` not walletAddress → no SSRF/injection (would be CROSS-CLASS INJ; not present).

---

## Input #42 — `messages` (body) — chat.ts:189
**Disposition: CANDIDATE (Low, LOG) + CROSS-CLASS**

- LOG (mine): chat.ts:189 `req.body?.messages ?? []` is an unbounded collection passed straight to `streamText({ messages })` (201). No `@Size`/length cap on the array or element content. Unauth POST /rest/chat. CWE-400 resource/token-cost exhaustion (unbounded array + per-request LLM billing). Gates 0/1/2a/2b pass; Gate 3: attacker forces large memory/token consumption. Low. Location: chat.ts:189,201.
- **CROSS-CLASS (INJ, prompt injection / tool-abuse):** attacker-controlled `messages` drives LLM tool calls — generateCoupon (chat.ts:174-185), getOrderById masked-email authz (152-171), system-prompt secret-leak "15% courtesy discount" (chat.ts:104). Sink: chat.ts:201 `streamText`.
- **CROSS-CLASS (INJ, NoSQL injection):** getProductReviews tool builds `$where: 'this.product == ' + productId` (chat.ts:148); productId=Number(id) is coerced so likely safe, but flag for INJ review of the `$where` sink.
