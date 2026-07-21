# [HIGH] Server-Side Request Forgery via user-controlled profile image URL

**File:** `routes/profileImageUrlUpload.ts` (lines 19, 24, 30)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `ssrf`

## Finding

The handler reads `req.body.imageUrl` and passes it directly to `fetch(url)` (L24) with no scheme/host allowlist and the default `redirect: 'follow'` behavior. Any authenticated user (registration is open, so effectively any anonymous attacker after a free signup) can force the server to issue arbitrary outbound GET requests to internal-only endpoints (e.g. cloud metadata `http://169.254.169.254/`, `http://localhost:*` admin services, internal hostnames). The code even records `req.app.locals.abused_ssrf_bug` when the URL matches an internal challenge path, confirming this is a reachable SSRF sink. The response body is streamed to disk and, on failure, the raw URL is stored as the user's `profileImage`. No egress restriction or URL validation is performed.

## Recommendation

Validate the URL scheme (only https/http), resolve and reject private/link-local/loopback IP ranges (SSRF allowlist/denylist), disable redirect following (`redirect: 'manual'`) or re-validate each redirect hop, and enforce a response size/time limit.
