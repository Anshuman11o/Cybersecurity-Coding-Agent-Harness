# [MEDIUM] User-controlled query parameter reflected into image src and socket event without validation

**File:** `frontend/src/app/deluxe-user/deluxe-user.component.ts` (lines 57, 68, 73)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-dom-injection`

## Finding

The 'testDecal' query parameter is read via this.route.snapshot.queryParams.testDecal (line 57) and interpolated unvalidated into logoSrc = `assets/public/images/${decalParam || logo}` (line 68), which binds to an <img> src in the template. It is also emitted verbatim to the '[REDACTED]' socket event (line 73). Because the value is fully attacker-controlled via the URL, it can inject relative path traversal (e.g. ../../ sequences) to point the image at arbitrary same-origin assets, or supply a crafted filename/SVG reference. While the fixed 'assets/public/images/' prefix prevents an absolute off-origin URL, the lack of any allowlist/sanitization on a reflected parameter is a real trust-boundary weakness (this is the underlying SVG-injection training issue in Juice Shop).

## Recommendation

Validate testDecal against an allowlist of known sticker filenames (or strip path separators and enforce a safe filename regex) before assigning it to logoSrc or emitting it. Do not interpolate raw query-string input into DOM-bound src attributes.
