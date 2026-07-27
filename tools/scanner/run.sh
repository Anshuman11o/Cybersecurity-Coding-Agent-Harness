#!/usr/bin/env bash
# Single entry point for scanner runs.
#
#   ./tools/scanner/run.sh <provider> <stage|all>
#
# Guarantees:
#   - only one PROVIDER may run at a time (cross-provider mutex)
#   - multiple concurrent runs of the SAME provider are allowed (re-entrant)
#   - stale locks from crashed runs are auto-cleared via PID liveness check
#   - stdout/stderr are teed into runs/<provider>/<stage>/logs/
#
# The lock is a directory (mkdir is atomic on POSIX), so this needs no flock —
# which macOS does not ship by default.

set -uo pipefail

SCANNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_DIR="$SCANNER_DIR/.run.lock"
LOCK_META="$LOCK_DIR/meta"

STAGES=(stage0-recon stage05-lane-selector stage1-budget-governor stage2-hunt-lanes stage3-validate)

usage() {
  echo "usage: $0 <qwen|openai> <stage|all>" >&2
  echo "  stages: ${STAGES[*]}" >&2
  exit 2
}

[ $# -eq 2 ] || usage
PROVIDER="$1"
TARGET="$2"

case "$PROVIDER" in
  qwen|openai) ;;
  *) echo "error: unknown provider '$PROVIDER'" >&2; usage ;;
esac

# ── Lock ────────────────────────────────────────────────────────────────────

holders_alive() {
  local alive=""
  for pid in $(grep '^holders=' "$LOCK_META" 2>/dev/null | cut -d= -f2-); do
    if kill -0 "$pid" 2>/dev/null; then alive="$alive $pid"; fi
  done
  echo "$alive" | xargs
}

acquire_lock() {
  for _ in 1 2 3; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf 'provider=%s\nholders=%s\nstarted=%s\n' \
        "$PROVIDER" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_META"
      return 0
    fi

    local held alive
    held="$(grep '^provider=' "$LOCK_META" 2>/dev/null | cut -d= -f2-)"
    alive="$(holders_alive)"

    if [ -z "$alive" ]; then
      echo "  [LOCK] clearing stale lock (holder PIDs no longer running)" >&2
      rm -rf "$LOCK_DIR"
      continue
    fi

    if [ "$held" = "$PROVIDER" ]; then
      # Re-entrant: same provider may run concurrently (parallel sub-work).
      sed -i.bak "s/^holders=.*/holders=$alive $$/" "$LOCK_META" && rm -f "$LOCK_META.bak"
      echo "  [LOCK] joined existing $PROVIDER run (holders:$alive $$)" >&2
      return 0
    fi

    echo "error: a '$held' run is in progress (PIDs:$alive)." >&2
    echo "       Only one provider may run at a time. Wait for it to finish." >&2
    exit 1
  done
  echo "error: could not acquire lock after 3 attempts" >&2
  exit 1
}

release_lock() {
  [ -d "$LOCK_DIR" ] || return 0
  local remaining
  remaining="$(grep '^holders=' "$LOCK_META" 2>/dev/null | cut -d= -f2- | tr ' ' '\n' | grep -v "^$$\$" | xargs)"
  if [ -z "$remaining" ]; then
    rm -rf "$LOCK_DIR"
  else
    sed -i.bak "s/^holders=.*/holders=$remaining/" "$LOCK_META" && rm -f "$LOCK_META.bak"
  fi
}

acquire_lock
trap release_lock EXIT INT TERM

# ── Run ─────────────────────────────────────────────────────────────────────

run_stage() {
  local stage="$1"
  local logdir="$SCANNER_DIR/runs/$PROVIDER/$stage/logs"
  mkdir -p "$logdir"

  echo "=== [$PROVIDER] $stage ==="
  (
    cd "$SCANNER_DIR/$stage" || exit 1
    SCANNER_PROVIDER="$PROVIDER" npm run --silent run
  ) > >(tee "$logdir/stdout.log") 2> >(tee "$logdir/stderr.log" >&2)

  local code=${PIPESTATUS[0]}
  echo "=== [$PROVIDER] $stage exited $code ==="
  return "$code"
}

if [ "$TARGET" = "all" ]; then
  for s in "${STAGES[@]}"; do
    run_stage "$s" || { echo "error: $s failed — stopping pipeline" >&2; exit 1; }
  done
else
  found=0
  for s in "${STAGES[@]}"; do [ "$s" = "$TARGET" ] && found=1; done
  [ "$found" -eq 1 ] || { echo "error: unknown stage '$TARGET'" >&2; usage; }
  run_stage "$TARGET"
fi
