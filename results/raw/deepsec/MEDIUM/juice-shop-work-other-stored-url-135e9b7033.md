# [MEDIUM] Unvalidated attacker URL persisted as profileImage on fetch failure

**File:** `routes/profileImageUrlUpload.ts` (lines 36)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-stored-url`

## Finding

In the catch block (L36) the raw user-supplied `url` is written directly into the user's `profileImage` field without any validation. This value is later rendered by the frontend as an image source, allowing storage of arbitrary URLs (e.g. `javascript:`-style or tracking/attacker-controlled URLs) tied to the account.

## Recommendation

Validate and sanitize the URL before persisting; restrict to http(s) and a known image path pattern.
