# [MEDIUM] Release event fields interpolated into sed run command (script injection)

**File:** `.github/workflows/update-news-www.yml` (lines 19, 14)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-ci-injection`

## Finding

Line 19 interpolates ${{ github.event.release.tag_name }} and ${{ github.event.release.published_at }} directly into a sed command inside a run block. tag_name is attacker-influenced text (the release/tag name) that can contain single quotes and shell metacharacters, allowing a crafted tag to break out of the sed expression and execute arbitrary shell commands. The job holds secrets.BOT_TOKEN (L14), a cross-repo write token that could be exfiltrated. Realistic exploitation requires the ability to publish a release (write/maintainer access), which limits the threat actor, but the injection sink is genuine.

## Recommendation

Move the release fields into env: variables and reference "$TAG_NAME" inside the run block instead of interpolating context values into the shell/sed command. Optionally validate the tag against a strict allowlist pattern.
