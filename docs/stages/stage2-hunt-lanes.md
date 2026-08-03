# Stage 2 — Hunt Lanes

Where vulnerabilities are actually found, and the only stage after Stage 0 that
calls a model. Its output, `candidate-findings.json`, is the pipeline's final
result — nothing downstream filters or reformats it.

Two implementations, both live. **v2 is the current track**; v1 is preserved
exactly and is not used for any current result.

---

## v2 — one lane per file (current)

`tools/scanner/stage2-hunt-lanes-perfile/src/`

| File | Role |
|---|---|
| `hunt-executor.ts` | Everything: prompt assembly, the lane agent loop, merge, concurrency, checkpointing, artifact writing |
| `llm-client.ts` | Provider client construction from the registry |
| `analyze-route-context.ts` | Route-context matching helpers |
| `types.ts` | `CandidateFinding`, `ChunkTokenRecord`, `LaneTokenRecordV2`, `BudgetConsumptionV2` |
| `playbooks/` | **14 modules**, one per vulnerability class |
| `loop.test.ts`, `test-breakdown.ts` | Loop-merge and prompt-breakdown tests |

Each lane is bound to exactly one file and hunts only that file's assigned
**classes**, loading only those classes' playbooks.

### The per-lane agent loop

**This is the defining feature of the current architecture and the change that
produced run 6's results.** Stage 2 is not one call per chunk. Each chunk opens a
conversation and takes at least two turns.

The arm is resolved by `shared/loop-config.ts` — deliberately in `shared/`, because
Stage 1 must project the same number of calls Stage 2 will execute.

| Mode | What the follow-up turn asks | Calls per chunk |
|---|---|---|
| `none` | nothing — single turn, what runs 1–5 executed | 1 |
| **`trace`** (default) | complete the path of every finding already reported | 1 + `passes` |
| `gap` | report instances of assigned classes not yet reported | 1 + `passes` |
| `reflect` | both, in that order | 1 + `passes` |
| `sweep` | *not* a follow-up — re-hunts the chunk in a fresh conversation per class group | 1 + ⌈classes ÷ group size⌉ |

Defaults: `HUNT_LOOP=trace`, `HUNT_LOOP_PASSES=1`, `HUNT_SWEEP_GROUP=3`.
`HUNT_LOOP_STRICT_TRACE=1` selects a stricter completion wording that was
**measured worse** (recall 66.0% → 52.6%) and is off by default.

Three properties of the loop that are easy to get wrong when reading the code:

- **The conversation is carried, not re-sent.** A follow-up turn appends the
  assistant's answer and a new instruction to the same message array. It does not
  rebuild the prompt, so the file, playbooks and context are paid for once.
  `followUpBreakdown()` attributes the carried transcript to a `conversation`
  segment rather than folding it into boilerplate.
- **An unproductive turn terminates the loop early.** After merging, if a turn
  added no finding and extended no trace, the remaining passes are skipped —
  `if (added === 0 && revised === 0) break`.
- **Nothing is ever removed.** `mergeFindings()` treats an incoming finding as a
  *revision* of an existing one when it shares a class and either kept its exact
  title or agrees on two cited lines; anything else is new. A revision adds lines
  the accumulated trace lacked and changes nothing else — no existing step loses
  its line, kind or position, because a trace may legitimately repeat a line or
  run backwards. The two-line floor matters: a shared class plus a *single* shared
  line is the ordinary shape of a different defect entering at the same place.

`sweep` is the exception to all of the above: it is a fresh prompt per class
group carrying only that group's playbooks, so it re-sends rather than continues,
and each group is recorded under its own `loop_mode` of `sweep:<a>+<b>+<c>` —
per-group cost and yield is the one question sweep exists to answer.

### Other v2 properties

- **Full file coverage.** Multi-chunk plans run one conversation per chunk. Line
  numbers shown to the model are the file's real line numbers in every chunk
  (`lineNumberContent()`), so cited locations stay correct past chunk 1.
- **Per-finding classes.** The output schema's class enum is built **per lane**
  from that lane's assigned classes (`buildHuntSchema()`), which makes an off-list
  label unrepresentable rather than silently rewritten.
