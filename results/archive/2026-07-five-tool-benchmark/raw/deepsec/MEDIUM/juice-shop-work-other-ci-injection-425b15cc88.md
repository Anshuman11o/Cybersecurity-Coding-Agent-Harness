# [MEDIUM] github.ref_name interpolated into run/wget command

**File:** `.github/workflows/update-challenges-ebook.yml` (lines 25)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-ci-injection`

## Finding

Line 25 interpolates ${{ github.ref_name }} directly into a shell command (wget URL) inside a run block. Interpolating context values into run scripts is the GitHub Actions script-injection anti-pattern; if the value contained shell metacharacters it could break out and execute arbitrary commands in a job that holds the BOT_TOKEN secret (secrets.BOT_TOKEN, L18). Exploitability is limited because the push trigger is filtered to branches master/develop (so ref_name is constrained there), and workflow_dispatch requires write access; git ref names also forbid spaces and many metacharacters. Still, the value should be passed via an intermediate env var rather than interpolated into the script body.

## Recommendation

Assign ${{ github.ref_name }} to an env: variable and reference it as "$REF" inside the run block, so context data is never expanded into the shell command text. Pin/validate the ref value.
