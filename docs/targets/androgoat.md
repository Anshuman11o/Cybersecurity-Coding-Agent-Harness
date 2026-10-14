# AndroGoat target readiness

Prepared public snapshot: `Anshuman11o/androgoat-clean-mobile` at
`eb460fe0561e3c55dcb1ebe2c859663a5c5757bd`. Private evaluation release:
`Anshuman11o/androgoat-clean-answer-key`, version `1.1.0`, at `fd6107b`.
The starting snapshots were `723a653` (public) and `7103d67` (private).
Use the exact public commit recorded by the private ground-truth release when
scoring; cleanup changes invalidate older file hashes and line anchors.

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
both selectors, reconstructing the v3 inventory envelope from those exact paths
and the public corpus's file metrics. Both runs produced 541 hunt and 324 skip
lanes with zero unaccounted files. The complete lane artifacts, with only
`generated_at` removed, were byte-identical after canonical JSON serialization:
SHA-256 `bfad4227ec31f8719213a4d7f2eeeb27403a827ed4fe40249e83373bbe0433b2`.
The existing signal map, documentation string, and all pre-existing language
patterns were unchanged. Both v1 component directories were byte-identical.

Synthetic Kotlin fixtures cover every content signal, with negative controls
and bounded-runtime checks. Synthetic selector integration covers manifest and
qualified configuration hunting, retained XML skips, class routing, and
empty/test/oversize exclusions. Run the new selector test with:

```bash
cd tools/scanner/stage05-lane-selector-perfile
./node_modules/.bin/tsx --test src/android-config.test.ts
```
