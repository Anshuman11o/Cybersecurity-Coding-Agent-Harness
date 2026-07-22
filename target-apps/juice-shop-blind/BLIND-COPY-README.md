# Category-blind copy

This is a copy of `target-apps/juice-shop/`, identical except for one change:
`data/static/challenges.yml`'s `category` field (e.g. `Injection`, `XSS`, `Broken Access Control`)
has been replaced with a neutral placeholder (`Unspecified`) for all 113 entries.

## Why

`category` is a real, unredacted field in the working copy that the app itself uses only for the
scoreboard's category filter UI (`frontend/src/app/score-board/helpers/challenge-filtering.ts`,
`.../category-filter/category-filter.component.ts`) — cosmetic, not security-relevant business
logic. But it's also a direct, in-code giveaway: a scanner reading `challenges.yml` could read
`category: XSS` next to a challenge key and skip the actual reasoning work of figuring out a
vulnerability's class. This copy exists so a scanner (or any other coding agent) evaluated against
it has to determine vulnerability categories from genuine code analysis, not from a label sitting in
a config file.

Everything else — routes, models, lib, frontend logic, the stripped hints/descriptions/solveIf
oracle from the original blind-development split (`docs/BLIND_DEVELOPMENT.md`) — is unchanged.

## Pairing

The private answer-key repo has a matching `ground-truth-subset.json` (mirroring the 10
`benchmark_ground_truth` entries, minus the `category` field) for scoring runs against this copy.
Same guardrail applies as always: no scanner-building or scanner-tuning session opens either the
main `answer-key.json` or `ground-truth-subset.json` — only a separate scoring step, after an
independent scan completes.

## What this is not

This is not a smaller/reduced app — same file tree, same route count, same complexity. The only
change is the one field. Deliberately: shrinking the app itself would make Stage 0 recon's job
easier in a way that doesn't reflect real-world use (see the scanner architecture plan, Part 1
§7.6, and Part 3's "why shrink the app is the wrong lever" section).
