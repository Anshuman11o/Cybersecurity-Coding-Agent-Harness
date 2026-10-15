# AI Goat target readiness

The public target is `Anshuman11o/aigoat-clean-LLM` at `9c62129`. Resolve the
abbreviated pin to its full commit and record it for every run. A private answer
key exists and is supplied only in a separate scoring environment.

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

Use a separate environment with only the harness and public checkout. Keep
private answer keys out of the scanning environment. Use a fresh
reports directory outside the target and leave the playbook agent disabled for
the fixed-class workflow:

Held-out targets run under the **product profile**: no benchmark seed denylist,
risk-ordered lanes, and a required Stage 1 scan plan. Product runs do not resume
implicitly. For these held-out measurements, use a fresh run and **no resume**;
do not pass `--resume` or set `SCANNER_RESUME=1`. These execution differences mean
their numbers are **not directly comparable** with Juice Shop benchmark-profile
rows, even when both use fixed classes. Record the profile and plan with results.

```bash
# From the harness root; PROVIDER is an authorized registry provider key.
TARGET=/workspace/aigoat-clean-LLM
TARGET_COMMIT=$(git -C "$TARGET" rev-parse '9c62129^{commit}')
test "$(git -C "$TARGET" rev-parse HEAD)" = "$TARGET_COMMIT"
git merge-base HEAD origin/main
rg 'terraform|key-material' tools/scanner/stage0-recon/src/recon-contract.ts
unset SCANNER_PLAYBOOK_AGENT SCANNER_RESUME
SCANNER_REPORTS_ROOT=/workspace/held-out-reports \
  ./tools/scanner/run.sh --target "$TARGET" --profile product "$PROVIDER" all-v2
```

Score privately with `tools/scan-benchmark/score_scanner.py --findings "$FINDINGS"
--answer-key "$BENCHMARK_KEY" --json-out "$PRIVATE_METRICS"`. Paths to private
artifacts are supplied by the scoring operator, never committed here. Record
aggregate metrics tagged with the target name, full target commit and ground-truth
version. No paid scan is part of readiness preparation, and prior class-level
playbook-agent evaluations are not evidence of full-scanner performance.
