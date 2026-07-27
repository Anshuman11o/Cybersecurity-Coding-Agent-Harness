#!/usr/bin/env bash
# Compare two providers' results for a stage.
#
#   ./tools/scanner/diff.sh stage3-validate [qwen] [openai]
#
# This is the deliverable of the dual-provider setup: which verdicts changed,
# and in which direction.

set -uo pipefail

SCANNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${1:-stage3-validate}"
A="${2:-qwen}"
B="${3:-openai}"

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

meta() {
  local f="$SCANNER_DIR/runs/$1/$STAGE/meta.json"
  [ -f "$f" ] && jq -r '"\(.provider)/\(.model) @ \(.git_sha) (\(.ended))"' "$f" || echo "$1 (no meta.json)"
}

echo "A: $(meta "$A")"
echo "B: $(meta "$B")"
echo

case "$STAGE" in
  stage3-validate)
    fa="$SCANNER_DIR/runs/$A/$STAGE/validated-findings.json"
    fb="$SCANNER_DIR/runs/$B/$STAGE/validated-findings.json"
    for f in "$fa" "$fb"; do
      [ -f "$f" ] || { echo "error: missing $f" >&2; exit 1; }
    done

    echo "--- verdict counts ---"
    printf '%-8s ' "$A"; jq -r '[.[].verdict]|group_by(.)|map("\(.[0])=\(length)")|join(" ")' "$fa"
    printf '%-8s ' "$B"; jq -r '[.[].verdict]|group_by(.)|map("\(.[0])=\(length)")|join(" ")' "$fb"

    echo
    echo "--- per-candidate verdict changes ---"
    join -t'|' \
      <(jq -r '.[]|"\(.consolidated_id)|\(.verdict)"' "$fa" | sort) \
      <(jq -r '.[]|"\(.consolidated_id)|\(.verdict)"' "$fb" | sort) \
      | awk -F'|' -v a="$A" -v b="$B" \
          'BEGIN{n=0} $2!=$3 {printf "  %-12s %s: %-10s -> %s: %s\n",$1,a,$2,b,$3; n++} \
           END{if(n==0) print "  (no verdict changes)"; else printf "\n  %d of the candidates changed verdict\n", n}'
    ;;

  stage2-hunt-lanes)
    fa="$SCANNER_DIR/runs/$A/$STAGE/candidate-findings.json"
    fb="$SCANNER_DIR/runs/$B/$STAGE/candidate-findings.json"
    echo "--- finding counts ---"
    printf '%-8s %s findings\n' "$A" "$(jq 'length' "$fa")"
    printf '%-8s %s findings\n' "$B" "$(jq 'length' "$fb")"
    ;;

  *)
    echo "no comparison defined for stage '$STAGE'" >&2
    exit 1
    ;;
esac

echo
echo "--- token spend ---"
for p in "$A" "$B"; do
  f="$SCANNER_DIR/runs/$p/$STAGE/budget-consumption.json"
  [ -f "$f" ] && printf '%-8s %s tokens\n' "$p" "$(jq '[.[].tokens_used]|add' "$f")"
done
