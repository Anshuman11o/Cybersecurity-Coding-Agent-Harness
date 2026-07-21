# Phase 1: Reconnaissance — OWASP Juice Shop

## Attack Surface Report

**Languages**: TypeScript / JavaScript (Node.js backend), TypeScript (Angular frontend)
**Frameworks**:
- Backend: Express `^4.22.1`, body-parser, cookie-parser (signed secret `'kekse'`), Sequelize ORM (`models/`), finale-rest (auto-CRUD REST for `/api/*`), Socket.IO (`registerWebsocketEvents`), multer (`uploadToMemory`/`uploadToDisk`).
- Auth: `express-jwt` `0.1.3` (ancient), `jsonwebtoken` `0.4.0` (ancient), `jws`. RS256 JWT with **public key from `encryptionkeys/jwt.pub`** used as the verification secret. Password hashing = **MD5** (`insecurity.ts:41`).
- Notable libs: `notevil` (sandboxed eval), `libxml2-wasm` (XXE-enabled), `js-yaml`, `vm`, `ethers` (web3), `express-ipfilter`, `sanitize-html`, `download`.
- Frontend: Angular (in `frontend/`, compiled to `frontend/dist/frontend`).

**This is a deliberately vulnerable training application.** Nearly every route intentionally embeds a known vulnerability class. The inventory below is exhaustive of the live attack surface; Phase 2 should treat almost all inputs as reaching a real sink.

**Input Inventory**: 90+ inputs across ~70 entry points (61 route files + finale auto-CRUD `/api/*` + websocket + file uploads).

---

## Step 1a: Sink Inventory (file:line)

### SQL injection (string-interpolated raw queries)
- `routes/login.ts:33` — `sequelize.query("SELECT * FROM Users WHERE email = '${req.body.email}' AND password = '${hash(req.body.password)}' ...")` — **UNAUTH**. Classic authentication-bypass SQLi.
- `routes/search.ts:19` — `sequelize.query("SELECT * FROM Products WHERE ((name LIKE '%${criteria}%' OR description LIKE '%${criteria}%') ...")` where `criteria = req.query.q` — **UNAUTH**. Union-based SQLi / data exfiltration.

### NoSQL injection (MarsDB / `$where`-style, JSON.parse of params)
- `routes/orderHistory.ts:36` — `ordersCollection.update({ _id: req.params.id }, { $set: {...} })` — auth via header token lookup.
- `routes/updateProductReviews.ts:17` — `reviewsCollection.update({ _id: req.body.id }, { $set: { message: req.body.message } })` — `req.body.id` unvalidated object → NoSQL operator injection (mass update). Mounted with `security.isAuthorized()`.
- `routes/showProductReviews.ts:31` — `req.params.id` conditionally passed raw (`trunc(...,40)`) into Mongo-style find.
- `routes/recycles.ts:14` — `id: JSON.parse(req.params.id)` — untrusted JSON into query.

