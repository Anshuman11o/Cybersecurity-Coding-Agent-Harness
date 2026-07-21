# [BUG] Invalid 'branch' input to actions/checkout

**File:** `.github/workflows/update-news-www-legacy.yml` (lines 16)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Finding

Line 16 passes 'branch: master' to actions/checkout, but the action has no 'branch' input (the correct input is 'ref'). The value is silently ignored and the action checks out the target repository's default branch instead of an explicitly pinned ref. Not a security issue, but the intended ref pinning does not take effect.

## Recommendation

Use 'ref: master' instead of 'branch: master' in the actions/checkout step.
