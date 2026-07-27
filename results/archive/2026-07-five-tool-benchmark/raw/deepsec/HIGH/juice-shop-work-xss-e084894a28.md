# [HIGH] Stored XSS via last-login IP rendered with bypassSecurityTrustHtml

**File:** `frontend/src/app/last-login-ip/last-login-ip.component.ts` (lines 37, 39)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Finding

parseAuthToken() decodes the JWT from localStorage and, if present, renders payload.data.lastLoginIp into the DOM via this.sanitizer.bypassSecurityTrustHtml(`<small>${payload.data.lastLoginIp}</small>`) (L39), which is then bound to [innerHTML] in the template (last-login-ip.component.html L10). The lastLoginIp value is populated server-side from a client-controlled HTTP request header (e.g. X-Forwarded-For / True-Client-IP) recorded at login time. Because bypassSecurityTrustHtml explicitly disables Angular's built-in HTML sanitizer, any markup an attacker places in that header is embedded verbatim and executed when the victim views the Last Login IP page. This is a classic stored/persistent XSS: an attacker sends a login request with a header value such as `<img src=x onerror=alert(document.cookie)>`, which is stored, embedded into the victim's JWT/data on subsequent logins, and rendered unsanitized. Impact includes session/token theft (the JWT itself is in localStorage), account takeover, and arbitrary actions in the victim's context.

## Recommendation

Do not use bypassSecurityTrustHtml on values derived from request headers or any non-constant data. Render the IP as plain text interpolation ({{ lastLoginIp }}) so Angular escapes it, or if HTML wrapping is required, bind a plain string and let the default [innerHTML] sanitizer run. Additionally, validate/normalize the lastLoginIp server-side to a strict IP-address format before storing it.
