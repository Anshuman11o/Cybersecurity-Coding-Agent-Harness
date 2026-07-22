# Scan-only benchmark: 5 harnesses vs. 10 hand-verified Juice Shop challenges

Ground truth: `benchmark_ground_truth` in answer-key.json, 10 challenges spanning distinct OWASP categories. Scoring matches findings to ground truth by file + line proximity (±15 lines). Only findings whose file matches one of the 10 ground-truth files count toward precision/recall/localization; a tool's other real findings elsewhere in the app are noted in raw counts but out of scope for this comparison.

## Summary table

| Tool | Findings (in-scope / total) | Precision | Recall | Localization | False positives (in-scope) |
|---|---|---|---|---|---|
| security-audit-skill (Cloudflare) | 15 / 23 | 100% | 100% (10/10) | 100% | 0 |
| VulnHunter (Capital One) | 8 / 37 | 100% | 70% (7/10) | 100% | 0 |
| raptor (community) | 2 / 8 | 100% | 20% (2/10) | 50% | 0 |
| deepsec (Vercel Labs) | 22 / 101 | 100% | 90% (9/10) | 100% | 0 |

## Per-tool detail

### security-audit-skill (Cloudflare)

Completed. Run scoped to 5 parallel hunting lanes rather than the skill's full attack-class matrix (see `results/security-audit-skill/REPORT.md`).

- Total findings reported: 23
- In-scope findings (file matches a ground-truth challenge): 15
- Out-of-scope findings (real app, not in the 10-challenge subset): 8
- Ground-truth challenges found (file-level): basketAccessChallenge, chatbotPromptInjectionChallenge, loginAdminChallenge, noSqlReviewsChallenge, restfulXssChallenge, ssrfChallenge, unionSqlInjectionChallenge, usernameXssChallenge, weakPasswordChallenge, xxeFileDisclosureChallenge
- Ground-truth challenges precisely localized (±15 lines): basketAccessChallenge, chatbotPromptInjectionChallenge, loginAdminChallenge, noSqlReviewsChallenge, restfulXssChallenge, ssrfChallenge, unionSqlInjectionChallenge, usernameXssChallenge, weakPasswordChallenge, xxeFileDisclosureChallenge
- Ground-truth challenges missed entirely: none

### VulnHunter (Capital One)

**Did not complete.** Hit the Anthropic org's monthly Opus spend limit partway through Phase 2 (hunt across partitions) and exited before writing a final report. Scored from its 37 partial per-partition result files (SG-1 through roughly SG-8/9) that had already been written to disk; the two hunting lanes it hadn't reached yet (AI/LLM, and part of client-side/XSS) show up as misses below, not necessarily as true negatives.

- Total findings reported: 37
- In-scope findings (file matches a ground-truth challenge): 8
- Out-of-scope findings (real app, not in the 10-challenge subset): 29
- Ground-truth challenges found (file-level): basketAccessChallenge, loginAdminChallenge, noSqlReviewsChallenge, ssrfChallenge, unionSqlInjectionChallenge, usernameXssChallenge, xxeFileDisclosureChallenge
- Ground-truth challenges precisely localized (±15 lines): basketAccessChallenge, loginAdminChallenge, noSqlReviewsChallenge, ssrfChallenge, unionSqlInjectionChallenge, usernameXssChallenge, xxeFileDisclosureChallenge
- Ground-truth challenges missed entirely: chatbotPromptInjectionChallenge, restfulXssChallenge, weakPasswordChallenge

### raptor (community)

Completed as literally invoked in the brief (`/scan`, no extra flags) -- CodeQL is off by default for that command, so this is a Semgrep-only static-pattern scan, not raptor's full agentic `/agentic`/`/validate` pipeline. Much lower recall is expected and observed: pattern matching alone catches the SSRF and (via a generic hardcoded-secret rule, imprecisely localized) the insecurity.ts file, but none of the logic-heavy access-control, auth-bypass, or prompt-injection classes that need semantic reasoning to find.

- Total findings reported: 8
- In-scope findings (file matches a ground-truth challenge): 2
- Out-of-scope findings (real app, not in the 10-challenge subset): 6
- Ground-truth challenges found (file-level): ssrfChallenge, weakPasswordChallenge
- Ground-truth challenges precisely localized (±15 lines): ssrfChallenge
- Ground-truth challenges missed entirely: basketAccessChallenge, chatbotPromptInjectionChallenge, loginAdminChallenge, noSqlReviewsChallenge, restfulXssChallenge, unionSqlInjectionChallenge, usernameXssChallenge, xxeFileDisclosureChallenge

### deepsec (Vercel Labs)

Completed scan + process + export. Skipped the optional `revalidate` step (which defaults to Opus and would have spent more of an already-exhausted budget) -- the brief marked it optional.

- Total findings reported: 101
- In-scope findings (file matches a ground-truth challenge): 22
- Out-of-scope findings (real app, not in the 10-challenge subset): 79
- Ground-truth challenges found (file-level): chatbotPromptInjectionChallenge, loginAdminChallenge, noSqlReviewsChallenge, restfulXssChallenge, ssrfChallenge, unionSqlInjectionChallenge, usernameXssChallenge, weakPasswordChallenge, xxeFileDisclosureChallenge
- Ground-truth challenges precisely localized (±15 lines): chatbotPromptInjectionChallenge, loginAdminChallenge, noSqlReviewsChallenge, restfulXssChallenge, ssrfChallenge, unionSqlInjectionChallenge, usernameXssChallenge, weakPasswordChallenge, xxeFileDisclosureChallenge
- Ground-truth challenges missed entirely: basketAccessChallenge


### VVAH (Visa)

**Did not complete.** Timed out (28-minute bound) partway through Stage 4/11 (taint analysis) of its 11-stage pipeline; per its own `estimate` output the full repo scope is ~4M input tokens per pass across 9 detection stages, which needs materially longer than this run's time budget. No SARIF/Markdown report was ever emitted (that happens at S9), so there is nothing to score -- not included in the summary table below.

- Total findings reported: 0 (pipeline never reached the report-emission stage)

## Ground truth reference

**Redacted.** This section used to list the literal `challengeKey | category | file:line` table for
all 10 ground-truth challenges directly in this repo — which defeats the point of keeping the
answer key in a separate, restricted repo (`docs/BLIND_DEVELOPMENT.md`'s guardrail exists precisely
so no session building or evaluating the scanner can see this). It's removed here for the same
reason. The full ground truth lives only in the private answer-key repo's `answer-key.json`
(`benchmark_ground_truth` array), opened only by the scoring script, after independent scans
complete — never by a scanner-building or scanner-tuning session. If a future task has a legitimate
reason to see the reference table (e.g. auditing the scoring script itself), read it from the
answer-key repo directly rather than restoring it here.
