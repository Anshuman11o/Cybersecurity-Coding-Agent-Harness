# Sink-Driven Audit Results — OWASP Juice Shop

Target: `/tmp/juice-shop-work` (routes/, lib/, models/, server.ts). Build/test/node_modules excluded.
Note: Juice Shop is intentionally vulnerable; findings below are real code-level defects reported per the sink-driven methodology. IDs deferred (no VULN-NNN assigned).

---

## 1. ACTION-SCOPE / INJECTION AUDIT (raw SQL + NoSQL operator injection)

### CANDIDATE — SQL Injection in login (authentication bypass)
- **Sink**: `routes/login.ts:33` — `models.sequelize.query(\`SELECT * FROM Users WHERE email = '${req.body.email || ''}' AND password = '${security.hash(...)}' ...\`)`
- **Class**: CWE-89 SQL Injection
- **Severity**: High+ (unauthenticated → full auth bypass / DB read)
- **Data flow**: `req.body.email` (POST /rest/user/login, unauthenticated) → string interpolated directly into raw SQL, no `replacements`, no escaping → `sequelize.query`.
- **Gate 0**: Not intended (auth check, not a feature). **Gate 1**: reachable via `app.post('/rest/user/login', login())` server.ts:588. **Gate 2a**: attacker-controlled body. **Gate 2b**: none — plain template literal. **Gate 3**: `' OR 1=1--` logs in as arbitrary/admin user; also UNION data exfiltration. NEW capability = authentication bypass + arbitrary table read.

### CANDIDATE — SQL Injection in product search
- **Sink**: `routes/search.ts:19` — `sequelize.query(\`SELECT * FROM Products WHERE ((name LIKE '%${criteria}%' OR description LIKE '%${criteria}%') ...\`)`
- **Class**: CWE-89 SQL Injection
- **Severity**: High+ (unauthenticated, full DB read via UNION)
- **Data flow**: `req.query.q` (GET /rest/products/search, unauth) → truncated to 200 chars only → interpolated into raw SQL.
- **Gates**: G0 not intended; G1 reachable server.ts:594; G2a attacker-controlled query param; G2b only length truncation (not a sanitizer); G3 UNION SELECT extracts Users (email, password md5, totpSecret) — new capability = arbitrary DB read.

### CANDIDATE — NoSQL `$where` JS injection in product reviews
- **Sink**: `routes/showProductReviews.ts:36` — `db.reviewsCollection.find({ $where: 'this.product == ' + id })`
- **Class**: CWE-943 / NoSQL injection (server-side JS in `$where`)
- **Severity**: High (unauthenticated)
- **Data flow**: `req.params.id` → when `noSqlCommandChallenge` enabled, only `utils.trunc(id,40)` (length cap, NOT sanitization) → concatenated into a `$where` JS string evaluated by MarsDB. When challenge disabled it is `Number(...)` (safe), but the enabled branch is production-shipped code.
- **Gates**: G1 reachable server.ts:624; G2a attacker-controlled path param; G2b truncation only — `;` and JS payloads pass; G3 arbitrary JS evaluation in DB context (data exfiltration / DoS via `sleep`).

### CANDIDATE — NoSQL `$where` injection in track-order
- **Sink**: `routes/trackOrder.ts:18` — `db.ordersCollection.find({ $where: \`this.orderId === '${id}'\` })`
- **Class**: CWE-943 NoSQL injection
- **Severity**: High (unauthenticated; GET /rest/track-order/:id)
- **Data flow**: `req.params.id` → regex strip `[^\w-]` (safe branch) OR `utils.trunc(id,60)` when `reflectedXssChallenge` enabled → single-quote-delimited `$where` string. In the trunc branch a `'` breaks out.
- **Gates**: G1 reachable server.ts:609; G2b conditional truncation only; G3 read any order + JS injection.

### CANDIDATE — NoSQL `$where` injection reachable via AI chat tool
- **Sink**: `routes/chat.ts:148` — `db.reviewsCollection.find({ $where: 'this.product == ' + productId })`
- **Class**: CWE-943 NoSQL injection
- **Severity**: Medium (productId is `Number(id)` so numeric-coerced — injection largely neutralized, but reachable via LLM-tool argument; flag as lower-confidence). Same pattern, but `Number()` coercion is effective sanitization here → borderline SAFE. Recorded for completeness.

