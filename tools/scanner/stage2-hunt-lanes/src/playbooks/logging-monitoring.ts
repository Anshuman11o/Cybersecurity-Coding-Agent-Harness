export const playbook = `
Playbook for Security Logging and Monitoring Failures (OWASP A09)
=================================================================

Scope: Detect absence of security-relevant logging, exposure of log data, and logging of sensitive information.

## OWASP Categories Covered
- OWASP A09: Security Logging and Monitoring Failures

## Sink Patterns to Hunt For
1. Absence of logging for security-relevant events: failed login attempts, successful logins, privilege changes, role modifications, data exports, access control denials, password resets, account creation/deletion.
2. Public exposure of internal logs or metrics: log endpoints accessible without authentication, metrics dashboards (Prometheus, Grafana) exposed to unauthenticated users, log files served by the web server.
3. Logs containing sensitive data in plaintext: passwords, API tokens, session tokens, credit card numbers, PII (email addresses, phone numbers, physical addresses) written to application logs, error traces, or debug output.
4. Missing correlation IDs or request tracing that prevents reconstructing an attack timeline from logs.
5. No alerting thresholds for security events (e.g., no alert after 10 failed logins from the same IP).

## Distinguishing Real Findings from False Positives
- The absence of any logging at all is the primary finding. Gaps in log coverage for specific event types are secondary findings.
- Logging a hashed password is not a finding; logging the plaintext password is.
- Internal-only log access (restricted to ops/admin roles) is acceptable; publicly accessible logs are a finding.
- Structured logging without sensitive fields is the expected pattern; the finding is the presence of sensitive data in log entries.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The security-relevant event that is not logged (or is logged inadequately)
2. The code path where logging should occur but does not
3. For sensitive data in logs: the specific log statement and the sensitive field
4. For exposed logs: the accessible endpoint or file path
5. The impact: inability to detect, investigate, or respond to a security incident.
`;
