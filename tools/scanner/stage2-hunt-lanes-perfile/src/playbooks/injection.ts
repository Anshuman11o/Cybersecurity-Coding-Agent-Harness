export const playbook = `
Playbook for Injection (OWASP A03)
===================================

Scope: Detect any form of injection where untrusted input is interpreted as code, queries, or commands by the executing runtime, or as markup or script by a browser that later renders it.

## OWASP Categories Covered
- OWASP A03: Injection (all variants: SQL, NoSQL, OS command, LDAP, XPath, SSTI, code execution, and cross-site scripting — reflected, stored/persisted, and DOM-based)

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

### Cross-Site Scripting
Cross-site scripting is an A03 injection: the interpreter is the browser and the injected structure is markup or script.

10. Reflected: a request value (query parameter, path segment, header, body field) echoed into an HTML, JSON-in-HTML, or script response without context-appropriate output encoding.
11. Stored / persisted: user-controlled text written to a datastore, model attribute, file, or cache without validation or encoding, and rendered somewhere later. **Report this at the persistence point.** A model field, column definition, schema entry, or setter that accepts free-form user text with no sanitization, encoding, or allow-list is where a stored XSS is introduced — the rendering sink is usually in a different file, and frequently a different language, so you will not see it from here. Absence of the visible sink is not absence of the defect; say in the trace that the render sink is outside this file.
12. Data-shape fields that are conventionally trusted downstream — display names, titles, comments, descriptions, filenames, URLs, IP or user-agent strings captured from request headers — are the usual carriers. A URL or path stored without scheme validation can carry \`javascript:\` or \`data:\` and become script at render time.
13. Any value interpolated into an HTML document, inline script, or event-handler attribute during server-side rendering or string assembly, where encoding is absent or applied for the wrong context.

## Distinguishing Real Findings from False Positives
- Parameterized queries (bind variables, placeholders, named parameters) are SAFE. The database or query engine treats bound values as data, never as executable structure.
- ORM methods that take structured query objects (not raw strings) are generally safe because the ORM handles parameterization internally.
- Input validation (length caps, type checks, character allow-lists) is NOT a sanitizer for injection. It may make exploitation harder but does not close the vulnerability class unless it definitively prevents the injection mechanism (e.g., rejecting all non-numeric input for a field that must be numeric).
- Escaping functions are a weaker control than parameterization and can still fail in edge cases (encoding tricks, charset mismatches, double-decoding).
- For XSS: a framework that auto-escapes by default is a valid control, and an unescaped value inside a template that auto-escapes is not a finding. An explicit bypass of that escaping, or assembly of markup by string concatenation outside the template engine, is.
- For stored XSS: type or length constraints on a persisted field are not encoding. A field typed as free-form text with no sanitization hook remains a finding even though the value is inert until it is rendered.
- A finding requires demonstrating that user-influenced input reaches a code-interpreting sink without an intervening parameterization, allow-list, or other effective control.

## Hunting Discipline
Report what you can trace. When the entrypoint lies outside this file, begin the trace at the point where this file receives outside data and say so in that step. Identify:
1. The entrypoint (route, handler, or function accepting external input)
2. The tainted input source (query parameter, body field, header, path parameter, etc.)
3. The data-flow path showing how the input is assembled into executable structure
4. The execution sink (query call, eval, shell execution, template render, etc.)
5. Confirm no parameterization or allow-listing intervenes between taint and execution.
`
