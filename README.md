# Cybersecurity-Coding-Agent-Harness

An AI coding agent harness that scans a codebase for an entire class of
OWASP-categorized vulnerabilities, fixes every real instance of that class
at once, and proves two things about every fix: the exploit no longer
works, and the app's real functionality still works exactly as before.

## Dataset

The target is [OWASP Juice Shop](https://github.com/juice-shop/juice-shop),
a full-stack, deliberately vulnerable e-commerce app (Express/TypeScript
backend, Angular frontend) with ~113 documented vulnerability challenges
across the OWASP Top Ten.

## Blind development

Juice Shop is a *training* app — it embeds the exact vulnerable lines,
hand-authored correct fixes, working exploit payloads, and a "did you
solve it" oracle directly in its own source and tests. For any accuracy
number this project reports to mean anything, the harness has to find and
fix vulnerabilities on its own merit, not by reading the answer key.

So the repo is mechanically split into two things that never mix:

- **`target-apps/juice-shop/`** (this repo) — the working copy the harness
  actually scans, fixes, and tests against. The vulnerabilities are still
  there; only the markers that give them away are gone.
- **A separate private answer-key repo** — everything that was stripped
  out, used exactly once at final scoring, never touched during harness
  development.

See [`docs/BLIND_DEVELOPMENT.md`](docs/BLIND_DEVELOPMENT.md) for exactly
what was stripped, how, and the guardrail for future sessions: **no
harness-development session may open, read, or reference the answer-key
repo.**

## Status

This repo currently contains the blind/answer-key split (the working copy
plus the tooling that produced it). The scan → fix → verify harness itself
is future work.

