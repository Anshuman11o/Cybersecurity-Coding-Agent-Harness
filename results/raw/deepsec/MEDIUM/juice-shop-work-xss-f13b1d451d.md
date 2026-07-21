# [MEDIUM] Hacking-instructor challenge name from query param passed to dynamic import handler

**File:** `frontend/src/app/search-result/search-result.component.ts` (lines 97, 98, 99, 193)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `xss`

## Finding

In ngAfterViewInit (L97-100), a `challenge` query parameter is decoded via decodeURIComponent and passed to startHackingInstructor(), which logs it and forwards it to a dynamically imported module. While not directly an HTML sink, this reflects unvalidated attacker-controlled query input into application control flow guarded only by a URL regex match. Lower severity but worth validating the challenge name against a known allowlist before use.

## Recommendation

Validate the decoded challenge name against a fixed allowlist of known challenge identifiers before invoking startHackingInstructorFor.
