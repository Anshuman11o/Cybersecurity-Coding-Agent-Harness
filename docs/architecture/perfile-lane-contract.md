# Per-File Lane Architecture — Shared Contract (v2)

This document is the **binding interface** between three independently-built components.
Do not change this schema unilaterally. If something here is unworkable, say so in your
report rather than silently deviating — another component is being built against it in
parallel and will break.

## Design intent

The v1 architecture grouped many files into a small number of category-themed lanes.
v2 inverts this: **one lane per file**, each hunting the categories recon associates with
that specific file. Two problems this is meant to solve:

1. In v1, seed files were truncated at 15,000 characters, so large files were only
   partially analyzed and the tail was silently discarded. In v2 a lane MUST cover
   100% of its target file, using an explicit chunk plan when the file exceeds
   single-pass capacity.
2. In v1, per-lane category lists were coarse, so findings inherited a lane's whole
   category list rather than naming the vulnerability class actually found.

## Directory layout — the v1 architecture is PRESERVED, not modified

| Component | v1 (do not modify) | v2 (new, built by these tasks) |
|---|---|---|
| Lane Selector | `tools/scanner/stage05-lane-selector/` | `tools/scanner/stage05-lane-selector-perfile/` |
| Hunt Lanes | `tools/scanner/stage2-hunt-lanes/` | `tools/scanner/stage2-hunt-lanes-perfile/` |

v1 directories must remain byte-for-byte unchanged. v2 is a sibling, independently
runnable via its own `npm run run`. Copy and adapt v1 code freely as a starting point.

## Stage 0.5 v2 output: `output/lane-assignments.json`

```jsonc
{
  "generated_at": "<ISO-8601>",
  "target_dir": "<absolute path to scanned repo>",
  "source_stage0_run": "<path to the architecture-summary.json consumed>",

  "coverage_ledger": {
    "total_files_in_inventory": 918,
    "assigned_hunt": 531,
    "assigned_skip": 387,
    "unaccounted": 0            // MUST be 0. Assert this; fail loudly if not.
  },

  "category_universe": [        // every category recon marked present or uncertain
    { "code": "A01", "name": "A01: Broken Access Control", "framework": "OWASP Top 10 2021" }
  ],

  "lanes": [
    {
      "lane_id": "file-0001",
      "target_file": "routes/login.ts",      // path relative to target_dir
      "disposition": "hunt",                  // "hunt" | "skip"
      "skip_reason": null,                    // required non-null when disposition="skip"

      "categories": [                         // categories THIS file is hunted for
        { "code": "A03", "name": "A03: Injection", "framework": "OWASP Top 10 2021" }
      ],
      "category_basis": "route_table",        // why these categories -- see below

      "file_bytes": 4523,
      "file_lines": 120,
      "estimated_prompt_tokens": 1580,

      "chunk_plan": {
        "required": false,
        "total_chunks": 1,
        "chunks": [ { "index": 1, "start_line": 1, "end_line": 120 } ]
      }
    }
  ]
}
```

### `category_basis` — allowed values

Records *why* a file received its category list, so a wrong assignment is traceable:

- `route_table` — file implements one or more registered routes
- `persistence` — file performs raw/ORM query construction
- `client_render` — file contains a frontend escape-hatch render sink
- `llm_surface` — file participates in LLM/tool-calling
- `model_definition` — file defines a persistence model / schema
- `universe_default` — no specific evidence; received the full category universe

### Category association rules (generic — no target-specific names)

Derive per-file categories from recon's own evidence, keyed off **category code**
(`A01`, `API3`, `LLM01`), never off exact framework display strings — recon's
`framework` field wording varies between runs and exact-string matching against it
has already caused a silent lane-loss bug.

Association is evidence-driven; a file with **no** matching evidence receives the
**entire category universe** (`universe_default`). Failing open toward more coverage
is deliberate: under-assigning silently hides vulnerabilities, over-assigning only
costs tokens.

### Disposition rules

- `hunt` — default for any file whose language can contain executable logic.
- `skip` — pure declarative config/style/markup with no independently executable
  logic and no traceable entrypoint-to-sink path on its own. Must carry a
  `skip_reason`. **Still appears in `lanes[]`** so the ledger balances and nothing
  vanishes silently.

Decide skip by language class generically, not by filename or directory patterns
specific to any one repository.

### Chunk plan rules

- `SINGLE_PASS_LINE_BUDGET` — a named exported constant, not a magic number.
- If the file fits in one pass: `required: false`, one chunk spanning the whole file.
- If not: split into sequential line ranges with a **20-line overlap** between
  consecutive chunks, so a vulnerability spanning a boundary is not cut in half.
- Chunks MUST tile the entire file: `chunks[0].start_line == 1` and
  `chunks[last].end_line == file_lines`. Assert this.
- A lane is only complete when every chunk has been analyzed.

## Stage 2 v2 output — unchanged from v1

`output/candidate-findings.json` and `output/budget-consumption.json` keep their existing
shapes so downstream stages and the scoring tooling continue to work. One clarification:
`categories[]` on a finding must name the vulnerability class **actually found**, chosen
from that lane's assigned categories — it is not the lane's whole list copied verbatim.

## Constraints binding on all three tasks

- Only this repository. `target-apps/` is read-only.
- Never search for, read, or reference any answer-key or ground-truth material anywhere
  on this machine. Correctness scoring happens separately and is not your job.
- No prompt, playbook, or code may contain identifiers, file names, or hints specific to
  the repository currently being scanned. Everything must work unchanged against an
  arbitrary codebase in an arbitrary language.
