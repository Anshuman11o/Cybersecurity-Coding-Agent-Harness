# [BUG] Order insert failure leaves PDF stream and HTTP response hung

**File:** `routes/order.ts` (lines 164, 176, 177)
**Project:** juice-shop-work
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-logic-bug`

## Finding

The HTTP response is only sent from the fileWriter 'finish' handler (L47-56), which fires when doc.end() is called. doc.end() is only invoked inside the ordersCollection.insert().then() (L176-177). If the insert rejects, next(error) runs but doc.end() is never called, so the write stream never finishes, the 'finish' handler never runs, and the client's request can hang alongside a dangling file stream/handle.

## Recommendation

Call doc.end() (or clean up the stream) in the insert .catch path, and decouple the HTTP response from the PDF stream lifecycle.
