export const playbook = `
Playbook for Security Misconfiguration (OWASP A05, API8, API9)
==============================================================

Scope: Detect dangerous default configurations, exposed internals, and missing security controls.

## OWASP Categories Covered
- OWASP A05: Security Misconfiguration
- OWASP API8: Security Misconfiguration (API-specific)
- OWASP API9: Improper Inventory Management

## Sink Patterns to Hunt For
1. Exposed directories/files that should be internal: logs, configuration files, backups, private keys, .env files, .git directories, database dumps, test fixtures.
2. Dangerous parser settings: XML external entity (XXE) resolution enabled, YAML unsafe load (allowing arbitrary object deserialization), JSON parsers with prototype pollution vectors.
3. Missing security headers: Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security, Referrer-Policy.
4. Permissive CORS configuration: Access-Control-Allow-Origin: * on endpoints carrying credentials or sensitive data, or reflecting arbitrary Origin values.
5. Debug endpoints exposed in production: /debug, /actuator, /console, REPL interfaces, profiling endpoints, stack trace exposure on error responses.
6. Undocumented API endpoints: routes that exist in the code but are not declared in the public API specification — these may lack the security controls applied to documented endpoints.

## Distinguishing Real Findings from False Positives
- A configuration option existing is not a finding. A dangerous default left active, or a security control missing where it should be, is.
- A missing header on a static asset endpoint is typically low severity; missing headers on authenticated API responses is significant.
- An exposed .git directory is always a finding (source code, credentials, and commit history exposure).
- For undocumented endpoints: confirm the endpoint actually functions and carries a security-relevant operation before flagging.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The misconfigured resource or endpoint
2. The dangerous default or missing control
3. How an attacker discovers and exploits it
4. The resulting exposure or unauthorized access.
`;
