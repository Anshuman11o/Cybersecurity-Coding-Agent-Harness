# [HIGH] innerHTML binding of unsanitized search value

**File:** `frontend/src/app/search-result/search-result.component.html` (lines 11)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

L11 binds `[innerHTML]="searchValue"` where searchValue is a SafeHtml produced by bypassSecurityTrustHtml over the user-controlled `q` query parameter (see search-result.component.ts L140). This is the rendering sink for the reflected XSS described in the .ts file. Attacker-supplied markup in `q` executes as HTML/JS.

## Recommendation

Use interpolation ({{ searchValue }}) so the value is escaped, and remove the sanitizer bypass in the component.
