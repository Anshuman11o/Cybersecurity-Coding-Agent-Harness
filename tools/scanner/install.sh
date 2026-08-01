#!/usr/bin/env bash
#
# Install node dependencies for every scanner package.
#
#   tools/scanner/install.sh          # install everything
#   tools/scanner/install.sh --check  # report state, install nothing, exit 1 if incomplete
#
# Why this exists: node_modules/ is gitignored per package, and nothing in the
# repo installed it. A fresh clone therefore has zero installed packages, and
# every entry point that imports `openai` dies with ERR_MODULE_NOT_FOUND before
# it reaches any provider logic — which reads as a broken scanner rather than as
# a missing install. That failure cost a full six-target preflight sweep on
# 2026-08-01: all six "failed" identically, and none of them had run at all.
#
# Idempotent. Uses `npm ci` where a lockfile exists so installs are reproducible,
# falling back to `npm install` where one does not.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$PWD"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# Every directory holding a package.json, one level down. Deliberately
# discovered rather than listed: a hardcoded list is wrong the first time a
# stage is added, and the failure mode is silent.
mapfile -t PKGS < <(find . -maxdepth 2 -name package.json -not -path '*/node_modules/*' -printf '%h\n' | sort)

if [[ ${#PKGS[@]} -eq 0 ]]; then
  echo "no packages found under $ROOT" >&2
  exit 1
fi

missing=0
installed=0

for pkg in "${PKGS[@]}"; do
  name="${pkg#./}"

  if [[ -d "$pkg/node_modules" ]]; then
    printf '  %-36s ok\n' "$name"
    continue
  fi

  missing=$((missing + 1))

  if [[ $CHECK_ONLY -eq 1 ]]; then
    printf '  %-36s MISSING\n' "$name"
    continue
  fi

  if [[ -f "$pkg/package-lock.json" ]]; then
    printf '  %-36s installing (npm ci)...\n' "$name"
    # `npm ci` refuses to run when the lockfile is out of sync with
    # package.json, which is exactly what happens after a dependency is added
    # and the lock is not regenerated. Falling back to `npm install` keeps the
    # bootstrap working and rewrites the lock; it is announced rather than
    # silent, because it means the committed lock needs a refresh.
    if ! ( cd "$pkg" && npm ci --silent 2>/dev/null ); then
      printf '  %-36s lockfile out of sync, falling back to npm install\n' "$name"
      ( cd "$pkg" && npm install --silent )
    fi
  else
    printf '  %-36s installing (npm install, no lockfile)...\n' "$name"
    ( cd "$pkg" && npm install --silent )
  fi
  installed=$((installed + 1))
done

echo
if [[ $CHECK_ONLY -eq 1 ]]; then
  if [[ $missing -gt 0 ]]; then
    echo "$missing of ${#PKGS[@]} packages are not installed — run tools/scanner/install.sh" >&2
    exit 1
  fi
  echo "all ${#PKGS[@]} packages installed"
  exit 0
fi

echo "installed $installed package(s); ${#PKGS[@]} total ready"
