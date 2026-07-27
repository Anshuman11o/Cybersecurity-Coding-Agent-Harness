# [BUG] CAPTCHA is reusable and answer is not consumed after verification

**File:** `routes/captcha.ts` (lines 37, 38)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-logic-bug`

## Finding

verifyCaptcha (L35-46) looks up the stored captcha by req.body.captchaId and compares the answer, but never deletes/invalidates it after a successful match. The same captchaId+answer pair can be replayed indefinitely, defeating the rate-limiting/anti-automation purpose of the CAPTCHA on the feedback endpoint. captchaId is also a predictable incrementing counter (L11), making valid pairs easy to accumulate. Note: the eval() at L22 operates only on server-generated numbers/operators and is not user-controlled (not a vulnerability).

## Recommendation

Invalidate (delete) the captcha row after a successful verification and reject reuse; use unpredictable captcha ids.
