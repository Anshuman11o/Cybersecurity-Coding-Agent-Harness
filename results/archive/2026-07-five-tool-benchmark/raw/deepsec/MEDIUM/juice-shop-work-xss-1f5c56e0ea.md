# [MEDIUM] document.write of server-returned userData into a new window

**File:** `frontend/src/app/data-export/data-export.component.ts` (lines 71)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `xss`

## Finding

In save(), the data-export response field data.userData is written directly into a newly opened window via window.open(...).document.write(this.userData) (L71) with no escaping or sanitization. userData is HTML built server-side from the requesting user's own exported records (profile, memories, reviews, orders). Primary impact is self-XSS (the user sees their own data), which limits severity. However, if any component of the exported data can incorporate content authored by other users (e.g. shared/aggregated fields), this becomes a stored-XSS vector executing in the victim's own export window; and document.write into a blank window creates a script-execution context in the app's origin. The lack of any sanitization on a document.write sink is the core concern.

## Recommendation

Avoid document.write. Trigger a file download (Blob + application/json) or render exported data as escaped text nodes. If HTML rendering is required, sanitize with DOMPurify and serve the export from a sandboxed, distinct origin.
