# SG-2 INJ Results — Product Search / Reviews

Sinks: `models.sequelize.query` (raw SQL), MarsDB collection `.find/.update/.findOne`
(`$where` = server-side JS eval; `_id` object-injection). Store readers of reviews
traced: `showProductReviews` returns review `message`/`author` as JSON (client renders).

## Dispositions

| # | Input | Disposition | Sink | Class |
|---|-------|-------------|------|-------|
| 2 | search.ts:17 `q` | CANDIDATE | search.ts:19 | CWE-89 SQLi |
| 16 | updateProductReviews.ts:17 `id`,`message` | CANDIDATE | updateProductReviews.ts:16-18 | CWE-943 NoSQL injection (`_id` operator inj) |
| 17 | showProductReviews.ts:31 `id` | CANDIDATE | showProductReviews.ts:36 | CWE-94 server-side JS via Mongo `$where` |
| 18 | createProductReviews.ts:22 `message`,`author` | CANDIDATE | createProductReviews.ts:20 -> showProductReviews.ts:45 | CWE-79 stored XSS (message/author) |
| 19 | likeProductReviews.ts:18 `id` | CANDIDATE | likeProductReviews.ts:25,35,43,50 | CWE-943 NoSQL `_id` operator injection |

---

## [VULN-201] SQL Injection in product search
- **Input**: #2 query param `q`
- **Class**: CWE-89
- **Severity**: High+
- **Location**: routes/search.ts:19
- **Gate 0**: Search is intended, but raw SQL interpolation is not — vuln.
- **Gate 1**: Route mounted GET /rest/products/search (unauth), reachable.
- **Gate 2a**: `req.query.q`, attacker-controlled, unauth.
- **Gate 2b**: Only length trunc to 200 chars; no escaping/parameterization.
- **Gate 3**: Full UNION-based read of arbitrary tables (Users, etc.) — new capability.
- **Data Flow**: req.query.q (17) -> criteria (18) -> `SELECT ... LIKE '%${criteria}%'` sequelize.query (19).
- **Root Cause**: Template-literal SQL, no parameterization.

## [VULN-202] NoSQL server-side JS injection via `$where` (showProductReviews)
- **Input**: #17 route param `id`
- **Class**: CWE-94 (Mongo/MarsDB `$where` JS eval)
- **Severity**: High
- **Location**: routes/showProductReviews.ts:36
- **Gate 1**: GET /rest/products/:id/reviews (unauth), reachable.
- **Gate 2a**: `req.params.id`, attacker-controlled.
- **Gate 2b**: When noSqlCommandChallenge enabled, `trunc(id,40)` — no JS escaping; concatenated into `$where` string. Number() path (default) is safe, but trunc path evals attacker JS (e.g. `0;return true` / sleep DoS).
- **Gate 3**: Arbitrary JS eval in DB context / NoSQL DoS.
- **Data Flow**: req.params.id (31) -> `$where:'this.product == '+id` .find (36).

## [VULN-203] NoSQL operator injection in updateProductReviews `_id`
- **Input**: #16 body `id`,`message`
- **Class**: CWE-943
- **Severity**: High
- **Location**: routes/updateProductReviews.ts:16-18
- **Gate 1**: PATCH /rest/products/reviews (auth, near-unauth per threat model), reachable.
- **Gate 2a**: `req.body.id`/`message` JSON, attacker-controlled.
- **Gate 2b**: None — object passed directly as `_id` filter; `{$gt:''}` matches all, `multi:true` sets message on every review.
- **Gate 3**: Mass overwrite of all reviews' message (also stored-XSS vector via message).
- **Data Flow**: req.body.id/message (17) -> update({_id:id},{$set:{message}},{multi:true}) (16-19).

## [VULN-204] Stored XSS / author spoofing in createProductReviews
- **Input**: #18 body `message`,`author`
- **Class**: CWE-79 (stored); author spoofing = integrity
- **Severity**: Medium
- **Location**: routes/createProductReviews.ts:20 -> read at showProductReviews.ts:45
- **Gate 2b**: message/author stored unsanitized; returned via queryResultToJson to client which renders review body.
- **Gate 3**: Persistent XSS to all viewers; `author` arbitrarily set (spoofing, forgedReviewChallenge).
- **Data Flow**: req.body.message/author (22) -> reviewsCollection.insert -> showProductReviews returns (45).
- Note: author spoofing (missing binding to authenticated user) — CROSS-CLASS(NAV, CWE-639) also.

## [VULN-205] NoSQL operator injection in likeProductReviews `_id`
- **Input**: #19 body `id`
- **Class**: CWE-943
- **Severity**: Medium
- **Location**: routes/likeProductReviews.ts:25,35,43,50
- **Gate 2a**: `req.body.id`, authed but object-injectable.
- **Gate 2b**: None — passed directly as `_id` filter (`{$gt:''}` selects arbitrary review).
- **Gate 3**: Like/select reviews not owned; limited impact.
- **Data Flow**: req.body.id (18) -> findOne/update({_id:id}) (25,35,43,50).

## CROSS-CLASS
- #18 `author` (createProductReviews.ts:22): missing binding to authenticated user — CROSS-CLASS(NAV, CWE-639 author spoofing).
