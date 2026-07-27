# [HIGH] Stored XSS via user email rendered with bypassSecurityTrustHtml

**File:** `frontend/src/app/administration/administration.component.ts` (lines 73)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

In findAllUsers(), each user's email is wrapped in raw HTML and passed to sanitizer.bypassSecurityTrustHtml(), which disables Angular's built-in output sanitization. The result is bound to [innerHTML] in the template (administration.component.html L26 and L113). The email value originates from the users REST API and is fully attacker-controlled: registration is open with no verification, so a low-privilege attacker can register an account whose email contains an HTML payload (e.g. an <img src=x onerror=...> style vector). When an administrator opens the Administration page, the payload executes in the admin's authenticated session, enabling admin-context account/session compromise. Because the string is interpolated directly (`<span class="...">${user.email}</span>`) with no escaping and the sanitizer is explicitly bypassed, there is no mitigation on this path.

## Recommendation

Do not use bypassSecurityTrustHtml on values derived from user-controlled data. Bind the email via interpolation ({{ user.email }}) or apply the CSS class through structural bindings/[ngClass] instead of building an HTML string, so Angular's default contextual escaping applies.
