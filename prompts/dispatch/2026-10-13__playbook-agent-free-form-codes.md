# Dispatch — Playbook agent: accept free-form vulnerability codes

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

## Why

`validateOverlay()` in `tools/scanner/shared/playbook-overlay.ts` (lines 42-44)
rejects any additional-class code that is not exactly `CWE-n`, `Ann`, `APIn` or
`LLMnn`. With web search in the class decision, the agent now proposes classes
with real but differently written codes (e.g. a year-suffixed OWASP code, or an
OWASP Mobile / MASVS code), and the stage dies with `Invalid codes for <id>`
before any review turn or research call runs. Two live runs failed exactly so.

Scope is the **playbook agent only**. Stage 0.5, Stage 1 and Stage 2 keep the
current strict check unchanged for now.

## Change

### 1. `tools/scanner/shared/playbook-overlay.ts`

Give `validateOverlay` an optional fourth parameter
`opts: { codeFormat?: 'strict' | 'free' } = {}` (default `'strict'`).

- `'strict'` (default): exactly today's behaviour, byte for byte.
- `'free'`: `codes` must still be a non-empty array, and every entry must be a
  string that is non-empty after trimming, at most 100 characters, and contains no
  line break. No other format rule. The error message for a violation stays
  `Invalid codes for ${id}`.

Every existing caller keeps the default. Do not change `mergeClassTables`,
`addOverlayPlaybookSizes`, `readClassesOverlay`, `readClassSelection` or
`validateClassSelection`.

### 2. `tools/scanner/stage-playbook-agent/src/agent.ts`

Pass `{ codeFormat: 'free' }` at the two `validateOverlay` calls in this file (in
`validateDecision`, and after each class is written to or read from the cache).
Codes are stored exactly as the model returned them; no normalisation.

Nothing else changes: no prompt text, no schema, no other validation.

### 3. Tests

- `shared/foundation.test.ts` or the playbook-agent tests: `'strict'` still rejects
  `API10:2023`, `M3`, `MASVS-STORAGE`; `'free'` accepts them; `'free'` still rejects
  an empty array, an empty or whitespace-only string, a non-string, a string over
  100 characters and a string with a newline.
- A playbook-agent test where the initial decision proposes an additional class
  with codes `['API10:2023', 'MASVS-PLATFORM']`: the run completes, the overlay and
  `class-selection.json` contain the class, and the overlay codes are stored
  verbatim.
- The existing Stage 0.5 golden test and every other test still pass.

All model and web responses stay mocked. **Make no network call and run no stage
against a real model.**

### 4. `tools/scanner/stage-playbook-agent/README.md`

One sentence under "Decision and cache": additional-class codes are stored as the
model wrote them (non-empty strings); Stage 0.5, 1 and 2 still apply the strict
OWASP/CWE code format when they load the overlay.

## Do not touch

Everything outside the files named above, including every stage other than the
playbook agent, all prompt text, `shared/*.json` and `run.sh`.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, judgement calls, and each
command's pass/fail counts verbatim.
