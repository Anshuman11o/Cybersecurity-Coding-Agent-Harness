#!/usr/bin/env bash
# Seed one provider's upstream stage artifacts from another provider's run.
#
#   ./tools/scanner/seed-upstream.sh <from> <to> [stage ...]
#   ./tools/scanner/seed-upstream.sh qwen openai stage1-budget-governor stage2-hunt-lanes
#
# Use case: run a VALIDATOR-ONLY comparison. Both providers judge the same
# stage-2 candidates, isolating the validator model as the single variable.
# Much cheaper than a full pipeline (stage 3 alone is ~41 calls).
#
# Provenance: the copied meta.json is rewritten with provider=<to> plus a
# `seeded_from` field, so assertUpstream() passes but the artifacts remain
# honestly labelled as borrowed. A run built on seeded upstream is NOT a
# full end-to-end comparison — say so when reporting results.

set -euo pipefail

SCANNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FROM="${1:-}"; TO="${2:-}"; shift 2 || true
STAGES=("${@:-stage1-budget-governor stage2-hunt-lanes}")

[ -n "$FROM" ] && [ -n "$TO" ] || {
  echo "usage: $0 <from-provider> <to-provider> [stage ...]" >&2; exit 2; }
[ "$FROM" != "$TO" ] || { echo "error: from and to are the same" >&2; exit 2; }

for stage in ${STAGES[*]}; do
  src="$SCANNER_DIR/runs/$FROM/$stage"
  dst="$SCANNER_DIR/runs/$TO/$stage"
  [ -d "$src" ] || { echo "error: no such run dir: $src" >&2; exit 1; }

  mkdir -p "$dst"
  find "$src" -maxdepth 1 -name '*.json' ! -name 'meta.json' -exec cp {} "$dst/" \;

  cat > "$dst/meta.json" <<JSON
{
  "provider": "$TO",
  "model": "seeded",
  "stage": "$stage",
  "git_sha": "$(git -C "$SCANNER_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "started": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "ended": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "exit_code": 0,
  "seeded_from": "$FROM"
}
JSON
  echo "  seeded $stage: $FROM -> $TO ($(find "$dst" -maxdepth 1 -name '*.json' ! -name meta.json | wc -l | xargs) artifacts)"
done

echo
echo "NOTE: runs/$TO/ now contains artifacts produced by '$FROM'."
echo "      Downstream results are a VALIDATOR-ONLY comparison, not end-to-end."
