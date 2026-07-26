export const playbook = `
Playbook for Server-Side Request Forgery (OWASP A10)
====================================================

Scope: Detect outbound network requests where the destination is controlled by the user.

## OWASP Categories Covered
- OWASP A10: Server-Side Request Forgery

## Sink Patterns to Hunt For
1. Outbound HTTP/HTTPS calls where the URL or hostname is derived from user-controlled input (query parameters, body fields, headers). Look for any HTTP client library or network call primitive where the target address is not hardcoded or configuration-only.
2. Non-HTTP protocol calls: outbound connections to other network services (file transfer, mail, database, cache, key-value stores) where the connection target is user-controlled.
3. URL fetch/redirect implementations: services that fetch a user-provided URL (link preview generators, webhook testers, URL shorteners, image fetchers, document generators from URLs).
4. File retrieval from user-specified paths that can include protocol handlers which can interact with internal services (local filesystem, internal network services, cloud metadata endpoints).

## Distinguishing Real Findings from False Positives
- Outbound calls to hardcoded or configuration-only URLs are safe: the target is not user-controlled.
- User-controlled URL components that can target internal services (loopback addresses, private network ranges, cloud metadata endpoints) are the finding.
- DNS rebinding can bypass IP allow-lists — a finding that validates the hostname but not the resolved IP is still vulnerable.
- Protocol handler restrictions (http/https only) reduce but do not eliminate risk — an HTTP call to an internal service's admin endpoint is still SSRF.
- A URL validation layer that only allows specific domains or IP ranges is a valid control.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route + HTTP method)
2. The user-controlled parameter carrying the target URL/hostname
3. The outbound network call
4. The internal resource that can be reached (metadata endpoint, internal API, admin console)
5. The data or capability the attacker gains.
`
