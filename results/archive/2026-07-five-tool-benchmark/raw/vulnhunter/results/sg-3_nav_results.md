# SG-3 NAV Trace Results (CSRF, IDOR, auth bypass, CVB, identity/signal spoofing, confused deputy, mass assignment, param pollution)

Partition SG-3 assigned inputs are all file-serving / upload / XXE / YAML / zip sinks.
None terminate in a NAV-class sink. All are CROSS-CLASS to INJ (path traversal,
XXE, code injection, zip-slip). NAV-specific evaluation of each below.

## Per-input dispositions

### #5 `file` — GET /ftp/:file (fileServer.ts:16 → sendFile :33)
- **CROSS-CLASS (INJ, CWE-22 path traversal / poison null byte)** — sink fileServer.ts:33.
- NAV lens: unauth public-file server. Not scoped to any principal → NOT IDOR/CWE-306
  (Missing Auth Assessment: returns public information). No state change → no CSRF. **NO-MATCH (NAV)**.

### #6 `file` — GET /encryptionkeys/:file (keyServer.ts:11 → sendFile :14)
- **CROSS-CLASS (INJ, CWE-22 path traversal)** — sink keyServer.ts:14. No allowlist/null-byte check at all.
- NAV lens: unauth public key-file server (challenge-by-design), not per-principal. **NO-MATCH (NAV)**.

### #7 `file` — GET /support/logs/:file (logfileServer.ts:11 → sendFile :14)
- **CROSS-CLASS (INJ, CWE-22 path traversal)** — sink logfileServer.ts:14.
- NAV lens: unauth, public log dir, not per-principal. **NO-MATCH (NAV)**.

### #8 `file` — GET /ftp/quarantine/:file (quarantineServer.ts:11 → sendFile :14)
- **CROSS-CLASS (INJ, CWE-22 path traversal)** — sink quarantineServer.ts:14.
- NAV lens: unauth, not per-principal. **NO-MATCH (NAV)**.

### #9 file upload (multipart) — POST /file-upload → zip extract (fileUpload.ts:31-34)
- **CROSS-CLASS (INJ, CWE-22/zip-slip write)** — sink fileUpload.ts:34 (`pipeline` write; the
  `absolutePath.includes(path.resolve('.'))` guard is prefix-only, bypassable).
- NAV lens: multipart file, not a JSON DTO → Request Body Gate N/A (no mass-assignment surface).
  Endpoint is unauthenticated → no session authority to abuse → **CSRF N/A / NO-MATCH (NAV)**.
  Gate 0: upload is intended function.

### #10 uploaded XML — POST /file-upload handleXmlUpload → parseXmlString (xml.ts:38)
- **CROSS-CLASS (INJ, CWE-611 XXE → file read/SSRF)** — sink xml.ts:38 (NOENT|DTDLOAD, fs providers registered).
- NAV lens: no identity/authz element. **NO-MATCH (NAV)**.

### #11 uploaded YAML — POST /file-upload handleYamlUpload → vm.runInContext (fileUpload.ts:104)
- **CROSS-CLASS (INJ, CWE-1321/400 code-exec-in-vm / billion-laughs DoS)** — sink fileUpload.ts:104.
- NAV lens: none. **NO-MATCH (NAV)**.

## Absent-input / CVB analysis
- `ensureFileIsPassed`, `handleXmlUpload`/`handleYamlUpload` challenge-enabled guards, and
  the `!file.includes('/')` checks are feature/challenge gates, not security-auth checks. Omitting
  inputs fails closed (400/403) or skips a challenge — no security bypass. No CVB candidate.

## Auth-helper coverage audit
- All five endpoints are intentionally unauthenticated public file/upload services (per shared
  threat model). Not cross-principal resources → no CWE-306/862 NAV candidate.

## Summary
No NAV-class candidates in SG-3. All 7 inputs = CROSS-CLASS(INJ) + NO-MATCH(NAV).
