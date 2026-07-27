export const playbook = `
Playbook for Access Control (OWASP A01, API1 BOLA, API5 Broken Function Level Authorization)
============================================================================================

Scope: Detect authorization gaps where a user can access, modify, or delete resources belonging to other users or roles.

## OWASP Categories Covered
- OWASP A01: Broken Access Control
- OWASP API1: Broken Object Level Authorization (BOLA)
- OWASP API5: Broken Function Level Authorization

## Sink Patterns to Hunt For
1. Route handlers or functions that accept a resource identifier (path parameter, query parameter, or body field) and perform a lookup — by primary key, by slug, or by any identifier — without subsequently verifying that the currently authenticated user owns or is authorized to access that specific record.
2. Handlers that check only "is the user logged in?" (authentication) but never "does this user own this resource?" (authorization). Authentication is not authorization.
3. Admin-only or privilege-gated endpoints that fail to validate the user's role claim server-side — or where the role claim itself can be manipulated by the caller (e.g., sent in the request body or a custom header rather than derived from a trusted session).

## Distinguishing Real Findings from False Positives
- AUTHENTICATED is NOT AUTHORIZED. A handler that verifies the user is logged in but does not verify per-resource ownership is the core BOLA pattern. If User A can supply User B's resource identifier and receive a 200 response with data or a successful mutation, that is exploitable.
- For function-level authorization: if a lower-privileged user can reach an endpoint intended only for higher-privileged roles by omitting, modifying, or spoofing a role claim in the request, that is a Broken Function Level Authorization finding.
- A false positive occurs when the lookup itself is scoped to the current user (e.g., WHERE user_id = ? AND id = ?) or when the resource is intentionally public.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route path + HTTP method, or function name)
2. The parameter carrying the target resource identifier
3. The lookup call (query, ORM method, or service call)
4. The absence of a per-resource ownership check between lookup and response
5. A proof-of-concept: two distinct user accounts where User A accesses User B's resource by substituting the identifier.
`
