# [HIGH] DOM-based XSS via search query bypassing Angular sanitizer

**File:** `frontend/src/app/search-result/search-result.component.ts` (lines 133, 140)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

The `q` query string parameter is read from `this.route.snapshot.queryParams.q` in filterTable() (L133) and passed directly to `this.sanitizer.bypassSecurityTrustHtml(queryParam)` (L140), storing the result in `searchValue`. The template binds this to `[innerHTML]="searchValue"` (search-result.component.html L11). Because `bypassSecurityTrustHtml` explicitly disables Angular's built-in HTML sanitization, any attacker-controlled markup in the `q` parameter is rendered as live HTML. An attacker can craft a link like `/search?q=<img src=x onerror=alert(document.cookie)>` and deliver it to a victim (reflected XSS), enabling session token theft (the app stores the JWT in localStorage), account takeover, or arbitrary actions in the victim's session. This is a genuine, exploitable reflected XSS, not merely a training artifact.

## Recommendation

Do not call bypassSecurityTrustHtml on user-controlled input. Bind the search term with interpolation ({{ searchValue }}) so Angular escapes it, or render it as plain text. If HTML is truly required, sanitize with DomSanitizer.sanitize(SecurityContext.HTML, value) instead of bypassing.
