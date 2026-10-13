# Dispatch — Playbook agent: cited source URLs become optional

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

## Why

Citing source URLs is a hard constraint in three places, and a live run lost its
playbook because 8 of 14 cited URLs (real OWASP MAS and Android developer pages)
were not in that call's own search-source list. The project owner's decision:
citing URLs is **optional**; whatever the model cites is kept and labelled, never
a reason to fail.

## Change

1. `tools/scanner/stage-playbook-agent/src/agent.ts`
   - `playbookProblems` / `validatePlaybook`: remove the `sources` check (at least
     one http(s) URL). The `format`, `sections` and `size` checks are unchanged,
     with the same messages and bounds.
   - Research: remove the fatal "cites a URL absent from the search
     sources/citations" check. Instead split the cited URLs into
     `verified_source_urls` (present in the call's search sources) and
     `unverified_source_urls` (absent). Keep every cited URL, in order, in
     `source_urls`. Store `verified_source_urls` and `unverified_source_urls`
     in the cache `meta.json` and in the plan's class / playbook record, and add
     `unverified=<n>` to the research progress line.
   - Keep the "no web search performed" check (research still must search) and
     the `research-failures/` record for the checks that still fail.
   - The research `check` values `sources` and `cited_url_absent` disappear from
     `playbookProblems`; keep `cited_urls_absent_from_search` in a failure record
     as information.
   - A cited URL that is not a well-formed http(s) URL is kept in `source_urls`
     and listed in `unverified_source_urls`; it never fails the stage.
2. `tools/scanner/shared/playbook-cache.ts` (line ~63): `meta.source_urls` must be
   an array of strings, **may be empty**. Accept the two new optional arrays; an
   entry written before this change (without them) must still load.
3. Schema: the research `playbook` schema keeps `source_urls` (an array of
   strings, may be empty). No other schema change.
4. README (`tools/scanner/stage-playbook-agent/README.md`): state that cited URLs
   are optional, kept as cited, and labelled verified/unverified against the
   call's own search sources.

No prompt text changes (guidance.md and every task string stay byte-identical).
No change to Stage 0.5, 1, 2 or `run.sh`.

## Tests (mocked; no network, no real model)

- A research output citing URLs absent from its search sources completes; the
  cache meta and plan carry `source_urls` (all, in order),
  `verified_source_urls` and `unverified_source_urls`.
- A research output citing no URLs completes and is cached with `source_urls: []`.
- A malformed cited URL completes and is listed as unverified.
- An existing cache entry without the new fields still loads (including through
  Stage 1's `addOverlayPlaybookSizes`).
- Size, format and sections still fail with today's messages and still write
  `research-failures/<id>.json`; no-search still fails.
- All existing tests pass, including the Stage 0.5 golden.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, judgement calls, and each
command's pass/fail counts verbatim.
