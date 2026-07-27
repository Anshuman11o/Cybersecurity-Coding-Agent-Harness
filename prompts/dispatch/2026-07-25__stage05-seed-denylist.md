One small, precise fix -- nothing else. Do not re-run the full pipeline, do not touch any other file's logic.

Add a permanent seed-file denylist to tools/scanner/stage05-lane-selector/src/lane-selector.ts (wherever lane seed_files lists get finalized before being written to output/lane-manifest.json).

The following files must NEVER appear in any lane's seed_files, regardless of what recon's evidence-gathering or the orchestrator's category-check pass decides:
- models/challenge.ts
- lib/antiCheat.ts
- data/datacreator.ts

Reasoning (for your own context, not needed in code comments): these are internal bookkeeping/infrastructure files (challenge tracking schema, anti-cheat detection, product data seeding) with no exploitable application logic of their own -- they were never meant to be scanned, and reading them is undesirable for reasons outside this task's scope. Just implement the exclusion as a flat denylist filtered out of every lane's seed_files array right before the manifest is written, applying uniformly to every lane, not category-specific.

Verify: after your change, run the existing lane-selector against the current recon output and confirm none of these 3 paths appear anywhere in output/lane-manifest.json's seed_files arrays. Report back with a simple confirmation (grep result showing zero matches) -- this is a small mechanical change, no need for a long report.

CONSTRAINTS (same as always): only this repo; target-apps/juice-shop-blind/ is read-only; never search for or reference any answer-key/ground-truth material anywhere on this machine.
