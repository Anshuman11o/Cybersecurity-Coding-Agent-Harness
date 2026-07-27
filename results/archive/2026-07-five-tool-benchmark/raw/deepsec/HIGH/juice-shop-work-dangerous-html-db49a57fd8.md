# [HIGH] innerHTML binding renders trusted-bypassed feedback HTML (XSS sink)

**File:** `frontend/src/app/about/about.component.html` (lines 51)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `dangerous-html`

## Finding

The template binds [innerHTML]="item?.args" (L51) to render feedback gallery items. The bound value originates in about.component.ts where user-submitted feedback comments are wrapped in HTML and passed through DomSanitizer.bypassSecurityTrustHtml. Because the value is a trusted SafeHtml, Angular emits it verbatim into the DOM with no sanitization, making this the concrete DOM sink for the stored XSS described for about.component.ts.

## Recommendation

Avoid innerHTML for API-derived content; render the comment as escaped text, or ensure only sanitized (not bypass-trusted) HTML reaches this binding.
