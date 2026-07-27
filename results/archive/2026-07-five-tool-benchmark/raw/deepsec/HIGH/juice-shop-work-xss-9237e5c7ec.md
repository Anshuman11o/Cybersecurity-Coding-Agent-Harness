# [HIGH] Stored XSS via bypassSecurityTrustHtml on user-submitted feedback comments

**File:** `frontend/src/app/about/about.component.ts` (lines 116, 117, 118, 119, 120, 121)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

populateSlideshowFromFeedbacks() takes each feedback returned by feedbackService.find() and builds an HTML string by directly interpolating feedbacks[i].comment into a <figcaption>...</figcaption> template literal (L116-118). It then calls this.sanitizer.bypassSecurityTrustHtml() on the result (L119-121), explicitly disabling Angular's built-in output sanitization, and stores it as the gallery image's `args`. The about.component.html template renders this via [innerHTML]="item?.args" (L51). Feedback comments are attacker-controlled: any anonymous/low-priv user can submit feedback, and the comment field is persisted server-side and served to every visitor of the About page. An attacker can submit a comment containing markup such as an <img src=x onerror=...> (or other event-handler payloads that survive being placed inside innerHTML) to achieve stored cross-site scripting against all users viewing the About page. Because bypassSecurityTrustHtml is used, Angular does NOT sanitize the value, so the standard framework protection is intentionally defeated.

## Recommendation

Do not call bypassSecurityTrustHtml on API-derived data. Bind the comment as text (interpolation) instead of HTML, or if HTML structure is required, sanitize the user portion first (e.g. DomSanitizer.sanitize(SecurityContext.HTML, comment)) and only trust the static wrapper markup, keeping the user-supplied comment escaped.
