#!/usr/bin/env bash
# Single entry point for scanner runs.
#
#   ./tools/scanner/run.sh [--target DIR] [--profile P] [--run-id ID] [--resume] \
#                          [--out DIR] [--yes] [limit flags] [--models-file F] \
#                          <provider> <stage|all|all-v2>
#
# End users run the `secscan` CLI (tools/scanner/cli/), which drives this script
# one stage at a time; the lab runs it directly.
#
# The provider list is not hardcoded here — it comes from shared/models.json
# via shared/registry-cli.mjs, so adding a model is a registry entry and
# nothing else. Aliases are canonicalized before anything touches the disk:
# `run.sh openai …` must tee logs into the same runs/<key>/ directory the
# stage itself writes to, or the logs end up orphaned from the artifacts.
#
# Run context — WHAT a run scans and WHERE its artifacts go. The rules live in
# shared/run-context.ts; this script resolves the flags once and exports the
# result, so every stage (each its own process) sees the same answer:
#
#   benchmark  The lab, and the default. No flags means exactly what this script
#              always did: target-apps/juice-shop-blind, artifacts and logs under
#              runs/<provider>/<stage>/, Stage 2 resuming implicitly.
#   product    A user's repo, chosen by --target outside target-apps/. Results
#              go to a run store, <target>/.secscan/ (or --out DIR, outside the
#              target), git-ignored by a .gitignore of `*` inside it:
#                <store>/runs/<run-id>/            report.*, findings.*, run.json
#                <store>/runs/<run-id>/work/<provider>/<stage>/   internals, logs
#                <store>/index.json, <store>/latest    written by the report stage
#              The store is created only with consent: asked once on a terminal,
#              or --yes for scripts and CI. Stage 2 resumes only with --resume.
#
# A product run started at stage0-recon, all or all-v2 gets a generated run id;
# a later single stage names the run it belongs to with --run-id. A flag wins
# over the same SCANNER_* variable inherited from the caller's environment,
# except SCANNER_RESUME, which only --resume sets.
#
# Guarantees:
#   - only one PROVIDER may run at a time (cross-provider mutex)
#   - multiple concurrent runs of the SAME provider are allowed (re-entrant)
#   - stale locks from crashed runs are auto-cleared via PID liveness check
#   - stdout/stderr are teed into <artifact root>/<provider>/<stage>/logs/<stage>.std{out,err}.log
#     (named per stage because two passes can share one log directory)
#   - Ctrl-C stops a stage cleanly: Stage 2 starts no new lane, lets the ones in
#     flight finish and records INCOMPLETE; a second Ctrl-C aborts. The log tee
#     ignores the interrupt so it outlives the stage and keeps its last lines.
#
# Run limits (productization plan §2.6) are resolved by
# stage1-budget-governor/src/limits.ts from SCANNER_* variables; the flags below
# set them, and a flag wins over the same variable inherited from the caller:
#
#   --max-cost USD    no new lane once projected spend would pass it (priced models only)
#   --max-files N     hunt at most N files
#   --max-file-size S skip larger files (bytes, or 200k / 1m)
#   --timeout T       Stage 2 wall clock; no lane starts after it (600, 90s, 30m, 1h)
#   --concurrency N   lanes in flight (HUNT_CONCURRENCY; derived when unset)
#   --paths P         scan only this target-relative file or directory (repeatable)
#   --include G       scan only files matching this glob (repeatable)
#   --exclude G       skip files matching this glob (repeatable)
#   --models-file F   a user models.json overlay (SCANNER_MODELS_FILE)
#
# The lock is a directory (mkdir is atomic on POSIX), so this needs no flock —
# which macOS does not ship by default.

set -uo pipefail

# openai SDK v5+ uses fetch/undici, which ignores the `httpAgent` option and
# does not honour HTTPS_PROXY on its own. Behind a proxy that intercepts
# traffic, requests are then rejected with "Host not in allowlist". So when a
# proxy is configured, Node is told to route fetch through it — and only then:
# with no proxy the flag has nothing to do, and on a user's machine it is one
# more lab assumption the run should not carry.
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  export NODE_USE_ENV_PROXY=1
fi

SCANNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_DIR="$SCANNER_DIR/.run.lock"
LOCK_META="$LOCK_DIR/meta"
REGISTRY="$SCANNER_DIR/shared/registry-cli.mjs"

# The registry CLI reads a local JSON file and makes no network call, so it runs
# without the proxy env — which would otherwise print an experimental-API
# warning on every lookup and bury the real error message.
#
# A model defined only by a user overlay (SCANNER_MODELS_FILE) or the generic
# OpenAI-compatible endpoint is unknown to registry-cli.mjs, which reads the
# shipped file alone. Those lookups fall through to the CLI's query, which goes
# through shared/models.ts itself — the one loader the stages use — so bash and
# TypeScript still cannot disagree about a key. Overlays may not redefine a
# shipped key, so a key registry-cli.mjs knows has the same answer in both.
REGISTRY_TS="$SCANNER_DIR/cli/src/registry-query.ts"
REGISTRY_TSX="$SCANNER_DIR/cli/node_modules/.bin/tsx"
registry() {
  local out
  if out="$(NODE_NO_WARNINGS=1 NODE_USE_ENV_PROXY= node "$REGISTRY" "$@" 2>/dev/null)"; then
    printf '%s\n' "$out"
    return 0
  fi
  if [ -x "$REGISTRY_TSX" ]; then
    NODE_NO_WARNINGS=1 NODE_USE_ENV_PROXY= "$REGISTRY_TSX" "$REGISTRY_TS" "$@"
    return $?
  fi
  # Neither knows it: rerun for registry-cli's own error message.
  NODE_NO_WARNINGS=1 NODE_USE_ENV_PROXY= node "$REGISTRY" "$@"
}

# v1 — category-themed lanes.
STAGES_V1=(stage0-recon stage05-lane-selector stage1-budget-governor stage2-hunt-lanes)
# v2 — one lane per file. Shares stage0-recon with v1; reconcile runs after
# stage 2 has produced the consumption it reconciles against, and the report
# (deterministic, no model call) last, since it reads that usage record.
STAGES_V2=(stage0-recon stage05-lane-selector-perfile stage1-budget-governor-perfile stage2-hunt-lanes-perfile reconcile-v2 report)

usage() {
  echo "usage: $0 [--target DIR] [--profile P] [--run-id ID] [--resume] [--out DIR] [--yes] <provider> <stage|all|all-v2>" >&2
  echo "  --target DIR   repository to scan (default: target-apps/juice-shop-blind)" >&2
  echo "  --profile P    benchmark | product (default: product when --target is outside target-apps/)" >&2
  echo "  --run-id ID    product: the run, <store>/runs/<ID>/ (generated when starting at stage0-recon, all or all-v2)" >&2
  echo "  --resume       product: let Stage 2 continue the checkpoint already in that run" >&2
  echo "  --out DIR      product: the run store, outside the target (default: <target>/.secscan)" >&2
  echo "  --yes          product: allow creating the run store without asking (scripts, CI)" >&2
  echo "  limits:        --max-cost USD  --max-files N  --max-file-size S  --timeout T  --concurrency N" >&2
  echo "                 --paths P  --include GLOB  --exclude GLOB  (the last three repeatable)" >&2
  echo "  --models-file F  user models.json overlay" >&2
  echo "  providers: $(registry spellings 2>/dev/null || echo '(registry unreadable)')" >&2
  echo "  v1 stages: ${STAGES_V1[*]}" >&2
  echo "  v2 stages: ${STAGES_V2[*]}" >&2
  exit 2
}

die() { echo "error: $*" >&2; exit 2; }

