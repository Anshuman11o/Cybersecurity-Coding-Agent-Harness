# [MEDIUM] Challenge description from REST API rendered via bypassSecurityTrustHtml

**File:** `frontend/src/app/score-board/score-board.component.ts` (lines 82)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `dangerous-html`

## Finding

In ngOnInit, each challenge's `description` field (from the challengeService.find() REST response, ultimately the /api/Challenges endpoint) is passed to `this.sanitizer.bypassSecurityTrustHtml(challenge.description as string)` and bound into the template as trusted HTML. This disables Angular's built-in XSS sanitization for that value. If challenge description content can ever be influenced by an attacker (e.g., a modified/injected challenge record, an admin-editable field, or a translation source), it would result in stored XSS in the score-board view. In the default Juice Shop build these descriptions are static seed data, which keeps real-world exploitability low, but bypassing the sanitizer on any REST-sourced field violates the project's own hardening guidance and removes defense-in-depth.

## Recommendation

Avoid bypassSecurityTrustHtml on server-sourced data. Either render the description as plain text via interpolation, or sanitize it explicitly (DomSanitizer.sanitize(SecurityContext.HTML, value)) / use a strict allowlist for the limited HTML that descriptions actually need (e.g., anchor tags).
