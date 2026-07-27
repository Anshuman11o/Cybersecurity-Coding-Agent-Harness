# [MEDIUM] Passwords hashed with unsalted MD5

**File:** `lib/insecurity.ts` (lines 41)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `insecure-crypto`

## Finding

hash() (L41) is plain MD5 with no salt. It is used to store and compare user passwords (routes/login.ts, changePassword.ts, 2fa.ts, datacreator.ts — confirmed via call sites, e.g. hash('password') === '5f4dcc3b5aa765d61d8327deb882cf99'). Unsalted MD5 is trivially reversible via rainbow tables and permits mass credential recovery if the Users table leaks (compounded by SQL injection in login.ts).

## Recommendation

Use a memory-hard, salted password hash (bcrypt/scrypt/argon2). Keep MD5 only for non-security digests if needed.