# Same rule as absolute() below, needed while the options are still being read.
absolute_path() { case "$1" in /*) echo "$1" ;; *) echo "$PWD/$1" ;; esac; }

# ── Options ─────────────────────────────────────────────────────────────────
# Flags come before the positional arguments. Each value flag also accepts the
# --flag=value spelling, which Stage 0 has always taken for --target. An empty
# value is an error rather than "not given": `--target ""` quietly becoming the
# benchmark is the silent Juice Shop fallback this context exists to remove.

TARGET_ARG="${SCANNER_TARGET:-}"
PROFILE_ARG="${SCANNER_PROFILE:-}"
RUN_ID="${SCANNER_RUN_ID:-}"
RESUME=0
YES=0
OUT_ARG="${SCANNER_OUT:-}"

# Repeatable list flags accumulate newline-separated, the format limits.ts
# reads: a glob may contain a comma and a path may contain a space. The first
# use of a flag replaces anything inherited, later uses append.
PATHS_SET=0; INCLUDE_SET=0; EXCLUDE_SET=0
append_line() { if [ -n "$1" ]; then printf '%s\n%s' "$1" "$2"; else printf '%s' "$2"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target|--profile|--run-id|--out|--max-cost|--max-files|--max-file-size|--timeout|--concurrency|--paths|--include|--exclude|--models-file)
      { [ $# -ge 2 ] && [ -n "$2" ]; } || die "$1 needs a value"
      opt="$1"; val="$2"; shift 2
      ;;
    --target=*|--profile=*|--run-id=*|--out=*|--max-cost=*|--max-files=*|--max-file-size=*|--timeout=*|--concurrency=*|--paths=*|--include=*|--exclude=*|--models-file=*)
      opt="${1%%=*}"; val="${1#*=}"; shift
      [ -n "$val" ] || die "$opt needs a value"
      ;;
    --resume)  RESUME=1; shift; continue ;;
    --yes|-y)  YES=1; shift; continue ;;
    -h|--help) usage ;;
    --)        shift; break ;;
    -*)        echo "error: unknown option '$1'" >&2; usage ;;
    *)         break ;;
  esac
  case "$opt" in
    --target)        TARGET_ARG="$val" ;;
    --profile)       PROFILE_ARG="$val" ;;
    --run-id)        RUN_ID="$val" ;;
    --out)           OUT_ARG="$val" ;;
    # Values are validated by limits.ts, where every stage reads them.
    --max-cost)      export SCANNER_MAX_COST="$val" ;;
    --max-files)     export SCANNER_MAX_FILES="$val" ;;
    --max-file-size) export SCANNER_MAX_FILE_SIZE="$val" ;;
    --timeout)       export SCANNER_TIMEOUT="$val" ;;
    --concurrency)   export HUNT_CONCURRENCY="$val" ;;
    --paths)
      [ "$PATHS_SET" = 1 ] || SCANNER_PATHS=""
      PATHS_SET=1; export SCANNER_PATHS="$(append_line "$SCANNER_PATHS" "$val")" ;;
    --include)
      [ "$INCLUDE_SET" = 1 ] || SCANNER_INCLUDE=""
      INCLUDE_SET=1; export SCANNER_INCLUDE="$(append_line "$SCANNER_INCLUDE" "$val")" ;;
    --exclude)
      [ "$EXCLUDE_SET" = 1 ] || SCANNER_EXCLUDE=""
      EXCLUDE_SET=1; export SCANNER_EXCLUDE="$(append_line "$SCANNER_EXCLUDE" "$val")" ;;
    --models-file)
      mf="$(absolute_path "$val")"
      [ -f "$mf" ] || die "--models-file is not a file: $mf"
      export SCANNER_MODELS_FILE="$mf" ;;
  esac
done

[ $# -eq 2 ] || usage
PROVIDER_ARG="$1"
STAGE_ARG="$2"

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

# Validated here, before the lock, because the run id rule below depends on
# which stage was asked for.
case "$STAGE_ARG" in
  all|all-v2) ;;
  *) known_stage "$STAGE_ARG" || { echo "error: unknown stage '$STAGE_ARG'" >&2; usage; } ;;
esac

# ── Run context ─────────────────────────────────────────────────────────────
# Everything here is resolved before the lock and before anything is written,
# so a bad flag costs nothing. Paths are compared physically (pwd -P), the same
# way run-context.ts compares realpaths — a symlinked checkout must not flip
# the profile between bash and TypeScript.

REPO_ROOT="$(cd "$SCANNER_DIR/../.." && pwd -P)"

# Relative paths resolve against the caller's directory, which is the only cwd
# that means anything to the person typing them. Each stage runs from its own
# package directory, so a relative path exported as-is would resolve somewhere
# else entirely. Prefixing $PWD (rather than `cd`-ing to the path as given) also
# keeps CDPATH and a literal `-` out of it.
absolute() {
  case "$1" in
    /*) echo "$1" ;;
    *)  echo "$PWD/$1" ;;
  esac
}

TARGET=""
if [ -n "$TARGET_ARG" ]; then
  TARGET_ABS="$(absolute "$TARGET_ARG")"
  [ -d "$TARGET_ABS" ] || die "target (--target or SCANNER_TARGET) is not a directory: $TARGET_ABS"
  TARGET="$(cd "$TARGET_ABS" && pwd -P)" || die "target (--target or SCANNER_TARGET) is not readable: $TARGET_ABS"
fi

if [ -n "$PROFILE_ARG" ]; then
  case "$PROFILE_ARG" in
    benchmark|product) PROFILE="$PROFILE_ARG" ;;
    *) die "profile (--profile or SCANNER_PROFILE) must be benchmark or product, got '$PROFILE_ARG'" ;;
  esac
elif [ -n "$TARGET" ]; then
  # Inside target-apps/ is the lab; anywhere else is a user's repo. A missing
  # target-apps/ cannot contain anything, so it must not become an empty
  # pattern that matches every path.
  TARGET_APPS="$(cd "$REPO_ROOT/target-apps" 2>/dev/null && pwd -P)"
  PROFILE=product
  if [ -n "$TARGET_APPS" ]; then
    case "$TARGET/" in "$TARGET_APPS"/*) PROFILE=benchmark ;; esac
  fi
else
  PROFILE=benchmark
fi

# A run id becomes a path segment. Same rule as run-context.ts, spelled out
# letter by letter: a bracket range like [A-Z] follows the locale's collation
# order in bash 3.2, so it can admit characters the TypeScript regex rejects.
RUN_ID_ALNUM='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
valid_run_id() {
  case "$1" in
    ''|[!$RUN_ID_ALNUM]*|*[!$RUN_ID_ALNUM._-]*) return 1 ;;
  esac
  [ "${#1}" -le 128 ]
}

# A path with symlinks resolved as far as it exists. The store may not exist
# yet, but whether it lies inside the target has to be decided physically,
# exactly as run-context.ts decides it.
physical() {
  local p="$1" rest=""
  while [ ! -d "$p" ]; do
    rest="/$(basename "$p")$rest"
    p="$(dirname "$p")"
  done
  echo "$(cd "$p" && pwd -P)$rest"
}

# A run store is a directory whose .gitignore is exactly `*`: the file this
# script writes when it creates one, and the reason git never sees it.
is_store() { [ -f "$1/.gitignore" ] && [ "$(cat "$1/.gitignore" 2>/dev/null)" = '*' ]; }

# True when a directory holds nothing but what a run store holds (say, one whose
# .gitignore was deleted). Such a directory is not someone else's; it only needs
# consent again before the .gitignore is put back.
only_store_entries() {
  local e
  for e in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    case "$(basename "$e")" in
      runs|index.json|latest|latest.txt|.gitignore) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

RUN_ID_GENERATED=0
OUT_CUSTOM=0
if [ "$PROFILE" = product ]; then
  # The product profile scans a repository someone names. Falling back to the
  # benchmark target would write .secscan/ into the lab's working copy.
  [ -n "$TARGET" ] || die "the product profile needs --target DIR"

  # ── Run store ──
  # Default <target>/.secscan. --out moves it, but only outside the target: a
  # store inside it would be walked by Stage 0's inventory and scanned as source.
  OUT_ROOT="$TARGET/.secscan"
  if [ -n "$OUT_ARG" ]; then
    OUT_ROOT="$(physical "$(absolute "$OUT_ARG")")"
    if [ "$OUT_ROOT" != "$TARGET/.secscan" ]; then
      OUT_CUSTOM=1
      case "$OUT_ROOT/" in
        "$TARGET"/*) die "--out must be outside the target (or $TARGET/.secscan itself): $OUT_ROOT would be scanned as source" ;;
      esac
    fi
  fi
  # Never take over a directory that holds something else. Writing a
  # .gitignore of `*` into it would quietly hide the owner's own files from git.
  if [ -e "$OUT_ROOT" ]; then
    [ -d "$OUT_ROOT" ] || die "run store is not a directory: $OUT_ROOT"
    if ! is_store "$OUT_ROOT" && ! only_store_entries "$OUT_ROOT"; then
      die "$OUT_ROOT already holds files and is not a run store; choose a new or empty directory with --out"
    fi
  fi

  if [ -n "$RUN_ID" ]; then
    valid_run_id "$RUN_ID" ||
      die "run id (--run-id or SCANNER_RUN_ID) must start with a letter or digit, use only A-Z a-z 0-9 . _ - and be at most 128 characters, got '$RUN_ID'"
  else
    case "$STAGE_ARG" in
      stage0-recon|all|all-v2)
        # Second resolution, so two runs started in the same second on the same
        # target would share a directory. Suffix rather than collide: a reused
        # directory means Stage 0 overwrites another run's artifacts.
        run_id_base="$(date -u +%Y%m%d-%H%M%S)"
        RUN_ID="$run_id_base"
        n=2
        while [ -e "$OUT_ROOT/runs/$RUN_ID" ]; do
          RUN_ID="$run_id_base-$n"
          n=$((n + 1))
        done
        RUN_ID_GENERATED=1
        ;;
      *)
        echo "error: a product run needs --run-id to run '$STAGE_ARG' on its own." >&2
        echo "       A run starts at stage0-recon, all or all-v2, which print the id to reuse;" >&2
        echo "       existing runs are under $OUT_ROOT/runs/" >&2
        exit 2
        ;;
    esac
  fi

  # A later stage belongs to a run that exists. A mistyped id would otherwise
  # start a fresh, empty run directory and fail one stage later, less clearly.
  case "$STAGE_ARG" in
    stage0-recon|all|all-v2) ;;
    *) [ -d "$OUT_ROOT/runs/$RUN_ID" ] ||
         die "no run '$RUN_ID' under $OUT_ROOT/runs/$([ "$OUT_CUSTOM" = 1 ] || echo ' (pass the same --out the run started with)')" ;;
  esac

  # ── Consent ──
  # The store is the one thing this tool writes into a user's tree, so the
  # first run asks. On a terminal: a prompt. Anywhere else (scripts, CI): only
  # --yes allows it, and without it nothing at all is written.
  if ! is_store "$OUT_ROOT" && [ "$YES" != 1 ]; then
    if [ -t 0 ] && [ -t 2 ]; then
      printf '  Results will be written to %s/ (git-ignored by a .gitignore inside it). Create it? [Y/n] ' "$OUT_ROOT" >&2
      read -r answer || answer=n
      case "$answer" in
        ''|y|Y|yes|Yes|YES) ;;
        *) echo "  Nothing written. Use --out DIR to put results elsewhere." >&2; exit 1 ;;
      esac
    else
      echo "error: results go to $OUT_ROOT/, which is not a run store yet, and there is no terminal to ask." >&2
      echo "       Re-run with --yes to allow creating it, or --out DIR to put it outside the repository." >&2
      exit 2
    fi
  fi

  RUN_DIR="$OUT_ROOT/runs/$RUN_ID"
  ARTIFACT_ROOT="$RUN_DIR/work"
  if [ -n "${SCANNER_RUNS_ROOT:-}" ] && [ "$(absolute "$SCANNER_RUNS_ROOT")" != "$ARTIFACT_ROOT" ]; then
    echo "  [CONTEXT] ignoring inherited SCANNER_RUNS_ROOT — a product run writes under its run store" >&2
  fi
  export SCANNER_TARGET="$TARGET"
  export SCANNER_PROFILE=product
  export SCANNER_RUN_ID="$RUN_ID"
  export SCANNER_RUNS_ROOT="$ARTIFACT_ROOT"
  if [ "$OUT_CUSTOM" = 1 ]; then export SCANNER_OUT="$OUT_ROOT"; else unset SCANNER_OUT; fi
else
  # The lab layout. An inherited SCANNER_RUNS_ROOT is honoured, because the
  # stages honour it too; the logs must follow the artifacts wherever they go.
  if [ -n "${SCANNER_RUNS_ROOT:-}" ]; then
    ARTIFACT_ROOT="$(absolute "$SCANNER_RUNS_ROOT")"
    export SCANNER_RUNS_ROOT="$ARTIFACT_ROOT"
  else
    ARTIFACT_ROOT="$SCANNER_DIR/runs"
  fi
  if [ -n "$RUN_ID" ]; then
    echo "  [CONTEXT] ignoring run id '$RUN_ID' — the benchmark has none; its artifacts overwrite $ARTIFACT_ROOT/<provider>/ in place" >&2
    unset SCANNER_RUN_ID
  fi
  if [ -n "$OUT_ARG" ]; then
    echo "  [CONTEXT] ignoring --out '$OUT_ARG' — the benchmark has no run store; its artifacts go to $ARTIFACT_ROOT" >&2
  fi
  unset SCANNER_OUT
  if [ -n "$TARGET" ]; then export SCANNER_TARGET="$TARGET"; fi
  export SCANNER_PROFILE=benchmark
fi

# Only the flag grants a resume. A SCANNER_RESUME left exported in the caller's
# shell would be exactly the implicit resume the product profile exists to stop.
if [ "$RESUME" = 1 ]; then
  export SCANNER_RESUME=1
else
  unset SCANNER_RESUME
fi

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

# ── Context summary ─────────────────────────────────────────────────────────
# Printed once the run is certain to start, so nothing here describes a run
# that a lock conflict then stopped.

echo "  [CONTEXT] $PROFILE | target: ${TARGET:-$REPO_ROOT/target-apps/juice-shop-blind (default)} | artifacts: $ARTIFACT_ROOT/$PROVIDER" >&2

if [ "$PROFILE" = product ]; then
  # Nothing is written until here, after consent and the lock. The .gitignore
  # of `*` matches itself too, so git never sees the store and run artifacts
  # cannot be committed into the repository being scanned.
  if ! is_store "$OUT_ROOT"; then
    mkdir -p "$OUT_ROOT" && printf '*\n' > "$OUT_ROOT/.gitignore" ||
      { echo "error: cannot create the run store $OUT_ROOT/ — is it writable?" >&2; exit 1; }
  fi
  echo "  [STORE] $OUT_ROOT/runs/$RUN_ID/  (report lands here; internals in work/)" >&2

  if [ "$RUN_ID_GENERATED" = 1 ]; then
    # Quoted with %q so the commands paste back correctly even when the target
    # path has spaces in it.
    again="$(printf '%q' "$0") --target $(printf '%q' "$TARGET")$([ "$OUT_CUSTOM" = 1 ] && printf ' --out %q' "$OUT_ROOT") --run-id $RUN_ID"
    echo "  ============================================================================" >&2
    echo "  [RUN ID] $RUN_ID" >&2
    echo "    run a later stage of this run:" >&2
    echo "      $again $PROVIDER <stage>" >&2
    echo "    continue a Stage 2 that stopped:" >&2
    echo "      $again --resume $PROVIDER stage2-hunt-lanes-perfile" >&2
    echo "  ============================================================================" >&2
  else
    echo "  [RUN ID] $RUN_ID$([ "$RESUME" = 1 ] && echo ' (resume allowed)')" >&2
  fi
fi

# ── Run ─────────────────────────────────────────────────────────────────────

run_stage() {
  local stage="$1"
  local dir script logdir
  dir="$(stage_dir "$stage")"
  script="$(stage_script "$stage")"
  logdir="$ARTIFACT_ROOT/$PROVIDER/$(stage_logdir "$stage")/logs"
  mkdir -p "$logdir"

  echo "=== [$PROVIDER] $stage ==="
  # The tees ignore SIGINT and SIGTERM: Ctrl-C signals the whole process
  # group, and a tee that died first would cut the stage's wrap-up out of the
  # log — or, worse, fail the stage's writes to a closed pipe.
  (
    cd "$SCANNER_DIR/$dir" || exit 1
    SCANNER_PROVIDER="$PROVIDER" npm run --silent "$script"
  ) > >(trap '' INT TERM; exec tee "$logdir/$stage.stdout.log") \
    2> >(trap '' INT TERM; exec tee "$logdir/$stage.stderr.log" >&2)

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

case "$STAGE_ARG" in
  all)    run_pipeline "${STAGES_V1[@]}" ;;
  all-v2) run_pipeline "${STAGES_V2[@]}" ;;
  *)      run_stage "$STAGE_ARG" ;;
esac
