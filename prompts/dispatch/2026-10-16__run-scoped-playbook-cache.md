# Run-scoped playbook cache, cleared when the run ends

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only in the harness
checkout. No paid scans and no model API calls; every test uses synthetic
fixtures.

## Problem

Agent-researched playbooks are cached at `reportsRoot(ctx)/playbooks/`
(`tools/scanner/shared/playbook-cache.ts:35`), i.e. `<target>/.secscan/playbooks`,
which every product run of the same target shares. The playbook agent is shown
that cache and told to reuse cached identifiers, and its turns never drop a
class, so each later run of a target inherits and extends earlier runs' agent
classes (one held-out target went 1 → 6 → 8 agent-added classes over three
runs). Successive scans of a target are therefore not independent.

The cache is also read *during* a run, so it cannot simply be deleted at the
end: Stage 1 (`addOverlayPlaybookSizes`), round-two review (`review.ts`) and
Stage 2 (`hunt-executor.ts:350,367`) read playbook text back from it by sha256,
and a resumable run (budget or timeout stop, `resume_command` set) needs it
again when resumed.

## Approved change (owner-approved)

Owner's intent: every new scan starts with an empty agent cache; the cache only
saves repeated web research inside one run; it is cleared when the run ends.
Built-in playbooks (`stage2-hunt-lanes-perfile/src/playbooks/*.ts`) are source
files, never cache entries, and are untouched.

1. **Run-scoped location.** `cacheRoot(ctx)` returns `join(ctx.runsRoot, 'playbooks')`
   for both profiles. In the product profile `runsRoot` is
   `<reports>/runs/<run-id>`, so each run has its own cache and a resumed run
   (same run id) finds its own entries. Every reader already calls
   `cacheRoot()` in a child process whose `SCANNER_RUNS_ROOT` the CLI sets, so
   no reader needs a new argument. Check that this holds for each call site
   listed above.
2. **Empty at start.** The playbook-agent stage (`stage-playbook-agent/src/main.ts`)
   removes `cacheRoot()` before it runs unless `getRunContext().resume` is
   true. Confirm how `launchStage` in `cli/src/stages.ts` passes the resume flag
   to pre-stages, and state it in your report. This covers the benchmark profile,
   whose `runsRoot` is shared between runs.
3. **Cleared at the end.** In `cli/src/secscan.ts`, once a run's record and report
   are written (inside `finish`, after `generateReport`), remove
   `join(runsRoot, 'playbooks')` when the run is not resumable
   (`record.resume_command` is null). A resumable run keeps it for its resume;
   because the location is run-scoped, a kept cache can never reach another run.
   A failure to remove it is a warning on stderr, never a change to the exit code.
4. **Legacy shared cache.** At the start of a new (not resumed) product scan the
   CLI removes `join(reportsRoot, 'playbooks')` if present, with one log line
   (`Removed the playbook cache left by earlier runs: <path>`). That directory
   is only ever the old shared cache.
5. Unchanged: playbook-agent prompts and decision logic, cache file format and
   identity checks (`readCachedPlaybook`, `writeCachedPlaybook`,
   `cacheDirectory`), run records (`PlaybookRecord` keeps sha256 and sources),
   report generation, v1 components.
6. Docs: update the cache location and lifetime in
   `tools/scanner/stage-playbook-agent/README.md` (line ~132 and the diagram
   label), `tools/scanner/stage-playbook-agent/guidance.md` line ~85 (path text
   only), and `docs/architecture/round-2-class-review.md` where it implies a
   cache shared across runs.

## Verification

- Replace the two integration tests that assert the cache is shared across runs
  (`stage-playbook-agent/src/integration.test.ts`, "reports cache is shared across
  product runs…" and "custom reports root owns the playbook cache…") with tests
  that assert: two product run ids get different cache roots under their own
  run folders; a resumed context (same run id) gets the same root; a custom
  reports root still places the cache under `runs/<run-id>/playbooks`.
- Test: the playbook-agent start clears a pre-existing cache when not resuming
  and keeps it when resuming (synthetic entry written with `writeCachedPlaybook`).
- Test: the CLI removes the run's cache after a non-resumable finish, keeps it
  when `resume_command` is set, and removes a legacy `<reports>/playbooks` at the
  start of a new run but not on `--resume`. Use the existing CLI test harness
  (`cli/src/orchestration.test.ts` / `cli.test.ts` dependency injection); no
  network.
- Every scanner suite passes (guard, stage0, stage-playbook-agent, stage05
  perfile, stage1, stage2-perfile, cli, report), and `tsc --noEmit` is clean for
  the packages you touch (the CLI's 9 pre-existing type errors on `main` may
  remain; do not add any).
