# [MEDIUM] No rate limiting on security-answer verification enables brute force

**File:** `routes/resetPassword.ts` (lines 35, 41)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `rate-limit-bypass`

## Finding

`/rest/user/reset-password` is an unauthenticated endpoint (server.ts L590) that lets anyone submit an email plus a guessed security answer (L18-19). The answer is compared against the stored HMAC (L41) with no attempt counter, lockout, or rate limiting. Security-question answers have far lower entropy than passwords, so an anonymous attacker can brute-force the answer for any known email and reset that user's password, resulting in account takeover.

## Recommendation

Add per-account/per-IP rate limiting and lockout on failed security-answer attempts; consider requiring an emailed reset token instead of a static security question.
