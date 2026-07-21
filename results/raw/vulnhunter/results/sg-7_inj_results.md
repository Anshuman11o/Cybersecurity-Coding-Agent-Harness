# SG-7 INJ Trace Results

Partition SG-7 — redirect / video / recycles / track-order / continue-code.
Agent class: INJ. Target: `/tmp/juice-shop-work` TypeScript sources.

## Disposition Summary
| # | Input | Disposition | Sink | Class |
|---|---|---|---|---|
| 3 | `to` query, redirect.ts:15 | CANDIDATE (VULN-701) | redirect.ts:19 | CWE-601 Open Redirect |
| 30 | `range` header, videoHandler.ts:23 | SAFE | videoHandler.ts:26-29 | numeric parseInt only |
| 20 | `id` JSON.parse, recycles.ts:14 | CANDIDATE (VULN-702) | recycles.ts:12-14 | CWE-943 Sequelize object/NoSQL injection |
| 45 | `continueCode`, restoreProgress.ts | SAFE | hashids.decode | strict regex `^[a-zA-Z0-9]+$` |
| 46 | `id`, trackOrder.ts:15 | CANDIDATE (VULN-703) | trackOrder.ts:18 | CWE-943/CWE-94 Mongo `$where` JS injection |

---

### [VULN-701] Open redirect via substring allowlist bypass
- **Input**: #3 — query param `to` (GET /redirect), unauth
- **Class**: CWE-601 Open Redirect
- **Severity**: Medium (phishing enabler; no scheme validation but `javascript:` cannot pass the includes check unless it also contains an allowlisted URL — see note)
- **Location**: routes/redirect.ts:19 (`res.redirect(toUrl)`); guard lib/insecurity.ts:132-138
- **Gate 0**: Redirect feature exists, but allowlist is the intended security control being bypassed — not design-intent.
- **Gate 1**: Reachable — GET /redirect mounted unauth (shared context threat model).
- **Gate 2a**: `toUrl = query.to`, fully attacker-controlled.
- **Gate 2b**: `isRedirectAllowed` uses `url.includes(allowedUrl)` (insecurity.ts:135) — substring match, not prefix/host validation. Bypass: `?to=https://evil.com/?x=https://github.com/juice-shop/juice-shop` includes an allowlisted string → allowed → redirects to evil.com. Ineffective.
- **Gate 3**: Attacker redirects victims to arbitrary external site under the app's trusted /redirect endpoint (phishing / OAuth-token theft staging).
- **Data Flow**: query.to (redirect.ts:15) → isRedirectAllowed substring pass (insecurity.ts:135) → res.redirect (redirect.ts:19).
- **Root Cause**: `includes()` instead of origin/prefix validation.

### [VULN-702] Object / operator injection into Sequelize where via JSON.parse
- **Input**: #20 — route param `id` (GET /api/Recycles/:id), unauth
- **Class**: CWE-943 (NoSQL/ORM object injection)
- **Severity**: Low-Medium
- **Location**: routes/recycles.ts:12-14
- **Gate 0**: Not design-intent; id expected to be a scalar.
- **Gate 1**: Reachable — unauth route.
- **Gate 2a**: `JSON.parse(req.params.id)` — attacker supplies arbitrary JSON (e.g. `{"$gt":0}` / nested object) placed directly as `where.id`.
- **Gate 2b**: No sanitization; raw parsed object handed to Sequelize `findAll`. Sequelize parameterizes scalar values (blocks raw SQLi) but attacker-controlled object shape can alter query semantics; malformed JSON throws → caught (info disclosure minimal).
- **Gate 3**: Limited data-shaping of the recycle query; not raw SQL. Flagged as candidate per INJ Gate 3 "unsanitized value into backend query construction."
- **Data Flow**: req.params.id → JSON.parse (recycles.ts:14) → RecycleModel.findAll where id.
- **Root Cause**: Untrusted JSON parsed into ORM filter without type constraint.

### [VULN-703] MongoDB `$where` server-side JS injection in track-order
- **Input**: #46 — route param `id` (GET /rest/track-order/:id), unauth
- **Class**: CWE-943 NoSQL injection + CWE-94 server-side JS (Mongo `$where` executes JS)
- **Severity**: High+ (unauth code/query injection into DB `$where`)
- **Location**: routes/trackOrder.ts:18
- **Gate 0**: Not design-intent.
- **Gate 1**: Reachable — unauth /rest/track-order/:id.
- **Gate 2a**: `id` derived from `req.params.id`.
- **Gate 2b**: TWO paths (trackOrder.ts:15). Path A (reflectedXssChallenge disabled): `String(id).replace(/[^\w-]+/g,'')` strips quotes/metachars → SAFE on that path. Path B (challenge enabled): `utils.trunc(id, 60)` — NO metacharacter stripping → single-quote breakout into ``$where: `this.orderId === '${id}'` `` allows arbitrary JS/query (e.g. `a' || 'a'=='a`, `'; return true; //`). Sanitizer path-dependent; unsanitized path exists.
- **Gate 3**: Attacker executes arbitrary boolean/JS in Mongo `$where`, exfiltrating all orders / boolean-based extraction.
- **Data Flow**: req.params.id → trunc (trackOrder.ts:15) → template literal into `$where` → ordersCollection.find (trackOrder.ts:18).
- **Root Cause**: User input interpolated into `$where` JS string; sanitization gated on a challenge flag.

---

## SAFE
- **#30 range header** — `range.replace(/bytes=/,'').split('-')` then `parseInt(...,10)` into `fs.createReadStream(path,{start,end})`. Only numbers used; `path` is config-derived, not from range. No path traversal / injection. Malformed range → NaN offsets (benign). SAFE.
- **#45 continueCode** — validated by `hashidRegexp = /^[a-zA-Z0-9]+$/` before `hashids.decode`; decode yields integers only, compared to challenge ids. No sink. SAFE (all three restoreProgress variants).

## Notes
- videoHandler.ts config-driven `videoPath`/`getSubsFromFile`/pug.compile SSTI depends on config writability (not an SG-7 assigned input; config trust boundary flagged elsewhere) — out of scope for assigned inputs.
- No CROSS-CLASS sinks encountered for assigned inputs.
