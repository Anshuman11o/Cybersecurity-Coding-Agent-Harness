# AI Goat target readiness

The public target is `Anshuman11o/aigoat-clean-LLM` at `9c62129`; the private
scoring snapshot is `Anshuman11o/aigoat-clean-answer-key` at `2f2bdbc`.
Resolve both abbreviated pins to full commits and record them for every run.
Scoring-tool preparation commits descend from the private snapshot and do not
change the frozen vulnerability entries.

This is a store application with a Python/Flask backend, TypeScript/JavaScript
frontend and Terraform/HCL infrastructure. Key and certificate files are part of
the product-profile source inventory. Scanning source does not require deploying
cloud infrastructure or building the frontend.

Required harness support: `.tf`, `.tfvars`, `.hcl` inventory, huntable Terraform
lanes, generic infrastructure signals, and `.pem`, `.key`, `.crt` inventory with
cryptographic review lanes. Key material is huntable because committed private
keys can be secrets; a certificate alone is not evidence of a vulnerability.
Existing Python sink detection recognizes route decorators. A dedicated Python
route-table extractor is deferred; this does not prevent Python hunt lanes, but
route-table context remains incomplete for this framework.

Use a separate environment with only the harness and public checkout. Keep both
private answer-key repositories out of the scanning environment. Use a fresh
reports directory outside the target and leave the playbook agent disabled for
comparison with the fixed-class reference runs:

```bash
# From the harness root; PROVIDER is an authorized registry provider key.
TARGET=/workspace/aigoat-clean-LLM
TARGET_COMMIT=$(git -C "$TARGET" rev-parse '9c62129^{commit}')
test "$(git -C "$TARGET" rev-parse HEAD)" = "$TARGET_COMMIT"
git merge-base HEAD origin/main
rg 'terraform|key-material' tools/scanner/stage0-recon/src/recon-contract.ts
unset SCANNER_PLAYBOOK_AGENT
SCANNER_REPORTS_ROOT=/workspace/held-out-reports \
  ./tools/scanner/run.sh --target "$TARGET" --profile product "$PROVIDER" all-v2
```

Score privately with `tools/scan-benchmark/score_scanner.py --findings "$FINDINGS"
--answer-key "$BENCHMARK_KEY" --json-out "$PRIVATE_METRICS"`. Paths to private
artifacts are supplied by the scoring operator, never committed here. Record
aggregate metrics tagged with the target name, full target commit and ground-truth
version. No paid scan is part of readiness preparation, and prior class-level
playbook-agent evaluations are not evidence of full-scanner performance.
