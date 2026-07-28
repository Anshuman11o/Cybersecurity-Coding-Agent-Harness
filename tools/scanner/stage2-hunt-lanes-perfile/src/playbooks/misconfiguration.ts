export const playbook = `
Playbook for Security Misconfiguration (OWASP A05)
===================================================

Scope: Detect dangerous default configurations, exposed internals, missing security controls, and insecure deployment settings.

## OWASP Categories Covered
- OWASP A05: Security Misconfiguration

## Sink Patterns to Hunt For

### How to sweep a file for this class
Configuration is a value, not a file type. Work through this file and list every place
it does any of the following:
  - constructs or initialises a library, framework, parser, server, or client
  - passes an options object, flag, mode, or boolean literal into such a call
  - sets a header, permission, limit, timeout, or origin
  - declares a credential, key, endpoint, or environment default

That list is your candidate set. Test each entry against the patterns below: is this
particular value the unsafe one? Most dangerous settings are a single argument inside
an otherwise ordinary call, in a file with an entirely ordinary name.

1. Exposed internal resources: directories, files, or endpoints that should be internal or restricted — configuration files, environment files, version control metadata, database dumps, test fixtures, backup files.
2. Dangerous parser or deserialization settings: XML external entity resolution enabled, unsafe YAML/object deserialization, parsers with known vulnerability modes active.
3. Missing security headers or transport controls: absence of content security directives, frame-busting, MIME-type enforcement, or transport-layer security enforcement on responses.
4. Permissive cross-origin configuration: allowing any origin to make cross-origin requests to endpoints carrying credentials or sensitive data, or reflecting arbitrary origin values.
5. Debug or diagnostic endpoints exposed in production environments: introspection endpoints, REPL interfaces, profiling endpoints, stack trace exposure on error responses, configuration dumps.
6. Hardcoded secrets or credentials in source code, configuration files, or environment variable defaults.
7. Default or weak credentials for administrative interfaces, databases, or internal services.

## Distinguishing Real Findings from False Positives
- A configuration option existing is not a finding. A dangerous default left active, a security control missing where it should be, or sensitive data exposed is.
- A missing header on a static asset endpoint is typically low severity; missing headers on authenticated API responses is significant.
- Hardcoded secrets in source code are always findings, regardless of whether they are currently used in production.
- Debug endpoints in production are always findings — they should only be active in development environments.
- For undocumented or hidden endpoints: confirm the endpoint actually functions and carries a security-relevant operation before flagging.

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The misconfigured resource, endpoint, or setting
2. The dangerous default or missing control
3. How an attacker discovers and exploits it
4. The resulting exposure or unauthorized access.
`
