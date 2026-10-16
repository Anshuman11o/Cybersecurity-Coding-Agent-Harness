# Recon-guided playbook agent (Mode A)

An optional stage adds guidance for vulnerability families recon detects that
the fourteen built-in playbooks do not cover. The built-ins remain immutable.

```mermaid
flowchart LR
    Recon[Stage 0: recon] --> Agent[Playbook agent: coverage + cached/web guidance]
    Agent --> Classes[Stage 0.5: deterministic class assignment]
    Classes --> Estimate[Stage 1: deterministic estimate]
    Estimate --> Hunt[Stage 2: hunt]
    Hunt --> Report[Run record / report]
    Cache[(Run-scoped playbook cache)] <--> Agent
    Cache --> Estimate
    Cache --> Hunt
```

## Use

Run `tools/scanner/install.sh` from the repository root to install the new
package along with the existing stages. Enable it for a product scan:

```bash
cd tools/scanner/cli
SCANNER_PLAYBOOK_AGENT=1 npm run secscan -- scan /path/to/target
```

The registry supplies the model, endpoint, credential name and token settings.
The product default is `luna6` (GPT-6 Luna); the lab default and previous model
entries retain their identities. This model is unmeasured on the benchmark.
Pricing uses the registry's verified token, cache-write and web-search rates,
service-tier, regional and long-context settings from Task 2a.

`SCANNER_PLAYBOOK_ALLOWED_DOMAINS` is an optional comma-separated list of search
domains. Its empty default sends no filter. Values are passed directly to the
Responses `web_search` tool's `filters.allowed_domains`. The agent chooses its
own queries; there is no query filter or enforced source allowlist.

The stage is opt-in per productization plan §3.4. It runs between recon and
class assignment in the CLI and in `run.sh ... all-v2` when enabled. For an
already prepared recon run it can also be called explicitly:

```bash
tools/scanner/run.sh --target /path/to/target --run-id RUN_ID luna6 stage-playbook-agent
```

Coverage and any web research run before the existing hunt confirmation, and
are billed by the selected provider. Each attempt appends to Task 2a's shared
spend ledger as well as this stage's usage artifact; the estimate and live hunt
gate include that spend. Requests pin recon's observed service tier, use the
shared pricing functions, and book conservative reservations when usage is
missing. Unsupported
Responses/web-search providers fail explicitly. No alternate model is selected
silently. No full scan or paid call was used to test this implementation.

## Decision and cache

`guidance.md` is loaded at runtime. A strict structured coverage call receives
the architecture, languages, frameworks, manifest section of recon's repo map,
file signals and counts, category applicability, built-in text and registry,
signal mappings, and available cached classes. It offers the Responses
`web_search` tool (`tool_choice: 'auto'`, with any configured domain filter):
the model searches when it judges the built-ins leave a surface recon shows
uncovered, and no search is required. The model returns a reason, the selected
built-ins and zero or more additional class definitions. Every class carries at
least one code; the text is free-form, stored as the model wrote it, and passes
through all stages to findings unchanged.

A code-driven loop of review turns follows that initial decision:

| Purpose | Runs | Asks the model to |
|---|---|---|
| `turn1` | once | reconcile each excluded built-in with recon's evidence; propose classes for surfaces no built-in covers |
| `turn2:pass<N>` | up to `SCANNER_PLAYBOOK_LOOP_PASSES` (default 3) | reconsider every class not selected; the loop stops at the first pass that adds no class id |
| `turn3` | once | check that every surface recon describes is covered and each additional class is distinct |

Each turn is a decision call like the first, with web search available, and
returns the same schema plus `changes` (`{ id, why }` per addition). Every
decision call's input starts with the same object (recon, signal counts,
signal mappings, built-ins, cached classes) so the calls share a cacheable
prefix; a turn appends the union decision so far and the queries and sources
of every earlier decision call. `SCANNER_PLAYBOOK_LOOP=0` skips the turns and
runs the initial call only; any other value, or none, keeps them.
`SCANNER_PLAYBOOK_LOOP_PASSES` must be a positive integer; any other value fails
the stage before any model call. The purposes above, with `coverage` and
`research:<class-id>`, label each call in `usage.json` and the spend ledger.

Turns can only add classes, and code enforces it. Each turn's output is
validated like the initial decision, then merged as a union: built-ins by id,
keeping the first reason; additional classes by id, keeping the first
definition (framework, codes, signals, reason), so a later turn cannot redefine
one. A class a turn omits stays selected and is listed in that turn's
`restored`. The decision's `reason` is the latest turn's.

Each uncached class in the final decision then gets a Responses call with
`web_search` (required) and a strict playbook schema. It returns a plain-text
playbook in the built-in format plus source URLs. The caller captures queries
from `output[].action.queries`.

