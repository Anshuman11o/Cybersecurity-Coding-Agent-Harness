# Stage 2 — Hunt Lanes

Where vulnerabilities are actually found. Two implementations, both live.

## v1 — one lane per category theme
`tools/scanner/stage2-hunt-lanes/src/` — `hunt-executor.ts`, `llm-client.ts`,
`types.ts`, `playbooks/` (18 files).

Three phases: hunt, orchestrator review of scope requests and escalations,
approved second passes.

**Two defects that shaped v2:**

1. **Seed truncation.** Each seed file was cut at 15,000 characters before the
   prompt was built. The main server file is 2.7x that and was seeded to every
   lane, so all lanes read only its first ~37%. Five ground-truth entries were
   physically unreachable.
2. **Category inheritance.** `f.categories = lane.categories` assigned the
   lane's entire category list to every finding, and the prompt never asked the
   model to categorize its own finding. A finding titled as one class carried
   the labels of several others.

## v2 — one lane per file
`tools/scanner/stage2-hunt-lanes-perfile/src/` — same layout, 16 playbooks
covering all 26 category codes.

Each lane is bound to exactly one file and hunts only that file's assigned
categories, loading only those playbooks.

- **Full file coverage.** Multi-chunk plans run one pass per chunk. Line numbers
  shown to the model are the file's real line numbers in every chunk, so cited
  locations stay correct past chunk 1.
- **Per-finding categories.** The output schema requires `finding_category`
  chosen from that lane's assigned list.
- **Startup validation.** Every category code must resolve to a loadable
  playbook, or the run exits non-zero listing what is missing. This replaced a
  `console.warn` that once let 12 of 16 modules be absent unnoticed.
- **Incremental checkpointing.** Results are written after each lane and a
  restart resumes from the checkpoint. Added after a run died at lane 159 and
  lost ~3M tokens of completed work.
- **Bounded concurrency**, no budget enforcement, retry with backoff on 429s.

## Input
Architecture summary + lane assignments + playbooks + line-numbered file content.

## Output
`output/candidate-findings.json` — per finding: `finding_id`, `lane_id`,
`finding_classes`, `categories`, `title`, `description`, `trace[]` of
`{kind: entrypoint|propagation|sink, file, line, description}`,
`severity_estimate`, `confidence`. A finding is dropped unless its trace is
non-empty, starts with an entrypoint and ends with a sink.

`finding_classes` is one or two `{class, justified_by_step}` entries naming the
vulnerability classes the finding belongs to, each pointing at the trace step
that establishes it. `categories` is the union of those classes' OWASP alias
codes and always holds code strings, never class ids — see
`docs/architecture/vulnerability-class-model.md`.

`output/budget-consumption.json` — per lane tokens, seconds, `ceiling_hit`.

## Prompt construction
Assembled in `buildHuntPrompt()`. Playbook guidance describes vulnerability
*shapes* only — no library or framework APIs — so it applies equally to any
language. Target-specific knowledge reaches the lane solely through the
architecture summary, which recon generates per run.

Seed content is sanitized for PEM private-key material before prompt assembly;
a raw key blob once tripped an upstream content filter and silently zeroed an
entire lane.

## Category model
Lanes are assigned OWASP codes; the executor collapses those to vulnerability
classes before loading playbooks or building the prompt, so the model chooses
among ~15 classes rather than 26 partly-synonymous codes. The class enum is built
per lane, which makes an off-list label unrepresentable rather than silently
rewritten.

This replaced a defect that was the largest single contributor to the recall gap:
findings emitted exactly one code each, while ground-truth entries often carry
several and a single line can genuinely be two classes. Recall ignoring category
was 53.1% versus 31.6% with it. Full rationale, the two axes of multiplicity, and
why the class cap is two: `docs/architecture/vulnerability-class-model.md`.
