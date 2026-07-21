# SG-2 NAV Results — Product Search / Reviews

Partition: SG-2. Class group: NAV (CSRF, IDOR, auth bypass, CVB, identity
spoofing, confused deputy, mass assignment, parameter pollution).

## Dispositions

| # | Input | Disposition |
|---|---|---|
| 2 | `q` (search.ts:17) | CROSS-CLASS (INJ) |
| 16 | `id`,`message` (updateProductReviews.ts:17) | CANDIDATE (IDOR) + CROSS-CLASS (INJ) |
| 17 | `id` (showProductReviews.ts:31) | CROSS-CLASS (INJ) |
| 18 | `message`,`author` (createProductReviews.ts:22) | CANDIDATE (Identity Spoofing) + CROSS-CLASS (INJ) |
| 19 | `id` (likeProductReviews.ts:18) | SAFE (NAV) + CROSS-CLASS (INJ) |

---

## Input #2 — search `q` → CROSS-CLASS

- Sink: `models.sequelize.query(...LIKE '%${criteria}%'...)` search.ts:19 — raw
  string interpolation into SQL.
- Not a NAV sink. Endpoint is unauth public product search; no authorization
  boundary is crossed (returns public catalog only). No IDOR/authz/identity
  concern.
- **CROSS-CLASS (input #2, search.ts:19, suspected class: INJ — SQL injection, CWE-89)**

---

## Input #17 — showProductReviews `id` → CROSS-CLASS

- Sink: `db.reviewsCollection.find({ $where: 'this.product == ' + id })`
  showProductReviews.ts:36 — attacker string concatenated into a Mongo
  `$where` JS-eval clause.
- NAV analysis: unauth read of reviews scoped to a product id. Reviews are
  public, not scoped to a principal → no IDOR / cross-principal read. NO NAV finding.
- **CROSS-CLASS (input #17, showProductReviews.ts:36, suspected class: INJ — NoSQL/JS injection via `$where`, CWE-943)**

---

## [VULN-201] IDOR — any authenticated user can modify any product review

- **Input**: #16: body `id` (and `message`) — PATCH /rest/products/reviews
- **Class**: CWE-639 (Insecure Direct Object Reference / missing ownership check)
- **Severity**: High
- **Location**: routes/updateProductReviews.ts:16-19
- **Resource ID Gate**:
  (a) Ownership check? NO. `security.authenticatedUsers.from(req)` is read into
      `user` (line 15) but NEVER used — no query binds the review `_id` to the
      caller. Any logged-in user updates ANY review.
  (b) Downstream credential: local Mongo (marsdb) call, no per-user scoping.
  (c) Single ID (`req.body.id`) — evaluated independently.
- **Gate 0**: Not intended — endpoint gates on `isAuthorized()` (auth-only), no
  design intent that any user edits others' reviews (this IS the forgedReview /
  noSqlReviews challenge behavior).
- **Gate 1**: Reachable — mounted server.ts:626 `app.patch('/rest/products/reviews', security.isAuthorized(), updateProductReviews())`.
- **Gate 2a**: `req.body.id` fully attacker-controlled.
- **Gate 2b**: No ownership/authorization filter between source and sink.
- **Gate 3**: New capability — attacker rewrites `message` of reviews they do not
  own (with `{ multi: true }`, mass-overwrite of matching docs). Cannot achieve
  via any owner-scoped path.
- **Data Flow**: PATCH body `id`,`message` → updateProductReviews.ts:15 (user
  fetched, unused) → line 16-19 `reviewsCollection.update({_id: req.body.id}, {$set:{message: req.body.message}}, {multi:true})`.
- **Root Cause**: Handler authenticates but never authorizes the specific review
  against the caller.

Also for #16: `{ _id: req.body.id }` accepts an object → NoSQL operator injection.
**CROSS-CLASS (input #16, updateProductReviews.ts:16, suspected class: INJ — NoSQL injection, CWE-943).** Fixing the IDOR authz would not fix the operator-injection sink; separate finding.

Request Body Gate on #16: fields are `id` (resource selector — covered by IDOR
above) and `message` (review content, design-intent field). No additional
role-restricted field passes unfiltered → no separate mass-assignment candidate.

---

## [VULN-202] Identity Spoofing — review author taken from request body

- **Input**: #18: body `author` (and `message`) — PUT /rest/products/:id/reviews
- **Class**: CWE-290 (Identity/authentication spoofing — attribution field from client)
- **Severity**: Medium
- **Location**: routes/createProductReviews.ts:20-26
- **Request Body Gate**: fields `message`, `author`. `author` is an
  identity/attribution field. It is copied straight into the persisted review
  (`author: req.body.author`) with NO cross-check against any session/token.
- **Gate 0 (NAV exemption)**: Identity-spoofing exemption applies — a request
  field flowing into a stored identity/attribution field breaks the trust
  binding regardless of surrounding auth. Not dismissible.
- **Gate 1**: Reachable — server.ts:625 `app.put('/rest/products/:id/reviews', ...createProductReviews())`, NO auth guard (unauth).
- **Gate 2a**: `req.body.author` fully attacker-controlled.
- **Gate 2b**: No validation binding author to a verified identity.
- **Gate 3**: New capability — attacker forges a review attributed to any
  arbitrary email/user (impersonation; the forgedReview challenge). No
  legitimate path lets a user post as another identity.
- **Data Flow**: PUT body `author` → createProductReviews.ts:23 →
  `reviewsCollection.insert({..., author: req.body.author, ...})`.
- **Root Cause**: Author is trusted from the request body instead of derived
  from the authenticated session (and the endpoint is unauthenticated).

`message` on #18 → stored, later rendered → potential stored XSS.
**CROSS-CLASS (input #18, createProductReviews.ts:22, suspected class: INJ — stored XSS via review message, CWE-79).**

---

## Input #19 — likeProductReviews `id` → SAFE (NAV) + CROSS-CLASS

- Sink: `reviewsCollection.findOne({ _id: id })` / `update({ _id: id }, {$inc..})`
  likeProductReviews.ts:25,35,43,50.
- Resource ID Gate: liking is NOT an owner-scoped operation by design — any
  authenticated user may like any review; the handler already enforces auth
  (line 20-22) and prevents double-like (line 31-33). Selecting another user's
  review to like is the intended feature, no cross-principal privilege gained.
  → **SAFE (input #19, reason: like operation not ownership-scoped; auth + dup-like guard present; no NAV boundary crossed).**
- `{ _id: id }` accepts an object → NoSQL operator injection.
  **CROSS-CLASS (input #19, likeProductReviews.ts:25, suspected class: INJ — NoSQL injection, CWE-943).**

---

## Post-Trace Audit: Authorization Helper Coverage

Across the reviews controllers: `updateProductReviews` and `createProductReviews`
perform NO ownership/authorization check while the operations are cross-principal.
Covered by VULN-201 (IDOR) and VULN-202 (identity spoofing). `likeProductReviews`
does gate (auth + dup guard). No additional CWE-862 gap beyond those emitted.

## Summary
- CANDIDATES: VULN-201 (IDOR, #16), VULN-202 (Identity Spoofing, #18)
- CROSS-CLASS(INJ): #2 (SQLi), #16 (NoSQL), #17 (NoSQL $where), #18 (stored XSS), #19 (NoSQL)
- SAFE (NAV): #19
