# CASTLE C target readiness

The public `Anshuman11o/castle-clean-c` corpus is pinned to
`4278a493c41b126e63eca2e03a9a54d231e065cc`. Its paired private
`Anshuman11o/castle-clean-answer-key` started at `4ab2594`; readiness updates are at private commit
`e6953cf` with ground truth 1.1.0. Record the full private scoring commit and
ground-truth version with each evaluation. Scoring
updates must preserve the frozen public hashes. Never copy private evidence into
this repository, the public target, or scanning prompts.

## Harness support

The target has 250 independent C programs and a Makefile, with no web routes.
Stage 0 recognizes C and headers, extracts C symbols, and detects C-specific
review surfaces. Patterns are generic public C/CERT C concepts, including string
and memory operations, allocation/lifetime, formats, shell commands, file paths,
SQL, randomness, signal handlers, threads and assertions. These are review
signals, not proof of a vulnerability; they narrow existing classes only.
Reference vocabulary: [CERT C](https://wiki.sei.cmu.edu/confluence/display/c)
(ARR, MEM, STR, FIO, ENV, SIG, CON) and the public
[CWE catalog](https://cwe.mitre.org/data/index.html).
Makefile is not a dependency manifest in the current inventory contract. Its
absence from the dependency map does not prevent source selection or hunt lanes.

The per-file selector treats C as executable. With no playbook-agent selection,
all eligible programs should receive a hunt lane even when there are no routes
or content signals, because the default class floor remains. Verify the inventory
and actual lane ledger before any paid run; expected count is 250 hunt lanes.
The generic routeless fixture exercises deterministic Stage 0 preparation and the
real selector. Live model-driven Stage 0/Stage 2 are not validated by that fixture.

### Categories and memory safety

There is no built-in memory-safety class. Accept category-blind scoring for
memory safety rather than forcing unrelated OWASP labels. The frozen corpus has
25 CWE types. Version 1.0.0 had 15 unmapped types and three provisional
mappings. Private review in 1.1.0 removed those three effect-only proposals,
leaving 18 types without a family/code. The export retains 262 evidence-line
entries, of which 77 carry directly mapped OWASP codes. Thus a
perfect category-blind result can reach 262/262, while category-aware recall over
the whole corpus has a ceiling of 77/262 (29.389%). Code/family comparability
changed; rescore earlier artifacts at the same key version before comparing. Report the current export's exact ceiling;
do not quietly remove unmapped entries from its denominator.

A future `memory-safety` class is an owner decision under productization plan
§2.4 and needs an appropriate playbook, output/scoring contract, and comparable
baseline. This change does not add a class or invent OWASP aliases for it.

## Launch later, in a blind environment

No paid scan or model API call is part of readiness. Run scans in a separate task
with only the public checkout and harness; private answer keys must not be
mounted or reachable. Resolve credentials and provider separately. Keep reports
outside the target and use a fresh run ID. The command below is a future launch
recipe, not an executed validation:

```sh
cd /path/to/Cybersecurity-Coding-Agent-Harness
unset SCANNER_PLAYBOOK_AGENT
export SCANNER_REPORTS_ROOT=/path/to/reports/castle
./tools/scanner/run.sh "$PROVIDER" all-v2 \
  --profile product --target /path/to/castle-clean-c --run-id castle-full-001
```

Use the built-in playbooks, reconcile usage, archive artifacts and record harness
SHA, target SHA, run profile, settings, class registry, inventory, lane ledger,
blocked reads, degradation and failed lanes. Stage 0 and Stage 2 need model access;
prevent unrelated network access and prefer a filesystem/network sandbox allowing
only the chosen inference destination (or no network with a separately brokered
inference transport). An ordinary online provider cannot run with all network
access disabled. Do not expose these intentionally vulnerable programs as services.

## Private scoring

Bring completed artifacts to a separate private scoring task. `KEY` below is its
private checkout; `RUN` is the provider's directory under the completed run.
Keep detailed outputs private; publish aggregates only.

```sh
python3 tools/scan-benchmark/score_scanner.py \
  --findings "$RUN/stage2-hunt-lanes-perfile/candidate-findings.json" \
  --answer-key "$KEY/benchmark-ground-truth.json" \
  --json-out "$PRIVATE_RESULTS/scanner-metrics.json"
python3 "$KEY/score.py" \
  "$RUN/stage2-hunt-lanes-perfile/candidate-findings.json" --level located \
  --public-checkout /path/to/castle-clean-c \
  --output "$PRIVATE_RESULTS/located-metrics.json"
python3 "$KEY/fp_score.py" \
  --findings "$RUN/stage2-hunt-lanes-perfile/candidate-findings.json" \
  --key "$KEY/ground-truth.json" --output "$PRIVATE_RESULTS/false-positives.json"
python3 "$KEY/reachability.py" \
  --inventory "$RUN/stage0-recon/file-inventory.json" \
  --lanes "$RUN/stage05-lane-selector-perfile/lane-assignments.json" \
  --key "$KEY/ground-truth.json" --output "$PRIVATE_RESULTS/reachability.json"
```

The shared scorer at this readiness base ignores alternate evidence lines and ranges; exports
retain `file` and `line` for compatibility. Alternate/range support is owned by
the parallel scorer session. Until integrated, each exported evidence line still
scores correctly at its primary line. A perfect synthetic result should attain
full category-blind recall and the mapped category-aware ceiling, not full
category-aware recall on unmapped entries.

## Headline metrics and contamination

Report exact-line category-aware recall and category-blind recall over all 262
marked lines, localization (±15) in both forms, and file-level hit rate over 150
vulnerable programs. Also report the share of the 100 clean programs with at least
one finding (false-positive rate), total findings landing on clean programs, and
findings per clean program. Do not confuse the shared scorer's evidence-entry
file-match rate with unique-program hit rate. Include precision proxy, hedging,
distinct cited lines, coverage, tokens, cost and failed/skipped lanes.

**Contamination exposure accompanies every number:** LICENSE/NOTICE necessarily
identify CASTLE and its author. Training exposure cannot be excluded; license
metadata remains visible. Recommend no browsing/network access to the corpus's
upstream or answer key and record actual inference-network constraints. No
benchmark quality numbers have been measured by this readiness task.

Compilation is optional for source scanning. Modern GCC requires compatibility
warning flags for several legacy conversions; one upstream program has an
undefined helper and cannot link. Keep that defect visible rather than changing
the corpus. The Makefile's syntax-check loop masks failures, so inspect compiler
results or use the private validator with the chosen compiler.

## Deterministic readiness evidence

The current source checkout produces 250 hunt lanes, zero skips and zero
unaccounted entries. The Juice Shop replay uses the archived category and route
context with freshly selected inventory, symbols and signals in both arms;
304 hunt + 580 skip = 884 entries. This is a deterministic current-contract
replay, not a reproduction of an old paid scan's lane count. Before/after signals
and normalized lane artifacts are byte-identical (only generated timestamp and
source-artifact pathname are excluded). Normalized lane SHA-256:
`38e2ab4b5de9c74b6644e83f99431021f61955d2bb3803dc884dfbc43d241675`.
The legacy v1 selector and hunt components are byte-identical to the base commit;
all preexisting signal registry fields, including other languages, are unchanged.
These are coverage checks, not vulnerability-detection results; the contamination
exposure described above still applies.
