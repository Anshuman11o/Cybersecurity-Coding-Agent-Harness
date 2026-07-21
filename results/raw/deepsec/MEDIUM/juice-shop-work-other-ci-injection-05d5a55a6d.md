# [MEDIUM] github.ref_name interpolated into run shell comparisons

**File:** `.github/workflows/update-challenges-www-legacy.yml` (lines 28, 37)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-ci-injection`

## Finding

Lines 28 and 37 interpolate ${{ github.ref_name }} directly into shell test comparisons inside run blocks, in a job that has access to secrets.BOT_TOKEN (L19). This is the GitHub Actions script-injection pattern. Practical exploitability is low because the push trigger is filtered to master/develop and workflow_dispatch requires write access, but injecting context into run scripts is unsafe by construction.

## Recommendation

Move ${{ github.ref_name }} into an env variable and reference "$REF" inside the run block rather than string-interpolating it.
