# Dispatch — Playbook agent: persist the decision before research, and diagnose research failures

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

## Why

A live run completed the whole decision loop and proposed an additional class;
that class's research call then failed `validatePlaybook` ("Generated playbook
must be roughly 2–6 KB") and the stage exited 1. Because every artifact is written
only at the end, the finished class decision was lost, and the rejected playbook
text was not kept, so the exact cause (too long or too short, by how much) is
unknown.

## Change

### 1. Persist the final decision before any research call

In `tools/scanner/stage-playbook-agent/src/agent.ts`, after the decision loop has
produced the final union and before the first research call, call a new
`AgentOptions` callback `recordDecision(decision)` with:

    {
      schema: 'secscan.class-decision/1',
      created_at, model,
      builtin: string[]            // selected built-in ids, sorted
      added: ProposedClass[]       // additional classes exactly as decided (id, framework, codes, signals, reason)
      classes: string[]            // sorted union of builtin ids and added ids
      turns, loop                  // same shapes as in PlaybookPlan
    }

`main.ts` writes it atomically (same `writeJson`) to
`runPath(provider, 'stage-playbook-agent')/class-decision.json`.

- Written whether or not research later succeeds. `class-selection.json`,
  `classes-overlay.json` and `playbook-plan.json` keep their current meaning and
  are still written only on success. No other stage reads `class-decision.json`;
  Stage 0.5 is unchanged.
- At the start of `main()` (where `meta.json` is marked failed first), delete any
  existing `class-decision.json` in the stage dir so a stale one from an earlier
  attempt can never be mistaken for this run's.

### 2. Diagnose research failures (debug artifacts and logs)

When a research call's output fails any check — JSON parse, `validatePlaybook`
(format, sections, size, source URLs), the "no web search performed" check, or
the "cites a URL absent from the search sources" check — before rethrowing, call
a new `AgentOptions` callback `recordResearchFailure(record)`; `main.ts` writes it
to `runPath(...)/research-failures/<class-id>.json`. Record:

    {
      class_id, purpose, error,                 // the thrown message
      check,                                    // 'json' | 'format' | 'sections' | 'size' | 'sources' | 'no_search' | 'cited_url_absent'
      byte_size, char_size,                     // of the playbook text, when there is one
      size_bounds: [1500, 8000],
      missing_sections: string[],               // which required headings are absent
      cited_urls_absent_from_search: string[],
      web_search_calls, queries, search_source_urls, cited_source_urls,
      response_status, output_tokens, reasoning_tokens,
      playbook_text                             // the rejected text, verbatim (or the raw output text if JSON failed)
    }

To fill `check`, `missing_sections` and the sizes, split `validatePlaybook` into a
pure `playbookProblems(text, sources)` that returns the list of failed checks
(the same checks, same bounds, same order), and keep `validatePlaybook` throwing
the **same messages as today** for the first problem. Behaviour on failure is
unchanged: the stage still exits 1.

### 3. Progress logs

`main.ts` / the agent prints one line per model call to stdout as it completes:
`[playbook-agent] <purpose> <status> in=<n> out=<n> searches=<n> added=<ids or ->`
(`added` for turns; for research, the playbook byte size), plus
`[playbook-agent] decision saved: N classes (B built-in, A additional)` after step 1,
and on a research failure
`[playbook-agent] research:<id> FAILED check=<check> bytes=<n> (bounds 1500-8000) missing=<...>`.

## Not in scope

No prompt text change. No change to any check's bounds or rules. No retry. No
change to Stage 0.5, 1, 2, `shared/` or `run.sh`.

## Tests (mocked; no network, no real model)

- `class-decision.json` exists and matches the final union when research succeeds,
  and **also when a research call fails** (stage exit 1).
- A stale `class-decision.json` is removed at stage start.
- A research output that is too short, too long, missing a section, cites an
  absent URL, made no search, or is not JSON each produces
  `research-failures/<id>.json` with the right `check`, sizes, `missing_sections`
  and verbatim text, and the stage still fails with today's message.
- `validatePlaybook` messages are unchanged.
- Existing tests still pass, including the Stage 0.5 golden.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, judgement calls, and each
command's pass/fail counts verbatim.
