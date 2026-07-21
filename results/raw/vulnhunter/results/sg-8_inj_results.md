# SG-8 INJ Trace Results

Partition SG-8 — Vuln-code challenge server + B2B order (sandbox eval)
Class focus: INJ (SQLi, cmd, path traversal, SSRF, XSS, XXE, LDAP, API-query, code eval/SSTI, file upload)

## Input dispositions

| # | Input | Disposition | Sink | Class |
|---|-------|-------------|------|-------|
| 12 | `orderLinesData` (body, POST /b2b/v2/orders) | **CANDIDATE** | b2bOrder.ts:23 | CWE-94 code injection / CWE-400 DoS |
| 37 | `challenge` (param, GET /snippets/:challenge) | **SAFE** | vulnCodeSnippet.ts:44 | — |
| 38 | `key`,`selectedLines` (body, POST /snippets/verdict) | **SAFE** | vulnCodeSnippet.ts:89-90 | path traversal (gated) |
| 39 | `key`,`selectedFix` (param/body, /snippets/fixes*) | **SAFE** | vulnCodeFixes.ts:29,80-81 | path traversal (gated) |

---

## [VULN-801] RCE / DoS via notevil+vm eval of B2B orderLinesData

- **Input**: #12 — HTTP body field `orderLinesData` (POST /b2b/v2/orders)
- **Class**: CWE-94 (Code Injection) + CWE-400/1333 (DoS via CPU-occupy / ReDoS-style infinite loop)
- **Severity**: High+ (RCE-class; auth boundary is near-unauth per threat model — RS256 public-key-as-secret, open registration)
- **Location**: routes/b2bOrder.ts:19-23
- **Gate 0 (intended behavior?)**: This is Juice Shop's deliberate RCE challenge (`rceChallenge`/`rceOccupyChallenge`). Juice Shop is intentionally vulnerable by design; per the vulnhunt exercise a real, exploitable injection is still reported as a CANDIDATE. The sandbox is the *only* claimed defense, so it is a validation weakness, not a pure feature.
- **Gate 1 (reachable?)**: 1 production call site — mounted at server.ts:640 `app.post('/b2b/v2/orders', b2bOrder())`; `/b2b/v2` guarded by `security.isAuthorized()` (server.ts:419).
- **Gate 2a (attacker-controlled?)**: Yes. `body.orderLinesData` (b2bOrder.ts:19) flows verbatim into the sandbox object (line 21) and is eval'd (line 23). No transformation.
- **Gate 2b (sanitization?)**: Only defense is the notevil `safeEval` interpreter + `vm.runInContext` 2000ms `timeout`. notevil is a JS-implemented sandbox (no source verification performed here → treated as best-effort per methodology option c). The `timeout` is the deliberate mechanism the `rceOccupyChallenge` exploits: a `while(true){}` payload triggers the timeout branch (line 26), i.e. an intended CPU-occupy DoS. No character/keyword filtering on the input.
- **Gate 3 (new capability?)**: Attacker gains arbitrary JS execution in the server process (subject to notevil sandbox) and a reliable DoS primitive (thread occupation until timeout). Not obtainable through any other B2B code path.
- **Entry Point**: POST /b2b/v2/orders
- **Data Flow**: req.body.orderLinesData (b2bOrder.ts:19) -> sandbox.orderLinesData (line 21) -> vm.runInContext('safeEval(orderLinesData)', ...) (line 23)
- **Root Cause**: User-supplied string passed directly to a JS evaluator inside a vm context with no allowlist/sanitization; sandbox is the sole barrier.
- **Exploitability**: Direct — single authenticated POST with a crafted `orderLinesData` string. DoS variant trivial (`while(true){}`); code-exec depends on notevil escape.

---

## SAFE dispositions (with reasoning)

### #37 `challenge` — vulnCodeSnippet.ts:44 — SAFE
`req.params.challenge` flows only to `retrieveCodeSnippet` -> `getCodeChallenges()` Map `.has()/.get()` lookup (vulnCodeSnippet.ts:36-37). Used purely as an in-memory Map key; never concatenated into a filesystem path, SQL, command, URL, or HTML sink. No path traversal reachable. Response returns only `snippet` string. SAFE (type/usage-constrained).

### #38 `key`, `selectedLines` — vulnCodeSnippet.ts:71,86 — SAFE
- `key` reaches a filesystem read at vulnCodeSnippet.ts:89-90 (`fs.stat`/`fs.readFile('./data/static/codefixes/' + key + '.info.yml')`) which WOULD be path traversal (CWE-22). **Gated**: line 74 `retrieveCodeSnippet(key)` returns null and line 75-78 sends 404 + `return` unless `key` is a valid coding-challenge Map key. Valid keys are identifiers harvested from source `vuln-code-snippet start` markers (alphanumeric, no `../`), so a traversal payload never reaches line 89. Path is attacker-influenced only within the fixed allowlisted key set. SAFE (upstream Map-membership gate).
- `selectedLines` is `number[]` used only in numeric `getVerdict` comparisons (lines 61-67, 86-87). No sink. SAFE (type-constrained).

### #39 `key`, `selectedFix` — vulnCodeFixes.ts:57,71 — SAFE
- `serveCodeFixes`: `req.params.key` -> `readFixes(key)`. Inside readFixes, `key` is used only in `file.startsWith(\`${key}_\`)` (line 28) to filter `readdirSync` results; the path read at line 29 (`${FixesDir}/${file}`) uses `file` from the directory listing, not raw `key`. No path built from `key`. SAFE.
- `checkCorrectFix`: `req.body.key` reaches `fs.existsSync`/`readFileSync('./data/static/codefixes/' + key + '.info.yml')` at lines 80-81 (potential CWE-22). **Gated**: line 73 `readFixes(key)`; lines 74-77 return 404 unless some file in `codefixes/` starts with `${key}_`. A traversal payload (`../…`) is not a prefix of any fixture filename, so `fixes.length === 0` short-circuits before the concatenated read. SAFE (upstream fixture-prefix gate).
- `selectedFix` is a number compared to `fixData.correct` (line 85); no sink. SAFE.

### codingChallenges.ts ReDoS note
The dynamic `new RegExp(...challengeKey...)` / `source.match(...challengeKey...)` calls (lines 59,76,78) interpolate `challengeKey` sourced from **file-content scanning**, not user input. The user-facing `key`/`challenge` inputs never reach these regex constructions (they only hit the pre-built Map). No user-controlled ReDoS. SAFE.

## Cross-class
None. No SSRF/redirect/XSS/SQL/LDAP/XXE/file-upload sinks in this partition's files; all reads are gated Map/fixture lookups.
