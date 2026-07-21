# [MEDIUM] Action pinned to mutable branch ref (calibreapp/image-actions@main) plus mutable major tags

**File:** `.github/workflows/image_actions.yml` (lines 30, 33, 42)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain`

## Finding

This workflow pins 'calibreapp/image-actions@main' (L33) — a mutable branch that can change at any time — and 'actions/checkout@v6' (L30) and 'peter-evans/create-pull-request@v8' (L42) to mutable major tags. The '@main' pin is the highest-risk form of unpinning: whoever controls that branch controls code that runs with secrets.GITHUB_TOKEN (L35) and, on push events, opens/pushes PRs (create-pull-request). Execution is gated to the juice-shop repo and same-repo PR heads (L24-27), which prevents fork-PR abuse but does not mitigate upstream-action compromise.

## Recommendation

Pin all three actions to full commit SHAs with version comments. Never reference third-party actions by a branch (@main).
