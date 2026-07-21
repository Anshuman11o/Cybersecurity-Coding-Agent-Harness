# SG-4 LOG Trace Results — Partition SG-4 (Profile / SSTI / SSRF / image / Data erasure)

Class group LOG focus: race conditions, cache isolation, credential scope, resource
exhaustion, prototype pollution, crypto, integer overflow.

Partition theme (SSTI/SSRF/LFI) is predominantly INJ/NAV — most inputs are CROSS-CLASS
for LOG. One genuine LOG candidate (unbounded outbound download → disk exhaustion).

---

## Input dispositions

### Input #4 — `imageUrl` (POST /profile/image/url, profileImageUrlUpload.ts:19)
- **CROSS-CLASS (NAV/INJ, CWE-918 SSRF)** — primary sink `fetch(url)` at profileImageUrlUpload.ts:24, no allowlist. Belongs to another partition/class group.
- **CANDIDATE (LOG, CWE-400 Resource Exhaustion — Low)** — sink profileImageUrlUpload.ts:24-30.
  - Gate 0: not the feature's purpose (feature is "fetch an image", not "stream unbounded bytes to server disk").
  - Gate 1: reachable — route mounted on POST /profile/image/url.
  - Gate 2a: `imageUrl` fully attacker-controlled (req.body); auth is near-unauth (open registration).
  - Gate 2b: none — `fetch(url)` has no timeout, no `Content-Length`/size cap; `response.body` is piped straight into `fs.createWriteStream(...)` (line 29-30). No max-bytes guard.
  - Gate 3: new capability — attacker makes server download an arbitrarily large remote body and write it to shared server disk (`frontend/dist/.../uploads/<id>.<ext>`), exhausting disk for all users; also a hung/slow endpoint (no timeout) ties up the request. Shared-resource DoS, not self-only.
  - Severity: Low (auth required, no per-request cap but bounded by single connection).

### Input #41 — `username` (POST /profile, updateUserProfile.ts:33)
- **CROSS-CLASS (INJ, CWE-94/CWE-1336 SSTI code injection)** — stored via `user.update({ username })` (updateUserProfile.ts:33) → read second-order at userProfile.ts:52 → `eval(code)` at **userProfile.ts:61**. Server-side template/code injection. Not a LOG class; routed to INJ.
- LOG check: no race/count invariant (full-value overwrite of own username); no crypto/proto-pollution. No LOG match.

### Input #52 — image bytes (POST /profile/image/file, profileImageFileUpload.ts)
- **NO-MATCH (LOG)** — buffer validated by `fileType.fromBuffer` + `image/*` mime check (lines 24-33); written to disk keyed by own `loggedInUser.data.id`. No race (self-scoped), no crypto, no integer overflow, no proto pollution. (Upload size cap handled by multer config outside this file — not a LOG sink here.)

### Input #53 — config `application.logo/favicon/theme/name` (rendered into templates)
- **NO-MATCH (LOG)** / note CROSS-CLASS (INJ, SSTI if config writable). Values come from server config (`config.get(...)`), not attacker-controlled at runtime per threat model. No crypto/race/exhaustion LOG sink. `themes[themeKey]` has a `|| default` fallback — no crash.

### Input #40 — `layout`, `...req.body` (POST /dataerasure, dataErasure.ts:103-124)
- **CROSS-CLASS (NAV/INJ, CWE-22 LFI / CWE-1336 SSTI)** — `req.body.layout` → `path.resolve(...)` with weak denylist (ftp/ctf.key/encryptionkeys only, dataErasure.ts:104-105) → pug `res.render` layout (line 107). Local file read / template injection. Not LOG.
- **Prototype-pollution check (LOG, CWE-1321): NEGATIVE.** `res.render('dataErasureResult', { ...req.body, ... })` — object spread copies own enumerable keys only; it does NOT assign through `__proto__`/`constructor.prototype`, and pug locals are not fed to a recursive merge. No proto-pollution sink. No LOG match beyond the cross-class LFI/SSTI.

---

## Adjacent LOG observations (shared node, not in assigned input rows)
- `lib/insecurity.ts:41` `hash = crypto.createHash('md5')` used at userProfile.ts:75 for `_emailHash_` — **DESIGN-INTENT** (Gravatar-style email hash; MD5 is Gravatar's required algorithm, not a security control).
- `lib/insecurity.ts:53` `denyAll = expressJwt({ secret: ''+Math.random() })` — insecure random, but intentional (random secret guarantees no JWT validates → deny). DESIGN-INTENT.

---

## Summary
| # | Input | LOG disposition | Sink |
|---|-------|-----------------|------|
| 4 | imageUrl | CANDIDATE CWE-400 (Low) + CROSS-CLASS SSRF | profileImageUrlUpload.ts:24-30 |
| 41 | username | CROSS-CLASS (INJ, SSTI) | userProfile.ts:61 |
| 52 | image bytes | NO-MATCH | profileImageFileUpload.ts:43 |
| 53 | config logo/favicon/theme | NO-MATCH (CROSS-CLASS SSTI) | userProfile.ts / dataErasure.ts render |
| 40 | layout / ...req.body | CROSS-CLASS (NAV/INJ, LFI/SSTI); proto-pollution NEGATIVE | dataErasure.ts:104-107 |
