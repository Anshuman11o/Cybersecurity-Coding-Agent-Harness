#!/usr/bin/env bash
#
# Build the machine state a patcher run needs, entirely OUTSIDE the repository.
#
# What preflight demands, and what this produces:
#
#   1. $PATCHER_WORK/node_modules              the shared install the run config
#                                              symlinks into every work tree
#   2. a BUILT base tree                       build/server.js plus five
#                                              frontend/dist/frontend/* files the
#                                              application requires at startup
#
# The base tree is built at $PATCHER_WORK/base/juice-shop-blind, a copy —
# NEVER in place. target-apps/juice-shop-blind is the pristine tree every run is
# copied from, `build/` is not gitignored there, and three agents share the
# checkout: building in place puts ~2.7 MB of untracked compiler output in a
# repository somebody is about to commit.
#
# Consequence: target.base_tree in the run config must point at the copy this
# script builds. See docs/patcher/RUN-ENVIRONMENT.md.
#
# Usage:
#   tools/patcher/setup/prepare_env.sh            # full prepare (~8 min, ~930 MB)
#   tools/patcher/setup/prepare_env.sh --verify   # re-check an existing install only
#   tools/patcher/setup/prepare_env.sh --force    # discard and rebuild the base copy
#
set -euo pipefail

PATCHER_WORK="${PATCHER_WORK:-/home/user/patcher-work}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC_TREE="$REPO_ROOT/target-apps/juice-shop-blind"
BASE="$PATCHER_WORK/base/juice-shop-blind"
SHARED_NM="$PATCHER_WORK/node_modules"

MODE=prepare
case "${1:-}" in
  --verify) MODE=verify ;;
  --force)  MODE=force ;;
  '')       ;;
  *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

say() { printf '[prepare_env] %s\n' "$*"; }

verify() {
  local rc=0
  [ -d "$SHARED_NM" ] || { echo "MISSING shared node_modules: $SHARED_NM"; rc=1; }
  local f
  for f in build/server.js \
           frontend/dist/frontend/index.html \
           frontend/dist/frontend/styles.css \
           frontend/dist/frontend/main.js \
           frontend/dist/frontend/polyfills.js; do
    if [ -f "$BASE/$f" ]; then echo "OK      $f"; else echo "MISSING $f"; rc=1; fi
  done
  # The sixth file is content-hashed, so it is matched by glob, exactly as
  # preflight matches it.
  if compgen -G "$BASE/frontend/dist/frontend/hacking-instructor-*.js" >/dev/null; then
    echo "OK      frontend/dist/frontend/hacking-instructor-*.js"
  else
    echo "MISSING frontend/dist/frontend/hacking-instructor-*.js"; rc=1
  fi
  return $rc
}

if [ "$MODE" = verify ]; then
  verify
  exit $?
fi

[ -d "$SRC_TREE" ] || { echo "no such tree: $SRC_TREE" >&2; exit 1; }

mkdir -p "$PATCHER_WORK/base" "$PATCHER_WORK/logs" "$PATCHER_WORK/pinned"

if [ -d "$BASE" ]; then
  if [ "$MODE" = force ]; then
    say "discarding existing base copy"
    rm -rf "$BASE"
  else
    say "$BASE already exists; pass --force to rebuild it, or --verify to check it"
    verify
    exit $?
  fi
fi

say "copying the pristine tree (source only) -> $BASE"
tar -C "$(dirname "$SRC_TREE")" -cf - \
    --exclude=node_modules --exclude=.git "$(basename "$SRC_TREE")" \
  | tar -C "$PATCHER_WORK/base" -xf -

# CYPRESS_INSTALL_BINARY=0: cypress@15's postinstall downloads a ~250 MB binary
# and that download dies with ECONNRESET through the outbound proxy, taking the
# whole `npm install` with it. Cypress is only used by `npm run test:e2e`, which
# no gate in any run config invokes.
#
# The app's own .npmrc sets package-lock=false, so there is no lockfile to
# `npm ci` against and this resolves against the registry as of today. The
# resolved set is captured under $PATCHER_WORK/pinned/ afterwards.
say "npm install (root; postinstall builds the frontend and the server) — several minutes"
( cd "$BASE" && CYPRESS_INSTALL_BINARY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm install --no-audit --no-fund ) 2>&1 | tee "$PATCHER_WORK/logs/npm-install.log" | tail -5

say "moving node_modules out of the tree -> $SHARED_NM"
if [ -d "$SHARED_NM" ] && [ ! -L "$BASE/node_modules" ]; then
  rm -rf "$SHARED_NM"
fi
if [ ! -L "$BASE/node_modules" ]; then
  mv "$BASE/node_modules" "$SHARED_NM"
  ln -s "$SHARED_NM" "$BASE/node_modules"
fi

# The Angular build cache is regenerable and would otherwise be copied into
# every work tree.
rm -rf "$BASE/frontend/.angular"

say "recording what actually got installed -> $PATCHER_WORK/pinned/"
( cd "$BASE" && CYPRESS_INSTALL_BINARY=0 \
    npm install --package-lock-only --package-lock=true --no-audit --no-fund \
    > "$PATCHER_WORK/logs/lockfile-gen.log" 2>&1 \
  && mv package-lock.json "$PATCHER_WORK/pinned/package-lock.json" ) || \
  say "WARNING: could not generate a root lockfile; see logs/lockfile-gen.log"
( cd "$BASE/frontend" && npm install --package-lock-only --package-lock=true --no-audit --no-fund \
    > "$PATCHER_WORK/logs/lockfile-gen-frontend.log" 2>&1 \
  && mv package-lock.json "$PATCHER_WORK/pinned/frontend-package-lock.json" ) || \
  say "WARNING: could not generate a frontend lockfile"

say "verifying the six startup files preflight checks"
verify

cat <<EOF

[prepare_env] done.

  shared node_modules : $SHARED_NM
  built base tree     : $BASE
  pinned versions     : $PATCHER_WORK/pinned/

The run config still points target.base_tree at the in-repo checkout, which is
deliberately NOT built. Preflight passes only against the copy above:

  "base_tree": "$BASE"

Then:

  python3 tools/patcher/src/run_patcher.py \\
    --config tools/patcher/config/subset4.run-config.json --check
EOF
