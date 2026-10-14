# Solidity benchmark readiness

Public target: `Anshuman11o/smartbugs-clean-solidity` at `6d09946` (143 standalone
Solidity source units). Private scoring snapshot: `Anshuman11o/smartbugs-clean-answer-key`
at `1aae231`, with readiness export, reachability and compiler validation
committed at `373aaf7`. Record the full target,
harness and private key SHAs with each run. Do not mount the private key in a scan
environment.

## Harness support

Stage 0 already maps `.sol` to `solidity`; the per-file selector treats Solidity
as executable. Neither HTTP routes nor a dependency manifest is required. A
synthetic manifest-less, routeless fixture exercises the actual Stage 0
orchestrator with all credentials removed, checks zero model calls and its
explicitly degraded deterministic fallback, then runs the actual selector.
This validates wiring, not live model recon or scan accuracy.

The generic Solidity `sink_patterns` member covers value-bearing calls (modern
and historical syntax), transfers, delegate calls, contract destruction,
origin-based authorization, block metadata in conditions or randomness,
unchecked low-level call surfaces, legacy arithmetic, public/external function
headers without custom modifiers, and assembly. These are surface heuristics,
not vulnerability verdicts: a checked low-level call still raises a signal,
and a missing custom modifier does not prove missing authorization. Empty arrays
define content signals with no Solidity equivalent, such as HTTP clients and
HTML sinks. Function entries use the existing `route_handler` signal without
inventing HTTP routes. JS/TS detectors, v1 components, class mappings and the
built-in class registry are unchanged.

Generic references: [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html),
[breaking changes in 0.8](https://docs.soliditylang.org/en/latest/080-breaking-changes.html),
and the [SWC registry](https://swcregistry.io/). The SWC registry is historical
guidance, not a complete current security checklist.

## Classes and metrics

Use category-blind scoring for the headline comparison. Findings retain the
existing classes and their category strings so the standard scorer can read
them; do not force a contract finding into a web class just to earn a category
match. Adding a dedicated smart-contract class and playbook would require the
owner's §2.4 class/playbook decision and is not implemented here.

Report exact-line category-blind recall over 207 entries, category-blind
localization, and file-level hit rate. Report both the scorer's entry-weighted
file match rate (207 entries) and distinct source-file coverage (143 files),
which have different denominators. Keep category-aware exact recall as a
diagnostic: the OWASP mapping is approximate, with five contract types sharing
A04. The standard ±15-line localization window is close to file-level matching
for short contracts. Also report distinct lines cited, trace density, precision
as a lower bound (labels are incomplete), hedging, completed lanes, tokens,
cost, and any failed or skipped lanes. Multi-line evidence is a set of explicit
labelled lines, not permission to count the entire enclosing function.

**Contamination exposure:** the license NOTICE identifies SmartBugs Curated;
the original contracts and labels are public and widely used. State this next
to every reported number, including synthetic checks and coverage ceilings.
Run target analysis without network access or external source lookup. Model
transport must use the authorized inference route; prohibit research/source
egress rather than accidentally preventing the required inference request.

## Launch (future authorized scan only)

Run in a separate blind environment with only the harness and public target.
Configure the selected provider securely, choose the budget independently, and
keep reports outside the target. This preparation does not run these commands.
From the harness root, with `TARGET`, `REPORTS`, `RUN_ID`, and `PROVIDER` set:

```bash
export SCANNER_REPORTS_ROOT="$REPORTS"
unset SCANNER_PLAYBOOK_AGENT
for stage in stage0-recon stage05-lane-selector-perfile stage1-budget-governor-perfile stage2-hunt-lanes-perfile reconcile-v2; do
  ./tools/scanner/run.sh --profile product --target "$TARGET" --run-id "$RUN_ID" "$PROVIDER" "$stage" || break
done
```

Inspect artifacts and exit statuses between stages; a degraded recon is not a
successful live scan. Use a new run ID, preserve existing runs, and freeze the
final artifacts before private scoring. For a budgeted invocation add the
documented `--max-cost` limit; do not use the product CLI here, which enables the
playbook agent. Follow the running-a-scan and eval protocols for archival.

## Private scoring

Only after the blind run is complete, in a private evaluation environment set
`KEY` to the private checkout and `FINDINGS` to its frozen findings. Keep every
located output in private storage:

```bash
python3 tools/scan-benchmark/score_scanner.py --findings "$FINDINGS" \
  --answer-key "$KEY/benchmark-ground-truth.json" --json-out "$REPORTS/scorer-metrics.json"
python3 "$KEY/score.py" "$FINDINGS" --level located --line-slack 0 \
  --public-checkout "$TARGET" --output "$REPORTS/contract-exact.json"
python3 "$KEY/reachability.py" \
  "$REPORTS/runs/$RUN_ID/$PROVIDER/stage0-recon/file-inventory.json" \
  "$REPORTS/runs/$RUN_ID/$PROVIDER/stage05-lane-selector-perfile/lane-assignments.json" \
  --output "$REPORTS/reachability.json"
```

The private scorer checks the pinned public checkout and preserves evidence-line
matching. Use its `METRICS.md` to interpret results and distinguish distinct-file
coverage from entry-level scores. `alt_lines` and `line_end` export compatibility
depends on the generic scorer version; older scorers retain primary-line
compatibility but do not credit alternative evidence. Publish aggregates only.

## Deterministic verification

From `tools/scanner/stage0-recon`, run:

```bash
npx --no-install tsx src/signals.test.ts
npx --no-install tsx --test src/solidity.test.ts
```

The preparation also ran every existing Stage 0 test and the shared, CLI,
playbook-agent, budget and per-file hunt suites. The v1 component directories
are byte-identical to the branch base. Replaying the per-file selector against
the same archived Juice Shop recon signals and current deterministic inventory
produced identical normalized manifests: 884 inventoried files, 301 hunt, 583
skip, zero unaccounted. Only run timestamps were excluded from comparison.
This is frozen-input replay equality; a fresh recon will intentionally detect
Solidity surfaces in embedded contract snippets differently. No JS/TS detector
or existing language pattern changed.

Deterministic target preparation assigned all 143 Solidity files to hunt lanes,
with no skips or unaccounted files. Private reachability covers all 207 entries;
primary-line perfect synthetic findings score 207/207. All 143 cleaned and all
143 original sources compiled under their recorded versions, with no paired
success/error-kind differences. These are preparation checks, with public-data
contamination exposure, not measured scan accuracy. Live Stage 0 and Stage 2
remain unverified, and alternative-line credit awaits the parallel generic
scorer update.
