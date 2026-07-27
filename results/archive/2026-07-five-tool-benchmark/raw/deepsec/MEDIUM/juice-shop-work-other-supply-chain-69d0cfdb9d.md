# [MEDIUM] Remote script piped directly into shell (curl | sh) for Heroku CLI install

**File:** `.github/workflows/ci.yml` (lines 358)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-supply-chain`

## Finding

The heroku job runs 'curl https://cli-assets.heroku.com/install.sh | sh' (L358). Piping a remote, unpinned script directly into a shell means any compromise of cli-assets.heroku.com (or MITM/DNS hijack) results in arbitrary code execution in a job that holds secrets.HEROKU_API_KEY (L371), enabling deployment/credential compromise. The job is gated to internal pushes on develop/master, which limits (but does not eliminate) exposure.

## Recommendation

Download the installer to a file, verify a known checksum/signature, then execute; or use a pinned, vendored Heroku deploy action. Avoid curl|sh in privileged jobs.
