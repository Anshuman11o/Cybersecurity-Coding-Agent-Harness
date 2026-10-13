# Dispatch — Free-form class codes across the whole pipeline

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside the harness
repository (your worktree of it). Do not open any other directory under
`/home/user/`.

Builds on `2026-10-13__playbook-agent-free-form-codes.md`, which made the
playbook agent accept any code text via `validateOverlay(..., { codeFormat: 'free' })`
while Stage 0.5, 1 and 2 kept the strict OWASP/CWE regex.

## Decision (from the project owner)

A class must carry **at least one** code. The code's **style/format is not
constrained anywhere**: whatever text the agent first recorded and cached is
passed through every stage to the report unchanged.

## Why this is one change

The only place a class code's format is checked is the regex inside
`validateOverlay()` in `tools/scanner/shared/playbook-overlay.ts`. Every stage
that loads added classes goes through that function:

- playbook agent — `stage-playbook-agent/src/agent.ts` (two calls)
- Stage 0.5 — `mergeClassTables` from `stage05-lane-selector-perfile/src/lane-selector-perfile.ts`
- Stage 1 — `addOverlayPlaybookSizes` in `shared/playbook-cache.ts`, called from `stage1-budget-governor/src/budget-governor.ts`
- Stage 2 — `mergeClassTables` from `stage2-hunt-lanes-perfile/src/hunt-executor.ts`

Downstream, codes are only copied (findings' `categories` are the verbatim union of
their classes' codes) or used as lookup keys in fallbacks that agent mode never
reaches. No other code-format check exists for class codes. (Do not confuse with
`extractCategoryCode` in Stage 0.5, which parses recon's category labels, or the
built-in coverage list in `hunt-executor.ts` around line 391, which skips added
classes — leave both alone.)

## Change

### 1. `tools/scanner/shared/playbook-overlay.ts`

- Remove the strict regex and the `codeFormat` option. `validateOverlay` goes back
  to three parameters `(overlay, builtins, map)`.
- The codes rule for every caller becomes what `'free'` is today: `codes` is a
  non-empty array; every entry is a string that is non-blank after trimming, at
  most 100 characters, and contains no line terminator (`\n`, `\r`, U+2028, U+2029,
  written as escapes, never raw characters). Error message stays
  `Invalid codes for ${id}`.
- Update the doc comment accordingly.

### 2. `tools/scanner/stage-playbook-agent/src/agent.ts`

Remove the `{ codeFormat: 'free' }` argument from both `validateOverlay` calls.

### 3. Nothing else in the stages

No change to Stage 0.5, 1 or 2 source is needed: they inherit the rule through
`validateOverlay`. Do not normalise, rewrite or canonicalise codes anywhere.

### 4. Tests

- Replace the strict/free unit test with one asserting, for the single rule:
  `API10:2023`, `M3`, `MASVS-STORAGE`, `CWE-79`, `A03` all accepted; empty array,
  blank/whitespace string, non-string, >100 chars, and each line terminator rejected.
- Keep the existing integration test that a free-form-code class completes the
  playbook stage with codes stored verbatim.
- Add an integration test that an overlay whose added class carries a free-form
  code (e.g. `['API10:2023', 'MASVS-PLATFORM']`) is accepted by the deterministic
  Stage 0.5 run in agent mode (the existing one-file Stage 0.5 harness in
  `integration.test.ts`), and that the class reaches a hunt lane.
- Add a test that `addOverlayPlaybookSizes` accepts such an overlay (Stage 1 hook)
  and that Stage 2's import-only registry load (`mergeClassTables`) accepts it and
  carries the codes verbatim in the merged registry.
- The Stage 0.5 golden test (`fixtures/lane-assignments-no-overlay.json`) must
  still match byte for byte.

All model and web responses stay mocked. **Make no network call to any model and
run no stage against a real model.**

### 5. Docs

- `tools/scanner/stage-playbook-agent/README.md`: replace the sentence saying
  Stage 0.5, 1 and 2 apply the strict format with: every class carries at least
  one code; the text is free-form and passes through all stages to findings
  unchanged.

## Do not touch

Any prompt text, `shared/*.json`, `run.sh`, `tools/scan-benchmark/` (the Juice
Shop scorer's own code extraction is evaluation, not pipeline), and any stage
source beyond the two files above.

## Done means

From the repository root of your worktree (install dependencies first with
`tools/scanner/install.sh` if `node_modules` is missing):

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Commit your change on your worktree branch with a clear message (do
not push). Report the branch name, commit sha, files changed, judgement calls and
each command's pass/fail counts verbatim.
