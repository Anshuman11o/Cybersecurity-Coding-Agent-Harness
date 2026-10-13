# Dispatch — Playbook agent: size limit up front and a research revision loop

Standing constraint: **never search for, read, or reference any answer-key or
ground-truth material anywhere on this machine.** Work only inside
`/home/user/Cybersecurity-Coding-Agent-Harness`. Do not open any other directory
under `/home/user/`.

## Why

The model is never told the real playbook size limit (1500-8000 bytes; it only
sees "roughly 2–6 KB" in guidance.md), and a playbook that fails format,
sections or size kills the stage at once. A live run lost a complete 9029-byte
playbook this way. The project owner approved: state the limit in the first
research prompt, then let the model revise its own playbook in a short loop.

## Behaviour

```
playbook = researchCall(class)                        // first call, task string below
for attempt in 1..MAX_REVISIONS (2):
    problems = playbookProblems(playbook.text)        // format / sections / size, measured by code
    if none: break
    playbook = revisionCall(class, playbook, problems) // web_search available, tool_choice 'auto'
if problems remain: write research-failures/<id>.json and fail exactly as today
```

`MAX_REVISIONS` is 2, a constant (no env var).

## Changes — `tools/scanner/stage-playbook-agent/src/agent.ts` (and `main.ts` only if needed for logging)

### Research call task — replace the current string with exactly

    Research this missing class using web_search and produce one generic playbook, using the built-in format. Cite the sources used. Keep the playbook under 8000 bytes.

Nothing else about the first research call changes (`tool_choice: 'required'`,
the must-search check, schema, input).

### Revision call

- Same request shape as research (instructions = guidance.md, `playbook` schema,
  `web_search` tool with the configured domain filter, sources `include`), but
  `tool_choice: 'auto'` — the model searches only if it needs to.
- `input` = `JSON.stringify({ task, class, stack, example_format, previous_playbook, previous_source_urls, problems })`
  where `class`, `stack`, `example_format` are exactly what the first research
  call received, `previous_playbook` / `previous_source_urls` are the last
  attempt's output, and `problems` = `{ bytes, size_bounds: [1500, 8000], missing_sections, title_line_ok }`.
- `task` is built from this template, exactly (code fills the braces; the bracketed
  clauses appear only when that problem exists):

      Your playbook is {bytes} bytes; it must be between 1500 and 8000 bytes[, and is missing these sections: {comma-separated section headings}][, and does not start with the required "Playbook for <Class name> (<codes>)" title line followed by a line of = characters]. Revise it to fit: keep the same class, the same five sections in the same order and the most important sink patterns and checks; shorten or merge the least important points. Do not add new content beyond what a missing or incomplete section needs. If a section is missing or incomplete, use web search to look up the information it needs, only if needed. Return the full revised playbook in the same schema.

- Purposes (usage, ledger label, progress line): `research:<id>:revise1`,
  `research:<id>:revise2`.
- The must-search check applies to the first research call only.
- Cited-URL labelling (verified / unverified) uses the union of search sources
  across the first call and its revisions; `queries` stored in the cache meta are
  the union too.
- The cache is written once, with the final accepted playbook. Record in the cache
  meta and the plan's playbook record `revisions: { attempts: n, sizes: [bytes per attempt] }`.

### Logs

Progress line per revision:
`[playbook-agent] research:<id>:reviseN <status> in=<n> out=<n> searches=<n> bytes=<before>-><after> problems=<list or ->`.

### Failure

If problems remain after 2 revisions: write `research-failures/<id>.json` as today
(for the last attempt) plus `attempts: [{ purpose, bytes, problems }]`, and throw
the same message as today for the first remaining problem.

## Not in scope

No other prompt text change; `guidance.md` stays byte-identical. No change to the
decision loop, Stage 0.5, 1, 2, `shared/` (except nothing — none needed) or
`run.sh`.

## Tests (mocked; no network, no real model)

- The first research request's task equals the new string exactly.
- A first output of 9029 bytes followed by a revision of 6000 bytes completes;
  the cached text is the revision; `revisions.sizes` is `[9029, 6000]`; the revision
  request has `tool_choice: 'auto'`, the task built from the template with the
  size only, and `previous_playbook` equal to the first output.
- Missing sections produce the template with the missing-sections clause; a bad
  title line produces the title clause.
- A revision that searches: its sources count toward verified URLs and queries.
- A revision is not required to search.
- Still failing after 2 revisions: exactly 3 research-type calls, the failure
  record carries `attempts`, the stage fails with today's message.
- A first output that passes makes no revision call.
- All existing tests pass, including the Stage 0.5 golden.

## Done means

    cd tools/scanner/stage-playbook-agent && npm test
    cd ../stage0-recon && npx tsx --test src/*.test.ts
    cd ../stage2-hunt-lanes-perfile && npx tsx ../shared/guard.test.ts
    cd ../shared && npx tsx --test foundation.test.ts

all pass. Do not commit. Report files changed, judgement calls, and each
command's pass/fail counts verbatim.
