# [MEDIUM] CAPTCHA verification bypassed entirely when no CAPTCHA exists for the user

**File:** `routes/imageCaptcha.ts` (lines 42, 52, 53)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `rate-limit-bypass`

## Finding

verifyImageCaptcha() gates POST /rest/user/data-export. It loads the user's most recent CAPTCHA from the last 5 minutes, then checks: `if (!captchas[0] || req.body.answer === captchas[0].answer) next()`. The `!captchas[0]` short-circuit means that if the authenticated user has NOT requested an image CAPTCHA (or the last one is older than 300s), verification is skipped and the request proceeds. An attacker simply never calls GET /rest/image-captcha and submits data-export directly, defeating the anti-automation control the CAPTCHA is meant to provide. Because the CAPTCHA answer is also returned in the CAPTCHA response body (imageCaptchas() res.json includes `answer`), the control is doubly weak, but the no-CAPTCHA bypass makes it moot entirely.

## Recommendation

Treat a missing CAPTCHA as a failed verification (require a valid, unused, recent CAPTCHA to exist and match). Invalidate the CAPTCHA row after a single use, and do not return the answer in the creation response.
