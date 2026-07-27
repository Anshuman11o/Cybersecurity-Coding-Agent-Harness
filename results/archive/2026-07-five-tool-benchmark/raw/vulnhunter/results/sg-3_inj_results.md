# SG-3 Injection (INJ) Trace Results

Partition SG-3 — file serving / traversal + upload / XXE / YAML / zip.
Attacker: anonymous (all entry points unauth).

## Disposition Summary
| # | Input | Disposition | Sink | Class |
|---|-------|-------------|------|-------|
| 5 | `/ftp/:file` param | CANDIDATE | fileServer.ts:33 | CWE-22 |
| 6 | `/encryptionkeys/:file` param | SAFE | keyServer.ts:14 | (no traversal) |
| 7 | `/support/logs/:file` param | SAFE | logfileServer.ts:14 | (no traversal) |
| 8 | `/ftp/quarantine/:file` param | SAFE | quarantineServer.ts:14 | (no traversal) |
| 9 | file upload (zip entry path) | CANDIDATE | fileUpload.ts:34 | CWE-22/434 |
| 10 | uploaded XML content | CANDIDATE | xml.ts:35-38 | CWE-611 |
| 11 | uploaded YAML content | CANDIDATE | fileUpload.ts:104 | CWE-400 |

---

## [VULN-301] Poison-null-byte file-read / extension-allowlist bypass (#5)
- **Input**: #5 route param `file` on GET /ftp/:file
- **Class**: CWE-22 (path traversal / arbitrary file read within `ftp/`)
- **Severity**: Medium (no dir escape; slash blocked → reads any file *inside* `ftp/` regardless of type)
- **Location**: routes/fileServer.ts:33 `res.sendFile(path.resolve('ftp/', file))`
- **Gate 0**: Deliberately planted challenge ([REDACTED]) but a genuine defect — reported.
- **Gate 1**: Mounted server.ts:269, unauth. Reachable.
- **Gate 2a**: `params.file` fully attacker-controlled.
- **Gate 2b**: `endsWithAllowlistedFileType` checks `.md`/`.pdf` on RAW value, THEN `cutOffPoisonNullByte` (insecurity.ts:44) truncates at `%00`. Request `foo.ext%2500.md` → express decodes to `foo.ext%00.md`, passes allowlist, truncates to `foo.ext`. Allowlist bypassed; sanitizer order defeats itself.
- **Gate 3**: Reads non-.md/.pdf files (backups, keys, source) in `ftp/` not otherwise served. Forward-slash block prevents parent traversal.
- **Data Flow**: params.file (fileServer.ts:16) → verify (27) → cutOffPoisonNullByte (29) → sendFile (33)

## [VULN-302] Zip-slip arbitrary file write (#9)
- **Input**: #9 uploaded `.zip` entry paths, POST /file-upload
- **Class**: CWE-22 / CWE-434
- **Severity**: High (unauth arbitrary write under project cwd → overwrite app files)
- **Location**: routes/fileUpload.ts:34 `fs.createWriteStream('uploads/complaints/' + fileName)`
- **Gate 0**: Planted ([REDACTED]) but genuine — reported.
- **Gate 1**: server.ts:307 handleZipFileUpload, unauth (challenge enabled by default). Reachable.
- **Gate 2a**: `entry.path` from attacker-supplied zip = attacker-controlled.
- **Gate 2b**: Guard `absolutePath.includes(path.resolve('.'))` only requires path CONTAIN cwd string — permits `../` writes anywhere UNDER cwd (overwrite source/config). Ineffective.
- **Gate 3**: Arbitrary write within project tree → code overwrite / persistence.
- **Data Flow**: unzipper entry.path (29) → path.resolve (31) → weak includes check (33) → writeStream (34)

## [VULN-303] XXE via uploaded XML (#10)
- **Input**: #10 uploaded `.xml` buffer, POST /file-upload
- **Class**: CWE-611 (external entity → local file disclosure + SSRF)
- **Severity**: High+ (unauth arbitrary file read e.g. file:///etc/passwd; content returned in error body)
- **Location**: lib/xml.ts:35-38 (XML_PARSE_NOENT | XML_PARSE_DTDLOAD, xmlRegisterFsInputProviders grants FS access)
- **Gate 0**: Planted ([REDACTED]) but genuine — reported.
- **Gate 1**: fileUpload.ts:68 handleXmlUpload → parseXmlString; server.ts:307 unauth. Reachable.
- **Gate 2a**: XML body attacker-controlled.
- **Gate 2b**: NONE — entity substitution + external DTD load deliberately enabled; only a vm timeout (blocks billion-laughs, not file/SSRF entities).
- **Gate 3**: Reads server files & reaches internal URLs; exfiltrated via error message (fileUpload.ts:77).
- **Data Flow**: file.buffer (fileUpload.ts:72) → parseXmlString (xml.ts:33) → fromString w/ NOENT+DTDLOAD (38) → truncated into error response (fileUpload.ts:77)

## [VULN-304] YAML-bomb DoS via uploaded YAML (#11)
- **Input**: #11 uploaded `.yml`/`.yaml` buffer, POST /file-upload
- **Class**: CWE-400 (billion-laughs / entity expansion DoS)
- **Severity**: Low (js-yaml v4 safe load → no RCE; 2s vm timeout + "Invalid string length" catch partially mitigate)
- **Location**: routes/fileUpload.ts:104 `vm.runInContext('JSON.stringify(yaml.load(data))', ...)`
- **Gate 0**: Planted ([REDACTED]) — reported.
- **Gate 1**: server.ts:307 handleYamlUpload, unauth. Reachable.
- **Gate 2a**: YAML body attacker-controlled.
- **Gate 2b**: yaml.load resource-limited only by vm timeout(2000ms); anchor/alias expansion can spike CPU/memory before timeout fires.
- **Gate 3**: Resource exhaustion. No code exec (default schema, no custom types).
- **Data Flow**: file.buffer (fileUpload.ts:100) → vm.runInContext yaml.load (104)

---

## SAFE dispositions
- **#6 /encryptionkeys/:file** (keyServer.ts:14): forward slash blocked; `..` without a slash is a single segment → `path.resolve` stays in `encryptionkeys/`; no extension bypass needed but also no dir escape possible. Serves intended dir only. No null-byte handling but no traversal reachable. SAFE (design-intent file server).
- **#7 /support/logs/:file** (logfileServer.ts:14): identical pattern; slash blocked, no traversal. SAFE.
- **#8 /ftp/quarantine/:file** (quarantineServer.ts:14): identical pattern; slash blocked, no traversal. SAFE.

No CROSS-CLASS flags: all sinks are INJ-class (file read/write, XXE, YAML). All entry points are unauth NONE-group, so no NAV authz gate applies (already anonymous, no resource-owner model).
