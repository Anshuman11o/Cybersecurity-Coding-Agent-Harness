# [MEDIUM] innerHTML binding of product description that may already be a bypassed SafeHtml

**File:** `frontend/src/app/product-details/product-details.component.html` (lines 16)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `xss`

## Finding

L16 binds `[innerHTML]="data.productData.description"`. When bound with a raw string, Angular auto-sanitizes, but the dialog's productData is supplied by callers (e.g. the search-result product grid) where each product.description has been converted to a bypassed SafeHtml object via bypassSecurityTrustHtml (search-result.component.ts L109). A SafeHtml value bound to innerHTML renders WITHOUT sanitization, so a malicious description reaches this sink unescaped, yielding stored XSS in the product-details dialog. Even absent the chained SafeHtml, binding untrusted description HTML via innerHTML is riskier than interpolation.

## Recommendation

Render the description with interpolation or explicitly sanitize it here; do not rely on upstream callers not to pass pre-bypassed SafeHtml values.
