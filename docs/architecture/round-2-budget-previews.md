# Round 2 budget screen previews

Captured from `buildSummary`, `renderSummary` and scripted `roundTwo` sessions on
2026-10-14 after the budget wording revision. These are synthetic fixtures, not a
live scan or provider validation. The fixture uses 541 one-chunk lanes with equal
estimated cost, $0.06 already spent, $0.85 estimated input, $1.21 estimated output,
and a $0.14 reservation per chunk. Partial coverage is computed from the plan:
378 files fit at $1.50. Durations and accuracy bands are fixture values.

The complete CLI suite passed: **48 tests, 0 failures, 0 skipped** with
`cd tools/scanner/cli && npm test`. The six preview sessions additionally checked
that full/partial/unlimited budgets return start, low-budget refusal redraws and
acceptance starts, and blocked/at-spend Enter cannot start before quitting.
No hunt or model call was made by these preview sessions.

“Scanned by severity first” is the requested display text for the existing
route-handler, distinct-signal-count, then path ordering. It does not mean
finding severity has been established before scanning. The start gates and
accounting thresholds are unchanged.

## Full

```text
Recon and planning done · spent so far $0.06
Target: ./synthetic-app (not a git checkout, 541 files)
Languages: TypeScript 100% (this model is unmeasured in every language)

Vulnerability classes for this repo                       files
  1  injection  541

Scan 541 files in: src/   Skip 0: -
Model: fixture (FIXTURE_KEY NOT SET), unmeasured   Extra guidance: reviewed class selection
Total estimate: $2.12, ~26 min
  $0.06 spent + input $0.85 + output $1.21.
  Accuracy band: ±7% (90%).
Current budget: $2.50
Budget covers the estimated cost of all 541 files.
Limits: concurrency 8 (default 8)
[Enter] start  [d] delete a class  [a] add a class  [b] budget  [e] limits  [s] save  [q] quit
```

Scripted input:

```text
> [Enter]
Result: start
```

## Partial

```text
Recon and planning done · spent so far $0.06
Target: ./synthetic-app (not a git checkout, 541 files)
Languages: TypeScript 100% (this model is unmeasured in every language)

Vulnerability classes for this repo                       files
  1  injection  541

Scan 541 files in: src/   Skip 0: -
Model: fixture (FIXTURE_KEY NOT SET), unmeasured   Extra guidance: reviewed class selection
Total estimate: $2.12, ~26 min
  $0.06 spent + input $0.85 + output $1.21.
  Accuracy band: ±7% (90%).
Current budget: $1.50
Budget will not cover all 541 files.
Estimated coverage: 378 of 541 files, scanned by severity first.
Raise the budget to $2.12 to cover the full estimated scan.
The report will be INCOMPLETE if the budget stops the scan.
Limits: concurrency 8 (default 8)
[Enter] start  [d] delete a class  [a] add a class  [b] budget  [e] limits  [s] save  [q] quit
```

Scripted input:

```text
> [Enter]
Result: start
```

## Low

```text
Recon and planning done · spent so far $0.06
Target: ./synthetic-app (not a git checkout, 541 files)
Languages: TypeScript 100% (this model is unmeasured in every language)

Vulnerability classes for this repo                       files
  1  injection  541

Scan 541 files in: src/   Skip 0: -
Model: fixture (FIXTURE_KEY NOT SET), unmeasured   Extra guidance: reviewed class selection
Total estimate: $2.12, ~26 min
  $0.06 spent + input $0.85 + output $1.21.
  Accuracy band: ±7% (90%).
Current budget: $0.30
Budget will not cover even the estimated input cost for all files.
Raise the total budget to cover at least partial scan.
Starting now will allow only a partial scan.
Limits: concurrency 8 (default 8)
[Enter] start  [d] delete a class  [a] add a class  [b] budget  [e] limits  [s] save  [q] quit
```

Scripted input:

```text
> [Enter]
Start with this low budget? [y/N] n
> [Enter]
Start with this low budget? [y/N] y
Result: start
```

## Blocked

```text
Recon and planning done · spent so far $0.06
Target: ./synthetic-app (not a git checkout, 541 files)
Languages: TypeScript 100% (this model is unmeasured in every language)

Vulnerability classes for this repo                       files
  1  injection  541

Scan 541 files in: src/   Skip 0: -
Model: fixture (FIXTURE_KEY NOT SET), unmeasured   Extra guidance: reviewed class selection
Total estimate: $2.12, ~26 min
  $0.06 spent + input $0.85 + output $1.21.
  Accuracy band: ±7% (90%).
Current budget: $0.19
Scan cannot start with this budget.
Raise the total budget to at least complete partial scan.
Limits: concurrency 8 (default 8)
[Enter] start  [d] delete a class  [a] add a class  [b] budget  [e] limits  [s] save  [q] quit
```

Scripted input:

```text
> [Enter]
> q
Result: quit
```

## At spend

```text
Recon and planning done · spent so far $0.06
Target: ./synthetic-app (not a git checkout, 541 files)
Languages: TypeScript 100% (this model is unmeasured in every language)

Vulnerability classes for this repo                       files
  1  injection  541

Scan 541 files in: src/   Skip 0: -
Model: fixture (FIXTURE_KEY NOT SET), unmeasured   Extra guidance: reviewed class selection
Total estimate: $2.12, ~26 min
  $0.06 spent + input $0.85 + output $1.21.
  Accuracy band: ±7% (90%).
Current budget: $0.06
Scan cannot start with this budget.
Raise the total budget to at least complete partial scan.
Limits: concurrency 8 (default 8)
[Enter] start  [d] delete a class  [a] add a class  [b] budget  [e] limits  [s] save  [q] quit
```

Scripted input:

```text
> [Enter]
> q
Result: quit
```

## Unlimited

```text
Recon and planning done · spent so far $0.06
Target: ./synthetic-app (not a git checkout, 541 files)
Languages: TypeScript 100% (this model is unmeasured in every language)

Vulnerability classes for this repo                       files
  1  injection  541

Scan 541 files in: src/   Skip 0: -
Model: fixture (FIXTURE_KEY NOT SET), unmeasured   Extra guidance: reviewed class selection
Total estimate: $2.12, ~26 min
  $0.06 spent + input $0.85 + output $1.21.
  Accuracy band: ±7% (90%).
Current budget: Unlimited
Budget covers the estimated cost of all 541 files.
Limits: concurrency 8 (default 8)
[Enter] start  [d] delete a class  [a] add a class  [b] budget  [e] limits  [s] save  [q] quit
```

Scripted input:

```text
> [Enter]
Result: start
```
