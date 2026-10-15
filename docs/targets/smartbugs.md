# Solidity benchmark readiness

Public target: `Anshuman11o/smartbugs-clean-solidity` at `6d09946` (143 standalone
Solidity source units). A private answer key exists; keep it outside the scan
environment. Record the full public-target and harness SHAs with every run.

## Harness support

Stage 0 already maps `.sol` to `solidity`; the per-file selector treats Solidity
as executable. Neither HTTP routes nor a dependency manifest is required. A
synthetic manifest-less, routeless fixture exercises the actual Stage 0
orchestrator with all credentials removed, checks zero model calls and its
explicitly degraded deterministic fallback, then runs the actual selector.
This validates wiring, not live model recon or scan accuracy.

Solidity sink patterns and their structural checks apply only to the **product**
profile, using the same run-profile boundary as file selection's Terraform and
key-material surfaces. Benchmark runs retain the original Solidity detector
path, including Juice Shop's embedded snippets. The extension/inventory mapping
is unchanged in both profiles.

The generic checks cover value-bearing calls, unchecked bare `send` statements,
transfers, delegate calls, destruction, origin-based authorization, block
metadata, assembly, and address-keyed mappings. Contract/struct declarations do
not raise a schema signal. `route_handler` identifies payable or caller-fed
storage/value entries without a custom modifier or recognized caller guard;
pre-0.5 functions without visibility are treated as public. Constructors,
read-only functions, local shadows, immediate reverts and zero-value-only
payable entries are excluded. Sender/origin checks are recognized as guards;
this does not imply that origin-based authorization is safe.

Legacy arithmetic uses separate lexical pragma and bounded arithmetic checks.
It flags unguarded, assertion-free updates to existing storage using a direct
caller-controlled numeric operand under a pre-0.8 pragma. Loop counters, pure
helper math, mapping-key-only inputs and fresh computed assignments do not
raise that arithmetic signal. Bounds and delimiter pairing avoid whole-file
regex backtracking. These are conservative lexical heuristics, not full type,
inheritance or control-flow analysis; casts, indirect dataflow and complex
modifiers still need the hunt. `(?!)` marks regex signals without a Solidity
analogue or supplied entirely by the structural pass. JS/TS detectors, v1
components, existing pattern keys, class mappings and built-in classes remain
unchanged.

Generic references: [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html),
[breaking changes in 0.8](https://docs.soliditylang.org/en/latest/080-breaking-changes.html),
and the [SWC registry](https://swcregistry.io/). The SWC registry is historical
guidance, not a complete current security checklist.

## Classes and metrics

Use category-blind scoring for headline comparisons. **Harness output cannot
get a smart-contract type match: the harness has no such class or corresponding
type labels. Exact-type recall is structurally 0 until that class exists.**
Existing web/API classes must not be interpreted as smart-contract types.
Adding a dedicated class and playbook requires the owner's §2.4 decision and is
not implemented here. Category-aware OWASP scores remain diagnostics, while
exact-line category-blind recall, category-blind localization and file-level
hit rates are the headlines.

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

Fresh deterministic Stage 0 (credentials removed, zero model calls) and the
actual per-file selector were run on main `9eb2c82` and this branch. Juice Shop
used the benchmark profile: file signals and lane manifests were identical
with only run timestamps removed (884 inventory, 301 hunt, 583 skip, zero
unaccounted). No archived recon signals were used. The v1 component directories
and every existing sink-pattern member remain identical to main.

The public Solidity target used the product profile: 143 hunt lanes on both
main and this branch, no skips or unaccounted files. Mean classes per hunt lane
changed from **3.363636 on main to 8.237762**. These are structural measurements
on a contamination-exposed public corpus, not scan accuracy.

| Solidity signal | Contracts | Fire rate |
|---|---:|---:|
| `route_handler` | 114/143 | 79.72% |
| `db_query` | 0/143 | 0.00% |
| `model_schema` | 66/143 | 46.15% |
| `model_write` | 111/143 | 77.62% |
| `http_outbound` | 0/143 | 0.00% |
| `auth_check` | 68/143 | 47.55% |
| `crypto_op` | 54/143 | 37.76% |
| `html_sink` | 0/143 | 0.00% |
| `dynamic_exec` | 87/143 | 60.84% |
| `deserialize` | 0/143 | 0.00% |
| `file_io` | 0/143 | 0.00% |
| `llm_call` | 0/143 | 0.00% |
| `logging` | 19/143 | 13.29% |
| `config_file` | 0/143 | 0.00% |
| `dep_manifest` | 0/143 | 0.00% |

No signal exceeds 80%; no universality exception is needed. Every Solidity regex
is tested separately on adversarial 200 KB inputs with a 200 ms limit, including
long pragma-only inputs and unterminated lines/options/conditions. The lexical
structural pass is separately timed and all language tables retain the existing
1 MB stress checks. No model preflight, paid scan or live hunt ran.
