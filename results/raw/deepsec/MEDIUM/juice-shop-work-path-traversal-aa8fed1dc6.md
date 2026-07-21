# [MEDIUM] Extension allowlist bypass via poison null byte enables arbitrary file read in ftp/

**File:** `routes/fileServer.ts` (lines 27, 28, 33, 49, 50)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `path-traversal`

## Finding

servePublicFiles() enforces an extension allowlist (endsWithAllowlistedFileType checks for .md/.pdf) BEFORE calling security.cutOffPoisonNullByte(file). Because the allowlist check runs on the still-encoded filename, a request like 'package.json%00.md' passes the '.md' check, and cutOffPoisonNullByte() then truncates the string at '%00', yielding 'package.json'. The truncated name is passed to res.sendFile(path.resolve('ftp/', file)), serving a non-allowlisted file. The endpoint (app.use('/ftp(?!/quarantine)/:file')) is fully public — no auth wraps it. This lets an anonymous attacker read any file placed in the ftp/ directory regardless of its extension (backups, key files, etc.). The single-segment restriction (no '/') limits it to the ftp/ directory, but the extension filter — the only content control — is fully defeated.

## Recommendation

Call cutOffPoisonNullByte() (and fully URL-decode) BEFORE evaluating the extension allowlist, and reject any filename containing a null byte or '%00' outright rather than silently truncating.
