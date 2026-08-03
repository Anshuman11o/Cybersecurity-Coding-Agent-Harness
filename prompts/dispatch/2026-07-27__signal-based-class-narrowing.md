# Dispatch — Signal-based class narrowing (Stage 0 + Stage 0.5 + Stage 2)

Three components. Read the whole brief before starting; the JSON contract in the middle is what the
three agree on.

## The problem

Stage 0.5 tries to infer each file's vulnerability categories from architecture-level facts it does
not have. Measured on the last run, of 553 hunt lanes:

    category_basis:  universe_default  545
                     client_render       7
                     route_table         1

    classes per lane: {2: 7, 15: 546}

Seven lanes narrow. 546 receive all 15 classes, which loads all 15 playbooks — a measured ~8,460
tokens of fixed overhead per lane, against a median file of about 1,000 bytes. Half the lanes spend
most of their prompt on guidance for classes that do not apply.

The failure is structural: the architecture summary names a dozen or so files, so every other file
falls through to `universe_default`. And the one branch that fires most, `route_table`, maps to all
26 codes anyway with the comment "Every category class can manifest here."

## The shape of the fix

Move evidence *production* into Stage 0, where the whole tree is already walked. Stage 0.5 stops
inferring and becomes a lookup.

    Stage 0    detect per-file signals          -> file-signals.json
    Stage 0.5  signals -> classes, via a table  -> lane-assignments.json gains `classes`
    Stage 2    prefer `classes` when present

---

## Part 1 — Stage 0: per-file signal extraction

New pass in `tools/scanner/stage0-recon/`, emitting `output/file-signals.json`.

**Deterministic. No LLM call.** This is the same class of work as the existing AST route extraction.

Record what a file **does**, never whether it is wrong. `db_query` means "this file runs database
queries", not "this file has SQL injection".

One row per file in the existing inventory — all 918, not a subset:

```json
{
  "generated_at": "...",
  "target_dir": "...",
  "files": {
    "routes/basketItems.ts": ["route_handler", "db_query", "model_write"],
    "lib/insecurity.ts": ["crypto_op", "auth_check"]
  }
}
```

### Signals to detect

Detect by **language-level shape**, not by library name. `sequelize.query` must not be hardcoded;
what generalises is "a method call named like a query executor on some object". A file may carry any
number of signals.

| Signal | What indicates it |
|---|---|
| `route_handler` | The file's exported symbols appear as a `handler`, or whole-word inside a `middleware` entry, in the route table this stage already builds |
| `db_query` | Call expressions whose callee name matches query execution (`query`, `exec`, `execute`, `raw`, `find*`, `aggregate`, `select`, `insert`, `update`, `destroy`, `save`), or a template literal containing SQL keywords |
| `model_schema` | The file declares a persisted entity: extends a model base class, calls `.init(`, constructs a schema object, or carries an entity decorator |
| `model_write` | A call that persists or mutates a record (`save`, `create`, `update`, `upsert`, `build`, `bulkCreate`) |
| `http_outbound` | An outbound request call (`fetch`, `request`, `get`, `post`, `axios`-shaped) whose URL argument is **not** a literal |
| `auth_check` | Identifiers referencing authentication or authorisation — session, token, jwt, role, permission, `isAuthorized`-shaped names, login |
| `crypto_op` | Identifiers referencing hashing, encryption, signing, HMAC, salting, or key material |
| `html_sink` | A sink that bypasses framework escaping: `innerHTML`, `outerHTML`, `dangerouslySetInnerHTML`, `bypassSecurityTrust*`, `document.write`, `v-html` |
| `dynamic_exec` | `eval`, `new Function`, or process/shell execution |
| `deserialize` | Parsing of a serialised format from a non-literal source — JSON, YAML, XML, or a native deserializer |
| `file_io` | Filesystem or file-serving operations, especially with a non-literal path |
| `llm_call` | A model API call or a tool/function definition passed to one |
| `logging` | Logger or console calls at warn/error level |
| `config_file` | The file is configuration by structure — a settings document, environment file, or similar |
| `dep_manifest` | A dependency manifest or lockfile |

**When a signal is genuinely ambiguous, emit it.** Over-detection costs prompt tokens.
Under-detection removes a whole vulnerability class from a file and makes any defect of that class
there unfindable, no matter how good the model is. The two errors are not symmetric — this is
exactly how a pattern-matching-only scanner in this project's own benchmark scored 20% recall.

Detection must degrade rather than crash on a file it cannot parse: fall back to a textual scan, and
never drop a file from the output. A file with no detected signals gets an empty array, which is a
real answer, not a failure.

---

## Part 2 — the signal→class table

New file `tools/scanner/shared/signal-classes.json`, alongside `vuln-classes.json` and following the
same single-source-of-truth pattern. Plain data, no comments.

