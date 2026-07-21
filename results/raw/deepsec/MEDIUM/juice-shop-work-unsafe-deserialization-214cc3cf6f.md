# [MEDIUM] JSON.parse of user route param fed into Sequelize where clause on unauthenticated endpoint

**File:** `routes/recycles.ts` (lines 14)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `unsafe-deserialization`

## Finding

getRecycleItem() is mounted at GET /api/Recycles/:id with no auth middleware (server.ts L383). It computes `where: { id: JSON.parse(req.params.id) }`. Because the route param is JSON-parsed, an attacker can supply structured JSON (arrays/objects) rather than a scalar id, altering the query shape (e.g. an array yields an IN(...) query returning multiple records). Combined with the lack of authorization, this allows enumeration/retrieval of recycle records beyond a single intended id. JSON.parse also throws on malformed input, but that is caught and returns a generic error. Impact is limited (recycle data is low-sensitivity) but the pattern of deserializing untrusted input directly into a DB filter is unsafe.

## Recommendation

Coerce req.params.id to a typed scalar (e.g. Number(req.params.id) with validation) instead of JSON.parse, and reject non-numeric input. Add authorization if recycle data should not be public.
