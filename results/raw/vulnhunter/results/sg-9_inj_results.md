# SG-9 INJ Trace Results

Partition: Web3 / NFT / keys + Chat (LLM prompt injection)
Class focus: SQL/cmd/path/SSRF/XSS/redirect/XXE/LDAP/API-query/eval-SSTI/file-upload/LLM-prompt-injection

## Input dispositions

### #43 — `walletAddress` (body) — web3Wallet.ts:15, nftMint.ts:41 — /rest/web3/*
**SAFE.**
- web3Wallet.ts:15-16: `req.body.walletAddress` → `walletsConnected.add(metamaskAddress)`. Value only stored in an in-memory `Set` and later read via `.has(exploiter)` against an on-chain event arg (web3Wallet.ts:27). No injection sink.
- nftMint.ts:41-42: same pattern — `addressesMinted.has(metamaskAddress)` / `.delete()`. Membership test only.
- Contract address passed to `ethers.Contract` is a hardcoded constant (`web3WalletAddress`, `nftAddress`), NOT the user value. RPC URL is hardcoded + env var, no user input.
- No SQL/command/path/URL/template/HTML sink reached.

### #44 — `privateKey` (body) — checkKeys.ts:16 — POST /rest/web3/submitKey
**SAFE.**
- `req.body.privateKey` used only in strict `===` string comparisons against wallet-derived key/address/pubkey (checkKeys.ts:16,19,21). No interpolation, no query, no sink. Value never propagates anywhere; only branches a response message.

### #42 — `messages` (body) — chat.ts:189 — POST /rest/chat
**DESIGN-INTENT** (LLM prompt injection is the intended Juice Shop chatbot challenge).
- `req.body.messages` → `streamText({ messages, tools, system })` (chat.ts:189,201-205). Prompt injection to leak the confidential system-prompt discount or coax `generateCoupon` is the deliberate feature guarded by `chatbotPromptInjectionChallenge` / `chatbotGreedyInjectionChallenge` (chat.ts:180-181). Gate 0: intended function of the endpoint.
- **Model output reflected to user (XSS check):** streamed via SSE as `res.write('data: ' + JSON.stringify(...))` with `Content-Type: text/event-stream` (chat.ts:192,216). Output is JSON-encoded server-side and not emitted into an HTML context by the server; reflection is to the same requesting user (self). No server-side XSS sink. NOT a candidate.
- **NoSQL `$where` sink checked and SAFE:** `getProductReviews.execute` builds `db.reviewsCollection.find({ $where: 'this.product == ' + productId })` (chat.ts:148) but `productId = Number(id)` (chat.ts:147) — numeric coercion (NaN on injection) neutralizes the concatenation; not injectable. The `query`/`orderId` tool inputs are LLM-derived, and reach parameterized Sequelize `Op.like` / Mongo field-equality, not raw sinks.
- SSRF: no user-controlled outbound URL; `llmApiUrl` is server config, RPC URLs hardcoded.

## CROSS-CLASS flags
- #42 chat.ts:165-168 `getOrderById` ownership check compares `order.email` to masked email — potential authz weakness. CROSS-CLASS(NAV, CWE-639 / IDOR) for another group; not INJ.

## Summary
No INJ CANDIDATE. #43 SAFE, #44 SAFE, #42 DESIGN-INTENT.
