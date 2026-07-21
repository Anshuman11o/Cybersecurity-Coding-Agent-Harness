# SG-7 LOG Trace Results (partition SG-7)

Class focus: race conditions, cache isolation, credential scope, resource exhaustion, prototype pollution, crypto, integer overflow.

| # | Source | Disposition | Sink file:line | Class | Notes |
|---|--------|-------------|----------------|-------|-------|
| 3 | query `to` (redirect.ts:16) | CROSS-CLASS(NAV) | redirect.ts:19 | CWE-601 open redirect | `isRedirectAllowed` substring bypass → `res.redirect`. Not a LOG sink. |
| 30 | header `range` (videoHandler.ts:23) | SAFE | videoHandler.ts:25-29 | CWE-400 (n/a) | No LOG vuln. Regex `/bytes=/` not ReDoS; `parseInt` on NaN/invalid range → `fs.createReadStream` throws synchronously, caught by Express (500), no persistent DoS. `chunksize` used only as header, not allocation. File is fixed-size `owasp_promo.mp4`; no unbounded read/integer-overflow allocation. |
| 20 | param `id` JSON.parse (recycles.ts:14) | SAFE (LOG) / CROSS-CLASS(INJ) | recycles.ts:14 | CWE-1321 (n/a); CWE-89/943 (INJ) | Prototype pollution: `JSON.parse` sets `__proto__` as an OWN property, does NOT pollute Object.prototype → no PP. DoS: URL-length-bounded param → negligible. Parsed object flows into Sequelize `where: { id }` enabling operator/NoSQL injection → CROSS-CLASS(INJ, recycles.ts:12-15). |
| 45 | param `continueCode` (restoreProgress.ts:19,44,61) | DESIGN-INTENT | restoreProgress.ts:18/39/59 | CWE-321 (n/a) | Hashids with hardcoded salt (`'this is my salt'`, etc.) is obfuscation, not encryption/credential; decodes challenge IDs to restore save-game progress (intended feature). Regex `/^[a-zA-Z0-9]+$/` is linear (no ReDoS). No LOG vuln. |
| 46 | param `id` (trackOrder.ts:15) | CROSS-CLASS(INJ) | trackOrder.ts:18 | CWE-943 NoSQL/server-side-JS injection | `$where: \`this.orderId === '${id}'\`` string-interpolates user id into Mongo `$where` JS. `trunc(id,60)` / `\W` strip are injection-context, not LOG. No ReDoS in `/[^\w-]+/g`. Injection class. |

## Summary
- No confirmed LOG-class candidates in partition SG-7.
- CROSS-CLASS flags: #3 → NAV (CWE-601); #20 → INJ (Sequelize operator injection, CWE-89/943); #46 → INJ (Mongo `$where` injection, CWE-943).
- SAFE: #30 (range header — bounded fixed file, errors handled, no ReDoS/overflow).
- DESIGN-INTENT: #45 (Hashids save-game continue code; hardcoded salt is non-security obfuscation).
- Key finding: recycles.ts `JSON.parse` does NOT enable prototype pollution (own-property semantics); its real risk is INJ-class operator injection.