### CANDIDATE — NoSQL operator injection in review update (mass-assignment of `_id`)
- **Sink**: `routes/updateProductReviews.ts:16-20` — `reviewsCollection.update({ _id: req.body.id }, { $set: { message: req.body.message } }, { multi: true })`
- **Class**: CWE-943 (query-operator injection) + missing authorization
- **Severity**: High (authenticated user edits ANY user's review)
- **Data flow**: `req.body.id` passed as the Mongo selector value. Attacker sends `{"id": {"$ne": -1}}` → `multi:true` overwrites EVERY review's message. No ownership check on the review author vs. session user.
- **Gates**: G1 reachable server.ts:626 (`isAuthorized` only); G2a body-controlled; G2b none — object passed straight through; G3 mass edit of all reviews across users (stored-content tampering). CROSS-CLASS(NAV, CWE-639/915).

---

## 2. CREDENTIAL-ISSUING SINK AUDIT

### CANDIDATE — Hardcoded RSA private key used to sign all JWTs
- **Sink**: `lib/insecurity.ts:21` (`privateKey` literal) → `authorize()` `jwt.sign(user, privateKey, {algorithm:'RS256'})` line 54.
- **Class**: CWE-321/798 Hardcoded cryptographic key
- **Severity**: High+ — the JWT signing key is embedded in source (and the matching `jwt.pub` is served from the browsable `/encryptionkeys` dir, server.ts:276-277). Anyone can mint valid tokens for any user/role (admin) → full auth bypass.
- **Gates**: G1 reachable (every login mints tokens with it); G3 forge admin token = complete account/authorization takeover.

### CANDIDATE — JWT verification with wrong/missing algorithm (alg confusion / forged token)
- **Sink**: `lib/insecurity.ts:55` — `verify = (token) => jws.verify(token, publicKey)` (called with only 2 args; `jws.verify(sig, algorithm, secret)` — no algorithm pinned). Also `decode()` line 56 returns payload with NO signature check, and is used by `isDeluxe`/`isCustomer`/`isAccounting` (lines 154-171) after the weak `verify`.
- **Class**: CWE-347 Improper verification of cryptographic signature
- **Severity**: High — enables the classic `alg:none` / RS256→HS256 confusion forged-token attacks; role checks trust `decode()` output.
- **Gates**: G1 reachable across all role gates; G2b algorithm not constrained; G3 privilege escalation to accounting/deluxe/admin.

### CANDIDATE — MD5 used for password hashing
- **Sink**: `lib/insecurity.ts:41` — `hash = (data) => crypto.createHash('md5')...`; used in `login.ts:33`, `2fa.ts:107/152` password comparison, `order.ts:40`.
- **Class**: CWE-327/328 Weak hash for credentials (unsalted MD5)
- **Severity**: High — password store uses fast, unsalted, collision-prone MD5; trivially rainbow-tabled once DB is read (see SQLi above).

### CANDIDATE — Hardcoded HMAC secret for security answers / coupons
- **Sink**: `lib/insecurity.ts:42` — `hmac(data)=createHmac('sha256','pa4qacea4VK9t9nGv7yZtwmj')`; used in `resetPassword.ts:41` security-answer check.
- **Class**: CWE-798 Hardcoded credential / CWE-547
- **Severity**: Medium — fixed secret in source lets an attacker precompute/forge HMACs of security answers offline.

### CANDIDATE — `deluxeToken` HMAC keyed on the hardcoded privateKey
- **Sink**: `lib/insecurity.ts:148` — `createHmac('sha256', privateKey)`; token embedded in JWT and validated in `isDeluxe`. Since `privateKey` is public (finding above), the deluxe entitlement token is forgeable → paid-tier bypass. Severity Medium.

---

## 3. CRYPTOGRAPHIC SINK AUDIT

### CANDIDATE — `Math.random()` for CAPTCHA challenge
- **Sink**: `routes/captcha.ts:14-19` — arithmetic CAPTCHA terms/operators from `Math.random()`.
- **Class**: CWE-330 Insufficiently random values
- **Severity**: Low/Medium — non-crypto PRNG for an anti-automation control; predictable, but CAPTCHA answer is also returned/derivable server-side; primary weakness is design.

### CANDIDATE — `denyAll()` secret from `Math.random()`
- **Sink**: `lib/insecurity.ts:53` — `expressJwt({ secret: '' + Math.random() })`. Used as a "reject everything" middleware; predictable secret is a code smell (Low). Reachable on many `denyAll` routes (server.ts). Low severity — intent is to reject, not verify.

### CANDIDATE — SHA1 HMAC for continue-code / CTF signing
- **Sink**: `lib/utils.ts:86` — `createHmac('sha1', getCtfKey())`. SHA1 in a signing context (CWE-328). Severity Low (keyed HMAC-SHA1 not practically broken, but deprecated).

---

## 4. SENSITIVE DATA STORAGE / EXPOSURE AUDIT

### CANDIDATE — finale auto-CRUD exposes all users' records to any authenticated user
- **Sink**: `server.ts:474-500` finale mount; `server.ts:358-361` — `GET /api/Users` and `GET /api/Users/:id` gated only by `security.isAuthorized()`.
- **Class**: CWE-639 / CWE-284 Broken object-level authorization (IDOR)
- **Severity**: Medium-High — any logged-in customer can enumerate/read EVERY user (id, email, role, deluxeToken, etc.). `password` and `totpSecret` are excluded (`exclude: ['password','totpSecret']`, server.ts:477), which caps it below full-credential exposure, but cross-tenant PII (emails, roles) is disclosed with no ownership filter.
- **Gates**: G1 reachable; G2a any token; G3 cross-user PII enumeration.

### CANDIDATE — Other finale resources lack ownership filtering
- **Sink**: `server.ts:493-500` — Feedback, Card, Address, Complaint, PrivacyRequest resources auto-mounted. GET-list/read paths rely on `appendUserId()` only on specific hand-written routes (e.g. `/api/Cards` server.ts:434); the raw finale `/api/{name}s/:id` endpoints for several models are not consistently ownership-scoped. Cross-user read of feedbacks/addresses where not overridden → CWE-639, Medium. (Verify per-resource; Cards `:id` is guarded by `payment.getPaymentMethodById` which scopes `UserId`.)

### CANDIDATE — login response leaks TOTP-required signal + tmpToken
- **Sink**: `routes/login.ts:36-45` — returns whether `totpSecret !== ''` and a `tmpToken`. Minor account-enumeration/info exposure. Low.

---

## 5. CONCURRENCY / RACE CONDITION AUDIT

### CANDIDATE — Wallet balance check-then-act on order (double-spend)
- **Sink**: `routes/order.ts:148-150` — `findOne(wallet)` then `if (wallet.balance >= totalPrice) decrement(...)`. No transaction/lock between read and write.
- **Class**: CWE-367 TOCTOU race
- **Severity**: High — concurrent `POST /rest/basket/:id/checkout` requests can both pass the `balance >= totalPrice` check and both decrement, spending funds the user does not have (negative balance / free goods).
- **Gates**: G1 reachable server.ts:596; G2a attacker controls request timing + `UserId` (set by session); G3 monetary double-spend not otherwise achievable.

### CANDIDATE — Stock quantity read-modify-write race
- **Sink**: `routes/order.ts:78-81` — `quantityRow.quantity - BasketItem.quantity` then `QuantityModel.update(...)`. Non-atomic RMW; concurrent orders lose updates → inventory corruption/oversell. CWE-367, Medium.

### CANDIDATE — Deluxe upgrade wallet check-then-decrement
- **Sink**: `routes/deluxe.ts:25-31` — read `wallet.balance < 49` then `decrement(49)`. Same TOCTOU pattern; concurrent calls could upgrade while underfunded. Medium.

### Note — wallet top-up uses atomic `increment` (routes/wallet.ts:27) so no race there, BUT `addWalletBalance` lets any authenticated user credit an arbitrary `req.body.balance` after a self-owned card check (no server-side charge) → business-logic free-money (CWE-840), Medium. `getWalletBalance`/`addWalletBalance` trust `req.body.UserId` (set by `appendUserId` from the JWT — server-controlled, so not IDOR).

---

## 6. RATE-LIMIT / ATTEMPT-COUNTER AUDIT

### CANDIDATE — Reset-password rate limiter keyed on spoofable header
- **Sink**: `server.ts:340-344` — `rateLimit({... keyGenerator({headers,ip}){ return headers['X-Forwarded-For'] ?? ip } })` on `/rest/user/reset-password`.
- **Class**: CWE-307 Improper restriction of excessive auth attempts / CWE-290 spoofable identity
- **Severity**: High — the limit bucket is chosen by the attacker-supplied `X-Forwarded-For` header. Rotating that header per request resets the counter, defeating throttling on the security-question brute-force (`resetPassword.ts` compares `hmac(answer)` with no per-account attempt lockout). `app.enable('trust proxy')` (server.ts:339) makes header trust global.
- **Gates**: G0 not a feature (control being bypassed); G1 reachable; G2a header attacker-controlled; G2b none; G3 unlimited brute-force of security answers → account takeover.

### CANDIDATE — 2FA verify/setup/disable limiter with `validate:false`
- **Sink**: `server.ts:452-469` — `rateLimit({windowMs, max:100, validate:false})` on `/rest/2fa/verify` etc. `validate:false` disables express-rate-limit's proxy/keying safety validation; combined with global `trust proxy`, keying falls back to a spoofable client IP. max:100 per 5min per identity also weak for a 6-digit TOTP over the epochTolerance:30 window. CWE-307, Medium.

---

## Summary of highest-severity items
- SQLi auth bypass — `routes/login.ts:33` (High+)
- SQLi full DB read — `routes/search.ts:19` (High+)
- Hardcoded JWT signing key + public key served — `lib/insecurity.ts:21`, `server.ts:276` (High+)
- NoSQL `$where` JS injection — `showProductReviews.ts:36`, `trackOrder.ts:18` (High)
- Mass review tampering via operator injection — `updateProductReviews.ts:16` (High)
- Wallet double-spend TOCTOU — `order.ts:148` (High)
- Spoofable rate-limit key on reset-password — `server.ts:343` (High)
- MD5 password hashing — `lib/insecurity.ts:41` (High)
- Cross-user data exposure via finale — `server.ts:358,477` (Medium-High)
