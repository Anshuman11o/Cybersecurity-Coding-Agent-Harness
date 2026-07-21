# SG-8 NAV Trace Results (CSRF, IDOR, auth bypass, CVB, identity spoofing, confused deputy, mass assignment, param pollution)

Partition focus (sandbox escape/RCE, path traversal, ReDoS, info disclosure) is
predominantly INJ-class. NAV-class evaluation of each assigned input below.

## Input dispositions

### #37 `challenge` (route param, GET /snippets/:challenge, unauth) — vulnCodeSnippet.ts:44
- **Disposition: DESIGN-INTENT (NAV) / CROSS-CLASS(INJ)**
- Resource ID Gate: `challenge` selects a coding-challenge snippet via a **Map
  lookup** (`getCodeChallenges().has/get`, vulnCodeSnippet.ts:36-37). Challenge
  snippets are **public gamification content, not scoped to any principal** →
  Missing-Auth Assessment: "returns public info not scoped to a principal" = NOT
  a NAV finding. No ownership boundary crossed. No file read on this path.
- CROSS-CLASS note: not applicable here (Map lookup, no filesystem sink).

### #38 `key`, `selectedLines` (body, POST /snippets/verdict, unauth) — vulnCodeSnippet.ts:71,86
- **Disposition: CROSS-CLASS(INJ, CWE-22 path traversal)** — sink:
  vulnCodeSnippet.ts:89-90 `fs.stat`/`fs.readFile('./data/static/codefixes/' + key + '.info.yml')`.
  `key` is unauth body input concatenated into a filesystem path with no
  traversal sanitization. Suspected class: INJ (path traversal / arbitrary file
  read). Flagging for INJ agent.
- **NAV (CSRF):** POST mutates only gamification state (`solveFindIt` /
  `accuracy.storeFindItVerdict`). Non-critical, self-scoped progress tracking →
  DESIGN-INTENT (Gate 3: no cross-principal capability gained). Not a NAV candidate.
- Request Body Gate: body = {key, selectedLines}; no persistence/model mass
  assignment. No CWE-915.

### #39 `key`, `selectedFix` (param GET /snippets/fixes/:key + body POST /snippets/fixes, unauth) — vulnCodeFixes.ts:57,71
- **Disposition: CROSS-CLASS(INJ, CWE-22 path traversal)** — sinks:
  vulnCodeFixes.ts:28-29 (`readdirSync` + `file.startsWith(key)` +
  `readFileSync(\`${FixesDir}/${file}\`)`) and vulnCodeFixes.ts:80-81
  (`fs.existsSync`/`readFileSync('./data/static/codefixes/' + key + '.info.yml')`).
  Unauth `key`/`:key` into filesystem paths, no traversal check. Suspected class: INJ.
- **NAV:** content is public gamification fixes, not principal-scoped → no IDOR.
  CSRF: mutates only gamification state (`solveFixIt`) → DESIGN-INTENT, not a candidate.

### #12 `orderLinesData` (body, POST /b2b/v2/orders, auth via server.ts:419 isAuthorized) — b2bOrder.ts:19,23
- **Disposition: CROSS-CLASS(INJ, CWE-94 code injection / sandbox RCE)** — sink:
  b2bOrder.ts:23 `vm.runInContext('safeEval(orderLinesData)', sandbox, {timeout:2000})`.
  Authenticated body input passed to notevil `safeEval` inside a `vm` context.
  Suspected class: INJ (RCE / sandbox escape). Flagging for INJ agent.
- **NAV:** Endpoint is guarded by `security.isAuthorized()` (server.ts:419) — no
  auth-bypass gap vs sibling routes. Body = {orderLinesData, cid}; `cid` only
  reflected in JSON response, no store/model → no mass assignment (CWE-915).
  No resource ID / IDOR (no per-principal resource selected). Not a NAV candidate.

## Absent-input analysis
No security-critical check is gated on the *presence* of any assigned input.
`b2b/v2` auth is enforced at mount (server.ts:419), independent of body fields.
`getVerdict` handles `selectedLines === undefined` by returning false (fails
closed). No Conditional Validation Bypass found.

## Authorization Helper Coverage audit
Snippets handlers are uniformly unauth (all four) — consistent, serving public
gamification content; no sibling declares auth that another omits. b2bOrder
consistently sits behind the `/b2b/v2` `isAuthorized()` guard. No structural
auth-omission gap.

## Summary
No NAV-class CANDIDATE. All exploitable sinks in this partition are INJ-class:
- #38 → CROSS-CLASS(INJ) path traversal, vulnCodeSnippet.ts:89-90
- #39 → CROSS-CLASS(INJ) path traversal, vulnCodeFixes.ts:28-29, 80-81
- #12 → CROSS-CLASS(INJ) RCE/sandbox eval, b2bOrder.ts:23
- #37 → DESIGN-INTENT (public gamification, Map lookup)
