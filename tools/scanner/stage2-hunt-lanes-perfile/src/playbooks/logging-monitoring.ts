export const playbook = `
Playbook for Security Logging and Monitoring Failures (OWASP A09)
=================================================================

Scope: Detect absence of security-relevant logging, exposure of log data, and logging of sensitive information.

## OWASP Categories Covered
- OWASP A09: Security Logging and Monitoring Failures

## Sink Patterns to Hunt For
1. Absence of logging for security-relevant events: failed login attempts, successful logins, privilege changes, role modifications, data exports, access control denials, password resets, account creation/deletion.
2. Public exposure of internal logs or metrics: log endpoints accessible without authentication, metrics dashboards exposed to unauthenticated users, log files served by the application server.
3. Logs containing sensitive data in plaintext: passwords, API tokens, session tokens, credit card numbers, personally identifiable information (PII) written to application logs, error traces, or debug output.
4. Missing correlation IDs or request tracing that prevents reconstructing an attack timeline from logs.
5. No alerting thresholds for security events (e.g., no alert after repeated failed logins from the same source).

## Distinguishing Real Findings from False Positives
- The absence of any logging at all is the primary finding. Gaps in log coverage for specific event types are secondary findings.
- Logging a hashed password is not a finding; logging the plaintext password is.
- Internal-only log access (restricted to ops/admin roles) is acceptable; publicly accessible logs are a finding.
- Structured logging without sensitive fields is the expected pattern; the finding is the presence of sensitive data in log entries.

## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the logging is adequate and the underlying operation is itself unauthorized — use the
  class matching that operation
- a log level or destination is set to an unsafe value — that is misconfiguration
- the logged value is a secret that is also weak or reused — that is crypto-auth

Choose logging-monitoring when a security-relevant event is not recorded, is recorded
without enough detail to reconstruct it, or is recorded with data that should never be
written down. The gap is in the record of the event, not in the event.

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The security-relevant event that is not logged (or is logged inadequately)
2. The code path where logging should occur but does not
3. For sensitive data in logs: the specific log statement and the sensitive field
4. For exposed logs: the accessible endpoint or file path
5. The impact: inability to detect, investigate, or respond to a security incident.
`
