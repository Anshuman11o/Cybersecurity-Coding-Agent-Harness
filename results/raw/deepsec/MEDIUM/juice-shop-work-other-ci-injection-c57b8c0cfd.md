# [MEDIUM] github.ref_name interpolated into run shell comparisons

**File:** `.github/workflows/update-challenges-www.yml` (lines 28, 37)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-ci-injection`

## Finding

Lines 28 and 37 interpolate ${{ github.ref_name }} directly into shell comparisons inside run blocks in a job holding secrets.BOT_TOKEN (L19). GitHub Actions script-injection anti-pattern. Exploitability is low: push is filtered to master/develop and workflow_dispatch requires write access, but the pattern should still be avoided.

## Recommendation

Pass ${{ github.ref_name }} through an env variable and use "$REF" in the run block.
