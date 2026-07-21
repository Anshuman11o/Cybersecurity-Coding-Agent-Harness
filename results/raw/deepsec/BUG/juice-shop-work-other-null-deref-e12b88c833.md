# [BUG] Unchecked regex .groups access can throw in metrics update loop

**File:** `routes/metrics.ts` (lines 163)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-null-deref`

## Finding

At L163, `version.match(/(?<major>\d+).(?<minor>\d+).(?<patch>\d+)/).groups` dereferences the result of String.match without a null check. If utils.version() ever returns a value not matching the pattern, match() returns null and accessing .groups throws a TypeError. The throw is caught by the surrounding try/catch and only logged, so the metrics loop degrades rather than crashing the process, but version/challenge metrics silently stop updating for that tick. Low impact but a latent robustness bug.

## Recommendation

Guard the match result (e.g. `const m = version.match(...); if (m?.groups) { ... }`) before destructuring.
