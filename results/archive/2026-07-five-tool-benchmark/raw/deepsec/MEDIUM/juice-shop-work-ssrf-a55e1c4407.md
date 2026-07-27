# [MEDIUM] downloadToFile fetches an arbitrary URL and writes to disk

**File:** `lib/utils.ts` (lines 114, 116, 117)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `ssrf`

## Finding

downloadToFile() (L114-121) calls download(url) on a caller-supplied URL and writes the bytes to a caller-supplied destination path. If either argument is reachable from user input in any caller, this is an SSRF (server fetches attacker URL, including internal/metadata endpoints) and/or path-traversal write primitive. Flagged as lower confidence because exploitability depends on callers; the function itself performs no URL/host validation.

## Recommendation

Validate/allowlist the URL scheme and host (block internal/link-local ranges) and constrain the destination path before writing.
