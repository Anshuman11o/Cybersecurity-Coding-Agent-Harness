# Documentation index

**New here? Read `orientation.md` first.** It covers what exists, what does not,
the two different "models" this project talks about, and the traps that have cost
real time.

| Question | Read |
|---|---|
| I have never seen this repo before | `orientation.md` |
| What rules must I not break? | `../CLAUDE.md` |
| How do I execute a scan, end to end? | `protocols/running-a-scan.md` |
| How do I score a run and compare it to the last one? | `protocols/eval-howto.md` |
| What has been run, and what did it show? | `run-history.md` |
| What gets measured, and how is a score defined? | `protocols/eval-framework.md` |
| How does the scanner run under any given LLM, and how do I add one? | `architecture/multi-model-architecture.md` |
| What is the scanner meant to be, stage by stage? | `architecture/scanner-plan.md` |
| What contract do the v2 per-file components share? | `architecture/perfile-lane-contract.md` |
| How do signals, classes and OWASP codes relate? | `architecture/vulnerability-class-model.md`, `architecture/taxonomy-data-flow.md` |
| How much data does a dev-time eval run against? | `protocols/dev-loop-protocol.md` |
| What may the scanner never be allowed to see? | `protocols/blind-development.md` |
| What are we changing next to raise recall, and why? | `protocols/recall-improvement-backlog.md` |
| What does one specific stage read and write? | `stages/<stage>.md` |

`architecture/` is design intent. `protocols/` is process that outlives any one
component. `stages/` is the practical per-component reference: inputs, outputs,
which source files, which parts are deterministic code and which are LLM calls.
`orientation.md` and `run-history.md` sit at the top level because they are the
two documents most often wanted first.

Two things are deliberately **not** here, and must not be added: the answer key,
and anything that pairs a benchmark entry with a file and line. Both live in the
private answer-key repo. See `protocols/blind-development.md`.
