# Partition SG-7 — NAV Trace Results

## Disposition Summary
| # | Input | Disposition | Sink | Class |
|---|---|---|---|---|
| 3 | query `to` (redirect) | **CANDIDATE** | redirect.ts:19 | CWE-601 Open Redirect |
| 30 | header `range` (video) | **NO-MATCH** | videoHandler.ts:29 | DoS/resource (not NAV) |
| 20 | param `id` (recycles) | **CANDIDATE** + CROSS-CLASS | recycles.ts:12-14 | CWE-639 IDOR / INJ |
| 45 | param `continueCode` | **DESIGN-INTENT** | restoreProgress.ts | self-service, hashid-validated |
| 46 | param `id` (track-order) | **CROSS-CLASS(INJ)** | trackOrder.ts:18 | NoSQL `$where` (INJ) |

---

### [VULN-701] Open Redirect via substring allowlist bypass
- **Input**: #3 query param `to` — GET /redirect
- **Class**: CWE-601 Open Redirect
- **Severity**: Medium
- **Location**: routes/redirect.ts:19 (sink `res.redirect(toUrl)`)
- **Gate 0**: Redirect allowlist is meant to restrict targets — a bypass of the check is a vuln, not intended function.
- **Gate 1**: Reachable — mounted unauth at server.ts:651.
- **Gate 2a**: Attacker-controlled — raw `query.to`.
- **Gate 2b**: `isRedirectAllowed` (insecurity.ts:132-138) uses `url.includes(allowedUrl)` substring match. `http://evil.com/?x=https://github.com/juice-shop/juice-shop` contains an allowed URL as substring → passes. Ineffective.
- **Gate 3**: Attacker redirects victims to arbitrary external URL (phishing/crypto-scam) with juice-shop as the referring origin.
- **Data Flow**: query.to → redirect.ts:15 → isRedirectAllowed (substring, insecurity.ts:135) → res.redirect(toUrl) redirect.ts:19.
- **Root Cause**: Substring containment instead of prefix/origin validation.

### [VULN-702] IDOR read on GET /api/Recycles/:id
- **Input**: #20 route param `id` — GET /api/Recycles/:id
- **Class**: CWE-639 IDOR (Resource ID Gate)
- **Severity**: Medium (cross-principal read)
- **Location**: routes/recycles.ts:12-14; route server.ts:383 (no guard, unauth)
- **Gate a (ownership)**: None. RecycleModel has `UserId` (models/recycle.ts:20) but handler queries `where:{id}` with no caller-ownership check and no auth middleware on the GET route (POST=isAuthorized, PUT/DELETE=denyAll, GET=open).
- **Gate 1**: Reachable, server.ts:383.
- **Gate 3**: Any anonymous user reads any user's recycle records (address linkage, quantities, dates).
- **CROSS-CLASS(INJ)**: same `req.params.id` flows through `JSON.parse` into Sequelize `where` (recycles.ts:14) — NoSQL/query-object injection sink → suspected INJ class.

### CROSS-CLASS — #46 track-order `id`
- `req.params.id` → `db.ordersCollection.find({ $where: \`this.orderId === '${id}'\` })` at trackOrder.ts:18. String interpolation into MongoDB `$where` (server-side JS) → NoSQL/JS injection. Suspected class: **INJ**. Resource ID gate: track-order-by-orderId is intentional public lookup (DESIGN-INTENT for auth).

### Notes
- #30 range header: only controls integer `start`/`end` on a fixed config-derived path (videoHandler.ts:20-29); no NAV sink. NO-MATCH.
- #45 continueCode: `hashidRegexp` validated, decodes to challenge IDs, restores caller's own progress — self-service, not cross-principal. DESIGN-INTENT.
- Auth-helper coverage: GET /api/Recycles/:id lacks a guard while sibling verbs use isAuthorized/denyAll (server.ts:381-385) — reinforces VULN-702 (CWE-862/306).
