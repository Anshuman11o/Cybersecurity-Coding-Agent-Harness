export const playbook = `
Playbook for API Server-Side Request Forgery (API7)
===================================================

Scope: Detect SSRF vulnerabilities specifically in API endpoints, including API-specific patterns.

## OWASP Categories Covered
- OWASP API7: Server-Side Request Forgery

## Sink Patterns to Hunt For
1. All patterns from the general SSRF playbook (OWASP A10) applied to API endpoints: outbound HTTP calls with user-controlled URLs, URL fetch services, redirect implementations, webhook registration endpoints.
2. DNS rebinding attacks against API-internal hostnames: API endpoints that resolve and call hostnames within the internal network, where DNS rebinding can redirect the resolved IP to an internal service after initial validation.
3. Internal service discovery mechanisms exposed through API calls: API endpoints that query service registries, configuration management systems, or service mesh endpoints using user-supplied service names or identifiers.
4. Callback URL parameters in API workflows: endpoints that accept a callback URL for async processing, webhooks, OAuth flows, or payment redirects where the callback destination is user-controlled.
5. URL import endpoints: APIs that import resources (images, documents, configurations) from user-provided URLs.

## Distinguishing Real Findings from False Positives
- The same SSRF distinctions apply: hardcoded targets are safe, user-controlled targets are the finding.
- API-internal service discovery is a finding when the discovery mechanism allows reaching services that should not be accessible from the API's network position.
- Callback URLs that are validated against an allow-list of known-good domains are safe; unrestricted callback URLs are a finding.
- API gateway or WAF-level URL filtering may mitigate the application-level gap — note it but do not dismiss the finding.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The API entrypoint (route + HTTP method)
2. The user-controlled parameter (URL, hostname, service name, callback)
3. The outbound call or service discovery mechanism
4. The internal resource or service that can be reached
5. The specific capability or data the attacker gains through the API-level SSRF.
`;
