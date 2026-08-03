# Prompts

Two kinds, deliberately separated.

## `dispatch/`

Task prompts sent to the implementing agent (Qwen Code) to build or run
something. Named `<YYYY-MM-DD>__<short-description>.md`.

These are kept because they are the record of *what was asked for*. When a
component behaves unexpectedly, the first question is usually whether it was
built to do that — and the answer is here.

Previously these lived only in an ephemeral scratchpad and were lost when a
container was reclaimed. Anything dispatched should be saved here.

## `runtime/`

Prompt templates the scanner itself sends during a scan — the hunt-lane
template, recon probes, playbook guidance.

These are part of the architecture, not a convenience. A change here changes
scan results as surely as a code change does, so they belong under version
control alongside the code.

Note: most runtime prompt text currently lives inside the TypeScript source
(for example the playbooks under `tools/scanner/stage2-hunt-lanes-perfile/src/playbooks/`).
This directory is for templates extracted from source, and for documenting the
assembled shape of a prompt.

## Constraint

No prompt may contain identifiers, file names, or hints specific to the codebase
being scanned. Target-specific knowledge reaches a lane only through the
architecture summary that recon generates per run.
