# [MEDIUM] Timing-unsafe comparison of HMAC security answer

**File:** `routes/resetPassword.ts` (lines 41)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `insecure-crypto`

## Finding

The security answer is validated with a non-constant-time string equality (`security.hmac(answer) === data.answer`, L41). String `===` short-circuits on the first differing byte, leaking timing information. Combined with the lack of rate limiting, this marginally aids an attacker attempting to recover the stored answer digest.

## Recommendation

Compare digests with `crypto.timingSafeEqual` over equal-length buffers.
