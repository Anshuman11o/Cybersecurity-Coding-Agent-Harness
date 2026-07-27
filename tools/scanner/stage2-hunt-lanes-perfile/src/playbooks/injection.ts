export const playbook = `
Playbook for Injection (OWASP A03)
===================================

Scope: Detect any form of injection where untrusted input is interpreted as code, queries, or commands by the executing runtime.

## OWASP Categories Covered
- OWASP A03: Injection (all variants: SQL, NoSQL, OS command, LDAP, XPath, SSTI, code execution, etc.)

## Sink Patterns to Hunt For

### Query/Database Injection
1. Any database or query operation where the query string or query structure is assembled by concatenation, interpolation, or string formatting with user-controlled values. This includes raw query execution, ORM escape-hatch methods, and dynamic table/column name construction.
2. Look for the pattern: user input → string assembly → query execution. The assembly step may use string concatenation, template/string interpolation, format functions, or any mechanism that embeds user input into the query structure rather than passing it as a bound parameter.
3. Dynamic table names, column names, ORDER BY / GROUP BY clauses constructed from user input — these typically cannot be parameterized and require strict allow-listing.

### NoSQL/Document-Store Injection
4. Query operations where user-controlled input flows into operator positions or is merged directly into the query criteria object. In document stores, if a user-supplied value is a dictionary/object rather than a scalar, it may inject query operators (e.g., "not-equal", "greater-than", regex).
5. Any operator that executes code within a query context (e.g., server-side JavaScript execution in a database) is critical if user input reaches it.

### OS Command / Process Injection
6. Shell execution, process spawning, or system command invocation where any part of the command string or arguments derives from user-controlled input.
7. Template rendering where user-provided content is rendered as a template (not just inserted as text) in any templating language that supports code execution or expression evaluation.

### Code Execution
8. Dynamic code evaluation: eval(), dynamic function construction, or any mechanism that interprets a string as executable code where the string contains user-influenced content.
9. Dynamic module/class loading or import where the module path or class name is user-controlled.

## Distinguishing Real Findings from False Positives
- Parameterized queries (bind variables, placeholders, named parameters) are SAFE. The database or query engine treats bound values as data, never as executable structure.
- ORM methods that take structured query objects (not raw strings) are generally safe because the ORM handles parameterization internally.
- Input validation (length caps, type checks, character allow-lists) is NOT a sanitizer for injection. It may make exploitation harder but does not close the vulnerability class unless it definitively prevents the injection mechanism (e.g., rejecting all non-numeric input for a field that must be numeric).
- Escaping functions are a weaker control than parameterization and can still fail in edge cases (encoding tricks, charset mismatches, double-decoding).
- A finding requires demonstrating that user-influenced input reaches a code-interpreting sink without an intervening parameterization, allow-list, or other effective control.

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route, handler, or function accepting external input)
2. The tainted input source (query parameter, body field, header, path parameter, etc.)
3. The data-flow path showing how the input is assembled into executable structure
4. The execution sink (query call, eval, shell execution, template render, etc.)
5. Confirm no parameterization or allow-listing intervenes between taint and execution.
`
