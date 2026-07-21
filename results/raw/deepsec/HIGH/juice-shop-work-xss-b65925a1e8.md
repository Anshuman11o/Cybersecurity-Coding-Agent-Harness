# [HIGH] DOM XSS via bypassSecurityTrustHtml on order tracking data

**File:** `frontend/src/app/track-result/track-result.component.ts` (lines 48)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

In ngOnInit, the component builds an HTML string `<code>${results.data[0].orderId}</code>` and passes it through DomSanitizer.bypassSecurityTrustHtml (L48), which disables Angular's built-in output escaping and marks the value as trusted HTML to be rendered in the template. The value originates from the REST API response of `/rest/track-order/:id` (TrackOrderService.find), i.e. an untrusted server/DB-derived field rather than a literal string. The track-order endpoint performs a document-store lookup keyed on the user-supplied `id` query parameter and is a known NoSQL-injection / attacker-influenceable surface, so an attacker who controls or injects order data can place a payload such as `<img src=x onerror=alert(document.cookie)>` into orderId, which will execute in the victim's browser when the tracking result is rendered. Using bypassSecurityTrustHtml on any value that ultimately comes from a REST field is precisely the unsafe pattern called out in the project guidelines.

## Recommendation

Do not call bypassSecurityTrustHtml on server-supplied data. Bind orderId as plain text interpolation ({{ results.orderNo }}) and let Angular escape it, or wrap it in a <code> element in the template rather than constructing raw HTML. If HTML must be produced, sanitize with DomSanitizer.sanitize(SecurityContext.HTML, ...) instead of bypassing it.
