# [CRITICAL] Unauthenticated SQL injection in product search

**File:** `routes/search.ts` (lines 19)
**Project:** juice-shop-work
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `sql-injection`

## Finding

searchProducts() interpolates req.query.q (aliased as `criteria`) directly into a raw SQL query: `SELECT * FROM Products WHERE ((name LIKE '%${criteria}%' OR description LIKE '%${criteria}%') AND deletedAt IS NULL) ORDER BY name`. The only processing is truncation to 200 chars, which does not prevent injection. An anonymous attacker can break out of the LIKE clause and inject a UNION SELECT to exfiltrate arbitrary tables (e.g. the Users table with password hashes) since the raw query result rows are returned to the client as JSON. The route app.get('/rest/products/search', ...) has no auth wrapper.

## Recommendation

Parameterize the query using replacements/bind values, e.g. sequelize.query('... name LIKE :q ...', { replacements: { q: `%${criteria}%` }, type: QueryTypes.SELECT }). The LIKE wildcards should be applied to the bound parameter, not the SQL string.
