# [BUG] Captcha innerHTML binds server-generated SVG

**File:** `frontend/src/app/data-export/data-export.component.html` (lines 29)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-false-positive`

## Finding

Line 29 binds [innerHTML]="captcha", but captcha is the SVG image returned by the server's image-captcha endpoint (data.image), not user-controlled input. The value is server-generated and trusted, so this innerHTML binding is not an exploitable XSS sink from an attacker's perspective.

## Recommendation

No change required, though rendering the captcha as an <img>/SVG element rather than trusting raw HTML would be defense-in-depth.
