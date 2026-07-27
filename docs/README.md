# Documentation index

| Question | Read |
|---|---|
| What is the scanner meant to be, stage by stage? | `architecture/scanner-plan.md` |
| What contract do the v2 per-file components share? | `architecture/perfile-lane-contract.md` |
| How does the scanner run under more than one LLM provider? | `architecture/dual-model-architecture.md` |
| What gets measured, and how is a score defined? | `protocols/eval-framework.md` |
| How much data does a dev-time eval run against? | `protocols/dev-loop-protocol.md` |
| What may the scanner never be allowed to see? | `protocols/blind-development.md` |
| What does one specific stage read and write? | `stages/<stage>.md` |

`architecture/` is design intent. `protocols/` is process that outlives any one
component. `stages/` is the practical per-component reference: inputs, outputs,
which source files, which parts are deterministic code and which are LLM calls.
