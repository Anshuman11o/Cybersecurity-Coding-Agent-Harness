# Prompts

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
