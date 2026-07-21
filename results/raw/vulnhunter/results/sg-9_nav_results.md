# SG-9 NAV Trace Results

Class focus: CSRF, IDOR, auth bypass, CVB, identity spoofing, confused deputy,
mass assignment, parameter pollution. Target `/tmp/juice-shop-work`.

## Input dispositions

### #43 `walletAddress` — web3Wallet.ts:15 & nftMint.ts:41
**SAFE (DESIGN-INTENT).**
- web3Wallet.ts:15 → `walletsConnected.add(req.body.walletAddress)`; later compared
  against on-chain `ContractExploited` event `exploiter` (line 27). Contract address
  is hardcoded (`web3WalletAddress`, line 9) — walletAddress never interpolated into
  any ethers/RPC call or template.
- nftMint.ts:41 → `addressesMinted.has(req.body.walletAddress)` (line 42); Set is
  populated only from on-chain `NFTMinted` events (line 24). Hardcoded `nftAddress`.
- Resource ID Gate: value is only tested for membership in an in-memory Set used to
  toggle a CTF challenge flag (`solveIf`, side-effect only). No cross-principal
  resource is read/modified, no ownership boundary, no outbound identity header.
  Self-service challenge solving → not IDOR / not identity spoofing.
- No SSRF: RPC URL is hardcoded `wss://eth-sepolia...`; only `ALCHEMY_API_KEY` env
  interpolated, not attacker input.

### #44 `privateKey` — checkKeys.ts:16
**SAFE (DESIGN-INTENT).**
- `req.body.privateKey` used only in strict equality comparisons (`===`, lines 16/19/21)
  against a hardcoded mnemonic-derived key/address/pubkey to toggle `nftUnlockChallenge`.
- No auth decision, no outbound credential, no store write. Not a NAV sink.

### #42 `messages` — chat.ts:189
**CROSS-CLASS (INJ — LLM prompt injection).**
- `req.body?.messages` flows unsanitized into `streamText({ messages })` (chat.ts:201).
  Primary risk is LLM prompt injection → tool abuse (`generateCoupon`, line 174) — an
  injection/LLM sink, not NAV. Suspected class: INJ. Sink: chat.ts:201.
- NAV sub-checks performed, all SAFE:
  - Request Body Gate (CWE-915): `messages` is the LLM conversation array, not a DTO
    mapped to a persistence model with sensitive fields. No mass assignment.
  - `getOrderById` tool (line 152) DOES enforce ownership: derives userId from verified
    JWT (line 158), fetches caller email, compares `order.email !== maskedEmail`
    (line 168). Prompt injection cannot bypass this server-side check → no IDOR.
  - `generateCoupon` triggering via injection is the intended CTF challenge
    (`chatbotPromptInjectionChallenge`) → Gate 0 DESIGN-INTENT for NAV.
  - `getProductReviews` `$where` string-concat is INJ-class but neutralized by
    `Number(id)` (line 147) — noted CROSS-CLASS, not NAV.

## Authorization helper coverage audit (NAV structural check)
- web3/nft/checkKeys endpoints: all unauth CTF challenge endpoints per shared threat
  model (all-NONE auth group). They read/write only in-memory challenge Sets scoped to
  no principal — not cross-principal state → not CWE-306 findings.
- chat: unauth by design; the one authorization decision (getOrderById) is present and
  session-bound. No sibling handler lacks a check that a peer performs.

## Summary
No NAV CANDIDATES. #43 SAFE, #44 SAFE, #42 CROSS-CLASS(INJ, chat.ts:201).
