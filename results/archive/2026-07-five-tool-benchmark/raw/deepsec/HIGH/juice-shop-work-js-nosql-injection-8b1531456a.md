# [HIGH] NoSQL $where injection (server-side JS execution) in track-order endpoint

**File:** `routes/trackOrder.ts` (lines 15, 18)
**Project:** juice-shop-work
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `js-nosql-injection`

## Finding

The unauthenticated endpoint GET /rest/track-order/:id (server.ts:609) builds a MongoDB $where query by directly interpolating the request path parameter into a JavaScript string: db.ordersCollection.find({ $where: `this.orderId === '${id}'` }). $where evaluates its string as server-side JavaScript. The only sanitization is conditional: when challenges.[REDACTED] is *enabled* (which is the default — isChallengeEnabled/getChallengeEnablementStatus returns enabled:true for any challenge without a disabledEnv), the code takes the utils.trunc(req.params.id, 60) branch, which merely truncates to 60 characters and does NOT strip quotes, semicolons, or JS syntax. An attacker can break out of the string literal and inject arbitrary JS, e.g. an expression that always returns true to exfiltrate all orders, or a blocking loop (`'||while(true){}` style) to cause a denial of service. Only when the challenge is disabled does the safer replace(/[^\w-]+/g,'') branch run. The endpoint has no authentication and no rate limiting.

## Recommendation

Never use $where with interpolated input. Query by a typed field instead: db.ordersCollection.find({ orderId: String(req.params.id) }). If $where is unavoidable, pass user data via a scoped variable, never string concatenation, and always coerce the id to a plain string. Add authentication/rate limiting to the endpoint.
