# [BUG] Invalid 'branch' input to actions/checkout

**File:** `.github/workflows/update-news-www.yml` (lines 15)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Finding

Line 15 passes 'branch: master' to actions/checkout, which has no 'branch' input (correct input is 'ref'). The value is ignored and the default branch is checked out instead of the intended pinned ref. Non-security correctness bug.

## Recommendation

Replace 'branch: master' with 'ref: master' in the actions/checkout step.
