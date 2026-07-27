# [MEDIUM] Unauthenticated file serving from encryptionkeys/ with only a forward-slash filter

**File:** `routes/keyServer.ts` (lines 10, 13, 14)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `path-traversal`

## Finding

serveKeyFiles() serves res.sendFile(path.resolve('encryptionkeys/', file)) for the public route /encryptionkeys/:file, with the sole guard being `!file.includes('/')`. Unlike fileServer.ts there is no extension allowlist, so any file present in encryptionkeys/ is downloadable by an anonymous user. The '/'-only check does not cover backslash separators, so on a Windows host a segment like '..\..\file' contains no '/' and path.resolve would traverse out of encryptionkeys/. Even on Linux the endpoint is an unauthenticated raw file server over a directory named 'encryptionkeys', which is an information-disclosure risk if any sensitive key material is placed there.

## Recommendation

Restrict served files to a strict allowlist of expected public key filenames; reject any name containing '/', '\\', '..', or null bytes; and require authentication if the directory can ever hold sensitive material.
