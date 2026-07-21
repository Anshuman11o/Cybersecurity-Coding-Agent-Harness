# [MEDIUM] User-controlled key concatenated into YAML file path

**File:** `routes/vulnCodeFixes.ts` (lines 80, 81)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `path-traversal`

## Finding

In checkCorrectFix, `req.body.key` is concatenated into a filesystem path: `fs.existsSync('./data/static/codefixes/' + key + '.info.yml')` and `fs.readFileSync('./data/static/codefixes/' + key + '.info.yml', 'utf8')`. Although typed as `ChallengeKey`, TypeScript types are not enforced at runtime, so `key` is attacker-controlled. A value containing `../` sequences can traverse outside the codefixes directory to read any file the process can access whose name ends in `.info.yml`. The `.info.yml` suffix and modern Node's rejection of null bytes limit impact, and js-yaml v4's `yaml.load` is safe-by-default (no code execution), so this is bounded information disclosure rather than RCE.

## Recommendation

Validate `key` against an allowlist of known challenge keys (or a strict `^[a-zA-Z0-9_-]+$` regex) before using it in any filesystem path, and resolve/normalize the final path and confirm it stays within the codefixes directory.
