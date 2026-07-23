export const playbook = `
Playbook for NoSQL Injection (OWASP A03 Injection — NoSQL)
==========================================================

Scope: Detect NoSQL query operations where user-controlled input can influence query operators or structure.

## OWASP Categories Covered
- OWASP A03: Injection (NoSQL variant)

## Sink Patterns to Hunt For
1. NoSQL query/update operations where user-controlled input flows into operator positions: $where, $set, $gt, $lt, $regex, $in, $ne, and equivalent operators in MongoDB-style queries or other NoSQL stores.
2. Direct merging of request body or query parameters into a query criteria object without stripping operator keys (e.g., Object.assign({}, req.query) passed to findOne or find).
3. The $where operator specifically: it executes arbitrary JavaScript on the server. Any user-controlled value reaching $where is remote code execution.
4. $regex operators where the user supplies the regex pattern itself (not just a literal string to match against).

## Distinguishing Real Findings from False Positives
- Passing user input as a literal value in a query is generally safe: db.users.findOne({ username: req.body.username }) matches the exact string.
- Passing user input as a query operator or object that gets merged into the query criteria is the vulnerability: if req.body.username is { $ne: null }, the query becomes { username: { $ne: null } }, matching all users.
- $where is always dangerous with user input — it runs JavaScript. Even without $where, operator injection (injecting $gt, $regex, etc.) into what was intended as a string comparison is the core pattern.
- A validation layer that explicitly rejects objects with operator keys ($-prefixed) before query construction is a valid control.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route + HTTP method)
2. The tainted input source
3. How the input reaches a NoSQL query construction (direct merge, spread, or operator assignment)
4. The query execution call
5. Confirm no operator-stripping or validation layer exists between taint and execution.
`;
