# [MEDIUM] CodeQL actions pinned to mutable major tag @v3

**File:** `.github/workflows/codeql-analysis.yml` (lines 23, 34, 36)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-supply-chain`

## Finding

github/codeql-action/init, autobuild, and analyze are pinned to the mutable '@v3' tag (L23, L34, L36) rather than a commit SHA. A compromised/repointed tag would run in a job with 'security-events: write' and 'contents: read'. Risk is comparatively low because these are GitHub's first-party actions, but it is inconsistent with the SHA-pinning applied to actions/checkout in the same file.

## Recommendation

Pin the codeql-action steps to full commit SHAs with version comments for consistency and supply-chain integrity.
