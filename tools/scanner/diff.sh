#!/usr/bin/env bash
# Compare two providers' results for a stage.
#
#   ./tools/scanner/diff.sh <stage> <provider-a> <provider-b>
#   ./tools/scanner/diff.sh stage3-validate qwen luna
#   ./tools/scanner/diff.sh stage2-hunt-lanes-perfile qwen luna
#
# This is the deliverable of the multi-provider setup: which verdicts changed,
# and in which direction.
#
# Both providers are required arguments. There is no default pair: with more
# than two models in the registry, a defaulted comparison silently answers a
# question nobody asked.

set -uo pipefail

SCANNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="$SCANNER_DIR/shared/registry-cli.mjs"
STAGE="${1:-}"
A="${2:-}"
B="${3:-}"

if [ -z "$STAGE" ] || [ -z "$A" ] || [ -z "$B" ]; then
  echo "usage: $0 <stage> <provider-a> <provider-b>" >&2
  echo "  providers: $(node "$REGISTRY" spellings 2>/dev/null || echo '(registry unreadable)')" >&2
  exit 2
fi

# Canonicalize so an alias and its target are recognised as the same run tree
# rather than compared against each other as if they were two models.
A="$(node "$REGISTRY" canonical "$A")" || exit 1
B="$(node "$REGISTRY" canonical "$B")" || exit 1
[ "$A" != "$B" ] || { echo "error: '$A' compared against itself" >&2; exit 2; }

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

    # Consolidated IDs are positional, not stable across differing stage-2
    # input. Comparing verdicts across runs whose IDs mean different things
    # produces a plausible-looking but meaningless diff. Verify alignment.
    aligned=$(join -t'|' \
      <(jq -r '.[]|"\(.consolidated_id)|\(.title)"' "$fa" | sort) \
      <(jq -r '.[]|"\(.consolidated_id)|\(.title)"' "$fb" | sort) \
      | awk -F'|' '$2==$3' | wc -l | xargs)
    common=$(join -t'|' \
      <(jq -r '.[].consolidated_id' "$fa" | sort) \
      <(jq -r '.[].consolidated_id' "$fb" | sort) | wc -l | xargs)
    if [ "$common" -eq 0 ] || [ "$aligned" -lt $(( common * 9 / 10 )) ]; then
      echo "ABORT: candidate IDs are not aligned between these two runs." >&2
      echo "       $aligned of $common shared IDs refer to the same finding." >&2
      echo "       The runs consumed different stage-2 input, so a verdict diff" >&2
      echo "       would be meaningless. Re-run both providers against the same" >&2
      echo "       candidate-findings.json (see seed-upstream.sh) first." >&2
      exit 1
    fi
    echo "  (ID alignment verified: $aligned/$common shared candidates match)"
    echo
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

  stage2-hunt-lanes|stage2-hunt-lanes-perfile)
    fa="$SCANNER_DIR/runs/$A/$STAGE/candidate-findings.json"
    fb="$SCANNER_DIR/runs/$B/$STAGE/candidate-findings.json"
    for f in "$fa" "$fb"; do
      [ -f "$f" ] || { echo "error: missing $f" >&2; exit 1; }
    done
    echo "--- finding counts ---"
    printf '%-8s %s findings\n' "$A" "$(jq 'length' "$fa")"
    printf '%-8s %s findings\n' "$B" "$(jq 'length' "$fb")"

    # Per-lane counts. Lane ids are deterministic (assigned by stage 0.5, not
    # by the model), so unlike stage 3's consolidated ids they mean the same
    # thing in both runs and can be joined directly. In v2 one lane is one
    # file, so this is where the two models disagree about the codebase.
    echo
    echo "--- lanes where finding counts differ ---"
    join -t'|' -a1 -a2 -e0 -o 0,1.2,2.2 \
      <(jq -r 'group_by(.lane_id)[]|"\(.[0].lane_id)|\(length)"' "$fa" | sort) \
      <(jq -r 'group_by(.lane_id)[]|"\(.[0].lane_id)|\(length)"' "$fb" | sort) \
      | awk -F'|' -v a="$A" -v b="$B" \
          'BEGIN{n=0} $2!=$3 {printf "  %-48s %s:%-4s %s:%s\n",$1,a,$2,b,$3; n++} \
           END{if(n==0) print "  (no per-lane differences)"; else printf "\n  %d lane(s) differ\n", n}'
    ;;

  stage05-lane-selector-perfile)
    fa="$SCANNER_DIR/runs/$A/$STAGE/lane-assignments.json"
    fb="$SCANNER_DIR/runs/$B/$STAGE/lane-assignments.json"
    for f in "$fa" "$fb"; do
      [ -f "$f" ] || { echo "error: missing $f" >&2; exit 1; }
    done
    echo "--- lane dispositions ---"
    for pair in "$A|$fa" "$B|$fb"; do
      p="${pair%%|*}"; f="${pair#*|}"
      printf '%-8s %s\n' "$p" \
        "$(jq -r '[.lanes[].disposition]|group_by(.)|map("\(.[0])=\(length)")|join(" ")' "$f")"
    done
    ;;

  *)
    echo "no comparison defined for stage '$STAGE'" >&2
    exit 1
    ;;
esac

echo
echo "--- token spend ---"
# Two shapes: v1 writes a bare array of lane records, v2 an object whose
# `legacy_entries` holds the same array. Handle both rather than reporting
# `null` for one of them.
for p in "$A" "$B"; do
  f="$SCANNER_DIR/runs/$p/$STAGE/budget-consumption.json"
  [ -f "$f" ] || continue
  printf '%-8s %s tokens\n' "$p" \
    "$(jq '(if type=="array" then . else .legacy_entries end)|[.[].tokens_used]|add' "$f")"
done
