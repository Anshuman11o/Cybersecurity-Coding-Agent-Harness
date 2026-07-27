# [MEDIUM] YAML parsing inside vm with only timeout guard is DoS-prone

**File:** `routes/fileUpload.ts` (lines 102, 104)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-dos`

## Finding

`handleYamlUpload` runs `yaml.load(data)` inside a `vm` context (L102-104). js-yaml v4 `load` is safe (no arbitrary object instantiation), so RCE is unlikely, but deeply nested/anchored YAML ('billion laughs') can exhaust memory/CPU before the 2000ms timeout meaningfully helps, and the resulting `Invalid string length` path is explicitly handled (L109), confirming attacker-influenced resource pressure.

## Recommendation

Enforce input size limits, use a schema-restricted safe load, and cap nesting/anchor expansion.
