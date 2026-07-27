# [HIGH] Stored XSS via customer feedback comment rendered with bypassSecurityTrustHtml

**File:** `frontend/src/app/administration/administration.component.ts` (lines 91)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

In findAllFeedbacks(), each feedback comment is passed to sanitizer.bypassSecurityTrustHtml() and bound to [innerHTML] in the template (administration.component.html L60). Feedback comments are submitted by anonymous/low-privilege users through the public feedback endpoint and stored server-side. By submitting a comment containing an HTML/JS payload, an attacker causes arbitrary script/DOM execution in the administrator's browser when the admin reviews customer feedback on the Administration page. The sanitizer bypass removes Angular's normal escaping, so the stored payload runs verbatim.

## Recommendation

Render feedback comments via interpolation ({{ feedback.comment }}) or run the value through DOMPurify/Angular's default sanitizer instead of bypassSecurityTrustHtml. Additionally enforce server-side validation/encoding of feedback comments on submission.
