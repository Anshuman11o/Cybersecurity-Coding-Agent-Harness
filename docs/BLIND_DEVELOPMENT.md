# Blind development / answer-key protocol

This project fixes an entire class of vulnerabilities in [OWASP Juice Shop]
(https://github.com/juice-shop/juice-shop) and has to *prove* it did so
correctly. Juice Shop is a training app: it embeds the exact vulnerable
lines, hand-authored correct fixes, working exploit payloads, and a
database-backed "did you solve it" oracle directly in its own source and
tests. If the harness (or the process building it) can see any of that
while it works, an accuracy number reported afterwards is meaningless — it
would just be reading the answer key.

So the repo is split into two things that never mix:

- **Working copy** (`target-apps/juice-shop/` in this repo) — what the
  harness actually scans, fixes, and tests against. The vulnerabilities
  are still there; only the markers that give them away are gone.
- **Answer key** (a separate private repo, `juice-shop-answer-key`, never
  cloned alongside the working copy) — everything that was stripped out,
  used exactly once at final scoring.

**Guardrail:** no future session working on the harness itself may open,
read, or reference the answer-key repo. If something might be answer-key
material, treat it as answer-key material.

## How the split was produced

`tools/blind-development/split_answer_key.py` takes a pristine clone of
`juice-shop/juice-shop` and mechanically produces both sides. It is
repo-preparation tooling — it knows the *syntactic markers* Juice Shop
itself uses for its own training-mode giveaways (a comment tag, a function
call shape), not which lines are vulnerable. Re-running it against a fresh
clone reproduces the same split.

Phases:

1. **Copy** the pristine tree.
2. **Strip `// vuln-code-snippet` / `# vuln-code-snippet` tags**, repo-wide
   (not just `routes/`/`lib/`/`models/` — they also appear in the Angular
   frontend, `server.ts`, `.sol` contracts, and `securityQuestions.yml`;
   174 occurrences across 14 files, vs. the ~50/7 files visible from a
   narrower grep). Each tag records `{file, line, tag, challengeKeys}` in
   the answer key before its comment is deleted; the code itself is
   untouched.
3. **Move wholesale** to the answer key: `data/static/codefixes/` (the
   game's own "pick the correct fix" data), `SOLUTIONS.md`, `rsn/` (the
   Refactoring-Safety-Net tooling that diffs source snippets against
   codefixes — meaningless once both are gone), and
   `.ai/skills/verify-rsn-fix/` (an internal maintainer skill that names
   specific challenge keys). `package.json`'s now-dead `rsn`/`rsn:update`
   scripts are removed.
4. **Neutralize `challengeUtils.solveIf(challenge, criteria)`** — the
   scoring oracle the brief calls out by name — repo-wide (97 call
   sites across 39 files, not just the two files used as illustrative
   examples). Only the criteria argument is replaced with `() => false`;
   everything else about the call (which challenge, any trailing
   `isRestore`/`isCheating` flags) is left alone, so the app still runs
   identically for a normal user — it just never locally reports what
   would have solved a challenge.
5. **Strip `hints`/`description`/`mitigationUrl`** from
   `data/static/challenges.yml`, keeping `name`/`category`/`key`/etc.
   Fields are zeroed (`''`/`[]`) rather than deleted — `data/datacreator.ts`
   does an unconditional `description.replace(...)` at server boot with no
   null-check, so removing the key outright crashes app startup.
6. **Split exploit-payload tests** out of `test/api/*.test.ts`,
   `test/cypress/e2e/*.spec.ts`, and `test/server/*.unit.test.ts` (not just
   the four files named as examples). Each `it(...)` block is classified
   as an exploit test if its title matches an attack-keyword pattern, its
   body embeds a recognizable payload literal, or — the highest-confidence
   signal — it directly asserts the internal scoring oracle
   (`cy.expectChallengeSolved(...)` in Cypress, or
   `challenges.xChallenge.solved` in unit tests). Matched blocks move to a
   mirrored file under the answer key; everything else (plain functional
   regression tests) stays in the working copy untouched. 219 test cases
   moved out of 56 files this way.
7. **Hand-verified `notSolved(...)/solve(...)` neutralization.** Besides
   `solveIf`, a handful of route handlers (`login.ts`, `search.ts`,
   `verify.ts`, `restoreProgress.ts`, `fileUpload.ts`) implement the same
   "check → mark solved" oracle inline rather than through `solveIf` —
   e.g. `search.ts` dumping the full `Products` union-select result and
   checking whether it contains every user's email+password, or
   `verify.ts` scanning feedback/complaints for planted strings like a
   leaked API key or a typosquatted package name. These aren't a single
   regular pattern, so each occurrence was read in full, confirmed to have
   no side effect beyond the scoring bookkeeping (or, where it did — e.g.
   `restoreProgress.ts`'s magic continue-code `999`, `verify.ts`'s
   captcha-timing bookkeeping — the real side effect was kept and only the
   solving criteria removed), and recorded in the answer key. This pass is
   intentionally *not* generalized into the script the way `solveIf` is;
   see "Known limitations" below.

The script writes `answer-key.json` plus the mirrored directories/files
into the answer-key output; nothing it touches remains in the working
copy.

## Known limitations

- The `notSolved`/`solve` inline pattern (step 7) was hand-audited for the
  five files where it appears. If a future contributor adds a similarly
  inlined scoring oracle elsewhere in Juice Shop, this script will not
  catch it automatically.
- Step 6's test classifier is a heuristic, not a semantic diff. It was
  hand-verified against the four files the original brief named
  (`login.test.ts`, `search.test.ts`, `chat.test.ts`, `basket.spec.ts`)
  and spot-checked broadly, but a handful of borderline cases across ~700
  test titles may be mis-bucketed either direction.
- Some `test/cypress/e2e/*.spec.ts` files end up as empty `describe`
  shells in the working copy (every `it()` in that file asserted
  `expectChallengeSolved`). This is harmless — Cypress just reports zero
  tests for that block — but it's a known cosmetic artifact.
- A `solveIf` criteria closure that delegates to separately-named helper
  functions (rather than an inline comparison) leaves those helpers
  orphaned dead code after step 4 neutralizes the call site. This was
  cleaned up where found during hand-verification (`routes/verify.ts`'s
  `hasAlgorithm`/`hasEmail`) but was not hunted down repo-wide.

## Re-running the split

```
python3 tools/blind-development/split_answer_key.py \
  /path/to/pristine/juice-shop-clone \
  /path/to/output/working-copy \
  /path/to/output/answer-key
```