Citing source URLs is optional. Every URL the output cites is kept as cited, in
order, in `source_urls`, which may be empty; no cited URL is a reason to fail.
Each is labelled against that call's own search sources:
`verified_source_urls` holds the well-formed http(s) URLs found among them,
`unverified_source_urls` every other cited URL, including malformed ones. The
research progress line reports `unverified=<n>`. The call must still perform a
web search, and the playbook must still pass the format, section and size
checks; a failure writes `research-failures/<class-id>.json` (which lists any
cited URL absent from the search as information) and stops the stage.
Within one run (its resume and round-two review included), matching cached
entries are reused instead of being researched again; a new run starts with an
empty cache, so it assesses coverage and researches afresh. Cached definitions
keep their original codes and signals together with their text; changing
coverage cannot relabel an old entry.

The decision calls also select the built-in classes that apply
(`builtin_classes`, each with a reason). The final union's selected built-ins
plus its additional classes are the run's complete class set, recorded as
`selected_classes` in the plan and written to `class-selection.json`. When that
file exists, Stage 0.5 runs in agent mode: no floor classes; each hunt lane gets
the selected classes its file's signals reach; an added class whose
`framework` names a file language (a Stage 0 language id such as `c`,
`solidity` or `kotlin`, or an alias in `FRAMEWORK_LANGUAGE_ALIASES` in
`shared/lane-languages.ts`: `android` -> kotlin and java, `c/c++` and `c++` ->
c and cpp, `evm` and `ethereum` -> solidity) is also added to every hunt lane in
that language (`class_basis['language-wide']`); selected classes no
hunt-eligible file reaches are added to every hunt lane
(`class_basis['selection-unrouted']`); a lane left with no class is skipped.
A lane that hunts only because of its language's added classes is marked
`class_basis['language-base']` (rescued from the skip). Added classes with any
other framework keep signal-only routing. Without the file, Stage 0.5 output is
unchanged.

The cache lives at `<runsRoot>/playbooks/<class-id>/<framework>/<model>/`
(`cacheRoot()` in `shared/playbook-cache.ts`), so it is scoped to one run. In
the product profile `runsRoot` is `<reports>/runs/<run-id>` (or
`SCANNER_RUNS_ROOT` when set); a resumed run has the same run id and finds its
own entries, and no other run can see them. Lifetime: the playbook agent
removes the cache when it starts unless the run is resumed
(`SCANNER_RESUME=1`, which `secscan scan --resume` and `run.sh --resume` set);
the CLI removes it once the run record and report are written, unless the run
is INCOMPLETE: `--resume` accepts any INCOMPLETE run (with or without a
`resume_command`), so the cache stays for that resume. The
benchmark's runs root is shared between runs and never resumes, so the agent
clears it at every start. A new (not resumed) CLI scan also removes a
`<reports>/playbooks` folder left by versions that shared one cache across
runs. The model path segment is percent-encoded. Each entry
contains `playbook.md` and `meta.json` with the cited source URLs and their
verified/unverified labels (absent from entries cached before labelling, which
still load), sha256 of the UTF-8 text, creation time, model, queries, class codes, and signal mappings. Cache
publication is atomic; existing entries are immutable. Missing or mismatching
hashes stop loading rather than silently supplying different guidance.

## Artifacts and hooks

`runPath(provider, 'stage-playbook-agent')` contains:

- `playbook-plan.json`: the final union decision and its reason, whether any
  call searched, new classes and signal mappings, cache hits, all consulted
  playbooks with hashes and sources (an agent playbook's record carries the
  same verified/unverified labels as its cache entry). `turns` holds one entry per review turn
  (purpose, the ids the union `added` and `restored`, the model's `changes`,
  and the turn's search count, queries and sources); `loop` records
  `enabled`, `max_passes` and `passes_run`.
- `classes-overlay.json`: class-ID dictionary in the shipped registry's
  `playbook`/`codes` format, extended with `signals`, `framework`, `model`,
  and `sha256`. Built-in replacements and unknown signals are rejected.
- `class-selection.json`: the run's complete class set — selected built-in
  ids, additional class ids, and their sorted union. Stage 0.5 validates it
  against the shipped registry and the overlay before using it.
- `usage.json`: one entry per Responses request, including failures and
  incomplete responses, input/output, cached input, cache writes, reasoning
  tokens, search calls, query strings and sources. Usage is written before
  response validation. SDK automatic retries are disabled so requests are not
  hidden. Calls also append to `shared/ledger.ts`, which became available with
  Task 2a, so recon, playbook research and hunting share one spend total.
- `meta.json`: normal stage provenance; failed attempts cannot leave a
  previous overlay with successful provenance.

Stage 0.5 deterministically extends the signal tables when an overlay exists;
absent or empty overlays retain the shipped output. Its existing file selection
and skip rules still apply, including config/test files. Stage 1 adds cached
playbook lengths to the estimate. Stage 2 loads cached plain text for added
classes, includes their codes in findings, and records the guidance supplied
to lanes in `playbooks-used.json`. The CLI copies those records (or the agent
plan before hunting starts) to `run-record.json.playbooks`. Built-in records
have a repository source path and text hash; their web-source list is empty
because the original built-ins do not declare web sources.

## Tests

```bash
cd tools/scanner/stage-playbook-agent
npm ci
npm test
```

All model and web responses are mocked. The suite uses synthetic recon fixtures
and temporary caches/targets, including a one-file deterministic Stage 0.5 run
and import-only Stage 2 loading; it never launches recon or a hunting model.
