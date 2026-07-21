# [HIGH] Stored XSS via bypassed sanitization of product descriptions

**File:** `frontend/src/app/search-result/search-result.component.ts` (lines 107, 108, 109)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

trustProductDescription() (L107-111) iterates over all product entries and replaces each `description` with `this.sanitizer.bypassSecurityTrustHtml(tableData[i].description)` (L109). These descriptions originate from the REST product API and are rendered via innerHTML in the product grid/details views. Since product/description fields can be influenced through the application's data (and are rendered as trusted HTML with sanitization disabled), any HTML/script persisted into a product description executes in every visitor's browser (stored XSS). The bypass is applied blindly to every product regardless of source.

## Recommendation

Remove the bypassSecurityTrustHtml call on product descriptions. Render descriptions with normal Angular binding/interpolation so they are sanitized, or run them through DomSanitizer.sanitize(SecurityContext.HTML, ...).
