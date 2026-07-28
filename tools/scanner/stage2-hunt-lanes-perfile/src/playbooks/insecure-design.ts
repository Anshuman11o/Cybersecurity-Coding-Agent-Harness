export const playbook = `
Playbook for Insecure Design (OWASP A04)
========================================

Scope: Detect business-logic-level design flaws that cannot be fixed by adding a single security control.

## OWASP Categories Covered
- OWASP A04: Insecure Design

## Sink Patterns to Hunt For (Business Logic Level)
1. State transition inconsistencies: can a user skip required steps in a workflow? (e.g., completing a transaction without payment confirmation, accessing a resource before completing a prerequisite step, moving a process to a later state without satisfying intermediate conditions.)
2. Economic imbalances: can money, credits, or points be created or multiplied? (e.g., applying a discount multiple times through race conditions, transferring credits to oneself, negative value transactions that increase balance.)
3. Workflow bypasses: can mandatory checks be circumvented by calling endpoints or functions out of order? (e.g., submitting a form before validation, accessing step-3 of a multi-step process without completing steps 1 and 2, skipping identity verification in a verification flow.)
4. Trust assumption violations: does the client control something the server should validate? (e.g., client-side price calculation sent to server, client-reported completion status, client-determined access levels.)
5. Missing compensating controls for inherently risky operations: irreversible actions without confirmation, operations with cascading effects without safeguards.

## Distinguishing Real Findings from False Positives
- This is the hardest category to score. The finding must demonstrate a concrete way an attacker achieves something the application's own logic should prevent, not just "the design could be better."
- A design that is suboptimal but not exploitable is not a finding. The finding requires a concrete attack scenario.
- "Missing input validation" is an implementation flaw, not a design flaw. A design flaw is one where even correct implementation of the current design enables an attack.
- The fix for an insecure design finding typically requires architectural changes, not a single line of code.

## Distinguishing From Adjacent Classes
This finding belongs to another class if:
- a check exists for this flow and can be bypassed — that is access-control; insecure-design
  means no control was omitted because none was ever conceived
- the flow is sound and a setting, default, or option carries an unsafe value — that is
  misconfiguration
- caller data reaches an interpreter and changes how it parses — that is injection
- the design is sound and the identity proof protecting it is weak — that is crypto-auth
- the design is sound and the abuse is a legitimate operation repeated at scale — that is
  sensitive-business-flows

Choose insecure-design when the code does exactly what it was designed to do, and the
design itself permits the abuse — so no single added check would close it.

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The business process or workflow
2. The logical gap or inconsistency
3. The step-by-step attack scenario
4. The business impact: financial loss, data integrity violation, or process subversion.
`
