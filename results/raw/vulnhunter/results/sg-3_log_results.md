# SG-3 LOG Trace Results (partition: file serving / upload / XXE / YAML / zip)

Class focus: race conditions, cache isolation, credential scope, resource exhaustion,
prototype pollution, crypto, integer overflow.

Note: This partition is dominated by path-traversal / arbitrary-file-read and
deserialization sinks, which belong to INJ/NAV, not LOG. LOG-relevant angle across
these inputs is Resource Exhaustion (CWE-400).

---

## Per-input dispositions

### #5 — `file` (GET /ftp/:file, fileServer.ts:16→33)
**CROSS-CLASS (NAV/INJ, CWE-22 path traversal / poison null byte).**
`cutOffPoisonNullByte` + `.md/.pdf` allowlist bypass → `res.sendFile(path.resolve('ftp/', file))`
at fileServer.ts:33. No LOG sink (no crypto/alloc/race). NO-MATCH for LOG.

### #6 — `file` (GET /encryptionkeys/:file, keyServer.ts:14)
**CROSS-CLASS (NAV/INJ, CWE-22).** `sendFile(path.resolve('encryptionkeys/', file))`,
only defense is `!file.includes('/')`. No LOG sink. NO-MATCH for LOG.

### #7 — `file` (GET /support/logs/:file, logfileServer.ts:14)
**CROSS-CLASS (NAV/INJ, CWE-22).** Same pattern, `logs/` dir. NO-MATCH for LOG.

### #8 — `file` (GET /ftp/quarantine/:file, quarantineServer.ts:14)
**CROSS-CLASS (NAV/INJ, CWE-22).** Same pattern, `ftp/quarantine/`. NO-MATCH for LOG.

### #9 — multipart `file` / zip (POST /file-upload → handleZipFileUpload, fileUpload.ts:27-53)
- **CROSS-CLASS (NAV/INJ, CWE-22 zip-slip):** `extractZipBuffer` writes to
  `'uploads/complaints/' + fileName` (fileUpload.ts:34) using the raw entry path;
  the guard checks `absolutePath.includes(path.resolve('.'))` on a *different*
  (resolved) string, and the write uses the unresolved concatenation → classic zip-slip.
- **CANDIDATE (LOG, CWE-400 resource exhaustion — zip bomb):** fileUpload.ts:29-34.
  `extractZipBuffer` iterates every entry and pipes each to disk with **no
  decompressed-size cap and no entry-count cap** → a highly-compressed zip bomb can
  exhaust disk. Gate0: not the intended feature (intended challenge is the file-write/
  zip-slip, not DoS). Gate1: reachable, POST /file-upload is unauth (server.ts:307),
  gated only by `isChallengeEnabled(fileWriteChallenge)` (default on). Gate2a: attacker
  supplies the archive. Gate2b: none. **Severity: Low** (self-limited to disk fill,
  training app). Uncapped-allocation LOG finding, distinct from the zip-slip write.

### #10 — uploaded XML (POST /file-upload → handleXmlUpload → parseXmlString, xml.ts:33-42)
- **CROSS-CLASS (NAV/INJ, CWE-611 XXE):** `XML_PARSE_NOENT | XML_PARSE_DTDLOAD` +
  `xmlRegisterFsInputProviders()` (xml.ts:21,35) enable external-entity file read/SSRF
  (`file:///etc/passwd`). Intentional per design comment.
- **CANDIDATE→DESIGN-INTENT (LOG, CWE-400 entity-expansion / billion-laughs):**
  xml.ts:38. `XML_PARSE_NOENT` enables entity substitution → expansion bomb. A vm
  `timeout: 2000ms` wraps the parse, but the parse is a synchronous libxml2-wasm call
  and vm timeouts do not reliably interrupt synchronous native/WASM execution, so a
  laughs bomb may still exhaust CPU/memory before the timeout fires. Mitigation is
  present-but-partial; behavior is explicitly design-intent (comment xml.ts:29-32,
  handled as "Script execution timed out"). **Recorded DESIGN-INTENT, residual Low.**

### #11 — uploaded YAML `data` (POST /file-upload → handleYamlUpload, fileUpload.ts:96-123)
- **DESIGN-INTENT (LOG, CWE-400 YAML bomb / deserialization):** fileUpload.ts:104,
  `vm.runInContext('JSON.stringify(yaml.load(data))', sandbox, {timeout:2000})`.
  js-yaml `^3.14` `load` (FULL schema) + anchor/alias expansion = classic Juice Shop
  yamlBombChallenge. Mitigations in code: 2000ms vm timeout (interrupts synchronous
  JS) and explicit handling of "Invalid string length" / "Script execution timed out"
  → 503 (fileUpload.ts:109-111). This is the app's intended vulnerable feature.
  Also note `yaml.load` (not `safeLoad`) permits `!!js/function` deserialization, but
  it runs in a vm sandbox — deserialization RCE angle is CROSS-CLASS/design-intent.
  **Recorded DESIGN-INTENT, residual Low.**

---

## Summary of LOG dispositions
| # | Disposition | Class | Sink |
|---|---|---|---|
| 5 | NO-MATCH (LOG) / CROSS-CLASS NAV | CWE-22 | fileServer.ts:33 |
| 6 | NO-MATCH (LOG) / CROSS-CLASS NAV | CWE-22 | keyServer.ts:14 |
| 7 | NO-MATCH (LOG) / CROSS-CLASS NAV | CWE-22 | logfileServer.ts:14 |
| 8 | NO-MATCH (LOG) / CROSS-CLASS NAV | CWE-22 | quarantineServer.ts:14 |
| 9 | CANDIDATE (LOG) + CROSS-CLASS NAV | CWE-400 zip bomb / CWE-22 zip-slip | fileUpload.ts:29-34 |
| 10 | DESIGN-INTENT (LOG) + CROSS-CLASS NAV | CWE-400 / CWE-611 | xml.ts:38 |
| 11 | DESIGN-INTENT (LOG) | CWE-400 YAML bomb | fileUpload.ts:104 |

No race conditions, cache-isolation, credential-scope, prototype-pollution, crypto,
or integer-overflow sinks reachable from the assigned inputs in this partition.
