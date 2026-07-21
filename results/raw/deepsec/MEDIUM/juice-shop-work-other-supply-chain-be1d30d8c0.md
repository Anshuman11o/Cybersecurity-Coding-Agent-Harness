# [MEDIUM] Third-party action pinned to mutable major tag (coverallsapp/github-action@v2)

**File:** `.github/workflows/ci.yml` (lines 188)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain`

## Finding

Nearly all actions in this workflow are correctly pinned to full commit SHAs (defense against supply-chain tampering), but 'coverallsapp/github-action@v2' (L188) is pinned to a mutable major-version tag. If the upstream tag is repointed to a malicious commit, the coverage-report job would execute attacker code. This job runs on push to the juice-shop repo and has access to secrets.GITHUB_TOKEN (L190). Impact is limited because the job only runs on internal pushes (github.repository guard, github.event_name == 'push'), not on fork PRs.

## Recommendation

Pin coverallsapp/github-action to a full commit SHA with a version comment, consistent with the other actions in this file.
