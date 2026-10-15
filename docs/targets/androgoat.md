# AndroGoat target readiness

Signal-measurement baseline: `Anshuman11o/androgoat-clean-mobile` at
`eb460fe0561e3c55dcb1ebe2c859663a5c5757bd`. The private baseline release was
`1.1.0` at `fd6107b`. Final name/history cleanup will be frozen by private release
`1.1.1`; use its `public_commit` and hashes when scanning/scoring, rather than
these historical measurement pins. Public history replacement invalidates old
checkout pins even when the runtime behavior is retained.

The public application uses Kotlin and Android XML. Kotlin content signals
cover Android components, SQLite, WebView, storage and clipboard APIs,
cryptography and trust callbacks, process execution, and logging. Signals
identify surfaces to inspect; they do not prove a vulnerability.

The per-file selector hunts Android platform manifests and `res/xml` resources,
including qualified resource directories. Those files independently define
component access, network trust, backup and file-sharing policy. Layouts and
value resources remain skipped: their security meaning depends on the consuming
UI code. This is a deliberate coverage limitation, not grounds to remove entries
from the scoring denominator. Other XML remains skipped. Existing byte, empty,
test and blind-read exclusions still take precedence.

Manifest component/deep-link extraction into Stage 0 entry points is not added
in this change. Component signals and manifest hunting do not establish a
complete Android call graph or runtime reachability.

Generic references:
- [Android application manifest](https://developer.android.com/guide/topics/manifest/manifest-intro)
- [Network security configuration](https://developer.android.com/privacy-and-security/security-config)
- [Android security risks](https://developer.android.com/privacy-and-security/risks)
- [OWASP MASVS](https://mas.owasp.org/MASVS/)
- [OWASP MASTG](https://mas.owasp.org/MASTG/)

## Run and score

Run in a blind task with only the harness and public target available. Keep the
private answer key and any original/rejected history out of that task. Verify
all commits and archive previous run artifacts before launching. Choose a
configured provider and an explicit budget. The following command calls model
APIs and is documented here only; readiness checks make no such calls.

```bash
cd /workspace/Cybersecurity-Coding-Agent-Harness
export SCANNER_REPORTS_ROOT=/workspace/androgoat-reports
bash tools/scanner/run.sh --target /workspace/androgoat-clean-mobile \
  --profile product --run-id androgoat-v1-1 --max-cost "$SCAN_BUDGET" \
  "$SCANNER_PROVIDER" all-v2
```

The external target requires the product profile. Reports must be outside it.
After the full run completes, take its immutable artifacts to a private scoring
task. Export the matching release's benchmark ground truth and use the common
scorer's ground-truth argument. Report category-aware and category-blind exact,
localization and file metrics, precision proxy, hedging, coverage, and usage.
Keep located results private. A deterministic reachability ceiling is an upper
bound on coverage, not measured scan recall.

## Deterministic regression evidence

Replayed the archived Juice Shop per-file signal inventory (865 paths) through
latest main and this branch, reconstructing the v3 inventory envelope from those
exact paths and the public corpus's file metrics. Both runs produced 541 hunt
and 324 skip lanes with zero unaccounted files. Complete lane artifacts were
identical after removing `generated_at` and normalizing the two checkout-specific
path fields (`target_dir`, `source_stage0_run`). Canonical SHA-256:
`3dcebf5c0321a77bd860dc337026fdae01c0987de82bc5cd95b150c59b852e1b`.
All non-Kotlin patterns and both v1 component directories equal main.

All scanner suites passed: shared 16, CLI 52, report 47, playbook agent 75,
budget 28, per-file hunt 29, recon 29, selector 2: **278 test-runner cases**,
plus the suites' internal assertions. No model calls were made.

Synthetic Kotlin tests reject imports, type mentions and helper names as entry
points. Component declarations (including primary constructors) and lifecycle
callbacks remain entry-point signals. The declaration expression is line-anchored
and bounds its optional constructor span to keep malformed large inputs bounded;
lifecycle methods provide an independent entry-point signal. Fixtures exercise
storage constructors, external storage APIs, all scalar preference writes, and
clipboard/preferences routing without claiming an authentication check.

The unchanged global signal map routes `crypto_op` to `crypto-auth`, which owns
sensitive-data confidentiality. Preference/clipboard operations therefore use
that signal instead of `auth_check`; `file_io` remains for access/path analysis.
`file_io` alone does not route confidentiality. Generic `put*` writes also route
`model_write` to integrity analysis. These signals identify review surfaces, not
proven vulnerabilities.

On the same public baseline, real Stage 0 selection/signals and Stage 0.5 produce
34 Kotlin files, 32 Kotlin hunt lanes, and 34 total hunt lanes before and after.
Two Kotlin test files are skipped. Mean classes per Kotlin hunt lane:
**8.4375 → 8.5625**; across all hunt lanes: **8.3824 → 8.5000**. The increase comes
from storage/write coverage; the overly broad import trigger is removed.

| Kotlin signal | Before (of 34) | After (of 34) |
|---|---:|---:|
| `route_handler` | 32 (94.1%) | 32 (94.1%) |
| `db_query` | 3 (8.8%) | 3 (8.8%) |
| `model_schema` | 1 (2.9%) | 1 (2.9%) |
| `model_write` | 3 (8.8%) | 4 (11.8%) |
| `http_outbound` | 2 (5.9%) | 2 (5.9%) |
| `auth_check` | 6 (17.6%) | 2 (5.9%) |
| `crypto_op` | 1 (2.9%) | 4 (11.8%) |
| `html_sink` | 3 (8.8%) | 3 (8.8%) |
| `dynamic_exec` | 2 (5.9%) | 2 (5.9%) |
| `deserialize` | 0 (0.0%) | 0 (0.0%) |
| `file_io` | 4 (11.8%) | 7 (20.6%) |
| `llm_call` | 1 (2.9%) | 1 (2.9%) |
| `logging` | 7 (20.6%) | 7 (20.6%) |
| `config_file` | 0 (0.0%) | 0 (0.0%) |
| `dep_manifest` | 0 (0.0%) | 0 (0.0%) |

`route_handler` is the sole signal above 80%: 32/34 (94.1%). Independent public
class-declaration inspection found 29 activities, one provider, one service and
one receiver: every non-test Kotlin source file is an actual platform component.
The rate is therefore inherent to this target's composition. Imports and bare
mentions no longer suffice. The other signals all fire below 21%.

This check uses a synthetic architecture/category envelope to exercise routing,
not a complete model-assisted Stage 0 run. Run the selector test with:

```bash
cd tools/scanner/stage05-lane-selector-perfile
./node_modules/.bin/tsx --test src/android-config.test.ts
```
