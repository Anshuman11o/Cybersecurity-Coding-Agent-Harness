# [MEDIUM] MD5 used for password hashing (via security.hash)

**File:** `routes/chat.ts` (lines 14)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `insecure-crypto`

## Finding

Login/2FA and related flows compare passwords using security.hash, which is crypto.createHash('md5') (lib/insecurity.ts L41). MD5 is fast and unsalted, making stored/compared password hashes trivially crackable if the Users table is exfiltrated (e.g. via the SQLi findings above). Noting here because chat/login/2fa all depend on it.

## Recommendation

Use a salted, slow password hash (bcrypt/scrypt/argon2) for credential storage and verification.