- **Startup validation.** `validateAllPlaybooks()` runs before any lane: every
  class must resolve to a loadable playbook or the run exits non-zero listing what
  is missing. This replaced a `console.warn` that once let 12 of 16 modules be
  absent unnoticed.
- **Read guard.** File content is read through `readCorpusFile()`, not `fs`. This
  is the second line of defence behind Stage 0.5's denylist and is independent of
  it — either alone is sufficient. A refused read logs `[BLOCKED]` and the lane
  produces no findings rather than failing the run.
- **Incremental checkpointing.** `writeCheckpoint()` runs after *every* lane,
  success or failure. Added after a run died at lane 159 and lost ~3M tokens.
- **Bounded concurrency.** `HUNT_CONCURRENCY`, default **8**, enforced by an
  in-process semaphore. No budget ceiling is enforced — no lane is ever cut off
  for cost.
- **Retry.** Transient errors retry up to **5** times with exponential backoff
  capped at **60s** (2+4+8+16+32 = 62s, crossing a full TPM window). Raised from 3
  retries / 15s after a run lost 52 of 541 lanes to sustained rate limiting.
- **Resumable in bounded passes.** `HUNT_MAX_LANES=N` stops cleanly after N newly
  executed lanes, leaving a complete checkpoint, so a 541-lane run can be split
  across sittings when the transport has a rolling usage window. It is a clean
  stop rather than a kill precisely because in-flight lanes have already been
  billed.

### Resume semantics — the trap

**Stage 2 resumes from its own output directory.** `loadCheckpoint()` reads
`candidate-findings.json` + `budget-consumption.json`; lanes already present are
filtered out of the work list. Leaving a previous run's artifacts in place makes
the new run skip every lane and report success with stale findings, and the log
looks entirely normal. Clear them before launching — see
`../protocols/running-a-scan.md` §2.

Two things the resume path handles explicitly: failed lanes are dropped from the
carried-forward consumption so they are retried rather than counted twice, and
skip lanes are only appended once, because the reconcile pass keys its lane map
with `Map.set()` and a duplicate would silently overwrite rather than error.

### Failure reporting

A pass that lost lanes prints an `*** INCOMPLETE ***` block naming the failure
reasons and their counts, and states how many lanes the output actually covers.
The exit code is deliberately left at 0 — a bounded chunk stopping early is
normal here — so **failure is reported rather than signalled**. This was added
after a run printed "Complete" and exited 0 with 228 of 341 lanes failed.

---

## v1 — one lane per category theme (preserved, not current)

`tools/scanner/stage2-hunt-lanes/src/` — `hunt-executor.ts`, `llm-client.ts`,
`types.ts`, `playbooks/` (**18 files**, including the split
`injection-sql`/`injection-nosql`/`injection-code`, `ssrf-api` and
`general-catchall` modules that v2 consolidated).

Three phases: hunt, orchestrator review of scope requests and escalations,
approved second passes.

**Two defects that shaped v2:**

1. **Seed truncation.** Each seed file was cut at 15,000 characters before the
   prompt was built. The main server file is 2.7× that and was seeded to every
   lane, so all lanes read only its first ~37%. Five ground-truth entries were
   physically unreachable.
2. **Category inheritance.** `f.categories = lane.categories` assigned the lane's
   entire category list to every finding, and the prompt never asked the model to
   categorize its own finding. A finding titled as one class carried the labels of
   several others.

---

## Input (v2)

| Source | What |
|---|---|
| `stage05-lane-selector-perfile/lane-assignments.json` | lanes, dispositions, per-lane `classes`, chunk plans |
| `stage0-recon/architecture-summary.json` | arch snippet + the route table used for per-lane route context |
| `playbooks/` | one module per assigned class |
| the corpus | the lane's own file, via `readCorpusFile()` |

Stage 2 asserts its upstream belongs to the same provider (`assertUpstream()`) and
validates the coverage ledger and every chunk plan before running a single lane:
`unaccounted` must be 0, hunt + skip must equal the inventory, and each hunt
lane's chunks must start at line 1 and end at the file's last line.

## Output (v2)

