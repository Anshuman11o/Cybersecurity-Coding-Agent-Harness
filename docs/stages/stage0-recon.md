# Stage 0 — Recon

Turns an arbitrary codebase into one structured fact sheet that every later
stage reads, so no other stage has to re-parse raw source.

## Where the code is
`tools/scanner/stage0-recon/src/`

| File | Role | Method |
|---|---|---|
| `recon.ts` | Orchestrator, target resolution, file inventory, summary assembly | code |
| `ast-extractor.ts` | Route table + auto-CRUD extraction via ts-morph | code |
| `swagger-diff.ts` | Declared API spec vs. actual routes | code |
| `frontend-grep.ts` | Framework detection + escape-hatch sink patterns | code |
| `llm-probe.ts` | Tool-calling detection, category applicability | **LLM** |

## Input
The target repository root, from `--target=<path>` or `SCANNER_TARGET`,
defaulting to `target-apps/juice-shop-blind`. Nothing else — no answer key, no
category hints.

## Output
`output/architecture-summary.json`
- `route_table` — hand-written routes, middleware routes, auto-CRUD resources
  (with per-model exclude lists, the mass-assignment signal)
- `persistence_layer` — ORM, database, models, raw-query files
- `dependencies`, `api_documentation` (swagger coverage diff)
- `client_side` — escape-hatch render sinks with file/line/framework
- `llm_ai` — tool-calling verdict
- `file_inventory` — every source file by language, plus `unclassified_surface`
  and `smart_contract_surface_detected`
- `framework_detection`

`output/category-applicability.json` — one row per OWASP / API Security / LLM
Top 10 category: `verdict` (present/absent/uncertain), `evidence`, `confidence`.

## What is code and what is an LLM call

Exactly **two** LLM calls in the whole stage. Everything that touches all files —
AST parsing, escape-hatch grep, the inventory walk — is deterministic code.

1. **Tool-calling detection** — one file's content sent to the model. Gated by a
   hardcoded path check (`routes/chat.ts`); this gate is not generalized and is
   a known limitation.
2. **Category applicability** — one call over the assembled summary (not raw
   source). The category taxonomy and per-category evidence heuristics are
   hardcoded into the prompt in `llm-probe.ts`, so the model is applying a
   supplied checklist, not recalling the OWASP standard.

Both have deterministic fallbacks if the API call fails or returns unparseable
output.

## Known limitations
- `detectExpress` and `detectFrontendFrameworks` recognise Express, Angular,
  React and Vue only. Other stacks skip deep extraction gracefully and fall
  through to the generic file inventory.
- Only 6 of the 10 LLM Top 10 categories are ever evaluated; LLM04, LLM07,
  LLM08 and LLM09 are excluded by design in `buildCategoryList()`.
- `classifiedFiles` uses target-relative paths while the extractors emit
  repo-relative ones, so almost every file lands in `unclassified_surface`.
  Harmless today (Stage 0.5 seeds them anyway) but it makes the
  classified/unclassified split unreliable as a coverage measure.
