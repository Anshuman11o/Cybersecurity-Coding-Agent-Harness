# [HIGH] Local file read / template injection via user-controlled EJS layout parameter

**File:** `routes/dataErasure.ts` (lines 103, 104, 105, 106, 107, 108, 114, 115)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `path-traversal`

## Finding

In the POST handler, req.body.layout is passed (via the spread of req.body into res.render options) as the EJS `layout` for rendering. The only containment control is a blacklist substring check on path.resolve(req.body.layout).toLowerCase() that rejects paths containing 'ftp', 'ctf.key', or 'encryptionkeys'. This is not an allowlist/containment check (no path.resolve(...).startsWith(root) verification), so an authenticated low-privilege user can supply an absolute or ../-traversed path to any other file on the server (e.g. /etc/passwd, source files, config secrets). The rendered file content is returned in the response (first 100 chars via sendlfrResponse), yielding arbitrary local file read, and because the file is rendered as an EJS template it can additionally lead to server-side template injection / code execution if the target contains EJS syntax or attacker-controlled content.

## Recommendation

Do not allow user input to select the render layout/template. If a layout must be selectable, validate it against a fixed allowlist of known template names, and enforce containment with path.resolve(base, name).startsWith(path.resolve(base)). Never render arbitrary filesystem paths.
