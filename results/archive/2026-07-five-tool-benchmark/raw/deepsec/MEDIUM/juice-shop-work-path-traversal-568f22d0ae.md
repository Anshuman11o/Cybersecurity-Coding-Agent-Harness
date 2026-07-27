# [MEDIUM] Path traversal in quarantine file server via backslash separator

**File:** `routes/quarantineServer.ts` (lines 11, 13, 14)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `path-traversal`

## Finding

serveQuarantineFiles() is mounted publicly at '/ftp/quarantine/:file' (server.ts:270) with no authentication. The user-controlled route segment params.file is passed to path.resolve('ftp/quarantine/', file) and served via res.sendFile(). The only guard is `if (!file.includes('/'))`, which blocks forward slashes but not backslashes. On Windows, path.resolve/sendFile treat '\' as a directory separator, so a request like '/ftp/quarantine/..%5c..%5cpackage.json' (params.file = '..\..\package.json', which contains no '/') escapes the quarantine directory and discloses arbitrary files. Express decodes %2f to '/' before the check so forward-slash encodings are caught, but %5c backslash encodings are not. Even on POSIX, the guard is a fragile denylist rather than confining the resolved path to the intended base directory.

## Recommendation

Do not rely on a slash denylist. Resolve the base directory and the requested path, then verify the resolved path stays within the base: `const base = path.resolve('ftp/quarantine/'); const target = path.resolve(base, file); if (!target.startsWith(base + path.sep)) return next(new Error(...));`. Additionally reject '\', '..', and null bytes, and use path.basename(file) to strip any directory components.
