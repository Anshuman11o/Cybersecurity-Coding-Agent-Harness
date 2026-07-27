# [HIGH] innerHTML sinks render trusted-bypassed user email and feedback

**File:** `frontend/src/app/administration/administration.component.html` (lines 26, 60, 113)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

Lines 26 and 113 bind [innerHTML]="user.email" and line 60 binds [innerHTML]="feedback.comment". These are the DOM sinks for the two stored XSS issues in administration.component.ts (L73/L91), where the bound values have been wrapped with bypassSecurityTrustHtml, disabling Angular escaping. Both email and feedback comment are attacker-controlled fields from the REST API.

## Recommendation

Replace [innerHTML] bindings with text interpolation, or ensure the bound values are sanitized (not trust-bypassed) before binding.
