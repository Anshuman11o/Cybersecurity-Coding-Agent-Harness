# [MEDIUM] Auto-commit workflow runs on every push and commits lint:fix output back to the branch

**File:** `.github/workflows/lint-fixer.yml` (lines 3, 21, 25)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-untrusted-checkout`

## Finding

This workflow triggers on all pushes and runs 'npm run lint:fix' then auto-commits and pushes the result to the branch (git-auto-commit-action, L22-29). 'npm install --ignore-scripts' mitigates install-time script execution, but lint:fix executes the repo's ESLint config and any locally-referenced ESLint plugins/config from the checked-out code, which for a branch pushed by a contributor is attacker-influenced code executing in a job that then pushes commits using the default token. github.head_ref (L25) is empty on 'push' events (it is only set for pull_request), so the branch input is effectively unused/no-op here — a functional oddity rather than an injection vector, since it is consumed as an action input, not shell-interpolated.

## Recommendation

Restrict the trigger (e.g. to specific branches or pull_request from same-repo), avoid running project-defined tooling on untrusted refs with write-back, and remove the no-op github.head_ref branch input or switch the trigger to pull_request where head_ref is populated.
