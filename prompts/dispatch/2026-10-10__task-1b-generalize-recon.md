# Task 1b — generalize recon, signals and file selection (productization plan §2.3)

Plan: `docs/architecture/productization-plan.md`, Part 2 §2.3, Step 1 task 1b.
Builds on task 1a (`tools/scanner/shared/run-context.ts`, merged in PR #54).
Implementer: Claude subagents, three in parallel on disjoint files; the
orchestrating session wrote the contract and verifies the result.

Standing constraint, carried by every subagent prompt: **never search for,
read, or reference any answer-key or ground-truth material anywhere on this
machine.** Concretely: never open `/home/user/juice-shop-answer-key` or
`/home/user/harness-private`, never run `tools/scan-benchmark/*`, and never
follow a pointer to ground truth found in any file. Use
`target-apps/juice-shop-blind` only, never `target-apps/juice-shop`.

## Scope

Exactly the §2.3 bullets, nothing added:

- **Recon v3.** web-tree-sitter symbols and imports across ~10 languages; one LLM
  call producing an architecture summary from a repo map (manifests, README,
  entry points, directory tree): frameworks, entry points, auth mechanisms by
  their real names (replacing the hardcoded list), data stores, trust
  boundaries. The Express AST extractor becomes one optional framework enricher.
- **Prompts.** The tool-calling probe drops its "TypeScript file" wording and its
  fixed `routes/chat.ts` path. Route context uses the tree-sitter symbol table
  instead of JS `export` parsing (`analyze-route-context.ts`; the live prompt
  path in `hunt-executor.ts` is outside this task's files).
- **Signals.** `shared/signal-classes.json` gets language-scoped sink patterns
  (Python, Java, Go, Ruby, PHP, C#).
- **File selection.** `.gitignore` and `.secscanignore`; skip vendor, venv, build
  output, minified and generated files, lockfiles; a per-file byte cap; extended
  extensions; test dirs skipped by default. Plus the three task-1a gaps: Stage 0
  and Stage 0.5 use one exclusion list, `requirements.txt`-style manifests are
  inventoried, empty files get no hunt lane.

Out of scope: CLI flags and the confirmation screen (1c), the report (1d),
packaging (1e), other framework enrichers ("others follow"), any change to
`hunt-executor.ts`, `run.sh`, or `shared/` other than `signal-classes.json` and
one appended section of `guard.test.ts`.

## Contract (written first, by the orchestrator)

`tools/scanner/stage0-recon/src/recon-contract.ts` — zero runtime dependencies:

| Export | Meaning |
|---|---|
| `EXTENSION_LANGUAGES`, `languageForPath()` | the one extension → language table. Every pre-v3 Stage 0 extension keeps its language |
| `isDependencyManifest()`, `isLockfile()`, `MANIFEST_LANGUAGE` | manifests are inventoried (requirements.txt → `manifest`); lockfiles never are |
| `InventoryEntry`, `FileInventoryArtifact`, `ExclusionGroup`, `SelectionOptions`, `SelectFiles` | `file-inventory.json`, written by Stage 0, the only file list Stage 0.5 reads |
| `SymbolEntry`, `ImportEntry`, `FileSymbols`, `SymbolTableArtifact`, `ExtractSymbolTable`, `exportedNames()` | `symbols.json`, the tree-sitter symbol table |
| `AuthMechanism`, `ArchitectureInfo` | the `architecture` block of `architecture-summary.json` |
| `FILE_INVENTORY_FILE`, `SYMBOLS_FILE`, `REPO_MAP_FILE` | artifact names in `runPath(provider, 'stage0-recon')` |

Dependencies added to `stage0-recon/package.json` by the orchestrator, exact
versions: `web-tree-sitter@0.25.10`, `tree-sitter-wasms@0.1.13` (prebuilt
grammar WASM, no native build), `ignore@7.0.10` (gitignore semantics,
including negation and parent-directory rules).

## Work split

| Part | Owner | Files (nobody else edits them) |
|---|---|---|
| A · file selection, lane selector | subagent A | `stage0-recon/src/file-selection.ts` (new), `stage0-recon/src/file-selection.test.ts` (new), `stage05-lane-selector-perfile/src/lane-selector-perfile.ts` |
| B · symbols, signals, route context | subagent B | `stage0-recon/src/symbols.ts` (new), `stage0-recon/src/symbols.test.ts` (new), `stage0-recon/src/signal-detector.ts`, `stage0-recon/src/signals.test.ts` (new), `shared/signal-classes.json`, `stage2-hunt-lanes-perfile/src/analyze-route-context.ts` |
| C · recon v3 orchestration, LLM, enrichers | subagent C | `stage0-recon/src/recon.ts`, `stage0-recon/src/llm-probe.ts`, `stage0-recon/src/ast-extractor.ts`, `stage0-recon/src/frontend-grep.ts`, `stage0-recon/src/repo-map.ts` (new), `stage0-recon/src/recon-v3.test.ts` (new) |
| contract, deps, guard section | orchestrator | `recon-contract.ts`, `stage0-recon/package.json` + lock, appended section of `shared/guard.test.ts` |

## Required behaviour

### A · File selection (`file-selection.ts`, implements `SelectFiles`)

- One walk, sorted (`readdirSync` entries sorted by name), so identical input
  gives identical output. Symlinks are never followed or inventoried (reason
  `symlink`).
- Directory exclusions, checked before descending (the directory is recorded,
  not walked):
  - `tool_dir`: `.git`, `.hg`, `.svn`, `.secscan` (`PRODUCT_DIRNAME`), `.qwen`
  - `vendor_dir`: `node_modules`, `bower_components`, `jspm_packages`, `vendor`,
    `third_party`, `.venv`, `venv`, `virtualenv`, `site-packages`, `__pycache__`,
    `.tox`, `.nox`, `.eggs`, `.bundle`, `Pods`, `Carthage`, `.gradle`, `.yarn`,
    `.pnpm-store`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, and any
    directory containing a `pyvenv.cfg`
  - `build_dir`: `dist`, `build`, `out`, `target`, `coverage`, `.nyc_output`,
    `.next`, `.nuxt`, `.output`, `.angular`, `.svelte-kit`, `.parcel-cache`,
    `.cache`, `.turbo`, `.vercel`, `.serverless`, `.terraform`, `storybook-static`
  - Every name Stage 0 or Stage 0.5 excluded before must still be excluded.
- Ignore files: every `.gitignore` at or below the target root (each relative
  to its own directory, deeper files overriding shallower ones, negation
  honoured — use `ignore`'s `test()` and evaluate root → deepest so a deeper
  `!pattern` can re-include), and `.secscanignore` at the target root (gitignore
  syntax, applied after `.gitignore`, reason `secscanignore`). Nothing above the
  target root, no global excludes, no `.git/info/exclude`. A directory that is
  ignored is not walked. **Regression trap:** Juice Shop's own `.gitignore` has
  `app/` followed by `!frontend/src/app`, and `assets/` followed by
  `!frontend/src/assets/`; both directories must stay inventoried.
- File exclusions, for files with a language (in this order): `lockfile`
  (`isLockfile()`), `minified` (`*.min.{js,mjs,cjs,css}`, `*-min.js`, or a
  javascript/css file over 2 KB whose longest line exceeds 5,000 characters and
  whose mean line length exceeds 250), `generated` (`*.pb.go`, `*_pb2.py`,
  `*_pb2_grpc.py`, `*.pb.{cc,h}`, `*.g.dart`, `*.freezed.dart`, `*.designer.cs`,
  `*.g.cs`, `*.generated.*`, or a header in the first 1 KB matching `@generated`,
  `Code generated .* DO NOT EDIT`, `<auto-generated`, `This file (was|is)
  (automatically|auto-) ?generated`, `Generated by the protocol buffer compiler`).
- Files with no language are counted in `unsupported`, never listed.
- Inventoried files carry flags, never removed: `test` (unless
  `include_tests`), `oversize` (`bytes > max_file_bytes`; content not read),
  `empty` (zero bytes or whitespace only).
  - Test rule: any path segment (directory) named `test`, `tests`, `__tests__`,
    `__test__`, `spec`, `specs`, `e2e`, `cypress`, `testdata`, `__mocks__`,
    `__fixtures__`; or a file name matching `*.spec.*`, `*.test.*`,
    `*_test.go`, `test_*.py`, `*_test.py`, `*Test.java`, `*Tests.java`,
    `*Test.kt`, `*_spec.rb`, `*_test.rb`, `*Test.php`, `*Tests.cs`, `*Test.cs`.
- Options: `max_file_bytes` default `1_000_000` (Semgrep's default target cap);
  `include_tests` default `false`. Export `selectionOptionsFromEnv(env)` reading
  `SCANNER_MAX_FILE_BYTES` and `SCANNER_INCLUDE_TESTS=1` — the hook 1c's flags
  will set; invalid values throw.
- Output exactly `FileInventoryArtifact`; `files` sorted by path; `excluded`
  groups sorted by reason, paths sorted.

### A · Lane selector (`lane-selector-perfile.ts`)

- Reads Stage 0's `file-inventory.json` and nothing else for the file list. The
  walk, its private exclusion list and `EXT_TO_LANG` are deleted. A Stage 0 run
  without `file-inventory.json` fails with a message to re-run Stage 0.
- One lane per inventory entry, in inventory order (sorted by path), lane ids
  `file-0001…`. Target check against the run context as in 1a (also check
  `file-inventory.json`'s `target_dir`).
- Disposition, first match wins: seed denylist (unchanged, still first) →
  `empty` → `test` → `oversize` → non-executable language → executable language
  → unknown language (hunt + warning, as now). New skip reasons:
  - `Empty file — nothing to scan`
  - `Test file — skipped by default`
  - `Exceeds the per-file byte cap (<bytes> > <cap> bytes)`
  - `MANIFEST_LANGUAGE` joins the non-executable set with reason
    `Dependency manifest — declarative; dependency risk is not judged per file`
- `file_bytes`, `file_lines`, chunk plan, signals, classes, categories, ledger
  and every assertion: computed exactly as before.
- `total_files_in_inventory` = inventory length, and must equal
  `architecture-summary.json`'s `file_inventory.total_source_files`.

### B · Symbols (`symbols.ts`, implements `ExtractSymbolTable`)

- web-tree-sitter, one `Parser.init()`, grammars loaded lazily from
  `tree-sitter-wasms/out/` via `createRequire(import.meta.url).resolve`.
- Languages: javascript, typescript (`tsx` grammar for `.tsx`), python, java, go,
  ruby, php, csharp (`c_sharp`), rust, c, cpp, kotlin, swift — at least ten must
  produce symbols and imports, each covered by a fixture in `symbols.test.ts`.
- Symbols: functions, methods (with `container`), classes, interfaces, types,
  enums, structs, traits, modules, and top-level variables/constants bound to a
  function or class. `exported` per language: JS/TS `export` (declarations,
  `export { a, b as c }` → `c`, `export default function X`), `module.exports =
  X / { a, b }`, `module.exports.X =`, `exports.X =`; Python top-level without a
  leading `_`; Go capitalised; Java/C#/Kotlin/Swift by modifier (Kotlin: not
  `private`/`internal`; Swift: `public`/`open`); Rust `pub`; Ruby and PHP all
  top-level and public; C/C++ non-`static`.
- Imports: ES `import` and `require()`, Python `import`/`from`, Java/Kotlin
  `import`, Go import specs, Ruby `require`/`require_relative`, PHP `use` and
  `require`/`include`, C# `using`, Rust `use`, C/C++ `#include`, Swift `import`.
- Parses inventory entries that are not `test`, `oversize` or `empty`, whose
  language has a grammar, and whose path the read guard allows
  (`isCorpusReadable(path.relative(REPO_ROOT, abs))`; denied → skipped as
  `guard_denied`, so the benchmark's denylisted files have no symbols).
- Never throws on a bad file: `parse_error: true` and whatever was recovered.

### B · Signals (`signal-detector.ts`, `shared/signal-classes.json`)

- `signal-classes.json` keeps `floor` and `signals` byte-identical and gains
  `sink_patterns: { python | java | go | ruby | php | csharp: { <signal>: [regex
  source, …] } }` covering, where the language has them: `route_handler`,
  `db_query`, `model_schema`, `model_write`, `http_outbound`, `auth_check`,
  `crypto_op`, `html_sink`, `dynamic_exec`, `deserialize`, `file_io`, `llm_call`,
  `logging`. Only existing signal names (no new signals, no class-map change).
  Patterns are JS `RegExp` sources compiled with flag `m`; every one must compile
  and each language's set must have positive and negative fixtures in
  `signals.test.ts`.
- New signature: `detectAllSignalsFromList(targetDir, entries:
  Pick<InventoryEntry,'path'|'language'|'oversize'|'empty'>[],
  routeHandlerNames, symbols?: SymbolTableArtifact)`. Every entry gets a key.
  Oversize: path-based signals only (content not read). Empty: none.
- A file in one of the six languages: path-based signals first (unchanged), then
  content signals from its `sink_patterns` only. Every other language
  (JS/TS and the rest): the existing detectors, unchanged.
- `route_handler`: (regex exports, JS/TS only) ∪ `exportedNames(symbols)`
  intersected with the route handler names; for the six languages also any
  `route_handler` sink pattern.
- `detectDepManifest` = `isDependencyManifest() || isLockfile()` (fixes the old
  mixed-case list that never matched `Cargo.toml`, `Gemfile`, `Pipfile`).
- `detectAllSignals` (unused legacy) is deleted.

### B · Route context analysis (`analyze-route-context.ts`)

- Reads `symbols.json` from Stage 0's run path and matches routes by the
  symbol table's exported names (same rules as `matchRoutesForFile`: handler or
  middleware whole-word match, auto-CRUD by model name or basename), rendering
  with the exported `renderRouteContext` / `renderRegistrarRouteContext`.
  Reports the match distribution for the symbol table and for the old regex
  side by side, and lists lanes whose matches differ. The three hardcoded Juice
  Shop lanes become optional CLI arguments (default: the three lanes with the
  most matched routes). `hunt-executor.ts` is not edited.

### C · Recon v3 (`recon.ts`)

Stage order and artifacts:

1. `selectFiles(target, selectionOptionsFromEnv())` → `file-inventory.json`.
2. `extractSymbolTable(target, inventory.files)` → `symbols.json`.
3. Enrichers (each optional, detected, logged): Express (below) and the
   frontend escape-hatch grep, which now scans non-test inventory files with
   `.ts .tsx .js .jsx .mjs .html .vue` extensions instead of the fixed
   `frontend/src/app` (findings sorted by file, line).
4. Swagger diff, unchanged.
5. Signals over every inventory entry, with route handler names from the same
   filtered route table as before → `file-signals.json`.
6. Repo map (`repo-map.ts`) → `repo-map.md`; one LLM call → `ArchitectureInfo`.
7. Auth tagging of Express routes from `verified_identifiers`.
8. Tool-calling probe, then the category probe, as before.
9. `architecture-summary.json` keeps every existing key with its existing
   meaning and adds `recon_version: 3`, `architecture`,
   `framework_detection.enrichers`, `llm_ai.files_probed`. No key named
   `subsystems` or `data_models` (Stage 2 reads those). `file_inventory` is
   computed from the new inventory in the old shape.

**Repo map** (deterministic, ≤ 60,000 characters, sections in this order, each
capped): language counts; directory tree (depth ≤ 3, file counts per
directory); manifests (≤ 8, shallowest first, ≤ 4,000 chars each); root README
(≤ 6,000 chars); entry points (the Express entry file, conventional names —
`server.*`, `app.*`, `main.*`, `index.*` at root, `src/` or `cmd/*/`,
`manage.py`, `wsgi.py`, `asgi.py`, `urls.py`, `Program.cs`, `Startup.cs`,
`main.go`, `config/routes.rb`, `routes/web.php`, files declaring `main` — ≤ 6
files, ≤ 6,000 chars each); route registrations when an enricher produced them
(`METHOD path  middleware…`, ≤ 200 lines); symbol outline of the top non-test
files (entry points first, then by signal count; exported symbols only, ≤ 12
per file). Every file whose content or symbols enter the map must pass
`isCorpusReadable`; read content through `readCorpusFile`. Test files are never
in the map.

**Architecture call** (`llm-probe.ts`, same client/registry plumbing as the
existing probes, output cap `PROBE_CAP_LARGE`): asks for strict JSON matching
`ArchitectureInfo` minus `source`, `model`, `verified_identifiers`, `dropped`.
Auth mechanisms: "every function, middleware, decorator or annotation the code
uses to authenticate a caller or authorize access, by the exact identifier used
at call sites; not rate limiting, validation or logging". Validation: a path
not in the inventory is dropped (recorded in `dropped`); an identifier is
verified when its last dotted segment is a symbol name in `symbols.json` or a
whole word in the route table's handler/middleware text. Failure or no client →
`markDegraded` and a deterministic fallback from manifests and the symbol table
(`source: 'deterministic'`).

**Express enricher** (`ast-extractor.ts`): detection as before (express
dependency + entry file; also the `package.json` `main` target and `.js/.mjs/.cjs`
variants of the conventional names). Route receivers are the identifiers
initialised from `express()`, `express.Router()` or `Router()` in the entry
file, falling back to `app`. Routes are extracted with `auth: null`; the
hardcoded auth list is deleted and replaced by `tagRouteAuth(routes,
identifiers)`: `auth` = the first middleware text containing a whole-word match
of an identifier's last dotted segment, else `null`.

**Tool-calling probe** (`llm-probe.ts`): no fixed path. Candidates are
inventory files that are not test/oversize/empty, in an executable language,
with the `llm_call` signal, ranked by tool-definition indicators (`tool({`,
`tools:`/`tools=`, `tool_calls`, `function_call`, `@tool`, `bind_tools`,
`tool_choice`, `"type": "function"`), top 3 with a non-zero score, each read
through `readCorpusFile`. The prompt names the file's path and language (no
"TypeScript file", fence tagged with the language). Verdicts are OR-ed, tools
unioned, `files_probed` recorded. No candidates → not tool-calling, not
degraded. Deterministic fallbacks lose their Juice-Shop identifiers
(`isAuthorized`/`appendUserId`/`jwtChallenges`, `generateCoupon`, the assumed
`stepCountIs`): auth presence comes from `architecture.auth_mechanisms` or an
auth-tagged route.

## Benchmark rules

- The seed denylist, read guard, run paths and `runs/<provider>/` layout are
  untouched. Denylisted files stay skip lanes and contribute nothing to the repo
  map or the symbol table.
- No subagent writes to `tools/scanner/runs/`: any stage run sets
  `SCANNER_RUNS_ROOT` to the subagent's own scratch directory.
- No subagent makes a paid model call: any Stage 0 run unsets every API key
  (`env -u OPENAI_API_KEY -u GEMINI_API_KEY -u DASHSCOPE_API_KEY -u ZAI_API_KEY
  -u MOONSHOT_API_KEY -u DEEPSEEK_API_KEY -u SCANNER_ANTHROPIC_API_KEY`), so the
  LLM steps take their marked-degraded fallback.

## Verification (orchestrator)

1. Read every diff. `guard.test.ts` (plus a new 1b section), `loop.test.ts`,
   `test-breakdown.ts`, Stage 1 `test-harness.ts`, the three new Stage 0 test
   files, and `tsc --noEmit` on Stage 0, Stage 0.5 and Stage 2.
2. Benchmark regression, free: Stage 0 offline (no API key) on Juice Shop with
   the committed luna `category-applicability.json` swapped in, then Stage 0.5
   and the Stage 1 v2 estimate, before (main at 41a70e1) and after, into scratch
   runs roots. The before side reproduces the committed lane plan and budget plan
   exactly. Diff keyed by `target_file`; every difference explained.
3. Product smoke, paid, luna: small fixture repos outside this repository
   (Python, Go and Express with custom auth names and a non-`app` router), full
   Stage 0 → 0.5 → 1 → Stage 2. 0 blocked reads, auth mechanisms named as the
   code names them, tool-calling probe finds the right file, selection receipts
   correct, artifacts under `.secscan/`. Cost reported.
