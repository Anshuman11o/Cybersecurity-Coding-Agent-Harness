# SG-8 LOG Trace Results (race/cache/credscope/resource/proto/crypto/intoverflow)

Partition: Vuln-code challenge server + B2B order (sandbox eval)
Class focus: LOG. Path-traversal / injection sinks noted as CROSS-CLASS.

## Summary table
| # | Input | Disposition | Sink | Class |
|---|-------|-------------|------|-------|
| 12 | `orderLinesData` | DESIGN-INTENT | b2bOrder.ts:23 | CTF RCE/DoS challenge |
| 37 | `challenge` (param) | SAFE | vulnCodeSnippet.ts:44 | — |
| 38 | `key`,`selectedLines` | SAFE | vulnCodeSnippet.ts:74,89-90 | — |
| 39 | `key`,`selectedFix` | SAFE | vulnCodeFixes.ts:26-29,80-81 | — |

---

## [12] orderLinesData → notevil/vm eval — DESIGN-INTENT
- **Location:** routes/b2bOrder.ts:19-23
- `body.orderLinesData` → `safeEval(orderLinesData)` inside `vm.runInContext(..., { timeout: 2000 })`.
- Entire block gated behind `isChallengeEnabled(challenges.[REDACTED] || [REDACTED])`.
- **Gate 0:** This IS the application's intended function. Juice Shop deliberately
  ships this as CTF challenges (`[REDACTED]` = notevil sandbox escape / RCE;
  `[REDACTED]` = CPU DoS via infinite loop). The notevil sandbox and the
  2000 ms `timeout` are the *designed* controls; the challenge is to defeat them.
- **Resource-exhaustion angle (my class):** each request can burn up to ~2 s CPU
  (the `[REDACTED]` DoS). This is the documented, intended challenge, not
  an unintended defect. `timeout: 2000` caps per-request CPU.
- Sandbox-escape → RCE is CROSS-CLASS(INJ) in nature but eliminated by DESIGN-INTENT.
- Disposition: **DESIGN-INTENT** (deliberate vulnerable challenge, gated, capped).

## [37] challenge param — SAFE
- routes/vulnCodeSnippet.ts:44 → `retrieveCodeSnippet(req.params.challenge)` →
  `codeChallenges.has/get(key)` (lib/codingChallenges.ts:36-37). Pure Map lookup;
  key never concatenated into a filesystem path. No traversal, no regex feed.
- The ReDoS-prone regexes in codingChallenges.ts:59,76,78 interpolate `challengeKey`
  parsed **from trusted repo file content**, not from this param, and run once at
  cache build. Not attacker-reachable. SAFE.
- Reason: type/lookup-constrained; input never reaches a LOG sink.

## [38] key / selectedLines (POST /snippets/verdict) — SAFE
- routes/vulnCodeSnippet.ts:71 `key = req.body.key`.
- Reaches file-path concatenation at :89-90 (`'./data/static/codefixes/'+key+'.info.yml'`,
  then `yaml.load`). **But** :74-78 returns 404 unless `retrieveCodeSnippet(key)` is
  non-null, i.e. `key` is a member of the pre-built challenge Map. Attacker cannot
  supply `../` or arbitrary keys past that gate → path traversal blocked.
- **Deserialization note:** js-yaml is ^3.14.0, so `yaml.load` uses the unsafe
  FULL_SCHEMA (`!!js/function` → RCE). Sink is real, but content comes from a
  *trusted repo* `.info.yml` selected by a constrained key → Gate 2a fails
  (content not attacker-controlled). SAFE.
- `selectedLines`: number[] used only in getVerdict array comparisons (:61-68). SAFE.

## [39] key / selectedFix (GET /snippets/fixes/:key, POST /snippets/fixes) — SAFE
- routes/vulnCodeFixes.ts:57 / :71 `key`.
- `readFixes(key)`: key used only in `file.startsWith(\`${key}_\`)` filter (:28); the
  file actually read (:29) comes from `readdirSync(FixesDir)`, not from key → no
  traversal via readFixes.
- **Proto-pollution check (my class):** `CodeFixes[key]` (:21 read, :40 write). For
  `key='__proto__'`/`'constructor'`, :21 reads a truthy inherited value and returns
  early, so the :40 write never fires → no write to Object.prototype. Not exploitable.
- **`.info.yml` read + `yaml.load` (:80-81):** reached only after `readFixes(key)`
  yields `fixes.length>0` (else 404 at :74/:59), which requires an existing
  `codefixes/${key}_*` file → key constrained to real challenge keys. Traversal and
  untrusted-yaml injection both blocked (same js-yaml 3.x FULL_SCHEMA sink, but
  content trusted / Gate 2a fails). SAFE.
- `selectedFix`: number compared to `fixData.correct` (:85) and used as `id===selectedFix+1`
  lookup (:82). No sink. SAFE.

## Notes / sinks catalogued (no candidate)
- js-yaml ^3.14.0 `yaml.load` unsafe FULL_SCHEMA deserialization sink at
  vulnCodeSnippet.ts:90 and vulnCodeFixes.ts:81 — only ever fed trusted on-disk
  `.info.yml` selected by a membership-constrained key. Would become CANDIDATE
  (CWE-502) only if an attacker could control the `.info.yml` content or bypass the
  Map/fixes-length gate.
- ReDoS regexes (codingChallenges.ts:59 `([^])*` with interpolated key) operate on
  trusted repo files at cache-build time; no attacker-controlled input reaches them.

No CANDIDATE findings for LOG class in SG-8.
