# [MEDIUM] generateCoupon tool trusts model-supplied discount with no server-side cap

**File:** `routes/chat.ts` (lines 179, 180, 181, 182, 183)
**Project:** juice-shop-work
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-llm-tool-trust`

## Finding

The generateCoupon tool's execute() calls security.generateCoupon(discount) using the `discount` value chosen by the LLM/model, with no server-side enforcement of the documented 10% maximum. The discount policy (max 10%, requires verified damaged order, etc.) exists only as natural-language instructions in the system prompt, plus a hidden 15% escalation offer. Via ordinary conversational prompt injection an attacker can convince the chatbot to invoke generateCoupon with an arbitrary discount (e.g. 99), producing a valid high-value coupon that security.generateCoupon simply encodes and discountFromCoupon later honors. Security-relevant limits must be enforced in code, not delegated to the model.

## Recommendation

Clamp/validate the discount server-side (e.g. reject or cap discount > 10), and gate coupon issuance on a verified order record in the database rather than on the model's decision.
