export const playbook = `
Playbook for Server-Side Request Forgery (OWASP A10 / API7)
===========================================================

Scope: Detect outbound network requests where the destination is controlled by the user.

## OWASP Categories Covered
- OWASP A10: Server-Side Request Forgery
- OWASP API7: Server-Side Request Forgery

## Sink Patterns to Hunt For
1. Outbound HTTP/HTTPS calls where the URL or hostname is derived from user-controlled input (query parameters, body fields, headers). Look for any HTTP client library or network call primitive where the target address is not hardcoded or configuration-only.
2. Non-HTTP protocol calls: outbound connections to other network services (file transfer, mail, database, cache, key-value stores) where the connection target is user-controlled.
3. URL fetch/redirect implementations: services that fetch a user-provided URL (link preview generators, webhook testers, URL shorteners, image fetchers, document generators from URLs).
4. File retrieval from user-specified paths that can include protocol handlers which can interact with internal services (local filesystem, internal network services, cloud metadata endpoints).
5. DNS rebinding attacks against internal hostnames: endpoints that resolve and call hostnames within the internal network, where DNS rebinding can redirect the resolved IP to an internal service after initial validation.
6. Internal service discovery mechanisms exposed through API calls: endpoints that query service registries, configuration management systems, or service mesh endpoints using user-supplied service names or identifiers.
7. Callback URL parameters in workflows: endpoints that accept a callback URL for async processing, webhooks, OAuth flows, or payment redirects where the callback destination is user-controlled.
8. URL import endpoints: APIs that import resources (images, documents, configurations) from user-provided URLs.

## Distinguishing Real Findings from False Positives
- Outbound calls to hardcoded or configuration-only URLs are safe: the target is not user-controlled.
- User-controlled URL components that can target internal services (loopback addresses, private network ranges, cloud metadata endpoints) are the finding.
- DNS rebinding can bypass IP allow-lists — a finding that validates the hostname but not the resolved IP is still vulnerable.
- Protocol handler restrictions (http/https only) reduce but do not eliminate risk — an HTTP call to an internal service's admin endpoint is still SSRF.
- A URL validation layer that only allows specific domains or IP ranges is a valid control.
- API-internal service discovery is a finding when the discovery mechanism allows reaching services that should not be accessible from the API's network position.
- Callback URLs that are validated against an allow-list of known-good domains are safe; unrestricted callback URLs are a finding.
- API gateway or WAF-level URL filtering may mitigate the application-level gap — note it but do not dismiss the finding.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route + HTTP method)
2. The user-controlled parameter carrying the target URL/hostname/service name/callback
3. The outbound network call or service discovery mechanism
4. The internal resource or service that can be reached (metadata endpoint, internal API, admin console, service registry)
5. The data or capability the attacker gains.
`
