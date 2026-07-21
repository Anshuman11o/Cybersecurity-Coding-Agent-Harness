# [BUG] github.workspace interpolated into node -e string could break on unexpected path characters

**File:** `.github/workflows/frontend-bundle-analysis.yml` (lines 50)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-logic-bug`

## Finding

The screenshot step builds 'file://${{ github.workspace }}/...' by string-interpolating github.workspace into a node -e script and shell command (L50). github.workspace is runner-controlled (not attacker-controlled), so this is not a script-injection vulnerability, but if the workspace path ever contains characters that are special to the surrounding double-quoted shell / JS string literal the step would fail. Flagged for completeness; no security impact.

## Recommendation

Pass the path via an environment variable (env: WS: ${{ github.workspace }}) and reference process.env.WS in the node script instead of string interpolation.
