# Stage 0 — Recon

Turns an arbitrary codebase into structured fact sheets that every later stage
reads, so no other stage has to re-parse raw source. Shared by v1 and v2.

## Where the code is
`tools/scanner/stage0-recon/src/`

| File | Role | Method |
|---|---|---|
| `recon.ts` | Orchestrator, target resolution, file inventory, summary assembly | code |
| `ast-extractor.ts` | Route table + auto-CRUD extraction via ts-morph | code |
| `swagger-diff.ts` | Declared API spec vs. actual routes | code |
| `frontend-grep.ts` | Framework detection + escape-hatch sink patterns | code |
| `signal-detector.ts` | Per-file signal extraction — what each file *does* | code |
| `llm-probe.ts` | Tool-calling detection, category applicability | **LLM** |

## Input
The target repository root, from `--target=<path>` or `SCANNER_TARGET`,
defaulting to `target-apps/juice-shop-blind`. Nothing else — no answer key, no
category hints.

## What it runs, in order

Framework detection → AST extraction (Express only) → swagger diff → frontend
escape-hatch grep → tool-calling probe → file-inventory walk → architecture
summary + category-applicability probe → per-file signal extraction.

Every framework-specific step degrades gracefully: a non-Express target skips AST
extraction, a target with no detected frontend skips the grep, and the run falls
through to the generic inventory rather than failing.

## Output

`runs/<provider>/stage0-recon/architecture-summary.json`
- `route_table` — hand-written routes, middleware routes, auto-CRUD resources
  (with per-model exclude lists, the mass-assignment signal)
- `persistence_layer` — ORM, database, models, raw-query files
- `dependencies`, `api_documentation` (swagger coverage diff)
- `client_side` — escape-hatch render sinks with file/line/framework
- `llm_ai` — tool-calling verdict
- `file_inventory` — every source file by language, plus `unclassified_surface`
  and `smart_contract_surface_detected`
- `framework_detection`

`runs/<provider>/stage0-recon/category-applicability.json` — one row per OWASP /
API Security / LLM Top 10 category: `verdict` (present/absent/uncertain),
`evidence`, `confidence`.

`runs/<provider>/stage0-recon/file-signals.json` — **the artifact Stage 0.5's
class assignment is built on.** A list of signals per file, from a fixed
vocabulary of 15:

    route_handler   db_query      model_schema   model_write    http_outbound
    auth_check      crypto_op     html_sink      dynamic_exec   deserialize
    file_io         llm_call      logging        config_file    dep_manifest

Signals describe what a file **does**, never whether it is wrong. Detection is
language-level shape analysis with a textual fallback for files that cannot be
parsed, and **no file is ever dropped from the output** — a file with no
detectable signal appears with an empty list. `route_handler` is resolved against
the AST route table's handler and middleware names rather than guessed.

## What is code and what is an LLM call

Exactly **two** LLM calls in the whole stage. Everything that touches all files —
AST parsing, escape-hatch grep, signal extraction, the inventory walk — is
deterministic code.

1. **Tool-calling detection** — one file's content sent to the model. Gated by a
   hardcoded path check (`routes/chat.ts`); this gate is not generalized and is a
   known limitation. A target without that file records a negative verdict and
   skips the call.
2. **Category applicability** — one call over the assembled summary (not raw
   source). The category taxonomy and per-category evidence heuristics are
   hardcoded into the prompt in `llm-probe.ts`, so the model is applying a
   supplied checklist, not recalling the OWASP standard.

Both have deterministic fallbacks if the API call fails or returns unparseable
output.

## The category list this stage can emit

Built in `buildCategoryList()`, and conditional:

| Framework | Categories | Condition |
|---|---|---|
| OWASP Top 10 2021 | A01–A10 (10) | always |
| API Security Top 10 | API1–API10 (10) | only when an API surface is detected |
| LLM Top 10 | LLM01, LLM02, LLM03, LLM05, LLM06, LLM10 (6) | only when tool-calling is detected |

So at most **26** category codes. Note that the class registry
(`shared/vuln-classes.json`) maps **25** of them — `API10` has no class and
therefore no playbook, so a lane assigned only API10 resolves to no classes.

## Known limitations
- `detectExpress` and `detectFrontendFrameworks` recognise Express, Angular,
  React and Vue only. Other stacks skip deep extraction gracefully and fall
  through to the generic file inventory.
- Only 6 of the 10 LLM Top 10 categories are ever evaluated; LLM04, LLM07, LLM08
  and LLM09 are excluded by design in `buildCategoryList()`.
- Tool-calling detection is gated on the literal path `routes/chat.ts`.
- `classifiedFiles` uses target-relative paths while the extractors emit
  repo-relative ones, so almost every file lands in `unclassified_surface`.
  Harmless today — Stage 0.5 assigns one lane per inventory file regardless — but
  it makes the classified/unclassified split unreliable as a coverage measure.
