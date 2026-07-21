# [MEDIUM] Release event fields interpolated into sed run command (script injection)

**File:** `.github/workflows/update-news-www-legacy.yml` (lines 19, 14)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-ci-injection`

## Finding

Line 19 interpolates ${{ github.event.release.tag_name }} and ${{ github.event.release.published_at }} directly into a sed command inside a run block. tag_name is attacker-influenced text (the git tag/release name), not a validated GitHub-generated value, and git tag names may contain single quotes and shell metacharacters. A crafted tag name can break out of the sed 's/.../.../' expression and inject arbitrary shell commands. The job has access to secrets.BOT_TOKEN (L14), so a successful injection could exfiltrate that cross-repo write token. Exploitability is gated by the fact that publishing a release requires write/maintainer permissions on the repo, which limits the realistic threat actor, but the pattern is a genuine CI injection sink.

## Recommendation

Assign the release fields to env: variables (e.g. TAG_NAME: ${{ github.event.release.tag_name }}) and reference "$TAG_NAME" inside the run block so the values are never expanded into the sed/shell command text. Consider validating the tag against a strict pattern.
