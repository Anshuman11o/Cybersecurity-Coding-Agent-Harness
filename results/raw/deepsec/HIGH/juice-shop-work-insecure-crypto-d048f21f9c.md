# [HIGH] Predictable OAuth account password derived from email address

**File:** `frontend/src/app/oauth/oauth.component.ts` (lines 30, 31, 46)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `insecure-crypto`

## Finding

During OAuth login the client derives the user's account password purely from their email: btoa(profile.email.split('').reverse().join('')) (L30 and L46). This is a deterministic, reversible transformation (base64 of the reversed email) with no secret input. Any attacker who knows a victim's email address can compute the exact same password and log into the victim's OAuth-provisioned account via the normal password login endpoint, fully bypassing the OAuth flow. The account is also silently created/registered with this password (userService.save, L31). This is a predictable-credential / broken authentication issue affecting every OAuth user.

## Recommendation

Never derive passwords from public identifiers. For OAuth-provisioned accounts, either do not set a usable password at all (mark the account as OAuth-only) or generate a cryptographically random secret server-side that is never reconstructable from the email.
