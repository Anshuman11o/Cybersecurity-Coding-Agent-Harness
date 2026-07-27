# [HIGH] Zip-slip path traversal writes attacker-controlled files outside upload dir

**File:** `routes/fileUpload.ts` (lines 31, 33, 34)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `path-traversal`

## Finding

`extractZipBuffer` (L27-37) uses the zip entry's `entry.path` as `fileName` and writes to `'uploads/complaints/' + fileName` (L34). A malicious archive containing an entry named `../../someFile` traverses out of the intended directory. The only guard (L33) checks `path.resolve('uploads/complaints/' + fileName).includes(path.resolve('.'))` — but the write on L34 uses the raw, un-normalized concatenated relative path, and the guard merely checks whether the resolved path string contains the cwd, which is trivially bypassable (e.g. a path that stays under cwd but escapes `uploads/complaints`, such as `../../<sensitive>`). This permits overwriting arbitrary files under the project root (config, source, static assets), potentially leading to RCE.

## Recommendation

Normalize the entry path, strip leading `/` and `..` segments, and verify `path.resolve(target).startsWith(path.resolve('uploads/complaints') + path.sep)` before writing using that validated absolute path (not the raw concatenation). Reject entries that escape.
