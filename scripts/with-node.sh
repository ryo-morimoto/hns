#!/usr/bin/env bash
# Run a command with the Node pinned by flake.nix (issue 0004).
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
# Keep both caches repo-local so the shell works even when $HOME is not writable.
export npm_config_cache="$ROOT/.work/npm-cache"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT/.work/nix-cache}"

# Already inside the pinned shell (pre-commit hook, or a nested npm script).
if [ "${IN_NIX_SHELL:-}" = "impure" ]; then
  exec "$@"
fi

if ! command -v nix >/dev/null 2>&1; then
  echo "with-node: nix with flakes is required (see README)" >&2
  exit 1
fi

exec nix develop "$ROOT" --command "$@"
