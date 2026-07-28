export const playbook = `
Playbook for Unrestricted Access to Sensitive Business Flows (API6)
==================================================================

Scope: Detect business-critical operations that lack anti-automation safeguards.

## OWASP Categories Covered
- OWASP API6: Unrestricted Access to Sensitive Business Flows

## Sink Patterns to Hunt For
1. Financial transactions: payment processing, fund transfers, balance adjustments — any operation with real monetary impact that lacks: rate limiting, idempotency checks, approval workflows, or transaction velocity controls.
2. Order placement: creating orders, applying discounts, or checking out without CAPTCHAs, rate limits, or velocity checks (enables scalping, inventory exhaustion, or fraud).
3. Coupon/promo code application: applying discount codes without usage limits per user, without expiration enforcement, or without rate limiting (enables abuse of promotional economics).
4. Privilege escalation or role changes: self-service account upgrades, role assignment, or permission grants without approval workflows or multi-step verification.
5. Data export: bulk data download endpoints without rate limiting, pagination, or approval — enables data harvesting or exfiltration at scale.

## Distinguishing Real Findings from False Positives
- The operation itself is not a finding. The absence of safeguards against automated abuse or manipulation of a business-critical flow is.
- A single missing control (e.g., no CAPTCHA) may be low severity if other controls compensate (rate limiting, approval workflows).
- Internal/admin operations may have different risk profiles; flag based on the potential business impact if abused.
- The finding should name the specific business impact: "enables automated purchase of limited inventory," "allows unlimited discount stacking," "permits bulk data exfiltration."

## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- the flow can be reached by a caller who should not reach it at all — that is
  access-control
- the flow is sound and the cost of one invocation is unbounded — that is
  resource-consumption
- the flow's own logic permits the abuse in a single pass, without repetition — that is
  insecure-design

Choose sensitive-business-flows when each individual invocation is legitimate and
authorized, and the harm comes from automating or repeating it at a scale the business
logic assumed a human would not reach.

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The business-critical entrypoint
2. The missing anti-automation control(s)
3. The attack scenario: how automated abuse operates
4. The business impact: financial loss, data exposure, or service degradation.
`
