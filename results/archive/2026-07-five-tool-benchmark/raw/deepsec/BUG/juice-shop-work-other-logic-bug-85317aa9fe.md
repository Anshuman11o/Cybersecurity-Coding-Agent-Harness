# [BUG] custom-config-test uses matrix conditionals but defines no matrix

**File:** `.github/workflows/ci.yml` (lines 202)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-logic-bug`

## Finding

The custom-config-test job (L192) has steps with 'if: ... matrix.os == ... && matrix.node-version == ...' (L202) but the job defines no 'strategy.matrix'. matrix.os / matrix.node-version evaluate to null, so the condition reduces to 'github.repository == juice-shop/juice-shop || false'. On forks this silently skips 'npm install', which can cause confusing downstream failures. Non-security correctness issue.

## Recommendation

Remove the matrix references from the if-condition for this non-matrix job, or add the intended matrix.
