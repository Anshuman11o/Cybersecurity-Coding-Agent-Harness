# [CRITICAL] SQL injection in login allowing authentication bypass

**File:** `routes/login.ts` (lines 33)
**Project:** juice-shop-work
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `sql-injection`

## Finding

The login handler builds a raw SQL string via template-literal interpolation of req.body.email directly into a SELECT statement passed to sequelize.query(): `SELECT * FROM Users WHERE email = '${req.body.email || ''}' AND password = '...'`. The email is fully attacker-controlled and unescaped. An anonymous attacker can send email `' OR 1=1--` (or `admin@juice-sh.op'--`) to bypass the password check entirely and authenticate as the first/any user, since the resulting user row is passed to afterLogin() and a session token is issued. This is a classic unauthenticated auth-bypass / data-exfiltration SQLi. The password field is MD5-hashed before interpolation so it is not injectable, but the email is. The endpoint app.post('/rest/user/login', login()) has no auth wrapper (correctly public), so it is reachable by any anonymous user.

## Recommendation

Use parameterized queries with bind/replacements (e.g. sequelize.query(sql, { replacements: [email, hash], type: QueryTypes.SELECT }) or, better, UserModel.findOne({ where: { email, password: hash } })). Never interpolate request data into SQL strings.
