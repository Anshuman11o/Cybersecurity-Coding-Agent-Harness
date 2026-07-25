export const playbook = `
Playbook for SQL Injection (OWASP A03 Injection — SQL)
======================================================

Scope: Detect raw SQL execution where user-controlled input can influence query structure.

## OWASP Categories Covered
- OWASP A03: Injection (SQL variant)

## Sink Patterns to Hunt For
1. Raw SQL query execution where any part of the query string is derived from user-controlled input (query parameters, request body fields, headers, path parameters). Look for: sequelize.query(), knex.raw(), db.execute(), pool.query(), or equivalent primitives in any ORM/DB layer.
2. String concatenation or template literals (backtick interpolation) that assemble SQL fragments with embedded user values.
3. Dynamic table names, column names, or ORDER BY / GROUP BY clauses constructed from user input — these cannot be parameterized and require strict allow-listing.
4. ORM "escape hatches": most ORMs provide safe parameterized query methods, but also expose raw SQL passthrough (e.g., Sequelize literal(), where() with raw operators, Knex .whereRaw()). These are the danger zones.

## Distinguishing Real Findings from False Positives
- Parameterized queries (bind variables, ? placeholders, named parameters like :id) are SAFE. The database treats bound values as data, never as executable SQL.
- ORM methods that take structured query objects (e.g., Model.findAll({ where: { id: req.body.id } })) are generally safe because the ORM handles parameterization internally.
- A length cap, input trimming, or basic input validation is NOT a sanitizer. It may make exploitation harder but does not close the vulnerability class.
- Escaping functions (e.g., mysql.escape()) are a weaker control than parameterization and can still fail in edge cases (encoding tricks, charset mismatches).

## Hunting Discipline
Only report what you can construct a concrete entrypoint-to-sink trace for. Identify:
1. The entrypoint (route + HTTP method)
2. The tainted input source (req.query.x, req.body.y, etc.)
3. The data-flow path showing interpolation or concatenation into a SQL string
4. The raw SQL execution call
5. Confirm no parameterization or allow-listing intervenes between taint and execution.
`;
