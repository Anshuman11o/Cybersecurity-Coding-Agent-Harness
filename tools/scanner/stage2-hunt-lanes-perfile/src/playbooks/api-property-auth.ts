export const playbook = `
Playbook for Mass Assignment / Broken Object Property Level Authorization (API3)
================================================================================

Scope: Detect automatic field binding that exposes sensitive model properties to caller control.

## OWASP Categories Covered
- OWASP API3: Broken Object Property Level Authorization (Mass Assignment)

## Sink Patterns to Hunt For
1. Request body spread directly into create/update calls without an explicit field allow-list: Model.create(request_body), Model.update(request_body), or equivalent operations that copy all caller-supplied fields into a data model.
2. Auto-generated CRUD or scaffolding endpoints with automatic field binding — these typically expose ALL model fields unless explicitly restricted.
3. Per-model exclude/include lists that expose sensitive fields: password hashes, internal flags (isAdmin, isVerified), other users' data, pricing fields, role/permission fields.
4. Validation layers that validate field types but do not restrict which fields are accepted — validation is not authorization.

## Distinguishing Real Findings from False Positives
- The presence of an exclude list is not necessarily safe. What matters is whether it covers ALL sensitive fields and whether new fields added to the model automatically become exposed (implicit allow vs explicit allow).
- An explicit allow-list (only these fields accepted) is the safer pattern. An exclude-list (everything except these fields) is fragile because adding a new sensitive field to the model creates a new vulnerability.
- A finding requires demonstrating that a caller can set a field they should not control, and that this has a security impact (privilege escalation, data exposure, bypass of business logic).
- Read-only fields that are validated but never persisted are not a mass assignment risk.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route + HTTP method)
2. The request body field that maps to a sensitive model property
3. The create/update call that persists it
4. The security impact: what the attacker achieves by setting this field.
`