```json
{
  "floor": ["insecure-design", "logging-monitoring", "general-catchall"],
  "signals": {
    "route_handler":  ["access-control", "api-property-auth", "resource-consumption"],
    "db_query":       ["injection", "api-property-auth"],
    "model_schema":   ["api-property-auth", "access-control"],
    "model_write":    ["injection", "integrity-failures"],
    "http_outbound":  ["ssrf"],
    "auth_check":     ["access-control", "crypto-auth"],
    "crypto_op":      ["crypto-auth"],
    "html_sink":      ["client-side", "injection"],
    "dynamic_exec":   ["injection"],
    "deserialize":    ["integrity-failures", "injection"],
    "file_io":        ["injection", "access-control"],
    "llm_call":       ["ai-llm-agency", "client-side"],
    "logging":        ["logging-monitoring"],
    "config_file":    ["misconfiguration", "vulnerable-components"],
    "dep_manifest":   ["vulnerable-components"]
  }
}
```

`floor` applies to **every** hunt lane regardless of signals. Those three classes have no reliable
syntactic marker because the pattern is an *absence* — you cannot find "no rate limit" by searching
for a rate limit. `insecure-design` alone accounts for a substantial share of the benchmark.

Every class id must exist in `vuln-classes.json`. Validate that at startup and fail loudly if not.

---

## Part 3 — Stage 0.5: lookup, not inference

In `tools/scanner/stage05-lane-selector-perfile/`:

**Delete** the `switch (basis)` block, its per-basis code lists, the `determineCategoryBasis`
priority ordering, and the `category_basis` field. They are replaced entirely.

**Add** for each hunt lane:

```jsonc
{
  "lane_id": "file-0356",
  "target_file": "routes/basketItems.ts",
  "disposition": "hunt",
  "skip_reason": null,

  "signals": ["route_handler", "db_query", "model_write"],

  "classes": ["access-control", "api-property-auth", "resource-consumption",
              "injection", "integrity-failures",
              "insecure-design", "logging-monitoring", "general-catchall"],

  "class_basis": {
    "route_handler": ["access-control", "api-property-auth", "resource-consumption"],
    "db_query":      ["injection", "api-property-auth"],
    "model_write":   ["injection", "integrity-failures"],
    "floor":         ["insecure-design", "logging-monitoring", "general-catchall"]
  },

  "categories": [ /* ALL 26, exactly as today, UNCHANGED */ ],

  "file_bytes": 3514, "file_lines": 100,
  "estimated_prompt_tokens": 879,
  "chunk_plan": { /* unchanged */ }
}
```

`classes` is the union of every signal's classes plus the floor, deduplicated, sorted.

`class_basis` records which signal contributed what, so a wrong narrowing can be diagnosed from the
file without re-running anything.

**`categories` keeps all 26 codes, unchanged.** That is deliberate: the current Stage 2 still reads
it, so the file stays a valid input and nothing breaks the day this lands.

Skip lanes get no `signals`, `classes` or `class_basis`.

Top level gains `"signal_class_map": "tools/scanner/shared/signal-classes.json"` and
`"floor_classes": [...]` so the file is self-describing.

Everything else the selector does — one lane per file, hunt/skip, chunk plan, coverage ledger — is
untouched. The ledger invariant still holds: `assigned_hunt + assigned_skip == total_files_in_inventory`,
`unaccounted == 0`.

---

## Part 4 — Stage 2: prefer `classes`

In `tools/scanner/stage2-hunt-lanes-perfile/src/hunt-executor.ts`, where the lane's classes are
currently derived by collapsing `lane.categories` through the code→class index:

- when `lane.classes` is present and non-empty, use it
- otherwise fall back to collapsing `lane.categories` exactly as today

Log which path was taken, once, in the startup banner, with a count of lanes on each. Nothing else
changes — not the class enum, not `finding_classes`, not `categories` on findings, not the schema.

---

## Running it

Run **Stage 0** and then **Stage 0.5** to regenerate their outputs. This is intended for this task,
unlike previous briefs. Their output directories are listed in a `.gitignore` even though the files
are tracked, so a file search that honours ignore rules will not show them — read and write them by
path directly:

    tools/scanner/stage0-recon/output/
    tools/scanner/stage05-lane-selector-perfile/output/

**Do NOT run Stage 2.** No scan, at all.

## What must not change

- `tools/scanner/stage2-hunt-lanes/` and `tools/scanner/stage05-lane-selector/` — the v1
  components. Do not touch either.
- The vulnerability-class model: `vuln-classes.json`, `finding_classes`, the per-lane class enum,
  `categories` as the union of alias codes, `maxItems: 2`.
- Route context, the architecture-summary path handling, and the reporting-threshold wording in the
  prompt and the playbooks — all just landed.
- Chunking, concurrency, checkpointing, resume, retry, PEM sanitisation, budget tracking.

## Report back

Real numbers read from the regenerated files, not estimates:

- Distribution of **signals per file** across all 918 (how many files have 0, 1, 2, 3, 4+).
- Distribution of **classes per hunt lane** — the direct comparison against today's `{2: 7, 15: 546}`.
- The 10 most common signals by file count, and any signal that fired on **zero** files, which
  probably means its detector is broken rather than that the pattern is absent.
- The full lane entry for `routes/basketItems.ts`, `models/user.ts` and `routes/premiumReward.ts`.
- Confirmation the coverage ledger is unchanged: 918 = 553 hunt + 365 skip, 0 unaccounted.
- Estimated prompt-token change per lane from loading fewer playbooks.
- Anything you find that contradicts this brief.

## Constraints

Work only inside this repository. `target-apps/` is read-only. Never search for, read, or reference
any answer-key or ground-truth material anywhere on this machine.
