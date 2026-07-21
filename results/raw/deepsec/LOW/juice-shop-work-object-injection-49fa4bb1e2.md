# [LOW] Dynamic property assignment from URL hash params

**File:** `frontend/src/app/oauth/oauth.component.ts` (lines 74, 75, 76, 77)
**Project:** juice-shop-work
**Severity:** LOW  •  **Confidence:** low  •  **Slug:** `object-injection`

## Finding

parseRedirectUrlParams() splits the redirect URL fragment on '&' and '=' and assigns params[key] = value for each pair (L74-77), with keys taken directly from attacker-influenceable URL fragment data. Assigning a key such as __proto__ via bracket notation on a plain object does not pollute Object.prototype globally in modern engines, and only params.access_token is subsequently consumed, so exploitability is limited, but the pattern is unsafe input handling.

## Recommendation

Parse the fragment with URLSearchParams and read only the expected keys (access_token) explicitly, rather than copying arbitrary keys into an object.
