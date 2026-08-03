#!/usr/bin/env bash
# Single entry point for scanner runs.
#
#   ./tools/scanner/run.sh <provider> <stage|all|all-v2>
#
# The provider list is not hardcoded here — it comes from shared/models.json
# via shared/registry-cli.mjs, so adding a model is a registry entry and
# nothing else. Aliases are canonicalized before anything touches the disk:
# `run.sh openai …` must tee logs into the same runs/<key>/ directory the
# stage itself writes to, or the logs end up orphaned from the artifacts.
#
# Guarantees:
#   - only one PROVIDER may run at a time (cross-provider mutex)
#   - multiple concurrent runs of the SAME provider are allowed (re-entrant)
#   - stale locks from crashed runs are auto-cleared via PID liveness check
#   - stdout/stderr are teed into runs/<provider>/<stage>/logs/<stage>.std{out,err}.log
#     (named per stage because two passes can share one log directory)
#
# The lock is a directory (mkdir is atomic on POSIX), so this needs no flock —
# which macOS does not ship by default.

set -uo pipefail

# openai SDK v5+ uses fetch/undici, which ignores the `httpAgent` option and
# does not honour HTTPS_PROXY on its own. Without this, requests are
# transparently intercepted and rejected with "Host not in allowlist".
export NODE_USE_ENV_PROXY=1

SCANNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_DIR="$SCANNER_DIR/.run.lock"
LOCK_META="$LOCK_DIR/meta"
REGISTRY="$SCANNER_DIR/shared/registry-cli.mjs"

# The registry CLI reads a local JSON file and makes no network call, so it runs
# without the proxy env — which would otherwise print an experimental-API
# warning on every lookup and bury the real error message.
registry() { NODE_NO_WARNINGS=1 NODE_USE_ENV_PROXY= node "$REGISTRY" "$@"; }

# v1 — category-themed lanes.
STAGES_V1=(stage0-recon stage05-lane-selector stage1-budget-governor stage2-hunt-lanes)
# v2 — one lane per file. Shares stage0-recon with v1; reconcile runs last,
# after stage 2 has produced the consumption it reconciles against.
STAGES_V2=(stage0-recon stage05-lane-selector-perfile stage1-budget-governor-perfile stage2-hunt-lanes-perfile reconcile-v2)

usage() {
  echo "usage: $0 <provider> <stage|all|all-v2>" >&2
  echo "  providers: $(registry spellings 2>/dev/null || echo '(registry unreadable)')" >&2
  echo "  v1 stages: ${STAGES_V1[*]}" >&2
  echo "  v2 stages: ${STAGES_V2[*]}" >&2
  exit 2
}

[ $# -eq 2 ] || usage
PROVIDER_ARG="$1"
TARGET="$2"

# Canonicalize (and validate) against the registry. Exits non-zero, with the
# accepted list, if the key is unknown.
PROVIDER="$(registry canonical "$PROVIDER_ARG")" || usage
if [ "$PROVIDER" != "$PROVIDER_ARG" ]; then
  echo "  [PROVIDER] '$PROVIDER_ARG' is an alias for '$PROVIDER'" >&2
fi
echo "  [PROVIDER] $PROVIDER / $(registry model "$PROVIDER") — $(registry label "$PROVIDER")" >&2

# ── Stage table ─────────────────────────────────────────────────────────────
# A stage key names an artifact namespace, not necessarily a source directory:
# the v2 budget governor shares v1's source but owns its own run tree.

stage_dir() {
  case "$1" in
    stage1-budget-governor-perfile|reconcile-v2) echo "stage1-budget-governor" ;;
    *) echo "$1" ;;
  esac
}

stage_script() {
  case "$1" in
    stage1-budget-governor-perfile) echo "run:v2" ;;
    reconcile-v2)                   echo "run:v2-reconcile" ;;
    *)                              echo "run" ;;
  esac
}

# Where logs go. reconcile-v2 is a second pass over the v2 governor's own
# artifacts, so its logs belong with them rather than in a stray directory.
stage_logdir() {
  case "$1" in
    reconcile-v2) echo "stage1-budget-governor-perfile" ;;
    *) echo "$1" ;;
  esac
}

known_stage() {
  local s
  for s in "${STAGES_V1[@]}" "${STAGES_V2[@]}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}

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
  local dir script logdir
  dir="$(stage_dir "$stage")"
  script="$(stage_script "$stage")"
  logdir="$SCANNER_DIR/runs/$PROVIDER/$(stage_logdir "$stage")/logs"
  mkdir -p "$logdir"

  echo "=== [$PROVIDER] $stage ==="
  (
    cd "$SCANNER_DIR/$dir" || exit 1
    SCANNER_PROVIDER="$PROVIDER" npm run --silent "$script"
  ) > >(tee "$logdir/$stage.stdout.log") 2> >(tee "$logdir/$stage.stderr.log" >&2)

  local code=${PIPESTATUS[0]}
  echo "=== [$PROVIDER] $stage exited $code ==="
  return "$code"
}

# Stages passed positionally, not by nameref: `local -n` needs bash 4.3, and
# macOS still ships 3.2 — the same reason the lock is a directory, not flock.
run_pipeline() {
  for s in "$@"; do
    run_stage "$s" || { echo "error: $s failed — stopping pipeline" >&2; exit 1; }
  done
}

case "$TARGET" in
  all)    run_pipeline "${STAGES_V1[@]}" ;;
  all-v2) run_pipeline "${STAGES_V2[@]}" ;;
  *)
    known_stage "$TARGET" || { echo "error: unknown stage '$TARGET'" >&2; usage; }
    run_stage "$TARGET"
    ;;
esac
