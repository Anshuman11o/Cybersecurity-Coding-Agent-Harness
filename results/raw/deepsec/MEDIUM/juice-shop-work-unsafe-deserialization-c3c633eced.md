# [MEDIUM] Unsafe yaml.load (js-yaml v3 full schema) on info files

**File:** `routes/vulnCodeSnippet.ts` (lines 90)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `unsafe-deserialization`

## Finding

yaml.load is called (L90) using js-yaml ^3.14.0. In js-yaml v3, load() uses DEFAULT_FULL_SCHEMA, which supports dangerous tags such as !!js/function and !!js/regexp — deserializing such content can instantiate functions/objects and lead to code execution. Here the parsed content comes from ./data/static/codefixes/<key>.info.yml where <key> is validated against the known code-challenge map first (retrieveCodeSnippet returns null and the handler 404s otherwise), so the filename is not attacker-traversable and the file content is trusted repository data. This is therefore not currently exploitable, but the use of the unsafe loader is a latent risk (defense-in-depth): if any of those YAML files ever became attacker-influenced, it would be RCE.

## Recommendation

Use yaml.safeLoad (js-yaml v3) or upgrade to js-yaml v4 where load() defaults to the safe schema. Explicitly pass a safe schema regardless of trust level.
