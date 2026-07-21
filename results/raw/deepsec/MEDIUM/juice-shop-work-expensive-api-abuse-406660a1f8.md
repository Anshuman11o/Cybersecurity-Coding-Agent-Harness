# [MEDIUM] Unauthenticated chatbot endpoint invokes paid LLM API without rate limiting

**File:** `routes/chat.ts` (lines 113, 114, 189, 201)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `expensive-api-abuse`

## Finding

app.post('/rest/chat', utils.asyncHandler(chat())) is registered with no auth middleware and no rate limiter. The handler streams to an external LLM provider (createOpenAICompatible with process.env.LLM_API_KEY) and accepts arbitrary req.body.messages. Any anonymous user can repeatedly call this endpoint to drive up LLM API costs (financial DoS) and consume server resources. Unlike the 2FA routes which use rateLimit(), this expensive endpoint has no abuse protection.

## Recommendation

Add rate limiting (and ideally authentication/quota) to /rest/chat, and cap message count/length per request.