`runs/<provider>/stage2-hunt-lanes-perfile/candidate-findings.json` — per finding:
`finding_id`, `lane_id`, `finding_classes`, `categories`, `title`, `description`,
`trace[]` of `{kind: entrypoint|propagation|sink, file, line, description}`,
`severity_estimate`, `confidence`.

A finding is **dropped** unless its trace is non-empty, starts with an
`entrypoint` step, ends with a `sink` step, and carries at least one class that
survives validation against the lane's assigned list.

`finding_classes` is one or more `{class, justified_by_step}` entries naming the
classes the finding belongs to, each pointing at the trace step that establishes
it. `categories` is the union of those classes' OWASP alias codes and always holds
code strings, never class ids — see `../architecture/vulnerability-class-model.md`.

`runs/<provider>/stage2-hunt-lanes-perfile/budget-consumption.json` — v2 shape:

- `lanes[]` — per lane: `chunk_count` (distinct chunks, **not** calls),
  `chunks[]`, `lane_totals`
- each `chunks[]` entry is **one model call**, carrying `prompt_breakdown`,
  `segment_attribution`, `measured` tokens, and — for a loop turn — `loop_pass`,
  `loop_mode`, `findings_emitted`, `findings_added`, `traces_extended`
- `rollup` — run-level aggregation
- `legacy_entries[]` — the v1-shaped per-lane list, always complete

`runs/<provider>/stage2-hunt-lanes-perfile/cli-usage.jsonl` — append-only per-call
ledger, written only by the `claude-cli` transport. It records every invocation
including ancillary calls the CLI makes on its own account, so those stay
separable from the scanner's own inference spend. Inert for HTTP transports.

`meta.json` records `loop_mode`, `loop_passes`, `sweep_group_size`, `sampling` and
`max_output_tokens` alongside the usual provider/model/`git_sha`/`blocked_reads`.
**The loop arm is an environment variable, so `git_sha` cannot distinguish two
runs of the same tree** — "verify the tree, not the intent" applies to runtime
configuration too.

## Prompt construction

Assembled in `buildHuntPrompt()`, which emits a segment list alongside the prompt
and **asserts the segments' character counts sum to the prompt length**, so token
attribution cannot silently drift from what was actually sent.

| Segment | Contents |
|---|---|
| `boilerplate` | task framing, target file, chunk-of-N header, assigned-class list |
| `playbook:<module>` | one segment per loaded playbook |
| `arch_context` | the architecture summary snippet (when present) |
| `route_context` | routes matched to this file (when present) |
| `file_content` | the line-numbered chunk |

Route context is computed **once per lane, not per chunk**. Two blocks may
appear: `renderRegistrarRouteContext()` for a file that *declares* registrations
(it carries line numbers, so it goes first) and `matchRoutesForFile()` for a file
that *exports* handlers, matched by exported-symbol name.

Playbook guidance describes vulnerability *shapes* only — no library or framework
APIs — so it applies equally to any language. Target-specific knowledge reaches a
lane solely through the architecture summary and route context, both generated
per run by recon.

File content is sanitized for PEM private-key material (`sanitizePemPrivateKey()`)
before assembly; a raw key blob once tripped an upstream content filter and
silently zeroed an entire lane. **A sanitizer that changes a file's line count
shifts every line below it**, which is invisible to a ±15-line window and fatal to
exact-line recall — an earlier version did exactly that and cost ~3 exact-line
hits in every run 1–5. There are regression tests on this; do not change the
substitution without them.

## Class model

Lanes carry `classes` directly from Stage 0.5's signal-based assignment. When a
lane predates that (only `categories`), the executor collapses its OWASP codes to
classes through the registry index. Either way the model chooses among **14
classes** rather than 25 partly-synonymous codes.

This replaced a defect that was the largest single contributor to the recall gap:
findings emitted exactly one code each, while ground-truth entries often carry
several and a single line can genuinely be two classes. Recall ignoring category
was 53.1% versus 31.6% with it. Full rationale, the two axes of multiplicity, and
why the class count is uncapped: `../architecture/vulnerability-class-model.md`.
The loop's own design rationale is in `../architecture/stage2-lane-loop.md`.
