export const playbook = `
Playbook for Unrestricted Resource Consumption (API4)
=====================================================

Scope: Detect endpoints vulnerable to denial-of-service through excessive resource consumption.

## OWASP Categories Covered
- OWASP API4: Unrestricted Resource Consumption

## Sink Patterns to Hunt For
1. Endpoints missing rate limiting entirely — no per-IP, per-user, or per-endpoint throttling.
2. Endpoints missing pagination on list/search operations: returning unbounded result sets where a single request can pull millions of records into memory.
3. Endpoints accepting unbounded request body sizes: no Content-Length limits, no max body size configuration, accepting arbitrarily large payloads that consume memory/disk.
4. Computationally expensive operations without throttling: complex report generation, image/video processing, cryptographic operations, regex evaluation on user-controlled patterns, deep object traversal or graph queries.
5. File upload endpoints without size or count limits.

## Distinguishing Real Findings from False Positives
- A single missing rate limit on a read-only, low-cost endpoint is typically low severity.
- Missing rate limits on expensive write operations (transactions, data mutations) or authentication endpoints (brute force enablement) are significant.
- Pagination limits on internal/admin endpoints may be acceptable if the consumer is trusted; the same missing limit on a public API endpoint is a finding.
- A body size limit that is set unreasonably high is effectively no limit.
- Infrastructure-level protections (WAF, reverse proxy rate limiting, load balancer limits) may mitigate the application-level gap — note them but do not dismiss the finding.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route + HTTP method)
2. The resource that can be consumed excessively (memory, CPU, disk, connections)
3. The missing control (rate limit, pagination, size cap, timeout)
4. The attack: how an attacker triggers excessive consumption
5. The impact: degraded service, outage, or data unavailability.
`
