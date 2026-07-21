# [BUG] redirectUrl is a hardcoded literal, not an open redirect

**File:** `frontend/src/app/basket/basket.component.ts` (lines 34)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-false-positive`

## Finding

The scanner flagged L34 as a redirect URL parameter, but redirectUrl is assigned the constant string '/basket' and passed as a query param to the internal Angular router navigation to '/login'. There is no user-controlled input in this redirect and no navigation to an external origin, so this is not an open redirect. (Any open-redirect risk from consuming redirectUrl would live in the login component that reads the query param, not here.)

## Recommendation

No change required. If reviewing open-redirect risk, audit the login component's handling of the redirectUrl query parameter for an allowlist/relative-path check.
