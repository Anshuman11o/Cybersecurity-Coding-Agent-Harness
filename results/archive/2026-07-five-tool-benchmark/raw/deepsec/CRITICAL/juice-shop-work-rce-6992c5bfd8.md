# [CRITICAL] Server-side template injection to RCE via eval() on username

**File:** `routes/userProfile.ts` (lines 54, 61, 73, 87)
**Project:** juice-shop-work
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `rce`

## Finding

The authenticated user's own `username` (fully attacker-controlled via profile update) is matched against `/#{(.*)}/` and, when it matches, the captured expression is passed directly to `eval(code)` on the server (L61). A registered customer can set their username to `#{global.process.mainModule.require('child_process').execSync('...')}` and trigger arbitrary Node.js code execution by requesting GET /profile. The resulting string is then substituted into a Pug template that is compiled and rendered (L73/L87), providing a second SSTI sink. This is exploitable by any self-registered account.

## Recommendation

Never eval() user-derived content. Remove the eval path entirely; render the username as escaped data (entities.encode) and pass it as a Pug template variable rather than string-substituting it into the template source before compile().
