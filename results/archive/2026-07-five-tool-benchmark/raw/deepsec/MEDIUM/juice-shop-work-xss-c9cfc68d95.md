# [MEDIUM] Product description sanitization is bypassed when [REDACTED] is enabled

**File:** `models/product.ts` (lines 44, 45, 46, 47, 48, 49, 50)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `xss`

## Finding

The `description` attribute setter conditionally skips HTML sanitization. When `utils.isChallengeEnabled(challenges.[REDACTED])` is true, the code calls `challengeUtils.solveIf(...)` and returns the raw, unsanitized `description` to `setDataValue`. Only in the `else` branch is `security.sanitizeSecure(description)` applied. This means when the (default-enabled) challenge is active, attacker-controlled product descriptions are persisted verbatim and later rendered in the storefront, yielding a stored/RESTful XSS. This is the intentional training vulnerability for OWASP Juice Shop, so it is by-design here, but the code path is a genuine stored-XSS sink: sanitization is gated behind a flag rather than always applied.

## Recommendation

Always apply output-encoding/sanitization (`security.sanitizeSecure`) to `description` regardless of challenge state, and keep the challenge-scoring logic decoupled from the security control so the sanitizer cannot be turned off.
