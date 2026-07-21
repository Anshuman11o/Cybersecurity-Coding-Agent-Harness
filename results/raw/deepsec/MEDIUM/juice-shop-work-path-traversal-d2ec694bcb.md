# [MEDIUM] Log file serving guarded only by a forward-slash filter

**File:** `routes/logfileServer.ts` (lines 10, 13, 14)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `path-traversal`

## Finding

serveLogFiles() serves res.sendFile(path.resolve('logs/', file)) for /support/logs/:file with the sole guard `!file.includes('/')`. The route is preceded by verify.accessControlChallenges() middleware, but that is challenge-bookkeeping, not an authorization guard, so the endpoint is effectively public. The '/'-only filter does not block backslash separators (Windows) or account for OS-specific path resolution, and there is no extension restriction — any file in logs/ is downloadable. Application logs frequently contain sensitive request data (tokens, PII, error stacks), making unauthenticated download an information-disclosure risk.

## Recommendation

Enforce an extension/format allowlist for log files, reject names containing '/', '\\', '..', or null bytes, and require an authenticated privileged (e.g. accounting/admin) session to download logs.
