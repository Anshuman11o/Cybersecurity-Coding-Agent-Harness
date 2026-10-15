# CASTLE C target readiness

The public `Anshuman11o/castle-clean-c` corpus is pinned to
`4278a493c41b126e63eca2e03a9a54d231e065cc`. A private answer key exists. Record its scoring version with each evaluation. Scoring
updates must preserve the frozen public hashes. Never copy private evidence into
this repository, the public target, or scanning prompts.

## Harness support

The target has 250 independent C programs and a Makefile, with no web routes.
Stage 0 recognizes C and headers, extracts C symbols, and detects C-specific
review surfaces. Patterns are generic public C/CERT C concepts, including string
and memory operations, allocation/lifetime, formats, shell commands, file paths,
SQL and randomness. Assertions, signal handlers and thread calls remain covered
by the default insecure-design floor; they are not authentication or logging
signals. Permission checks such as access() still narrow access-control classes. These are review
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
memory safety rather than forcing unrelated OWASP labels. The corpus needs two distinct denominators: record recall (150 vulnerable
programs) and literal marked-line recall (262 lines). The shared scorer's
alternate anchors represent equivalent locations within a record; they must not
be repeated on one export entry per line. Use a per-record export for the shared
scorer and the private located scorer for literal marked-line metrics. Keep
category-blind and category-aware results separate, and state the key version
and current category ceiling rather than forcing OWASP labels on memory errors.

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

The shared scorer supports alternate anchors and ranges. Use one ground-truth
entry per vulnerable record, with sparse alternate marked lines. For exact
marked-line recall use the private located scorer, which evaluates every mark
independently. A record-anchor hit must not be reported as every line being hit.

## Headline metrics and contamination

Report primary/alternate-anchor record recall over 150 vulnerable records from
the shared scorer, with category-aware and category-blind forms kept separate.
Report literal exact-line recall over 262 marks, localization (±15 lines), and
unique-program file hits from the private located scorer. Also report the share
of the 100 clean programs with at least one finding, findings landing on clean
programs, and findings per clean program. Include key/scorer versions, precision
proxy, hedging, distinct cited lines, coverage, tokens, cost and failed lanes.

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

The public source checkout produces 250 hunt lanes, zero skips and zero
unaccounted entries. Mean distinct classes per hunt lane changed from 5.42 to
5.32. The Juice Shop replay uses identical archived category/route context and
freshly selected inventory, symbols and signals in both arms; 306 hunt + 580
skip = 886 entries on the current base. Its signals and normalized lanes are
byte-identical; only timestamp and source-artifact pathname are excluded.
This is a deterministic replay, not a new paid scan. The v1 selector/hunt
components and all non-C signal-table fields are unchanged from the base.

C signal fire rates below are over all 250 public files, with no vulnerable/clean
labels read or used. The largest is 46.8%; none exceeds 80%. These patterns
identify review surfaces, not defects. Memory/input functions are deliberate
review surfaces, while general declarations, arithmetic and routine printf calls
with literal formats do not add a signal. Assertions, signal handlers and pthread
calls have no honest auth/logging signal in the existing map and are omitted;
the generic insecure-design floor still applies.

| C signal | Files | Fire rate |
|---|---:|---:|
| route_handler | 0 | 0.0% |
| db_query | 21 | 8.4% |
| model_schema | 0 | 0.0% |
| model_write | 6 | 2.4% |
| http_outbound | 5 | 2.0% |
| auth_check | 3 | 1.2% |
| crypto_op | 20 | 8.0% |
| html_sink | 17 | 6.8% |
| dynamic_exec | 13 | 5.2% |
| deserialize | 117 | 46.8% |
| file_io | 42 | 16.8% |
| llm_call | 0 | 0.0% |
| logging | 74 | 29.6% |

Every registered language (including C and Terraform) runs every pattern against
12 adversarial 200 KB shapes, with a 200 ms limit per pattern/input. A child
process timeout prevents a runaway regex from hanging the suite. Call-argument
patterns have explicit delimiter and length bounds; they intentionally miss
expressions longer than those limits rather than scanning an unbounded tail.
The C worst case measured 3.5 ms, and the all-language worst measured 24.3 ms.
The previous memory pattern took 22.5 seconds on a 1.2 KB comma list. These are
local timing/coverage checks, not vulnerability-detection results; the attribution
and contamination exposure above still applies.
