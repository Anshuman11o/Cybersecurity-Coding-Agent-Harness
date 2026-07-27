# [LOW] Parser error details reflected to client

**File:** `routes/fileUpload.ts` (lines 79, 85, 108, 114)
**Project:** juice-shop-work
**Severity:** LOW  •  **Confidence:** medium  •  **Slug:** `error-message-leak`

## Finding

On XML (L85) and YAML (L106/L114) parse failures the internal parser `error.message` is embedded into the response error text, disclosing internal parsing/library details to the client.

## Recommendation

Return a generic error message to clients and log the detailed error server-side.