### eval / SSTI / sandbox-escape
- `routes/captcha.ts:22` — `eval(expression)` on server-generated arithmetic expression (challenge-gated but confirm expression source).
- `routes/userProfile.ts:61` — `eval(code)` where `code` derived from `user.username` (`#{...}` SSTI) — **stored/second-order** via profile update. Pug template server-side template injection → RCE.
- `routes/b2bOrder.ts:21-23` — `safeEval` (notevil) inside `vm.runInContext` on `orderLinesData` from `req.body.orderLinesData` — sandbox-escape target. Mounted at `POST /b2b/v2/orders` behind `/b2b/v2 isAuthorized`.
- `routes/fileUpload.ts:103-104` — `vm.runInContext('JSON.stringify(yaml.load(data))')` on uploaded YAML — DoS/deserialization.
- `lib/xml.ts:12` — `new Function('specifier','return import(specifier)')`; `xml.ts:37-38` `vm.runInContext` parsing XML with `XML_PARSE_NOENT | XML_PARSE_DTDLOAD` and **filesystem input providers registered** → **XXE (file:///etc/passwd)** and entity-expansion (billion-laughs). Reached via `handleXmlUpload` on `POST /file-upload`.

### Path traversal / arbitrary file read+write
- `routes/fileServer.ts:33` — `res.sendFile(path.resolve('ftp/', file))`; poison-null-byte handling (`cutOffPoisonNullByte`) — `/ftp/:file`.
- `routes/keyServer.ts:14` — `res.sendFile(path.resolve('encryptionkeys/', file))` — `/encryptionkeys/:file`.
- `routes/logfileServer.ts:14` — `res.sendFile(path.resolve('logs/', file))` — `/support/logs/:file`.
- `routes/quarantineServer.ts:14` — `res.sendFile(path.resolve('ftp/quarantine/', file))`.
- `routes/fileUpload.ts:31-33` — `path.resolve('uploads/complaints/' + fileName)` with weak containment check (`absolutePath.includes(path.resolve('.'))`).
- `routes/dataErasure.ts:104` — `path.resolve(req.body.layout)` → arbitrary file read rendered into Pug (`filePath`, LFI). Auth via cookie token.
- `routes/videoHandler.ts:82` — `fs.readFileSync('frontend/dist/frontend/assets/public/videos/' + subtitles ...)` — `subtitles` from config/route.
- `routes/languages.ts:31,40` — `readFile('.../assets/i18n/' + fileName)` — `fileName` from directory listing (lower risk).
- `routes/profileImageFileUpload.ts:43` / `profileImageUrlUpload.ts:26` — `fs.writeFile`/`createWriteStream` to path built from `loggedInUser.data.id` + attacker-influenced `ext`.

### SSRF
- `routes/profileImageUrlUpload.ts:24` — `await fetch(url)` where `url = req.body.imageUrl` — **SSRF**, no host allowlist; also stores raw URL (stored XSS in `<img src>`) on failure. Auth via cookie token.

### Open redirect
- `routes/redirect.ts:19` — `res.redirect(query.to)` guarded by `isRedirectAllowed` which uses **`url.includes(allowedUrl)`** (`insecurity.ts:132-138`) — substring bypass (`?to=https://evil.com?x=https://github.com/...`). **UNAUTH**.

### Weak auth / crypto / IDOR primitives
- `lib/insecurity.ts:41` — `hash = md5`. `:42` — `hmac` with **hardcoded key** `'pa4qacea4VK9t9nGv7yZtwmj'`.
- `lib/insecurity.ts:52-56` — `isAuthorized` verifies JWT with the **public key as secret**; `express-jwt@0.1.3`/`jsonwebtoken@0.4.0` are known to accept `alg:none` / RS→HS confusion. **Forgeable tokens.**
- `lib/insecurity.ts:53` — `denyAll` uses `expressJwt({secret: Math.random()})` (not a real deny).
- **IDOR via `req.body.UserId`**: `payment.ts:21,41,70`, `address.ts:11,18,29`, `wallet.ts:12,24,27`, `deluxe.ts:19,25,35`, `order.ts:146-166`, `dataExport.ts:26`, `memory.ts:15`. `appendUserId()` (`insecurity.ts:173-181`) sets `req.body.UserId` from token BUT several handlers read `req.body.UserId` where the middleware is not applied or is overridable.

### Deserialization / decoding
- `routes/order.ts:196` — `Buffer.from(req.body.couponData,'base64').toString().split('-')` — coupon forgery.
- `routes/fileUpload.ts` — `yaml.load` (js-yaml) on uploaded content; zip extraction (`handleZipFileUpload`) → **zip-slip** candidate.

### Reflected / stored XSS sinks (server-rendered)
- `routes/userProfile.ts:83` — `template.replace(/_logo_/g, ...config.get('application.logo'))` and username interpolation into Pug.
- `routes/dataErasure.ts` — Pug render with `_favicon_`, `_logo_` and `req.body` spread into template locals (`...req.body` at :108,:124).
- `routes/currentUser.ts:54` — JSONP-style `req.query.callback` handling — reflected callback.
- Frontend Angular: check `bypassSecurityTrust*`, `innerHTML`, `[innerHTML]` in `frontend/src` (product description, search result rendering — the DOM XSS challenge).

### Websocket (Socket.IO) — `lib/startup/registerWebsocketEvents.ts`
- `notification received`, `verifyLocalXssChallenge`, `verifySvgInjectionChallenge`, `verifyCloseNotificationsChallenge` handlers accept `data` — low-value but enumerated.

---

## Step 1b: Input Inventory (primary entries)

| # | Source Type | Location | Variable | Entry Point | Trust |
|---|---|---|---|---|---|
| 1 | body field | login.ts:33 | `email`,`password` | POST /rest/user/login | unauth |
| 2 | query param | search.ts:17 | `q` | GET /rest/products/search | unauth |
| 3 | query param | redirect.ts:16 | `to` | GET /redirect | unauth |
| 4 | body field | profileImageUrlUpload.ts:19 | `imageUrl` | POST /profile/image/url | auth (cookie) |
| 5 | route param | fileServer.ts:15 | `file` | GET /ftp/:file | unauth |
| 6 | route param | keyServer.ts:? | `file` | GET /encryptionkeys/:file | unauth |
| 7 | route param | logfileServer.ts:? | `file` | GET /support/logs/:file | unauth |
| 8 | route param | quarantineServer.ts:? | `file` | GET /ftp/quarantine/:file | unauth |
| 9 | file upload | fileUpload.ts / server.ts:307 | `file` (multipart) | POST /file-upload | unauth |
| 10 | file content (XML) | fileUpload.ts→xml.ts | uploaded XML | POST /file-upload (handleXmlUpload) | unauth |
| 11 | file content (YAML) | fileUpload.ts:103 | `data` | POST /file-upload (handleYamlUpload) | unauth |
| 12 | body field | b2bOrder.ts:? | `orderLinesData` | POST /b2b/v2/orders | auth |
| 13 | body field | order.ts:196 | `couponData` | POST /rest/basket/:id/checkout | auth (basket owner) |
| 14 | route param | order.ts:34 | `id` (basket) | POST /rest/basket/:id/checkout | auth |
| 15 | route param | basket.ts:18 | `id` | GET /rest/basket/:id | auth (isAuthorized) |
| 16 | body field | updateProductReviews.ts:17 | `id`,`message` | PATCH /rest/products/reviews | auth |
| 17 | route param | showProductReviews.ts:31 | `id` | GET /rest/products/:id/reviews | unauth |
| 18 | body field | createProductReviews.ts:22 | `message`,`author` | PUT /rest/products/:id/reviews | unauth |
| 19 | body field | likeProductReviews.ts:18 | `id` | POST /rest/products/reviews | auth |
| 20 | route param | recycles.ts:14 | `id` (JSON.parse) | GET /api/Recycles/:id | unauth |
| 21 | route param | orderHistory.ts:36 | `id` | PUT /rest/order-history/:id/delivery-status | isAccounting |
| 22 | body field | payment.ts:21,41,70 | `UserId`,`id` | /api/Cards* | auth+appendUserId |
| 23 | body field | address.ts:11,18,29 | `UserId`,`id` | /api/Addresss* | auth+appendUserId |
| 24 | body field | wallet.ts:12,24,27 | `UserId`,`paymentId`,`balance` | /rest/wallet/balance | auth+appendUserId |
| 25 | body field | deluxe.ts:19,25,35 | `UserId`,`paymentMode`,`paymentId` | POST /rest/deluxe-membership | auth+appendUserId |
| 26 | body field | dataExport.ts:26 | `UserId` | POST /rest/user/data-export | auth (header token) |
| 27 | cookie | currentUser.ts:17 / many | `token` | many /rest/* | unauth-parsed |
| 28 | query param | currentUser.ts:22,54 | `fields`,`callback` | GET /rest/user/whoami | unauth |
| 29 | header | saveLoginIp.ts:18 | `true-client-ip` | GET /rest/saveLoginIp | unauth (spoofable) |
| 30 | header | videoHandler.ts:23 | `range` | GET /video | unauth |
| 31 | body field | changePassword.ts | `current`,`new`,`repeat` (query) | GET /rest/user/change-password | auth (token) |
| 32 | body field | resetPassword.ts | `email`,`answer`,`new` | POST /rest/user/reset-password | unauth (rate-limited) |
| 33 | query/body | securityQuestion.ts | `email` | GET /rest/user/security-question | unauth |
| 34 | body field | 2fa.ts:17,105,150 | `tmpToken`,`totpToken`,`password`,`setupToken` | /rest/2fa/* | mixed |
| 35 | body field | captcha.ts:37 | `captchaId`,`captcha` | POST /api/Feedbacks flow | unauth |
| 36 | body field | imageCaptcha.ts:52 | `answer` | data-export captcha | auth |
| 37 | route param | vulnCodeSnippet.ts:44 | `challenge` | GET /snippets/:challenge | unauth |
| 38 | body field | vulnCodeSnippet.ts:71,86 | `key`,`selectedLines` | POST /snippets/verdict | unauth |
| 39 | route param/body | vulnCodeFixes.ts:57,71 | `key`,`selectedFix` | GET /snippets/fixes/:key, POST /snippets/fixes | unauth |
| 40 | body field | dataErasure.ts:103-124 | `layout`, `...req.body` | POST /dataerasure | auth (cookie) |
| 41 | body field | updateUserProfile.ts:33 | `username` | POST /profile | auth (cookie) — SSTI seed |
| 42 | body field | chat.ts:189 | `messages` | POST /rest/chat | unauth (LLM prompt-injection) |
| 43 | body field | web3Wallet.ts:15 / nftMint.ts:41 | `walletAddress` | /rest/web3/* | unauth |
| 44 | body field | checkKeys.ts:16 | `privateKey` | POST /rest/web3/submitKey | unauth |
| 45 | route param | restoreProgress.ts (continueCode) | `continueCode` | PUT /rest/continue-code*/apply/:continueCode | unauth |
| 46 | route param | trackOrder.ts:15 | `id` | GET /rest/track-order/:id | unauth (NoSQLi/XSS) |
| 47 | body field | memory.ts:13 | `caption`,image | POST /rest/memories | auth+appendUserId |
| 48 | body field | basketItems.ts:60,71 | `ProductId`,`quantity` | POST/PUT /api/BasketItems | auth+appendUserId |
| 49 | auto-CRUD | finale `/api/*` | all model fields | Users/Products/Feedbacks/Complaints/... | mixed (see server.ts:351-449) |
| 50 | websocket | registerWebsocketEvents.ts | `data` | socket.io events | unauth |
| 51 | header | dataExport/orderHistory | `authorization` Bearer | token lookup | unauth-parsed |
| 52 | body field | profileImageFileUpload.ts | image bytes | POST /profile/image/file | auth (cookie) |
| 53 | env/config | userProfile/videoHandler/dataErasure | `application.logo/favicon/theme` | rendered into templates | config (RCE-adjacent) |

**Auto-CRUD note (`/api/*` finale-rest)**: `POST /api/Users` (registration) is UNAUTH and accepts arbitrary fields incl. `role` (`verify.registerAdminChallenge` hints privilege escalation). `GET /api/Products/:id` unauth. `GET /api/Feedbacks` unauth (customer email leak). Each finale model exposes list/read/create/update/delete filtered by the `security.*` guards mounted in `server.ts:351-471` — enumerate per-model.

---

## Step 2: Threat Model

| Entry-point group | App-layer auth enforcement | Caller identity binding | Per-resource authorization |
|---|---|---|---|
| `POST /rest/user/login` | NONE | NONE | NONE |
| `GET /rest/products/search`, `/redirect`, `/ftp/:file`, `/encryptionkeys/:file`, `/support/logs/:file`, `/snippets/*`, `POST /file-upload`, `POST /api/Users`, `GET /api/Products*`, `GET /api/Feedbacks`, `/rest/chat`, `/rest/track-order/:id`, `/rest/web3/*` | NONE | NONE | NONE |
| `/rest/basket/:id`, `/rest/basket/:id/*`, `/rest/user/authentication-details`, `/b2b/v2/*`, `/api/BasketItems*`, `/api/Complaints`(GET/POST), `/api/Recycles`(POST), `/api/PrivacyRequests`, `/rest/2fa/status|setup|disable` | server.ts:351-471 `security.isAuthorized()` (`insecurity.ts:52`, expressJwt w/ publicKey) | insecurity.ts:52 (JWT verify — but see forgery risk) | NONE (owner check absent; `req.body.UserId` client-set) |
| `/api/Cards*`, `/api/Addresss*`, `/rest/wallet/balance`, `POST /rest/deluxe-membership`, `POST /rest/memories` | `security.appendUserId()` (insecurity.ts:173) | insecurity.ts:184-187 updateAuthenticatedUsers | PARTIAL — appendUserId forces UserId, but handlers also read raw `req.body.UserId` (address.ts:11, wallet.ts:12) — verify override |
| `/rest/order-history/orders`, `PUT /rest/order-history/:id/delivery-status`, `/api/Quantitys/:id` | `security.isAccounting()` (insecurity.ts:152) | insecurity.ts:152 (role in JWT) | role-only, no per-resource |
| `DELETE /api/Products/:id`, `/api/Challenges`, `/api/SecurityQuestions/:id`, `/api/Feedbacks/:id`(PUT) | `security.denyAll()` (insecurity.ts:53 — random secret) | N/A | N/A |

- **Attacker profile**: The three-NONE groups are reachable by **any anonymous internet client**. JWT-authenticated groups are reachable by any registered user (registration is open + admin-role injectable), and because `isAuthorized` verifies against the RS256 **public** key with an ancient `jsonwebtoken`, tokens are plausibly **forgeable** (RS/HS confusion, `alg:none`) — treat "authenticated" groups as near-unauth for Phase 2.
- **Attacker controls**: every input in Step 1b (query/body/params/headers/cookies/uploads/websocket).
- **Attacker does NOT control**: `privateKey` (`encryptionkeys/jwt.key`), server config file secrets, the HMAC key literal is in-repo (so effectively known), ctf.key.
- **Existing attacker capabilities (baseline)**: anonymous → reach all NONE-group endpoints. Registered/forged → whatever the documented per-user contract allows (own basket/cards/addresses); ownership enforcement is the missing control that Phase 2 must test (CWE-639/CWE-306).

---

## Step 3: Trust Boundaries

| Boundary | Location | Input Source | Validation |
|---|---|---|---|
| HTTP → SQL | login.ts:33, search.ts:19 | body/query | NONE (string interpolation) |
| HTTP → NoSQL | orderHistory.ts:36, updateProductReviews.ts:17, recycles.ts:14, showProductReviews.ts:31 | params/body | NONE / JSON.parse |
| HTTP → filesystem read | fileServer/keyServer/logfileServer/quarantineServer/dataErasure/videoHandler | route param/body | weak allowlist + null-byte trim |
| HTTP → filesystem write | profileImage*Upload, fileUpload (zip/complaints) | upload/url | path from user-influenced id/ext; zip-slip |
| HTTP → outbound fetch | profileImageUrlUpload.ts:24 | body imageUrl | NONE (SSRF) |
| HTTP → eval/vm | captcha.ts:22, userProfile.ts:61, b2bOrder.ts:23, fileUpload.ts:104, xml.ts:38 | body/stored username/upload | notevil/vm sandbox only |
| HTTP → redirect | redirect.ts:19 | query.to | isRedirectAllowed = substring includes (bypassable) |
| JWT verification | insecurity.ts:52-56,184-187 | Authorization header / cookie token | RS256 vs public-key-as-secret, legacy libs |
| Header trust | saveLoginIp.ts:18 (`true-client-ip`) | request header | none (spoofable) |
| Config → template | userProfile/dataErasure/videoHandler | application.logo/favicon/theme | none (SSTI/XSS if config writable) |

---

## Step 4: Build-Time Code Swapping

- `build/` directory present (compiled TS output). **Production source is the TypeScript in `routes/`, `lib/`, `models/`, `server.ts`** — always audit the `.ts` sources, not `build/*.js`.
- `lib/startup/restoreOverwrittenFilesWithOriginals.ts` copies `data/static/*` into `ftp/` and `frontend/dist` at startup — relevant to the file-serving challenges but not a prod/mock swap.
- No prod-vs-mock directory swap detected. Grunt (`Gruntfile.js`) packages distributions only.

---

## Shared Infrastructure Catalog

| Module | Role | Files |
|---|---|---|
| Auth/crypto core | JWT verify, hashing, roles, redirect allowlist, appendUserId | lib/insecurity.ts |
| Utils | filename extraction, trunc, jwtFrom, challenge helpers | lib/utils.ts |
| Challenge tracking | solveIf / isChallengeEnabled (side-effect only, non-security) | lib/challengeUtils.ts, data/datacache.ts |
| ORM models | Sequelize model defs | models/*.ts |
| XML parser | XXE-enabled parse (app-specific SINK, not neutral infra) | lib/xml.ts |
| Config | runtime config reads (app-specific sink when interpolated) | config/*.yml, lib/config.schema.ts |
| Logging | logger | lib/logger.ts |
| Websocket | socket.io registration | lib/startup/registerWebsocketEvents.ts |
| Server bootstrap / route mounting + auth guards | server.ts:179-720 |

---

## Subgraph Partitions

| Partition | Inputs | Entry Points | App-Specific Files | Shared Nodes |
|---|---|---|---|---|
| SG-1 Auth/Login/SQLi | #1,#32,#33,#31,#34 | /rest/user/login, reset-password, change-password, security-question, /rest/2fa/* | login.ts, resetPassword.ts, changePassword.ts, securityQuestion.ts, 2fa.ts | insecurity, models |
| SG-2 Search/Products/Reviews | #2,#16,#17,#18,#19 | /rest/products/search, /rest/products/:id/reviews (GET/PUT/PATCH/POST) | search.ts, showProductReviews.ts, createProductReviews.ts, updateProductReviews.ts, likeProductReviews.ts | insecurity, models |
| SG-3 File serving / traversal | #5,#6,#7,#8 | /ftp/:file, /encryptionkeys/:file, /support/logs/:file, /ftp/quarantine/:file | fileServer.ts, keyServer.ts, logfileServer.ts, quarantineServer.ts | utils, insecurity |
| SG-4 File upload / XXE / YAML / zip | #9,#10,#11 | POST /file-upload | fileUpload.ts, lib/xml.ts | utils |
| SG-5 Profile / SSTI / SSRF / image | #4,#41,#52,#53 | /profile (GET/POST), /profile/image/url, /profile/image/file | userProfile.ts, updateUserProfile.ts, profileImageUrlUpload.ts, profileImageFileUpload.ts | insecurity, utils, config |
| SG-6 Basket/Order/Coupon/Delivery | #13,#14,#15,#47,#48 | /rest/basket/:id*, checkout, coupon, /api/BasketItems*, /rest/memories | basket.ts, order.ts, basketItems.ts, memory.ts, delivery.ts | insecurity, models |
| SG-7 Payment/Wallet/Address/Deluxe (IDOR) | #22,#23,#24,#25,#26 | /api/Cards*, /api/Addresss*, /rest/wallet/balance, /rest/deluxe-membership, /rest/user/data-export | payment.ts, address.ts, wallet.ts, deluxe.ts, dataExport.ts | insecurity(appendUserId), models |
| SG-8 Order history (NoSQLi/role) | #21,#51 | /rest/order-history, /orders, /:id/delivery-status | orderHistory.ts | insecurity(isAccounting), models |
| SG-9 Redirect / video / SSRF-adjacent | #3,#30 | /redirect, /video, /promotion | redirect.ts, videoHandler.ts | insecurity(isRedirectAllowed), utils, config |
| SG-10 Data erasure (LFI/SSTI) | #40 | POST /dataerasure | dataErasure.ts | insecurity, config |
| SG-11 Vuln code challenge server | #37,#38,#39 | /snippets/:challenge, /snippets/verdict, /snippets/fixes* | vulnCodeSnippet.ts, vulnCodeFixes.ts, lib/codingChallenges.ts | utils |
| SG-12 Web3 / NFT / keys | #43,#44 | /rest/web3/*, checkKeys | web3Wallet.ts, nftMint.ts, checkKeys.ts | ethers, insecurity |
| SG-13 Chat (LLM prompt injection) | #42 | POST /rest/chat | chat.ts | ai-sdk |
| SG-14 B2B order (sandbox eval) | #12 | POST /b2b/v2/orders | b2bOrder.ts | notevil, vm |
| SG-15 Recycles / track-order / continue-code | #20,#45,#46 | /api/Recycles/:id, /rest/track-order/:id, /rest/continue-code*/apply/:continueCode | recycles.ts, trackOrder.ts, restoreProgress.ts, continueCode.ts | insecurity, models |
| SG-16 Captcha / feedback / user CRUD | #35,#36,#49 | /rest/captcha, /rest/image-captcha, /api/Feedbacks, /api/Users, finale /api/* | captcha.ts, imageCaptcha.ts, verify.ts, finale auto-CRUD | insecurity, models |
| SG-17 Misc unauth reads / headers | #27,#28,#29 | /rest/user/whoami, /rest/saveLoginIp, currentUser | currentUser.ts, saveLoginIp.ts, authenticatedUsers.ts | insecurity |
| SG-18 Websocket | #50 | socket.io events | lib/startup/registerWebsocketEvents.ts | challengeUtils |

**Production reachability**: All partitions are `PRODUCTION` — routes are mounted unconditionally in `server.ts` (no `NODE_ENV`/env gate around route registration). Challenge-solving side-effects (`challengeUtils.solveIf`) do not gate reachability. No DEV-ONLY partitions.

**Partition coverage check**: All 61 route files + finale auto-CRUD + websocket + 3 upload endpoints are assigned to a partition (SG-1..SG-18). PASS.

**Prioritization for Phase 2**: Start unauthenticated → SG-1 (SQLi auth bypass), SG-2 (SQLi/NoSQLi/XSS), SG-3 (path traversal), SG-4 (XXE/YAML/zip-slip), SG-9 (open redirect), SG-16 (admin-role registration, finale mass-assignment), SG-11/SG-13/SG-12. Then authenticated/IDOR → SG-5 (SSTI/SSRF), SG-7 (IDOR payment/wallet), SG-6, SG-8, SG-10, SG-14. The JWT-forgery question (`insecurity.ts:52-56` + legacy `jsonwebtoken@0.4.0`/`express-jwt@0.1.3`) is cross-cutting and elevates every "authenticated" partition.
