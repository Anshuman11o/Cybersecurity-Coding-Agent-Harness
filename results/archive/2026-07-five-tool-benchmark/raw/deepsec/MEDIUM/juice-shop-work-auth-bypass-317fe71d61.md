# [MEDIUM] Identity taken from client-controlled x-user-email header

**File:** `lib/insecurity.ts` (lines 93, 94)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `auth-bypass`

## Finding

userEmailFrom() (L93-95) returns the value of the attacker-controlled `x-user-email` request header. Any consumer that treats this as an authenticated identity (rather than the verified JWT session) can be spoofed by simply setting the header. This is a client-trusted-input pattern that should never feed authorization or ownership decisions.

## Recommendation

Derive user identity only from the verified session token (authenticatedUsers.from(req)), never from a raw request header.
