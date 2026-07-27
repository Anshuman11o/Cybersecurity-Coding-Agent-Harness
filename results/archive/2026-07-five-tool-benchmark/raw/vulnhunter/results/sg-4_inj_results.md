# SG-4 INJ Trace Results — Profile / SSTI / SSRF / Data erasure

Agent: INJ trace, partition SG-4. Sources audited: routes/profileImageUrlUpload.ts,
updateUserProfile.ts, profileImageFileUpload.ts, dataErasure.ts, userProfile.ts, lib/utils.ts.

## Disposition summary
| # | Input | Disposition | Sink | Class |
|---|-------|-------------|------|-------|
| 4 | `imageUrl` body | CANDIDATE | profileImageUrlUpload.ts:24 | CWE-918 SSRF |
| 41 | `username` body (second-order) | CANDIDATE | userProfile.ts:61 | CWE-94 code injection / SSTI |
| 52 | image bytes | SAFE | profileImageFileUpload.ts:41 | — |
| 53 | config logo/favicon/theme | SAFE | userProfile.ts / dataErasure.ts | — |
| 40 | `layout` + `...req.body` | CANDIDATE | dataErasure.ts:104-110 | CWE-98/73 LFI + CWE-94 SSTI |

---

## [VULN-401] SSRF via profile image URL fetch
- **Input**: #4 body `imageUrl`
- **Class**: CWE-918 Server-Side Request Forgery
- **Severity**: High
- **Location**: routes/profileImageUrlUpload.ts:24
- **Gate 0**: Feature fetches a remote avatar, but no scheme/host allowlist → not the safe design; SSRF is unintended.
- **Gate 1**: Route mounted `POST /profile/image/url` (server.ts). Production-reachable.
- **Gate 2a**: `url = req.body.imageUrl` — fully attacker-controlled (any authenticated user; open registration).
- **Gate 2b**: NONE. `fetch(url)` called directly. No scheme (`file:`/`http:`/internal-IP) validation. Only a regex that sets a challenge flag (line 20), not a block.
- **Gate 3**: Attacker reaches internal/metadata endpoints (e.g. `http://169.254.169.254/`, internal services) from the server. On fetch failure the raw `url` is also stored as `profileImage` (line 36) → later reflected in CSP `img-src` (userProfile.ts:88) — secondary stored-content injection.
- **Data Flow**: req.body.imageUrl → url (line 19) → fetch(url) (line 24).
- **Root Cause**: Unvalidated user URL passed to server-side fetch.

## [VULN-402] Stored SSTI / code execution via username (eval)
- **Input**: #41 body `username` (POST /profile), stored to DB, read second-order.
- **Class**: CWE-94 Code Injection (server-side `eval`) / SSTI, also CWE-79 XSS via pug render
- **Severity**: High+
- **Location**: routes/userProfile.ts:61 (`eval(code)`); source updateUserProfile.ts:33
- **Gate 0**: Not intended — arbitrary server-side eval of username content.
- **Gate 1**: `updateUserProfile` (POST /profile) and `getUserProfile` (GET /profile) both mounted. Reachable.
- **Gate 2a**: `req.body.username` → `user.update({username})` (updateUserProfile.ts:33) → DB store → read as `user.username` (userProfile.ts:52). Attacker-controlled, second-order.
- **Gate 2b**: NONE. Username matching `#{(.*)}` has inner code extracted (line 60) and passed to `eval(code)` (line 61). Result then string-replaced into pug template and compiled/rendered (lines 73,87,96) → also XSS. No sanitization.
- **Gate 3**: Server-side JS execution in app context; and reflected HTML/JS into rendered profile page (CSP allows `unsafe-eval`).
- **Data Flow**: req.body.username → UserModel.update (updateUserProfile.ts:33) → DB → user.username (userProfile.ts:52) → substring (60) → eval (61) → template.replace (73) → pug.compile/render (87,96).
- **Root Cause**: Stored user field passed to `eval` and raw template substitution.

## [VULN-403] LFI + SSTI via dataErasure `layout` / body spread
- **Input**: #40 body `layout` and `...req.body` (POST /dataerasure)
- **Class**: CWE-98/CWE-73 Local File Read via template `layout` option; CWE-94 SSTI via unfiltered body spread
- **Severity**: High
- **Location**: routes/dataErasure.ts:103-110
- **Gate 0**: Not intended; arbitrary local file inclusion / template control.
- **Gate 1**: `POST /dataerasure` mounted. Reachable (auth cookie).
- **Gate 2a**: `req.body.layout` and entire `req.body` spread into `res.render('dataErasureResult', {...req.body, ...themeVars})`. Attacker-controlled.
- **Gate 2b**: WEAK blocklist only — `path.resolve(req.body.layout).toLowerCase()` rejected only if it contains `ftp`/`ctf.key`/`encryptionkeys` (line 105). Any other absolute path is rendered as the pug `layout`, disclosing first 100 bytes of arbitrary server files (line 114). No `..`/base-dir confinement. `...req.body` also injects arbitrary template locals.
- **Gate 3**: Read of arbitrary local files (outside the three blocked paths) and template-local injection.
- **Data Flow**: req.body.layout → path.resolve (104) → blocklist check (105) → res.render layout option (107) → html.slice(0,100) → res.send (114).
- **Root Cause**: User-controlled `layout` and body spread reach the template engine with only a substring blocklist.

---

## SAFE dispositions
- **#52 image bytes** — SAFE. profileImageFileUpload.ts: storage path uses server-side `loggedInUser.data.id` + `uploadedFileType.ext` derived from `file-type.fromBuffer` content sniffing (constrained to detected image types, no separators). No user-controlled filename/path component. Content-type validated against actual bytes (line 30). No path traversal / unrestricted upload.
- **#53 config application.logo/favicon/theme** — SAFE. Values come from on-disk config (not attacker-controlled in this partition; no config-write endpoint here). `logo`/`favicon` pass through `utils.extractFilename` (strips path to basename after last `/`, drops query). `name` HTML-encoded via entities.encode. themeKey indexes a fixed `themes` map with fallback. If a config-write primitive exists elsewhere, revisit as second-order.

## CROSS-CLASS notes
- VULN-402/403 render into HTML templates → XSS (CWE-79) co-occurs; retained in INJ as they are same-sink code/template injection.
- No NAV (CWE-915/639) header-injection sinks observed on outbound calls in these files.
