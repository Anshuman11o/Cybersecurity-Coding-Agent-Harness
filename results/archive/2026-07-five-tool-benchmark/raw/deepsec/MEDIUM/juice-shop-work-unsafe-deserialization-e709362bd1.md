# [MEDIUM] Unsafe yaml.load() with js-yaml v3 (full schema) in config lint script

**File:** `lib/scripts/lintConfig.ts` (lines 22)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `unsafe-deserialization`

## Finding

validateFile calls `yaml.load(await readFile(file, 'utf8'))` (L22). The project depends on js-yaml ^3.14.0, where `load()` uses the unsafe DEFAULT_FULL_SCHEMA that resolves custom tags such as !!js/function, !!js/regexp and !!js/undefined — enabling arbitrary code construction from crafted YAML (in v4 `load` became safe by default; v3 requires `safeLoad`). Reachability is limited: this is a developer/CI CLI (`npm run lint:config`) that only iterates *.yml files inside the repo's own config/ directory, which is not an anonymous-attacker input surface. The risk materializes only if a malicious YAML file reaches config/ (e.g. via a supply-chain/PR or a compromised config profile) and the script is then run. It is nonetheless an unsafe API choice that should be corrected.

## Recommendation

Use the safe schema explicitly: `yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA })` or js-yaml's `safeLoad`, or upgrade to js-yaml v4 where `load` is safe by default. Never resolve custom JS types when parsing config.
