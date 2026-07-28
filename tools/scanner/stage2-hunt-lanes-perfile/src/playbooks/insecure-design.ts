export const playbook = `
Playbook for Insecure Design (OWASP A04)
========================================

Scope: Detect defects where the code works exactly as designed, and the design itself permits the abuse.

## OWASP Categories Covered
- OWASP A04: Insecure Design

## Sink Patterns to Hunt For (Business Logic Level)

Start by naming what this file is responsible for enforcing: a sequence that must be
followed, a quantity that must be conserved, or a fact the server must decide rather
than accept from the caller. If the file enforces no such rule, this class has no
finding here. If it does, test whether that rule can be broken while every individual
operation still succeeds and returns normally.

1. State transition inconsistencies: can a user skip required steps in a workflow? (e.g., completing a transaction without payment confirmation, accessing a resource before completing a prerequisite step, moving a process to a later state without satisfying intermediate conditions.)
2. Economic imbalances: can money, credits, or points be created or multiplied? (e.g., applying a discount multiple times through race conditions, transferring credits to oneself, negative value transactions that increase balance.)
3. Workflow bypasses: can mandatory checks be circumvented by calling endpoints or functions out of order? (e.g., submitting a form before validation, accessing step-3 of a multi-step process without completing steps 1 and 2, skipping identity verification in a verification flow.)
4. Trust assumption violations: does the client control something the server should validate? (e.g., client-side price calculation sent to server, client-reported completion status, client-determined access levels.)
5. Missing compensating controls for inherently risky operations: irreversible actions without confirmation, operations with cascading effects without safeguards.

## Distinguishing Real Findings from False Positives
- The finding must show a concrete way an attacker achieves something the application's own logic should prevent. "The design could be better" is not a finding.
- A design that is suboptimal but not exploitable is not a finding. The finding requires a concrete attack scenario.
- Missing validation on one field is an implementation flaw. A rule the design never established — an amount that is never bounded, an ordering that is never enforced, a value the server never re-derives — is a design flaw.
- The test is whether the current design, implemented correctly, still permits the attack. Do not use the size of the fix as the test — a design flaw can have a one-line remedy, and an architectural fix does not make something a design flaw.

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
